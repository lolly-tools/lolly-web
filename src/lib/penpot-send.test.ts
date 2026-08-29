// SPDX-License-Identifier: MPL-2.0
/**
 * Penpot send target (plans/173) - custody of the PAT (the Mastodon shape:
 * session-only default, at rest only by explicit choice) and the send flow
 * (first send creates the "From Lolly" file and remembers it; later sends
 * reuse it). Headless: connections ride provider-connections' memory-only
 * mode, the network is a stubbed global fetch - the same rig as
 * publish-send.test.ts.
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { connectPenpot, disconnectPenpot, testPenpot, penpotSendTarget } from './penpot-send.ts';
import { cachedToken, getConnection, hasConnection, resetConnectionsForTests } from './provider-connections.ts';

const realFetch = globalThis.fetch;

beforeEach(() => resetConnectionsForTests());
afterEach(() => {
  resetConnectionsForTests();
  globalThis.fetch = realFetch;
});

/** One canned JSON response per URL-substring, recorded as it is served. */
function stubFetch(routes: Array<{ match: string; status?: number; json?: unknown }>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const route = routes.find(r => url.includes(r.match));
    if (!route) return new Response('not stubbed', { status: 500 });
    return new Response(JSON.stringify(route.json ?? {}), {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return calls;
}

const PROJECT = { id: 'p1', name: 'Brand kit' };
const PAYLOAD = { bytes: new Uint8Array([1, 2, 3]), name: 'poster.png', format: 'png', mime: 'image/png' };

// ── Custody ──────────────────────────────────────────────────────────────────

test('session-only custody keeps the PAT out of the record; persist writes it in', async () => {
  await connectPenpot(false, 'pat-secret', PROJECT);
  assert.ok(hasConnection('penpot'));
  let conn = await getConnection('penpot');
  assert.equal(conn?.persist, false);
  assert.equal(conn?.config?.token, undefined, 'session-only record is tokenless');
  assert.equal(conn?.config?.projectId, 'p1');
  assert.equal(cachedToken('penpot'), 'pat-secret', 'the token lives in the memory cache');
  assert.match(conn?.account ?? '', /design\.penpot\.app.*Brand kit/);

  await connectPenpot(true, 'pat-secret', PROJECT);
  conn = await getConnection('penpot');
  assert.equal(conn?.persist, true);
  assert.equal(conn?.config?.token, 'pat-secret', 'persist is the explicit choice that stores it');

  await disconnectPenpot();
  assert.ok(!hasConnection('penpot'));
  assert.equal(cachedToken('penpot'), null, 'disconnect drops the cached token too');
});

// ── The connect probe ────────────────────────────────────────────────────────

test('testPenpot: lists projects for the picker; an empty list is an honest failure', async () => {
  stubFetch([{ match: 'get-all-projects', json: [{ id: 'p1', name: 'Brand kit' }] }]);
  const ok = await testPenpot('pat');
  assert.ok(ok.ok);
  assert.deepEqual(ok.projects, [PROJECT]);

  stubFetch([{ match: 'get-all-projects', json: [] }]);
  const empty = await testPenpot('pat');
  assert.ok(!empty.ok);
  assert.match(empty.note, /no projects/);

  stubFetch([{ match: 'get-all-projects', status: 401 }]);
  const bad = await testPenpot('pat');
  assert.ok(!bad.ok);
  assert.match(bad.note, /401/);
});

// ── The send flow ────────────────────────────────────────────────────────────

test('first send creates the From Lolly file, uploads into it, and remembers the file id', async () => {
  await connectPenpot(false, 'pat', PROJECT);
  const calls = stubFetch([
    { match: 'create-file', json: { id: 'f9', name: 'From Lolly' } },
    { match: 'upload-file-media-object', json: { id: 'm1', name: 'poster.png' } },
  ]);
  const target = penpotSendTarget();
  assert.ok(target.available());
  const out = await target.send(PAYLOAD);
  assert.match(out.label, /Brand kit/);
  assert.deepEqual(JSON.parse(String(calls[0]!.init?.body)), { name: 'From Lolly', projectId: 'p1' });
  const form = calls[1]!.init?.body as FormData;
  assert.ok(form instanceof FormData);
  assert.equal(form.get('file-id'), 'f9');
  assert.equal(form.get('is-local'), 'false');
  assert.equal((await getConnection('penpot'))?.config?.fileId, 'f9', 'remembered on the connection');

  // Second send: no create-file, straight to the upload.
  const again = stubFetch([{ match: 'upload-file-media-object', json: { id: 'm2', name: 'poster.png' } }]);
  await penpotSendTarget().send(PAYLOAD);
  assert.equal(again.length, 1);
  assert.ok(again[0]!.url.includes('upload-file-media-object'));
});

test('a rejected token reads as connect-again, not a raw status', async () => {
  await connectPenpot(false, 'pat', PROJECT);
  stubFetch([{ match: 'create-file', status: 401 }]);
  await assert.rejects(() => penpotSendTarget().send(PAYLOAD), /connect again in Profile/);
});

test('sending with no connection is refused before any network', async () => {
  const calls = stubFetch([]);
  await assert.rejects(() => penpotSendTarget().send(PAYLOAD), /Connect Penpot in Profile first/);
  assert.equal(calls.length, 0);
});

test('formats stay what the media library accepts - images and svg, no pdf', () => {
  const formats = penpotSendTarget().formats!;
  assert.ok(formats.includes('png'));
  assert.ok(formats.includes('svg'));
  assert.ok(!formats.includes('pdf'));
});
