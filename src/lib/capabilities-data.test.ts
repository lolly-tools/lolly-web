// SPDX-License-Identifier: MPL-2.0
/**
 * Invariants for the Capabilities map (lib/capabilities-data.ts).
 *
 * Two jobs.
 *
 * 1. The DATA SHAPE the Dashboard's Capabilities panel and its search rely on.
 *    The panel escapes titles and feature names but renders `desc` RAW, so the
 *    inline HTML authored there is a trusted-by-review surface — these tests are
 *    that review, mechanised: the tag allowlist, balance, and the rule that an
 *    external link carries rel="noopener".
 *
 * 2. The FACTUAL claims that cite a number sourced from somewhere else in the
 *    repo. A capability page whose counts have quietly gone stale is worse than
 *    one that never claimed a count, so the count in the prose is asserted
 *    against the thing it counts. Those checks import across the workspace
 *    boundary (engine/, schemas/) and are SKIPPED — loudly — where that import
 *    cannot resolve, e.g. inside a git worktree, whose depth breaks the
 *    relative path. They run in a normal checkout and in CI, which is where a
 *    stale number would otherwise reach a reader.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { CAPABILITY_SECTIONS } from './capabilities-data.ts';

/** Just enough of tool.schema.json's shape to read the export-format enum. */
type SchemaShape = { properties?: { render?: { properties?: { formats?: { items?: { enum?: string[] } } } } } };

const allCards = CAPABILITY_SECTIONS.flatMap((s) => s.cards);
const allFeatures = allCards.flatMap((c) => c.features);
/** Every rendered string on the page, joined — for "is this claim present" checks. */
const allProse = allFeatures.map((f) => `${f.name} ${f.desc}`).join('\n')
  + CAPABILITY_SECTIONS.map((s) => `\n${s.title} ${s.desc}`).join('');

test('sections and cards are structurally sound', () => {
  assert.ok(CAPABILITY_SECTIONS.length >= 8, 'the map should not have collapsed to a stub');
  for (const s of CAPABILITY_SECTIONS) {
    assert.ok(s.title.trim(), `section ${s.id} needs a title`);
    assert.ok(s.desc.trim(), `section ${s.id} needs a description`);
    assert.ok(s.icon.startsWith('<svg'), `section ${s.id} needs an icon`);
    assert.ok(s.flag.trim(), `section ${s.id} needs a deep-link flag`);
    assert.ok(s.cards.length > 0, `section ${s.id} has no cards`);
    for (const c of s.cards) {
      assert.ok(c.title.trim(), `a card in ${s.id} has no title`);
      assert.ok(c.icon.startsWith('<svg'), `card "${c.title}" has no icon`);
      // A card with no features renders a "0" count badge and pops an empty
      // dialog — the one shape the panel has no sensible rendering for.
      assert.ok(c.features.length > 0, `card "${c.title}" has no features`);
      for (const f of c.features) {
        assert.ok(f.name.trim(), `a feature in "${c.title}" has no name`);
        assert.ok(f.desc.trim(), `feature "${f.name}" has no description`);
      }
    }
  }
});

test('ids and deep-link flags are unique', () => {
  const ids = CAPABILITY_SECTIONS.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate section id — a deep link would jump to whichever came first');
  // A flag is a space-separated list of deep-link keys (#/d?print). Two sections
  // claiming one key makes that link ambiguous.
  const flags = CAPABILITY_SECTIONS.flatMap((s) => s.flag.split(/\s+/).filter(Boolean));
  assert.equal(new Set(flags).size, flags.length, `duplicate deep-link flag among: ${flags.join(', ')}`);
});

test('card titles are unique — the search result list shows titles alone', () => {
  const titles = allCards.map((c) => c.title);
  const dupes = titles.filter((x, i) => titles.indexOf(x) !== i);
  assert.deepEqual(dupes, [], `two cards share a title, so a search hit is ambiguous: ${dupes.join(', ')}`);
});

