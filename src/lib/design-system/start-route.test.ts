// SPDX-License-Identifier: MPL-2.0
/**
 * start-route.ts - the #/start deep-link table.
 *
 * Run directly:
 *   node --import ./tests/css-stub.mjs --test "shells/web/src/lib/design-system/start-route.test.ts"
 *
 * The back-compatibility half is the point: every `?tab=` link ever generated
 * (the dashboard's "Manage fonts", the docs, bookmarks) must keep opening the
 * room it named, and `?import=0` must keep meaning "leave it shut". Those are
 * promises to links that already exist, so they are pinned case by case rather
 * than left to the structure of the implementation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveStartRoute, isStartArea, START_AREAS, START_ROOMS, DEFAULT_AREA, START_SOURCES } from './start-route.ts';

test('nothing asked for lands on Overview with nothing open', () => {
  const r = resolveStartRoute('');
  assert.equal(r.area, 'overview');
  assert.equal(r.wheel, false);
  assert.equal(r.importOpen, false);
  assert.equal(DEFAULT_AREA, 'overview');
});

test('every room is addressable by ?area=', () => {
  for (const area of START_AREAS) {
    assert.equal(resolveStartRoute(`area=${area}`).area, area, `?area=${area}`);
  }
});

test('LEGACY: ?tab= opens the same rooms', () => {
  for (const area of START_AREAS) {
    assert.equal(resolveStartRoute(`tab=${area}`).area, area, `?tab=${area}`);
  }
});

test('LEGACY: #/start?tab=type — the dashboard "Manage fonts" link', () => {
  assert.deepEqual(resolveStartRoute('tab=type'), { area: 'type', wheel: false, importOpen: false, focus: null, source: null });
});

test('LEGACY: #/start?tab=color&wheel opens the colour room with the chart flag', () => {
  assert.deepEqual(resolveStartRoute('tab=color&wheel'), { area: 'color', wheel: true, importOpen: false, focus: null, source: null });
});

test('LEGACY: ?wheel is presence, not value — ?wheel=0 has always meant open', () => {
  assert.equal(resolveStartRoute('area=color&wheel=0').wheel, true);
  assert.equal(resolveStartRoute('area=color').wheel, false);
});

test('LEGACY: #/start?import opens the source modal, ?import=0 leaves it shut', () => {
  assert.equal(resolveStartRoute('import').importOpen, true);
  assert.equal(resolveStartRoute('import=1').importOpen, true);
  assert.equal(resolveStartRoute('import=').importOpen, true);
  assert.equal(resolveStartRoute('import=0').importOpen, false);
});

test('?import carries its own area — it does not force one', () => {
  assert.equal(resolveStartRoute('import').area, 'overview');
  assert.equal(resolveStartRoute('area=logos&import').area, 'logos');
});

test('?area= wins over ?tab= when both are given and both resolve', () => {
  assert.equal(resolveStartRoute('area=type&tab=color').area, 'type');
});

test('an unrecognised ?area= falls through to ?tab= rather than dead-ending', () => {
  assert.equal(resolveStartRoute('area=typo&tab=type').area, 'type');
});

test('an unrecognised room name resolves to Overview', () => {
  assert.equal(resolveStartRoute('area=nope').area, 'overview');
  assert.equal(resolveStartRoute('tab=nope').area, 'overview');
  assert.equal(resolveStartRoute('area=nope&tab=alsonope').area, 'overview');
});

test('room names are exact — a cased or padded value is not a room', () => {
  assert.equal(resolveStartRoute('area=COLOR').area, 'overview');
  assert.equal(resolveStartRoute('area=%20color').area, 'overview');
});

test('an inherited object key is never mistaken for a room', () => {
  for (const key of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    assert.equal(resolveStartRoute(`area=${key}`).area, 'overview', `?area=${key}`);
    assert.equal(isStartArea(key), false, key);
  }
});

test('a leading ? is tolerated (a caller passing the raw search string)', () => {
  assert.deepEqual(resolveStartRoute('?area=color&wheel'), { area: 'color', wheel: true, importOpen: false, focus: null, source: null });
});

test('unknown params are ignored, not fatal', () => {
  assert.deepEqual(
    resolveStartRoute('area=tokens&utm_source=x&swatch=jungle-500'),
    { area: 'tokens', wheel: false, importOpen: false, focus: null, source: null },
  );
});

test('isStartArea guards null and empty', () => {
  assert.equal(isStartArea(null), false);
  assert.equal(isStartArea(undefined), false);
  assert.equal(isStartArea(''), false);
  assert.equal(isStartArea('overview'), true);
});

test('?focus= opens a named wing of the colour room (plan 97 SS5)', () => {
  for (const f of ['generate', 'curves', 'contrast', 'print', 'chart']) {
    assert.equal(resolveStartRoute(`area=color&focus=${f}`).focus, f, `?focus=${f}`);
  }
});

test('an unrecognised ?focus= is null, never a passthrough', () => {
  assert.equal(resolveStartRoute('area=color&focus=nope').focus, null);
  assert.equal(resolveStartRoute('area=color&focus=CURVES').focus, null);
  assert.equal(resolveStartRoute('area=color').focus, null);
  for (const key of ['constructor', '__proto__', 'toString']) {
    assert.equal(resolveStartRoute(`area=color&focus=${key}`).focus, null, `?focus=${key}`);
  }
});

test('?source= names the source the picker opens on, and implies the picker (plan 97 SS8)', () => {
  for (const src of ['file', 'image', 'font']) {
    const r = resolveStartRoute(`source=${src}`);
    assert.equal(r.source, src, `?source=${src}`);
    assert.equal(r.importOpen, true, `?source=${src} opens the picker`);
  }
});

test('?source=pdf and ?source=url resolve now and open the plain picker (M5/M6 give them tiles)', () => {
  for (const src of ['pdf', 'url']) {
    const r = resolveStartRoute(`source=${src}`);
    assert.equal(r.source, src, `?source=${src}`);
    assert.equal(r.importOpen, true, `?source=${src}`);
  }
  // Every declared source resolves - the table and the constant cannot drift.
  for (const src of START_SOURCES) assert.equal(resolveStartRoute(`source=${src}`).source, src, src);
});

test('an unknown ?source= is null and opens NOTHING — it falls through like an unknown ?area=', () => {
  const r = resolveStartRoute('source=zzz');
  assert.equal(r.source, null);
  assert.equal(r.importOpen, false);
  assert.equal(resolveStartRoute('source=FILE').source, null); // exact, never cased
  assert.equal(resolveStartRoute('source=%20file').source, null);
  for (const key of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    assert.equal(resolveStartRoute(`source=${key}`).source, null, `?source=${key}`);
    assert.equal(resolveStartRoute(`source=${key}`).importOpen, false, `?source=${key}`);
  }
});

test('LEGACY: ?import=0 still wins over a named source', () => {
  const r = resolveStartRoute('import=0&source=file');
  assert.equal(r.importOpen, false);
  assert.equal(r.source, 'file'); // resolved, just not opened - the view reads both
});

test('?import alone opens the picker with no source named', () => {
  const r = resolveStartRoute('import');
  assert.equal(r.importOpen, true);
  assert.equal(r.source, null);
});

test('?source rides a room param and does not move the room', () => {
  const r = resolveStartRoute('area=logos&source=image');
  assert.equal(r.area, 'logos');
  assert.equal(r.source, 'image');
  assert.equal(r.importOpen, true);
});

test('#/start?area=versions opens the Versions panel (plan 97 SS5 / SS6a)', () => {
  assert.deepEqual(
    resolveStartRoute('area=versions'),
    { area: 'versions', wheel: false, importOpen: false, focus: null, source: null },
  );
  // The kept alias reaches it too: one resolution table, no second rule.
  assert.equal(resolveStartRoute('tab=versions').area, 'versions');
  assert.equal(isStartArea('versions'), true);
});

test('the rail rooms are the areas minus the foot-pinned panels', () => {
  // START_ROOMS is what the sidebar renders; START_AREAS is what a link may ask
  // for. Every room is an area, and `versions` is the one area that is not a
  // room - if either half drifts, this says which way.
  for (const room of START_ROOMS) assert.ok((START_AREAS as readonly string[]).includes(room), room);
  assert.deepEqual(
    (START_AREAS as readonly string[]).filter(a => !(START_ROOMS as readonly string[]).includes(a)),
    ['versions'],
  );
});

test('?focus rides any room param form and coexists with ?wheel', () => {
  assert.equal(resolveStartRoute('tab=color&focus=generate').focus, 'generate');
  const both = resolveStartRoute('area=color&wheel&focus=curves');
  assert.equal(both.wheel, true);
  assert.equal(both.focus, 'curves');
});

test('the Versions entry is a LATCH, so ?area=versions is not a one-way door', async () => {
  // Not a route fact, but the other half of the same promise: the panel's own
  // empty state says "add colours first, then come back", and selectRoom
  // replaceStates the URL, so Back cannot recover it either. Hiding the entry the
  // moment another room opens leaves retyping the link as the only way home.
  //
  // A source guard rather than a mount: views/start.ts has no DOM test yet (plan
  // 97 §16 lists one as still owed) and standing the whole studio up for three
  // lines of state would be the wrong trade. Replace this the day that test lands.
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../../views/start.ts', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('const syncVersionsEntry'), src.indexOf('let openVersions'));
  assert.match(fn, /activeArea === 'versions'\)\s*versionsOffered = true/,
    'arriving at the panel has to latch the entry on');
  assert.match(fn, /versionsBtn\.hidden = !versionsOffered/,
    'and visibility reads the latch alone, not the current area');
  assert.match(src, /versionsOffered \|\|= offered/,
    'the late hasPublishableSystem answer must not take the entry away again');
});
