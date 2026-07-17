// SPDX-License-Identifier: MPL-2.0
// Tests for the pure share-chunk assembly helper in lib/drop-router.ts — the
// decode/concat step between the Android `LollyShare` JS interface's base64
// chunks and the File handed to the drop chooser. The interface itself (poll/
// consumed, warm-share events) only exists inside the Android WebView, so the
// pure part is what a node test can pin down.
// The tests tsconfig includes only *.test.ts + jsdom.d.ts; drop-router's lazy
// `import('../views/picker.ts')` pulls bridge/export.ts (and its vendor
// modules) into this program, so their ambient declarations must come along.
/// <reference path="../vendor.d.ts" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleShareChunks } from './drop-router.ts';

const b64 = (s: string): string => Buffer.from(s, 'latin1').toString('base64');

test('assembleShareChunks: concatenates chunks in order', () => {
  const chunks = [b64('hello '), b64('shared '), b64('world')];
  const out = assembleShareChunks(chunks.length, (i) => chunks[i]!);
  assert.equal(Buffer.from(out).toString('latin1'), 'hello shared world');
});

test('assembleShareChunks: zero chunks → empty buffer, reader never called', () => {
  const out = assembleShareChunks(0, () => { throw new Error('must not read'); });
  assert.equal(out.length, 0);
});

test('assembleShareChunks: binary bytes survive the round-trip', () => {
  const bytes = Uint8Array.from({ length: 4096 }, (_, i) => (i * 7 + 13) % 256);
  const chunk = Buffer.from(bytes).toString('base64');
  assert.deepEqual(assembleShareChunks(1, () => chunk), bytes);
});

test('assembleShareChunks: tolerates android Base64.DEFAULT line wraps', () => {
  // android.util.Base64.DEFAULT inserts "\n" every 76 chars (and a trailing one).
  const wrapped = `${Buffer.from('wrapped-payload-bytes').toString('base64').replace(/(.{8})/g, '$1\n')}\n`;
  assert.equal(Buffer.from(assembleShareChunks(1, () => wrapped)).toString(), 'wrapped-payload-bytes');
});

test("assembleShareChunks: '' chunk (the bridge's out-of-range answer) adds nothing", () => {
  const out = assembleShareChunks(2, (i) => (i === 0 ? b64('data') : ''));
  assert.equal(Buffer.from(out).toString(), 'data');
});

test('assembleShareChunks: uneven chunk sizes keep byte offsets exact', () => {
  const parts = ['a', 'bb', 'ccc', '', 'ddddd'];
  const out = assembleShareChunks(parts.length, (i) => b64(parts[i]!));
  assert.equal(Buffer.from(out).toString('latin1'), parts.join(''));
});