test('desc inline HTML sticks to the reviewed tag allowlist', () => {
  // The panel renders `desc` raw. Anything outside this set is either a styling
  // escalation or a script vector, and should be a deliberate decision made in
  // this test rather than a quiet addition in the data.
  const ALLOWED = new Set(['code', 'strong', 'em', 'a', 'br']);
  for (const f of allFeatures) {
    for (const [, tag] of f.desc.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)/g)) {
      assert.ok(ALLOWED.has(tag.toLowerCase()), `feature "${f.name}" uses <${tag}>, which is not on the allowlist`);
    }
    // Only inside an attribute. The copy legitimately *names* `javascript:` as
    // prose (the SVG-import card, describing what sanitising strips), and a
    // blanket match would forbid the page from discussing its own sanitiser.
    for (const [, url] of f.desc.matchAll(/\b(?:href|src)="([^"]*)"/gi)) {
      assert.doesNotMatch(url!, /^\s*javascript:/i, `feature "${f.name}" carries a javascript: URL`);
    }
  }
});

test('desc tags are balanced — an unclosed tag would swallow the rest of the dialog', () => {
  for (const f of allFeatures) {
    const open = [...f.desc.matchAll(/<([a-zA-Z][a-zA-Z0-9]*)(?![^>]*\/>)[^>]*>/g)].map((m) => m[1]!.toLowerCase()).filter((tg) => tg !== 'br');
    const close = [...f.desc.matchAll(/<\/([a-zA-Z][a-zA-Z0-9]*)>/g)].map((m) => m[1]!.toLowerCase());
    assert.deepEqual(open.sort(), close.sort(), `feature "${f.name}" has unbalanced inline HTML`);
  }
});

test('external links open safely; in-app links stay in-app', () => {
  for (const f of allFeatures) {
    for (const [tagHtml, href] of f.desc.matchAll(/<a\b([^>]*)href="([^"]+)"/g).map((m) => [m[0]!, m[2]!] as const)) {
      if (href.startsWith('#/')) continue;                    // an in-app route
      assert.ok(href.startsWith('https://'), `feature "${f.name}" links to a non-https URL: ${href}`);
      const attrs = tagHtml + f.desc.slice(f.desc.indexOf(tagHtml));
      const tag = attrs.slice(0, attrs.indexOf('>') + 1);
      if (tag.includes('target="_blank"')) {
        assert.match(tag, /rel="[^"]*noopener/, `feature "${f.name}" opens ${href} in a new tab without rel="noopener"`);
      }
    }
  }
});

test('every card carries search keywords', () => {
  // Search is the primary way into a ~60-card map, and the visible copy alone
  // misses the words people actually type (a card can describe CMYK output
  // without the word "prepress"). A card with no keywords is reachable only by
  // the phrasing its author happened to choose.
  const bare = allCards.filter((c) => !c.keywords?.trim()).map((c) => c.title);
  assert.deepEqual(bare, [], `cards missing keywords: ${bare.join(', ')}`);
  for (const c of allCards) {
    assert.equal(c.keywords, c.keywords!.toLowerCase(), `keywords for "${c.title}" must be lowercase — the filter lowercases the query, not the haystack`);
  }
});

test('every card screenshot resolves to a committed file', () => {
  // A `shot` slug becomes /info/shots/<slug>.svg in the detail dialog. Those
  // files are committed baselines (scripts/build-docs-shots.ts), so a typo or a
  // retired slug is a broken image inside a dialog — invisible until someone
  // opens that one card. This is the check that makes the mapping safe to grow.
  const dir = new URL('../../public/info/shots/', import.meta.url);
  const missing = allCards
    .filter((c) => c.shot && !existsSync(new URL(`${c.shot}.svg`, dir)))
    .map((c) => `${c.title} → ${c.shot}.svg`);
  assert.deepEqual(missing, [], `card screenshots that do not exist: ${missing.join(', ')}`);
});

test('a card`s `shot` is the base slug, never a variant suffix', () => {
  // `shot` names the base slug; the dialog derives the theme variant itself by
  // appending `.dark` under a dark/brand theme (views/dashboard.ts). A slug that
  // already carried `.dark` or a locale would be doubled into a 404.
  for (const c of allCards) {
    if (!c.shot) continue;
    assert.doesNotMatch(c.shot, /\.(dark|svg|png|jpg)$/, `card "${c.title}" — \`shot\` must be the bare slug, not "${c.shot}"`);
  }
});

// Shots whose recipe is light-only ON PURPOSE — no `dark=1`, so no dark twin
// exists and the dialog falls back to the light capture under a dark theme.
// Keep this list tiny and reasoned: an entry is a promise that the shot has no
// chrome worth theming (auth-url-render is a bare, chromeless tool canvas).
const LIGHT_ONLY_SHOTS = new Set(['auth-url-render']);

