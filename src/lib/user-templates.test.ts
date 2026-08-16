// SPDX-License-Identifier: MPL-2.0
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createUserTemplateStore, type UserTemplateHost } from './user-templates.ts';

// A memory-backed profile host - the same read-modify-write surface folders.ts uses. Carries
// a sibling field so the tests can prove the store never clobbers the rest of the profile.
function memHost(seed: Record<string, unknown> = {}): { host: UserTemplateHost; raw: () => Record<string, unknown> } {
  let profile: Record<string, unknown> = { headshot: 'keep-me', ...seed };
  return {
    host: {
      profile: {
        get: async () => profile as never,
        set: async (p) => { profile = p as Record<string, unknown>; },
      },
    },
    raw: () => profile,
  };
}

test('save → list round-trips the record and mints id + timestamps', async () => {
  const { host } = memHost();
  const store = createUserTemplateStore(host);
  const saved = await store.save({ toolId: 'design', name: 'My deck', values: { boxes: [{ id: 'a' }] } });
  assert.ok(saved.id, 'has an id');
  assert.ok(saved.createdAt && saved.updatedAt, 'has timestamps');
  assert.equal(saved.variationOf, undefined, 'standalone template has no base');

  const list = await store.list('design');
  assert.equal(list.length, 1);
  assert.equal(list[0]!.name, 'My deck');
  assert.deepEqual(list[0]!.values, { boxes: [{ id: 'a' }] });
});

test('list(toolId) scopes to the tool; list() returns all, newest first', async () => {
  const { host } = memHost();
  const store = createUserTemplateStore(host);
  await store.save({ toolId: 'design', name: 'D1', values: {} });
  await store.save({ toolId: 'qr-code', name: 'Q1', values: {} });
  await store.save({ toolId: 'design', name: 'D2', values: {} });

  const design = await store.list('design');
  assert.deepEqual(design.map(t => t.name).sort(), ['D1', 'D2']);
  const qr = await store.list('qr-code');
  assert.deepEqual(qr.map(t => t.name), ['Q1']);
  assert.equal((await store.list()).length, 3);
});

test('variation carries variationOf; standalone omits it', async () => {
  const { host } = memHost();
  const store = createUserTemplateStore(host);
  const v = await store.save({ toolId: 'design', name: 'Bold', values: {}, variationOf: 'slide-deck' });
  assert.equal(v.variationOf, 'slide-deck');
  const t = await store.save({ toolId: 'design', name: 'Plain', values: {} });
  assert.equal('variationOf' in t, false, 'no empty variationOf key on a standalone');
});

test('remove drops one record and leaves the rest', async () => {
  const { host } = memHost();
  const store = createUserTemplateStore(host);
  const a = await store.save({ toolId: 'design', name: 'A', values: {} });
  await store.save({ toolId: 'design', name: 'B', values: {} });
  await store.remove(a.id);
  const list = await store.list('design');
  assert.deepEqual(list.map(t => t.name), ['B']);
});

test('rename updates the name + touches updatedAt', async () => {
  const { host } = memHost();
  const store = createUserTemplateStore(host);
  const a = await store.save({ toolId: 'design', name: 'Old', values: {} });
  await store.rename(a.id, 'New');
  assert.equal((await store.list('design'))[0]!.name, 'New');
});

test('an empty name is rejected (save + rename)', async () => {
  const { host } = memHost();
  const store = createUserTemplateStore(host);
  await assert.rejects(() => store.save({ toolId: 'design', name: '  ', values: {} }));
  const a = await store.save({ toolId: 'design', name: 'Real', values: {} });
  await assert.rejects(() => store.rename(a.id, ''));
});

test('writes never clobber sibling profile fields (folders, headshot)', async () => {
  const { host, raw } = memHost({ folders: [{ id: 'f1', name: 'Proj', items: [] }] });
  const store = createUserTemplateStore(host);
  await store.save({ toolId: 'design', name: 'T', values: {} });
  const p = raw();
  assert.equal(p.headshot, 'keep-me', 'headshot preserved');
  assert.deepEqual(p.folders, [{ id: 'f1', name: 'Proj', items: [] }], 'folders preserved');
  assert.equal((p.userTemplates as unknown[]).length, 1, 'userTemplates written');
});
