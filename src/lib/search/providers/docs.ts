// SPDX-License-Identifier: MPL-2.0
/**
 * The Docs spotlight provider (plans/99 M3) — searches the /info site.
 *
 * The haystack is the static site's own per-locale search index
 * (`/info/search-index.json` for English, `/info/<lang>/search-index.json`
 * otherwise — the same file docs/build.ts writes for the docs sidebar search,
 * one record per page section). Nothing in the shell read it before this;
 * federating over it at runtime keeps plans/99 principle 2 (no build-time
 * unified index) since it is already per-locale static data the client can
 * reach.
 *
 * LAZY: nothing is fetched until the first search() call, so a user who never
 * searches pays nothing (the same first-interaction rule the docs sidebar
 * follows). The fetch promise is cached; ANY failure resolves to an empty
 * record set forever, with no logging — offline is a normal state for this
 * app, not an error.
 *
 * Scoring mirrors the docs sidebar's ladder (heading beats page title beats
 * body prose) through lib/search weights: heading 8, title 3, body 1 —
 * scoreHaystack's word-boundary doubling preserves the sidebar's extra
 * heading-prefix bonus.
 */
import { currentLang } from '../../../i18n.ts';
import { icon } from '../../icons.ts';
import { fold, scoreHaystack, type SearchField } from '../match.ts';
import type { SearchHit, SearchProvider } from '../registry.ts';

/** One /info page section, as docs/build.ts's indexSections writes it. Keys
 *  are short because the file ships once per locale and is fetched by readers:
 *  p=page slug, t=page title, h=heading ('' for the page intro), a=anchor
 *  ('' for the page intro), x=body snippet. */
interface DocsRecord { p: string; t: string; h: string; a: string; x: string }

/** A record with its haystack folded once at load, not per keystroke. */
interface PreparedRecord { rec: DocsRecord; fields: SearchField[] }

/** The docs scorer's field weights (heading > page title > body). */
const HEADING_WEIGHT = 8;
const TITLE_WEIGHT = 3;
const BODY_WEIGHT = 1;

export function createDocsProvider(): SearchProvider {
  // Cached across searches — settled once, kept forever (locale is fixed for
  // the session: switchLang reloads the whole app).
  let loaded: Promise<PreparedRecord[]> | null = null;

  const load = (): Promise<PreparedRecord[]> => {
    if (!loaded) {
      // English is unprefixed, every other locale lives under /info/<lang>/ —
      // mirrors the docs sidebar's data-search-base (and i18n.ts's docsHref).
      const lang = currentLang();
      const base = lang === 'en' ? '/info' : `/info/${lang}`;
      loaded = fetch(`${base}/search-index.json`)
        .then((r) => (r.ok ? (r.json() as Promise<DocsRecord[]>) : []))
        .then((records) =>
          (Array.isArray(records) ? records : []).map((rec): PreparedRecord => ({
            rec,
            fields: [
              { text: fold(String(rec.h ?? '')), weight: HEADING_WEIGHT },
              { text: fold(String(rec.t ?? '')), weight: TITLE_WEIGHT },
              { text: fold(String(rec.x ?? '')), weight: BODY_WEIGHT },
            ],
          })),
        )
        .catch(() => []); // offline/missing index → no docs group, forever, silently
    }
    return loaded;
  };

  return {
    id: 'docs',
    async search(tokens, limit): Promise<SearchHit[]> {
      if (!tokens.length) return [];
      const lang = currentLang();
      const base = lang === 'en' ? '/info' : `/info/${lang}`;
      const hits: SearchHit[] = [];
      for (const { rec, fields } of await load()) {
        const score = scoreHaystack(fields, tokens);
        if (score <= 0) continue;
        hits.push({
          icon: icon('help'),
          // A heading is the row (the sidebar shows the page title as context
          // only when there IS a heading); the page-intro record has none, so
          // the page title leads and needs no subtitle repeating it.
          title: rec.h || rec.t,
          ...(rec.h ? { subtitle: rec.t } : {}),
          // EXACTLY the sidebar's construction: base + '/' + p + '.html' +
          // ('#' + a when anchored) — the .html suffix is load-bearing (see
          // docsHref's note on /info/<lang>/ directory URLs 404ing in dev).
          href: `${base}/${rec.p}.html${rec.a ? `#${rec.a}` : ''}`,
          score,
        });
      }
      return hits.sort((a, b) => b.score - a.score).slice(0, limit);
    },
  };
}