test('every card shot has a committed dark twin, or is a documented light-only shot', () => {
  // The dialog prefers `<slug>.dark.svg` in dark/brand themes. A referenced slug
  // that silently lacks a dark twin would fall back to a LIGHT capture on a dark
  // pad — visually wrong and easy to miss. So every referenced slug must EITHER
  // have a committed dark twin OR be an intentional entry in LIGHT_ONLY_SHOTS.
  const dir = new URL('../../public/info/shots/', import.meta.url);
  const problems: string[] = [];
  for (const c of allCards) {
    if (!c.shot) continue;
    const hasDark = existsSync(new URL(`${c.shot}.dark.svg`, dir));
    const allowed = LIGHT_ONLY_SHOTS.has(c.shot);
    if (!hasDark && !allowed) problems.push(`${c.title} → ${c.shot} (no dark twin, not in LIGHT_ONLY_SHOTS)`);
    if (hasDark && allowed) problems.push(`${c.title} → ${c.shot} (in LIGHT_ONLY_SHOTS but a dark twin exists — drop it from the list)`);
  }
  assert.deepEqual(problems, [], `dark-twin coverage: ${problems.join('; ')}`);
});

test('the search haystack survives tag-stripping', () => {
  // capCard() strips tags out of the haystack so a query for "code" doesn't hit
  // every <code> element. Guard the consequence: a term that exists ONLY inside
  // a tag's attributes (a URL, say) must not be searchable, and the visible
  // words around it must survive.
  const strip = (s: string): string => s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').toLowerCase();
  const withLink = allFeatures.find((f) => f.desc.includes('href="https://c2pa.org"'));
  assert.ok(withLink, 'expected at least one external link in the copy');
  const hay = strip(withLink.desc);
  assert.ok(!hay.includes('href'), 'attribute names leaked into the searchable text');
  assert.ok(hay.includes('c2pa'), 'the visible link text should stay searchable');
});

// ── Factual claims checked against their source ─────────────────────────────
// Skipped where the cross-workspace import cannot resolve (see the file header).
const engineReach = await (async () => {
  try {
    const [urlMode, schema] = await Promise.all([
      import('../../../../engine/src/url-mode.ts'),
      import('../../../../schemas/tool.schema.json', { with: { type: 'json' } }),
    ]);
    return { urlMode, schema } as { urlMode: { RESERVED: Set<string> }; schema: { default: unknown } };
  } catch {
    return null;
  }
})();

test('the reserved-parameter count in the copy matches the engine', { skip: engineReach ? false : 'engine/ not reachable from here (worktree or partial checkout)' }, () => {
  const actual = engineReach!.urlMode.RESERVED.size;
  assert.match(allProse, new RegExp(`${actual} reserved controls`),
    `the copy cites a different number of reserved URL params than engine/src/url-mode.ts has (${actual}) — update the "N reserved controls" line in capabilities-data.ts`);
});

test('every reserved param named in the copy is really reserved', { skip: engineReach ? false : 'engine/ not reachable from here (worktree or partial checkout)' }, () => {
  // The URL-mode card lists the reserved names in <code> spans. A name that has
  // since been renamed or dropped would send a reader down a dead end.
  const card = allCards.find((c) => c.title === 'URL mode');
  assert.ok(card, 'the URL mode card should exist');
  const listed = card.features.flatMap((f) => [...f.desc.matchAll(/<code>([a-z_]+)<\/code>/g)].map((m) => m[1]!));
  assert.ok(listed.length > 10, 'expected the reserved params to be listed');
  for (const name of listed) {
    assert.ok(engineReach!.urlMode.RESERVED.has(name), `the copy lists "${name}" as a reserved param, but the engine does not reserve it`);
  }
});

test('the export-format count in the copy matches the schema', { skip: engineReach ? false : 'schemas/ not reachable from here (worktree or partial checkout)' }, () => {
  // Read the enum at its real path rather than regex-counting quotes — the
  // first draft of this test did the latter and was off by one, i.e. it would
  // have "caught" a copy line that was in fact correct.
  const root = (engineReach!.schema as { default?: unknown }).default ?? engineReach!.schema;
  const enumList = (root as SchemaShape)?.properties?.render?.properties?.formats?.items?.enum;
  assert.ok(Array.isArray(enumList), 'could not locate render.formats.items.enum in tool.schema.json');
  assert.match(allProse, new RegExp(`${enumList.length} format ids`),
    `the copy cites a different number of export formats than schemas/tool.schema.json declares (${enumList.length})`);
});
