// SPDX-License-Identifier: MPL-2.0
/**
 * lib/send-target.ts - the provider-agnostic send-destination registry.
 * Empty = dormant; availability and format gates; last-registration-per-kind
 * wins so an instance can replace a built-in.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { registerSendTarget, unregisterSendTarget, sendTargetsFor } from './send-target.ts';
import type { SendTarget } from './send-target.ts';

const mk = (kind: string, over: Partial<SendTarget> = {}): SendTarget => ({
  kind, label: kind, available: () => true,
  send: async () => ({ label: 'done' }),
  ...over,
});

test('empty registry offers nothing (the dormant default)', () => {
  assert.deepEqual(sendTargetsFor('png'), []);
});

test('availability and format gates filter per query; undefined formats = every format', () => {
  registerSendTarget(mk('a', { formats: ['emf'] }));
  registerSendTarget(mk('b'));
  registerSendTarget(mk('c', { available: () => false }));
  try {
    assert.deepEqual(sendTargetsFor('emf').map(t => t.kind), ['a', 'b']);
    assert.deepEqual(sendTargetsFor('PNG').map(t => t.kind), ['b'], 'format compare is case-insensitive');
  } finally {
    for (const k of ['a', 'b', 'c']) unregisterSendTarget(k);
  }
});

test('last registration per kind wins (an instance replacing a built-in), and unregister withdraws', () => {
  registerSendTarget(mk('gdrive', { label: 'builtin' }));
  registerSendTarget(mk('gdrive', { label: 'instance-policy' }));
  try {
    const got = sendTargetsFor('emf');
    assert.equal(got.length, 1);
    assert.equal(got[0]!.label, 'instance-policy');
  } finally {
    unregisterSendTarget('gdrive');
  }
  assert.deepEqual(sendTargetsFor('emf'), []);
});
