// SPDX-License-Identifier: MPL-2.0
/**
 * penpot-api (plans/173) - the pure RPC client, against a recording stub
 * fetch: URLs, the Token auth header, the proven multipart upload shape, the
 * narrow result typing, and error propagation. No network, no DOM.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makePenpotClient, PENPOT_PROXY_BASE } from './penpot-api.ts';

/** A recording fetch: every call captured, one canned JSON answer per call. */
function stub(responses: Array<{ status?: number; json?: unknown }>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let i = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const r = responses[Math.min(i++, responses.length - 1)] ?? {};
    return new Response(JSON.stringify(r.json ?? {}), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const headers = (init?: RequestInit): Record<string, string> => (init?.headers ?? {}) as Record<string, string>;

test('listProjects: POSTs empty JSON to the proxy with the Token header, narrows to id/name', async () => {
  const { calls, fetchImpl } = stub([{
    json: [
      { id: 'p1', name: 'Brand', 'team-id': 't1', extra: 42 },
      { id: 'p2', name: 'Web' },
      { id: 123, name: 'malformed - dropped' },
      null,
    ],
  }]);
  const projects = await makePenpotClient({ token: 'pat-1', fetchImpl }).listProjects();
  assert.deepEqual(projects, [{ id: 'p1', name: 'Brand' }, { id: 'p2', name: 'Web' }]);
  const call = calls[0]!;
  assert.equal(call.url, `${PENPOT_PROXY_BASE}/get-all-projects`);
  assert.equal(call.init?.method, 'POST');
  assert.equal(headers(call.init).Authorization, 'Token pat-1');
  assert.equal(headers(call.init)['Content-Type'], 'application/json');
  assert.equal(String(call.init?.body), '{}');
});

test('a custom base is honoured, trailing slash trimmed', async () => {
  const { calls, fetchImpl } = stub([{ json: [] }]);
  const projects = await makePenpotClient({ base: 'https://pen.example/rpc/', token: 't', fetchImpl }).listProjects();
  assert.deepEqual(projects, []);
  assert.equal(calls[0]!.url, 'https://pen.example/rpc/get-all-projects');
});

test('createFile: sends name + projectId, returns the narrow file', async () => {
  const { calls, fetchImpl } = stub([{ json: { id: 'f1', name: 'From Lolly', 'project-id': 'p1' } }]);
  const file = await makePenpotClient({ token: 't', fetchImpl }).createFile('From Lolly', 'p1');
  assert.deepEqual(file, { id: 'f1', name: 'From Lolly' });
  assert.equal(calls[0]!.url, `${PENPOT_PROXY_BASE}/create-file`);
  assert.deepEqual(JSON.parse(String(calls[0]!.init?.body)), { name: 'From Lolly', projectId: 'p1' });
});

test('createFile: a response with no id is refused', async () => {
  const { fetchImpl } = stub([{ json: { name: 'no id here' } }]);
  await assert.rejects(
    () => makePenpotClient({ token: 't', fetchImpl }).createFile('x', 'p1'),
    /no file id/);
});

test('uploadMedia: multipart with the proven field set, no JSON content type', async () => {
  const { calls, fetchImpl } = stub([{ json: { id: 'm1', name: 'poster.png' } }]);
  const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
  const media = await makePenpotClient({ token: 'pat-2', fetchImpl }).uploadMedia('f1', 'poster.png', blob);
  assert.deepEqual(media, { id: 'm1', name: 'poster.png' });
  const call = calls[0]!;
  assert.equal(call.url, `${PENPOT_PROXY_BASE}/upload-file-media-object`);
  assert.equal(headers(call.init).Authorization, 'Token pat-2');
  assert.equal(headers(call.init)['Content-Type'], undefined, 'FormData must set its own boundary');
  const form = call.init?.body as FormData;
  assert.ok(form instanceof FormData);
  assert.match(String(form.get('id')), /^[0-9a-f-]{36}$/, 'a fresh client-side uuid');
  assert.equal(form.get('file-id'), 'f1');
  assert.equal(form.get('name'), 'poster.png');
  assert.equal(form.get('is-local'), 'false');
  const content = form.get('content');
  assert.ok(content instanceof Blob);
  assert.equal((content as File).name, 'poster.png');
});

test('errors carry the command and status, and propagate', async () => {
  const { fetchImpl } = stub([{ status: 401 }]);
  await assert.rejects(
    () => makePenpotClient({ token: 'bad', fetchImpl }).listProjects(),
    /get-all-projects failed \(401\)/);
  const boom = (async () => { throw new Error('socket hangup'); }) as unknown as typeof fetch;
  await assert.rejects(
    () => makePenpotClient({ token: 't', fetchImpl: boom }).createFile('x', 'p'),
    /socket hangup/);
});
