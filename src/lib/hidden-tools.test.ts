// SPDX-License-Identifier: MPL-2.0
/**
 * lib/hidden-tools.ts — the per-user "hide this tool" overlay store. Mirrors
 * lib/favourites.ts: profile-backed, tolerant of junk, best-effort persistence.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadHiddenTools, saveHiddenTools } from './hidden-tools.ts';
import type { Profile } from '@lolly-tools/core/host-v1';

test('loadHiddenTools: absent / junk profiles read as empty', () => {
  assert.equal(loadHiddenTools(null).size, 0);
  assert.equal(loadHiddenTools(undefined).size, 0);
  assert.equal(loadHiddenTools({} as Profile).size, 0);
  assert.equal(loadHiddenTools({ hiddenTools: 'nope' } as unknown as Profile).size, 0);
});

test('loadHiddenTools: keeps strings (tool ids and view: keys), drops junk entries', () => {
  const profile = { hiddenTools: ['qr-code', 'view:verify', 42, null, 'street-map'] } as unknown as Profile;
  const set = loadHiddenTools(profile);
  assert.deepEqual([...set].sort(), ['qr-code', 'street-map', 'view:verify']);
});

test('saveHiddenTools: writes the set onto the profile and persists via host.profile.set', async () => {
  const profile = { hiddenTools: ['old'] } as unknown as Profile;
  let persisted: Profile | null = null;
  const host = { profile: { set: async (p: Profile) => { persisted = p; } } };
  await saveHiddenTools(host as never, profile, new Set(['a', 'view:b']));
  assert.deepEqual(profile.hiddenTools?.sort(), ['a', 'view:b']);
  assert.equal(persisted, profile);   // the SAME cached instance, so later reads see it
});

test('saveHiddenTools: a failed persist is non-fatal and still mutates the profile', async () => {
  const profile = {} as Profile;
  const host = { profile: { set: async () => { throw new Error('quota'); } } };
  await saveHiddenTools(host as never, profile, new Set(['x']));
  assert.deepEqual(profile.hiddenTools, ['x']);
});
