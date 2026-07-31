// SPDX-License-Identifier: MPL-2.0
/**
 * Unit tests for folder → batch row assembly (pure).
 * Run directly:  node --test shells/web/src/pro/folder-rows.test.ts
 *
 * Lives next to the feature so the whole /pro module can be removed in one delete.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stemOf, slug, rowFromToolSession, rowFromBatchRow, rowsForFolder,
} from './folder-rows.ts';

test('stemOf strips a known extension, falls back to toolId', () => {
  assert.equal(stemOf('badge.png', 'name-badge'), 'badge');
  assert.equal(stemOf('  card.svg ', 'x'), 'card');
  assert.equal(stemOf('', 'name-badge'), 'name-badge');
  assert.equal(stemOf(undefined, 'name-badge'), 'name-badge');
  assert.equal(stemOf('', ''), 'render');
});

test('slug keeps a folder name path-safe', () => {
  assert.equal(slug('My Event!'), 'My-Event');
  assert.equal(slug('  spaces  '), 'spaces');
  assert.equal(slug('a/b'), 'a-b');
});

test('rowFromToolSession keeps inputs, drops __meta, maps __export_*', () => {
  const data = {
    headline: 'Hello', size: 42, __toolId: 'poster', __toolVersion: '1.0.0',
    __label: 'My poster', __export_filename: 'hello.png', __export_format: 'png',
    __export_width: '800', __export_height: '600', __export_unit: 'px', __export_dpi: '300',
  };
  const row = rowFromToolSession(data);
  assert.deepEqual(row.values, { headline: 'Hello', size: 42 });
  assert.equal(row.toolId, 'poster');
  assert.equal(row.format, 'png');
  assert.equal(row.filename, 'hello.png');
  assert.equal(row.outWidth, 800);
  assert.equal(row.outHeight, 600);
  assert.equal(row.unit, 'px');
  assert.equal(row.dpi, 300);
  // No __-prefixed key leaks into values.
  assert.ok(!Object.keys(row.values).some(k => k.startsWith('__')));
});

test('rowFromToolSession with pathParts builds a nested filename', () => {
  const data = { x: 1, __toolId: 'poster', __export_filename: 'card.png' } as any;
  const row = rowFromToolSession(data, ['My Event']);
  assert.equal(row.filename, 'My Event/card');   // extension dropped; batch.js re-adds it
});

test('rowFromToolSession ignores zero/invalid numeric meta', () => {
  const row = rowFromToolSession({ __toolId: 't', __export_width: '0', __export_dpi: 'abc' });
  assert.equal(row.outWidth, undefined);
  assert.equal(row.dpi, undefined);
  assert.equal(row.unit, 'px');
});

test('rowFromBatchRow stamps the group/subgroup path onto the leaf', () => {
  const r = { toolId: 'name-badge', values: { name: 'Ada' }, filename: 'ada.png', format: 'png' };
  const row = rowFromBatchRow(r, ['My Event', 'VIP name badges']);
  assert.equal(row.filename, 'My Event/VIP name badges/ada');
  assert.deepEqual(row.values, { name: 'Ada' });
  assert.equal(row.format, 'png');
});

test('rowsForFolder expands batch sessions to all rows and tool sessions to one', async () => {
  const host = {
    state: {
      async load(slot: string) {
        if (slot === '__batch__:VIP name badges') {
          return {
            __batch: true, __label: 'VIP name badges',
            rows: [
              { toolId: 'name-badge', values: { name: 'Ada' }, filename: 'ada.png' },
              { toolId: 'name-badge', values: { name: 'Lin' }, filename: 'lin.png' },
            ],
          };
        }
        if (slot === 'poster:123') {
          return { __toolId: 'poster', headline: 'Hi', __export_filename: 'hi.png' };
        }
        return null;
      },
    },
  };
  const folder = {
    name: 'My Event',
    items: [
      { type: 'session', ref: '__batch__:VIP name badges' },
      { type: 'session', ref: 'poster:123' },
      { type: 'image', ref: 'user/upload/1' },          // skipped (input, not renderable)
      { type: 'session', ref: 'missing:0' },             // skipped (load → null)
    ],
  };
  const rows = await rowsForFolder(host, folder);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(r => r.filename), [
    'My Event/VIP name badges/ada',
    'My Event/VIP name badges/lin',
    'My Event/hi',
  ]);
});

test('rowsForFolder returns [] for an empty folder', async () => {
  const host = { state: { async load() { return null; } } };
  assert.deepEqual(await rowsForFolder(host, { name: 'Empty', items: [] }), []);
});

// ── Row identity ────────────────────────────────────────────────────────────────
// `planBatch` compacts the array it is given, so every number downstream (progress
// index, result index, the zip's NN- prefix) is a QUEUE position, not the row. A
// folder row therefore carries a stable, deterministic uid stamped from its source.

test('rowsForFolder stamps a deterministic uid naming the source ref + ordinal', async () => {
  const host = {
    state: {
      async load(slot: string) {
        if (slot === '__batch__:VIP name badges') {
          return {
            __batch: true, __label: 'VIP name badges',
            rows: [
              { toolId: 'name-badge', values: { name: 'Ada' }, filename: 'ada.png' },
              { toolId: 'name-badge', values: { name: 'Lin' }, filename: 'lin.png' },
            ],
          };
        }
        if (slot === 'poster:123') return { __toolId: 'poster', headline: 'Hi', __export_filename: 'hi.png' };
        return null;
      },
    },
  };
  const folder = {
    name: 'My Event',
    items: [
      { type: 'session', ref: '__batch__:VIP name badges' },
      { type: 'session', ref: 'poster:123' },
    ],
  };
  const rows = await rowsForFolder(host, folder);
  assert.deepEqual(rows.map(r => r.uid), [
    'My Event::__batch__:VIP name badges#0',
    'My Event::__batch__:VIP name badges#1',
    'My Event::poster:123',
  ]);
  // Deterministic: the same folder assembles the same ids (no counter, no random).
  assert.deepEqual((await rowsForFolder(host, folder)).map(r => r.uid), rows.map(r => r.uid));
});

test('rowsForFolder uids stay unique when the same session sits in two folders', async () => {
  // exportSelectionAsBatch CONCATENATES subtrees, so the same ref legitimately appears
  // twice — uniqueness is a property of the path prefix, and is pinned, not assumed.
  const host = { state: { async load() { return { __toolId: 'poster', __export_filename: 'hi.png' }; } } };
  const rows = [
    ...await rowsForFolder(host, { name: 'A', items: [{ type: 'session', ref: 'poster:123' }] }, null, ['Selection']),
    ...await rowsForFolder(host, { name: 'B', items: [{ type: 'session', ref: 'poster:123' }] }, null, ['Selection']),
  ];
  assert.deepEqual(rows.map(r => r.uid), ['Selection/A::poster:123', 'Selection/B::poster:123']);
  assert.equal(new Set(rows.map(r => r.uid)).size, rows.length);
});

// ── Template-less rows are part of the job ──────────────────────────────────────
// They used to be filtered out here, BEFORE planBatch could see them, which deleted
// them from the run report and shifted the source number of every row after them: the
// same saved batch rendered from the /pro grid said "2 rows skipped, qr-code is row 3"
// and rendered from Projects said nothing was skipped and called it row 1. A zip that
// lists only its successes is not an honest record of the job.

test('rowsForFolder keeps a template-less snapshot row, so positions and uids agree', async () => {
  const host = {
    state: {
      async load() {
        return {
          __batch: true, __label: 'Wave',
          rows: [{ toolId: '' }, { toolId: '' }, { toolId: 'qr-code', values: { url: 'x' } }],
        };
      },
    },
  };
  const rows = await rowsForFolder(host, { name: 'G', items: [{ type: 'session', ref: '__batch__:Wave' }] });
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(r => r.toolId), ['', '', 'qr-code']);
  // The uid's ordinal is the row's SOURCE position — the same number planBatch will
  // report for it — so the two can never name the row differently.
  assert.deepEqual(rows.map(r => r.uid), [
    'G::__batch__:Wave#0', 'G::__batch__:Wave#1', 'G::__batch__:Wave#2',
  ]);
});

test('a [no-tool, no-tool, qr] snapshot reports 3 rows: one rendered (row 3), two skipped (rows 1, 2)', async () => {
  // The composition folder-export.ts performs: every snapshot row → planBatch → report.
  const { planBatch } = await import('./batch.ts');
  const { buildPreflightReport } = await import('./manifest.ts');
  const snapshot = [{ toolId: '' }, { toolId: '' }, { toolId: 'qr-code', values: {} }];
  const batchRows = snapshot.map((r, k) => ({
    ...rowFromBatchRow(r as never, ['Wave']), uid: `slot#${k}`,
  }));
  const plan = await planBatch(batchRows as never, {
    getTool: async () => ({ manifest: {} }), isExportable: () => true,
  });
  assert.equal(plan.renderable.length, 1);
  assert.deepEqual(plan.srcIndex, [2]);

  const report = buildPreflightReport({
    rows: plan.renderable, srcIndex: plan.srcIndex, skipped: plan.skipped,
    results: [{ index: 0, ok: true, name: '01-qr-code.png' }],
    zipName: 'wave.zip', engine: '0.0.0', generated: '2026-07-31T00:00:00.000Z',
  });
  assert.equal(report.job.rowsRequested, 3);
  assert.equal(report.job.rowsRendered, 1);
  assert.deepEqual(report.rows.map(r => [r.row, r.state]), [
    [1, 'skipped'], [2, 'skipped'], [3, 'rendered'],
  ]);
  assert.deepEqual(report.rows.filter(r => r.state === 'skipped').map(r => r.reason), [
    'No template selected', 'No template selected',
  ]);
});
