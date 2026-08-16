// SPDX-License-Identifier: MPL-2.0
/**
 * The Overview room - what it reads, what it shows, and where its doors go.
 *
 * Run directly:
 *   node --import ./tests/css-stub.mjs --test "shells/web/src/lib/design-system/rooms/overview.test.ts"
 *
 * jsdom supplies the DOM for the mount half. The host is a stub of the three
 * slices the room reads (tokens discovery, resolved swatches/doc, user assets),
 * which is also how the object-URL contract gets pinned: listLogos mints one per
 * slot for previews this room never renders, so every one must come back.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body><div id="room"></div></body></html>', {
  url: 'http://localhost/#/start',
});
globalThis.window = dom.window as unknown as typeof globalThis.window;
globalThis.document = dom.window.document;

/** Object URLs jsdom does not mint itself - recorded so the revoke can be asserted. */
const minted: string[] = [];
const revoked: string[] = [];
(globalThis.URL as unknown as { createObjectURL: (b: unknown) => string }).createObjectURL = () => {
  const url = `blob:test/${minted.length}`;
  minted.push(url);
  return url;
};
(globalThis.URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = (u) => { revoked.push(u); };

const { readOverview, overviewHtml, mountOverviewRoom } = await import('./overview.ts');
type OverviewHost = Parameters<typeof readOverview>[0];

interface StubOpts {
  installed?: boolean;
  /** Overrides `installed`: the exact id tokens discovery answers with, so a
   *  catalog pack's own asset can be distinguished from the starter placeholder. */
  tokensId?: string;
  colors?: string[];
  doc?: unknown;
  fonts?: Record<string, string>;
  assets?: Array<{ id: string; type?: string; blob?: unknown; meta?: Record<string, unknown> }>;
}

function stubHost(opts: StubOpts = {}): OverviewHost {
  return {
    assets: {
      _findMetaByType: async (type: string) =>
        (type === 'tokens'
          ? { id: opts.tokensId ?? (opts.installed ? 'user/tokens/brand' : 'lolly/tokens/brand') }
          : null),
      _exportUserAssets: async () => opts.assets ?? [],
    },
    tokens: {
      colors: async () => (opts.colors ?? []).map(value => ({ value })),
      raw: async () => opts.doc ?? null,
      resolve: async (key: string) => opts.fonts?.[key] ?? '',
    },
  } as unknown as OverviewHost;
}

/** A minimal DTCG doc with a known token count. */
const DOC = {
  color: {
    brand: { primary: { $type: 'color', $value: '#ff6600' }, secondary: { $type: 'color', $value: '#0060ff' } },
  },
};

const logoAsset = (variant: string) => ({
  id: `user/logo/${variant}`,
  type: 'image',
  blob: { size: 10 },
  meta: { format: 'svg' },
});

// ── readOverview ─────────────────────────────────────────────────────────────

test('an install with no design system of its own reads as empty', async () => {
  const model = await readOverview(stubHost({ installed: false, colors: ['#ff6600'] }));
  assert.equal(model.furnished, false);
  assert.deepEqual(model.colors, []);
  assert.equal(model.colorCount, 0);
  assert.equal(model.tokenCount, 0);
});

// A catalog pack (an ingested brand, or SUSE's) is resolved by bridge/tokens.ts
// whenever there is no user install, so its palette is what every room behind
// this one paints. Reading it as empty would put "Nothing here yet" over a
// design system that demonstrably exists.
test('an unlocked catalog pack is furnished, even with nothing installed here', async () => {
  const model = await readOverview(stubHost({
    tokensId: 'acme/tokens/brand', colors: ['#0057b8', '#ffffff'], doc: DOC,
  }));
  assert.equal(model.furnished, true);
  assert.deepEqual(model.colors, ['#0057b8', '#ffffff']);
  assert.equal(model.tokenCount, 2);
});

test('no tokens asset anywhere reads as empty', async () => {
  const model = await readOverview(stubHost({ tokensId: '', colors: ['#ff6600'] }));
  assert.equal(model.furnished, false);
  assert.deepEqual(model.colors, []);
});

test('a furnished system reports its palette, type, logos and token count', async () => {
  const model = await readOverview(stubHost({
    installed: true,
    colors: ['#ff6600', '#0060ff', '#111111'],
    doc: DOC,
    fonts: { '{font.brand}': 'Outfit', '{font.display}': 'Outfit', '{font.mono}': 'Space Mono' },
    assets: [logoAsset('horizontal-primary'), logoAsset('stacked-mono'), { id: 'user/uploads/photo', type: 'image' }],
  }));
  assert.equal(model.furnished, true);
  assert.deepEqual(model.colors, ['#ff6600', '#0060ff', '#111111']);
  assert.equal(model.colorCount, 3);
  // Distinct families in role order - Outfit fills two roles and is listed once.
  assert.deepEqual(model.fonts, ['Outfit', 'Space Mono']);
  assert.equal(model.logoCount, 2);
  assert.equal(model.tokenCount, 2);
});

test('the palette strip is capped, but the count is the whole palette', async () => {
  const colors = Array.from({ length: 30 }, (_, i) => `#0000${String(i % 10)}${String(i % 10)}`);
  const model = await readOverview(stubHost({ installed: true, colors }));
  assert.equal(model.colorCount, 30);
  assert.ok(model.colors.length < 30 && model.colors.length > 0, `strip capped, got ${model.colors.length}`);
});

test('every object URL listLogos minted for its previews is handed back', async () => {
  minted.length = 0;
  revoked.length = 0;
  await readOverview(stubHost({ installed: true, assets: [logoAsset('horizontal-primary'), logoAsset('icon')] }));
  assert.equal(minted.length, 2);
  assert.deepEqual(revoked, minted);
});

test('an unreadable tokens doc still yields the palette rather than throwing', async () => {
  const model = await readOverview(stubHost({ installed: true, colors: ['#ff6600'], doc: 'not a doc' }));
  assert.equal(model.furnished, true);
  assert.deepEqual(model.colors, ['#ff6600']);
});

// ── overviewHtml ─────────────────────────────────────────────────────────────

test('the empty state offers exactly two doors plus a quiet exit', () => {
  const html = overviewHtml({ furnished: false, colors: [], colorCount: 0, fonts: [], logoCount: 0, tokenCount: 0 });
  assert.equal([...html.matchAll(/data-ds-door="/g)].length, 2);
  assert.match(html, /data-ds-door="file"/);
  assert.match(html, /data-ds-door="scratch"/);
  assert.match(html, /href="#\/"/);
  // The website door arrives with M6, gated on a transport that works - a
  // disabled third door would advertise something nobody here can use.
  assert.equal(/disabled/.test(html), false, 'no disabled door may be rendered');
  assert.equal(/website/i.test(html), false, 'the website source must not appear before M6');
});

test('the empty state names no steps and no progress', () => {
  const html = overviewHtml({ furnished: false, colors: [], colorCount: 0, fonts: [], logoCount: 0, tokenCount: 0 });
  assert.equal(/\bstep\b/i.test(html), false);
  assert.equal(/progress/i.test(html), false);
});

test('the furnished state is one door per room, with counts', () => {
  const html = overviewHtml({
    furnished: true, colors: ['#ff6600', '#0060ff'], colorCount: 7,
    fonts: ['Outfit'], logoCount: 3, tokenCount: 42,
  });
  for (const area of ['color', 'type', 'logos', 'tokens', 'catalogue']) {
    assert.match(html, new RegExp(`data-ds-goto="${area}"`), `no door into ${area}`);
  }
  assert.match(html, /7 colours/);
  assert.match(html, /3 logos/);
  assert.match(html, /42 tokens/);
  assert.match(html, /Outfit/);
  assert.equal([...html.matchAll(/class="ds-ov-chip"/g)].length, 2);
});

test('singular and plural counts both read naturally', () => {
  const html = overviewHtml({
    furnished: true, colors: ['#ff6600'], colorCount: 1, fonts: [], logoCount: 1, tokenCount: 1,
  });
  assert.match(html, /1 colour(?!s)/);
  assert.match(html, /1 logo(?!s)/);
  assert.match(html, /1 token(?!s)/);
});

test('a hostile family name cannot break out of the card', () => {
  const html = overviewHtml({
    furnished: true, colors: ['"><script>x()</script>'], colorCount: 1,
    fonts: ['<img src=x onerror=alert(1)>'], logoCount: 0, tokenCount: 0,
  });
  assert.equal(/<script>/.test(html), false);
  assert.equal(/<img /.test(html), false);
  assert.match(html, /&lt;img/);
});

test('COPY: the room says design system, never brand, and owns nothing', () => {
  const shown = [
    overviewHtml(null),
    overviewHtml({ furnished: false, colors: [], colorCount: 0, fonts: [], logoCount: 0, tokenCount: 0 }),
    overviewHtml({ furnished: true, colors: ['#ff6600'], colorCount: 1, fonts: ['Outfit'], logoCount: 1, tokenCount: 1 }),
  ].join('\n');
  assert.equal(/\bbrand\b/i.test(shown), false, '"brand" is not this room\'s word (plan 97 section 3)');
  assert.equal(/\byour\b/i.test(shown), false, 'no possessives on the material');
  assert.equal(shown.includes('—'), false, 'no em-dashes in user-facing copy');
});

// ── mountOverviewRoom ────────────────────────────────────────────────────────

/** Let the room's async read land (several awaits deep, so turn the loop). */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0));
};

function mountInto(opts: StubOpts): {
  el: HTMLElement;
  room: ReturnType<typeof mountOverviewRoom>;
  gone: string[];
  imports: number;
  paletteSubs: number;
} {
  const el = document.getElementById('room') as HTMLElement;
  el.innerHTML = '';
  el.hidden = false;
  const gone: string[] = [];
  const counts = { imports: 0, paletteSubs: 0 };
  const room = mountOverviewRoom(el, {
    host: stubHost(opts),
    editor: () => ({
      onPalette: () => { counts.paletteSubs++; return () => { counts.paletteSubs--; }; },
    } as unknown as ReturnType<Parameters<typeof mountOverviewRoom>[1]['editor']>),
    goto: (area) => gone.push(area),
    openImport: () => { counts.imports++; },
  });
  return {
    el, room, gone,
    get imports() { return counts.imports; },
    get paletteSubs() { return counts.paletteSubs; },
  };
}

test('mount paints the empty state and its doors are wired', async () => {
  const m = mountInto({ installed: false });
  await settle();
  assert.match(m.el.innerHTML, /ds-ov--empty/);
  m.el.querySelector<HTMLElement>('[data-ds-door="file"]')!.click();
  assert.equal(m.imports, 1);
  m.el.querySelector<HTMLElement>('[data-ds-door="scratch"]')!.click();
  assert.deepEqual(m.gone, ['color']);
  m.room.teardown();
});

test('mount paints the furnished state and every card opens its room', async () => {
  const m = mountInto({ installed: true, colors: ['#ff6600'], doc: DOC, assets: [logoAsset('icon')] });
  await settle();
  const cards = [...m.el.querySelectorAll<HTMLElement>('[data-ds-goto]')];
  assert.ok(cards.length >= 5, `expected a card per room, got ${cards.length}`);
  for (const card of cards) card.click();
  assert.deepEqual(m.gone, cards.map(c => c.dataset.dsGoto));
  m.room.teardown();
});

test('teardown unsubscribes from the palette feed and stops the doors', async () => {
  const m = mountInto({ installed: false });
  await settle();
  assert.equal(m.paletteSubs, 1);
  m.room.teardown();
  assert.equal(m.paletteSubs, 0);
  m.el.querySelector<HTMLElement>('[data-ds-door="file"]')?.click();
  assert.equal(m.imports, 0, 'a torn-down room must not still open the source modal');
});

test('a detached room never repaints (the view moved on mid-read)', async () => {
  const el = document.createElement('div'); // never appended - isConnected is false
  const room = mountOverviewRoom(el, {
    host: stubHost({ installed: true, colors: ['#ff6600'] }),
    editor: () => null,
    goto: () => {},
    openImport: () => {},
  });
  await settle();
  assert.match(el.innerHTML, /ds-ov-loading/, 'the resting line stands; no repaint into a detached node');
  room.teardown();
});
