// SPDX-License-Identifier: MPL-2.0
/**
 * The compact blocks wire format (lib/blocks-url.ts) against the ENGINE's own
 * decoder (parseUrlState), plus the layer-stack tool's wire-contract pins:
 * field order is the format, so the fields list is append-only forever, and a
 * 20-layer document must stay far under the 8000-char address-bar cap (the
 * whole reason the tool's rows are 8 lean fields - the governing constraint
 * from the PSD/XCF import design).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseUrlState } from '@lolly/engine';
import type { BlockFieldSpec, InputSpec, InputValue } from '../../../../engine/src/inputs.ts';
import { encodeBlocksCompact } from './blocks-url.ts';

/** Rows in tests are plain records; the encoder takes the engine's InputValue. */
const enc = (
  rows: Array<Record<string, unknown>>,
  fields: BlockFieldSpec[],
  opts?: { keepUserIds?: boolean },
): string | null => encodeBlocksCompact(rows as unknown as InputValue, fields, opts);

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(
  join(here, '..', '..', '..', '..', 'community', 'layer-stack', 'tool.json'), 'utf8',
)) as { inputs: Array<InputSpec & { fields?: BlockFieldSpec[] }> };
const layersInput = manifest.inputs.find((i) => i.id === 'layers')!;
const FIELDS = layersInput.fields!;

/** A typical imported layer row (asset ref exactly as decode mints it). */
const row = (i: number, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  img: { source: 'library', id: `user/upload/17${i}-l${i}.png` },
  x: i * 10 - 40,
  y: i * 6,
  o: 100,
  v: true,
  b: '',
  n: `Layer ${i}`,
  g: '',
  ...over,
});

test('layer-stack wire contract: field order is pinned (append-only forever)', () => {
  // The compact form is POSITIONAL: changing this order (or removing a field)
  // silently corrupts every shared/bookmarked layer-stack URL in existence.
  // New fields go at the END. If this test fails, you have broken the wire
  // format - revert; do not update the expectation.
  assert.deepEqual(FIELDS.map((f) => f.id), ['img', 'x', 'y', 'o', 'v', 'b', 'n', 'g']);
  assert.equal(layersInput.urlKey, 'l');
});

test('compact round-trip through the engine decoder preserves every field', () => {
  const rows = [row(1, { b: 'multiply', o: 45 }), row(2, { v: false, g: 'Header/logo' })];
  const compact = enc(rows, FIELDS, { keepUserIds: true });
  assert.ok(compact, 'representable rows must encode');
  // Through the REAL parse path, as an address-bar/share URL would arrive.
  const state = parseUrlState(`layers=${encodeURIComponent(compact!)}`, manifest);
  const back = state.values.layers as Array<Record<string, unknown>>;
  assert.equal(back.length, 2);
  const img = back[0]!.img as { source: string; id: string };
  assert.equal(img.source, 'library');
  assert.equal(img.id, 'user/upload/171-l1.png');
  assert.equal(back[0]!.x, '-30', 'numbers arrive as strings — the hook normalises');
  assert.equal(back[0]!.b, 'multiply');
  assert.equal(back[1]!.v, 'false', 'booleans arrive as the STRING "false" — the hook MUST normalise (a truthy trap otherwise)');
  assert.equal(back[1]!.g, 'Header/logo');
});

test('user/ ids: kept in the address-bar variant, empty in the share variant', () => {
  const rows = [row(1)];
  const bar = enc(rows, FIELDS, { keepUserIds: true })!;
  assert.ok(bar.includes('user%2Fupload%2F171-l1.png'));
  const share = enc(rows, FIELDS)!;
  assert.ok(!share.includes('user'), 'share links never carry device-local ids');
  assert.ok(share.startsWith(','), 'the image field is simply empty');
});

test('a raw comma or tilde in any value bails to null (JSON fallback), so import must scrub', () => {
  assert.equal(enc([row(1, { n: 'Shadow, base' })], FIELDS), null);
  assert.equal(enc([row(1, { g: 'a~b' })], FIELDS), null);
  // The import-side scrub (psd-import's `scrub`) maps both to spaces - encodable.
  assert.ok(enc([row(1, { n: 'Shadow  base' })], FIELDS));
});

test('20 imported layers stay far under the 8000-char bar cap', () => {
  const rows = Array.from({ length: 20 }, (_, i) => row(i, {
    b: i % 4 === 0 ? 'multiply' : '',
    o: i % 3 === 0 ? 80 : 100,
    n: `Layer name ${i}`,
    g: i % 2 ? 'Group A/Sub' : '',
  }));
  const compact = enc(rows, FIELDS, { keepUserIds: true })!;
  assert.ok(compact, 'a full import must be representable');
  assert.ok(compact.length < 1500, `expected < 1500 chars for 20 layers, got ${compact.length}`);
});

test('empty defaults cost nothing: an all-default tail row is just separators', () => {
  const compact = enc(
    [{ img: null, x: 0, y: 0, o: 100, v: true, b: '', n: '', g: '' }],
    FIELDS,
  )!;
  // ",0,0,100,true,,," - no field name overhead, no quoting.
  assert.ok(compact.length <= 16, `minimal row should be tiny, got "${compact}"`);
});
