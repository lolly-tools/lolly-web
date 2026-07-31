// SPDX-License-Identifier: MPL-2.0
/**
 * The BATCH PREFLIGHT COLLECTOR — `pro/preflight-rows.ts`, against the real engine.
 *
 * The engine's rules are tested in `tests/preflight.test.ts`; nothing here re-tests
 * a rule. What is tested here is the COLLECTION: that the job handed to the engine
 * describes the render that is actually about to happen.
 *
 * The load-bearing property is SETTINGS PARITY. A preflight that checks settings
 * the renderer will not use is worse than none, so the parity test restates
 * `runBatch`'s own two-level resolution independently (quoted from `batch.ts`) and
 * pins the collector to it — a drift in either direction fails here rather than
 * shipping a confident report about a job nobody ran.
 *
 * The other three cases are the ones plan §7 names: a clean row, a row with a
 * finding, and a SKIPPED row, which has no queue position at all and is exactly the
 * case preflight most needs to explain.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { planBatch, printSettingsFor, type BatchRow } from './batch.ts';
import {
  createBatchRowCheck, preflightJobForRow, preflightRow, rowSize,
  toPreflightManifest, type BatchPreflightEnv,
} from './preflight-rows.ts';
import type { Finding } from '@lolly/engine';

/** A minimal exportable manifest. `as never` only at the call boundary. */
const manifestOf = (over: Record<string, unknown> = {}) => ({
  id: 'demo',
  name: 'Demo',
  version: '1.0.0',
  render: { width: 1200, height: 900, formats: ['png', 'pdf'], ...(over.render as object ?? {}) },
  inputs: (over.inputs as unknown[]) ?? [{ id: 'title', label: 'Title', type: 'text', default: 'hi' }],
  ...(over.status ? { status: over.status } : {}),
}) as never;

const ENV: BatchPreflightEnv = {
  run: {},
  // Never a fabricated empty palette: an unresolved brand is a named refusal, and
  // the engine withholds the plate ceiling because of it.
  palette: { known: false, why: 'not-resolved' },
  source: 'test',
};

const CTX = { srcIndex: 0 };

test('a clean row produces no warnings and no errors', () => {
  const row: BatchRow = { toolId: 'demo', values: { title: 'hello' }, format: 'png' };
  const findings = preflightRow(row, toPreflightManifest(manifestOf()), 0, CTX, ENV);
  assert.equal(findings.filter(f => f.severity !== 'info').length, 0,
    `expected only info findings, got ${JSON.stringify(findings.map(f => [f.id, f.severity]))}`);
});

test('the job reports the stage as UNAVAILABLE, never as an empty stage', () => {
  const job = preflightJobForRow({ toolId: 'demo', values: {} }, toPreflightManifest(manifestOf()), 0, CTX, ENV);
  // The whole Tier-1 contract in one assertion: a pre-pass has no mounted node, and
  // an all-false StageFacts would make every stage-derived check silently pass.
  assert.deepEqual(job.stage, { known: false, why: 'needs-mount' });
  // No runtime ran, so no hook has patched anything. Said out loud, not implied.
  assert.equal(job.modelPhase, 'declared');
  assert.deepEqual(job.rawInitial, {});
});

test('a row with a problem carries the finding', () => {
  const m = manifestOf({ inputs: [{ id: 'title', label: 'Title', type: 'text', required: true }] });
  const row: BatchRow = { toolId: 'demo', values: {}, format: 'png' };
  const findings = preflightRow(row, toPreflightManifest(m), 0, CTX, ENV);
  const blank = findings.find(f => f.id === 'input.required-blank');
  assert.ok(blank, `expected input.required-blank, got ${JSON.stringify(findings.map(f => f.id))}`);
  assert.equal(blank!.severity, 'warn');
  assert.equal(blank!.inputId, 'title');
});

test('bindToProfile prefill is threaded in, so a pre-filled required input is not reported blank', () => {
  const m = manifestOf({ inputs: [{ id: 'name', label: 'Name', type: 'text', required: true, bindToProfile: 'firstname' }] });
  const withProfile = { ...ENV, profile: { firstname: 'Andy' } };
  const findings = preflightRow({ toolId: 'demo', values: {} }, toPreflightManifest(m), 0, CTX, withProfile);
  assert.equal(findings.some(f => f.id === 'input.required-blank'), false);
});

test('every finding is stamped with the SOURCE row, the only number a human can find', () => {
  const m = manifestOf({ inputs: [{ id: 'title', label: 'Title', type: 'text', required: true }] });
  // Queue position 2, source position 7: they are different index spaces, and the
  // one written into the artifact is the source position.
  const findings = preflightRow({ toolId: 'demo', values: {} }, toPreflightManifest(m), 2, { srcIndex: 7 }, ENV);
  for (const f of findings) assert.equal(f.rowIndex, 7);
});

// ── Skipped rows ────────────────────────────────────────────────────────────
//
// A skipped row has no queue position (`rowIndex: -1`) but IS the case preflight
// most needs to explain, so it must still be able to carry findings.

test('a skipped row with no loadable template still carries a finding', () => {
  const findings = preflightRow(
    { toolId: '', values: {} }, null, -1,
    { srcIndex: 3, skippedReason: 'No template selected' }, ENV,
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.id, 'collect.row-not-rendered');
  // The gap invariant, held by hand for a collector-side caveat: info, no count.
  assert.equal(findings[0]!.severity, 'info');
  assert.equal(findings[0]!.needs, 'not-carried');
  assert.equal(findings[0]!.count, undefined);
  assert.equal(findings[0]!.rowIndex, 3);
  assert.match(findings[0]!.message, /No template selected/);
});

test('a skipped row that DID load carries the caveat plus the engine findings', () => {
  const m = manifestOf({ render: { width: 1200, height: 900, formats: ['png'], export: false } });
  const findings = preflightRow(
    { toolId: 'demo', values: {} }, toPreflightManifest(m), -1,
    { srcIndex: 4, skippedReason: 'Render-only tool' }, ENV,
  );
  assert.equal(findings[0]!.id, 'collect.row-not-rendered');
  assert.ok(findings.length > 1, 'a render-only row still gets the engine report');
});

test('planBatch routes a skipped row through the check with rowIndex -1', async () => {
  const seen: Array<{ rowIndex: number; srcIndex: number; reason?: string }> = [];
  const plan = await planBatch<Finding>(
    [{ toolId: '', values: {} }, { toolId: 'demo', values: {} }],
    {
      getTool: async () => ({ manifest: manifestOf() }),
      isExportable: () => true,
      check: (row, rowIndex, ctx) => {
        seen.push({ rowIndex, srcIndex: ctx.srcIndex, reason: ctx.skippedReason });
        return preflightRow(row, row.toolId ? toPreflightManifest(manifestOf()) : null, rowIndex, ctx, ENV);
      },
    },
  );
  assert.deepEqual(seen, [
    { rowIndex: -1, srcIndex: 0, reason: 'No template selected' },
    { rowIndex: 0, srcIndex: 1, reason: undefined },
  ]);
  // The dropped row's findings ride the plan keyed by -1, so `notesFromFindings`
  // drops them from the runner's channel and the run REPORT keeps them.
  const dropped = plan.findings.find(f => f.rowIndex === -1);
  assert.ok(dropped, 'the skipped row carries findings');
  assert.equal(dropped!.items[0]!.id, 'collect.row-not-rendered');
});

// ── Settings parity ─────────────────────────────────────────────────────────

test('the job carries the settings runBatch would render with (row beats run)', () => {
  const run = { format: 'png', unit: 'mm', dpi: 150, profile: 'fogra39', bleed: '3mm', marks: 'crop,reg' };
  const row: BatchRow = {
    toolId: 'demo', values: {},
    format: 'pdf', outWidth: 210, outHeight: 297, unit: 'mm', dpi: 600,
    bleed: '5mm', filename: 'poster',
  };
  const job = preflightJobForRow(row, toPreflightManifest(manifestOf()), 0, CTX, { ...ENV, run });

  // batch.ts:317 — `printSettingsFor(row, { profile, bleed, marks }, format)`. The
  // collector calls the GATE itself, so this is the renderer's own answer.
  const print = printSettingsFor(row, { profile: run.profile, bleed: run.bleed, marks: run.marks }, run.format);
  assert.deepEqual(print, { profile: 'fogra39', bleed: '5mm', marks: 'crop,reg' });
  assert.deepEqual(job.settings.bleed, { known: true, value: { value: 5, unit: 'mm' } });
  assert.deepEqual(job.settings.pressProfile, { known: true, value: 'fogra39' });
  assert.deepEqual(job.settings.marks, {
    known: true,
    value: { crop: true, registration: true, bleed: false, colorBars: false, provenance: false },
  });

  // runBatch's own two lines, restated independently:
  //   const rowUnit = row.unit ?? unit ?? 'px';
  //   const rowDpi  = rowUnit === 'px' ? undefined : (row.dpi ?? dpi ?? 300);
  const rowUnit = row.unit ?? run.unit ?? 'px';
  const rowDpi = rowUnit === 'px' ? undefined : (row.dpi ?? run.dpi ?? 300);
  assert.equal(job.settings.size.width.unit, rowUnit);
  assert.equal(job.settings.size.dpi, rowDpi);
  assert.deepEqual(job.settings.size.width, { value: 210, unit: 'mm' });
  assert.equal(job.settings.size.declaredBy, 'row');
  assert.equal(job.settings.size.unitDeclared, true);
  // `chooseFormat(manifest, row.format || run.format)` — the row's own wins.
  assert.equal(job.settings.format, 'pdf');
  assert.equal(job.settings.filename, 'poster');
});

test('a non-print format is handed NO print settings, exactly as the render gate strips them', () => {
  const run = { format: 'png', bleed: '3mm', marks: 'crop', profile: 'fogra39' };
  const row: BatchRow = { toolId: 'demo', values: {} };
  const job = preflightJobForRow(row, toPreflightManifest(manifestOf()), 0, CTX, { ...ENV, run });
  // Known NULL, not unknown: the render applies none, and that is a fact.
  assert.deepEqual(job.settings.bleed, { known: true, value: null });
  assert.deepEqual(job.settings.marks, { known: true, value: null });
  assert.deepEqual(job.settings.pressProfile, { known: true, value: null });
});

test('no run format and no row format falls through to the tool\'s first declared format', () => {
  // The folder / selection paths: `chooseFormat` picks the native format later, and
  // the collector must pick the same one rather than reporting an empty format.
  const job = preflightJobForRow({ toolId: 'demo', values: {} }, toPreflightManifest(manifestOf()), 0, CTX, ENV);
  assert.equal(job.settings.format, 'png');
});

test('a half-declared size reports the manifest canvas, because that is what renders', () => {
  // renderRowToBlob honours the row's dimensions only when BOTH are positive.
  const size = rowSize({ toolId: 'demo', values: {}, outWidth: 210, unit: 'mm' }, toPreflightManifest(manifestOf()), {});
  assert.deepEqual(size.width, { value: 1200, unit: 'px' });
  assert.equal(size.declaredBy, 'manifest');
  assert.equal(size.unitDeclared, false);
});

test('a px fallback is not a declared unit', () => {
  const size = rowSize({ toolId: 'demo', values: {}, outWidth: 800, outHeight: 600 }, toPreflightManifest(manifestOf()), {});
  assert.equal(size.width.unit, 'px');
  assert.equal(size.unitDeclared, false);
  assert.equal(size.dpi, 96);
});

test('an unparseable bleed is UNKNOWN, never "no bleed"', () => {
  const row: BatchRow = { toolId: 'demo', values: {}, format: 'pdf', bleed: 'three millimetres' };
  const job = preflightJobForRow(row, toPreflightManifest(manifestOf()), 0, CTX, ENV);
  assert.deepEqual(job.settings.bleed, { known: false, why: 'not-resolved' });
});

// ── The wiring ──────────────────────────────────────────────────────────────

test('createBatchRowCheck resolves the palette ONCE for the whole run', async () => {
  let calls = 0;
  const host = {
    tokens: { colors: async () => { calls++; return [{ path: 'brand.a', name: 'A', spot: null }]; } },
    profile: { get: async () => ({ firstname: 'Andy' }) },
  };
  const rows: BatchRow[] = [
    { toolId: 'demo', values: {} }, { toolId: 'demo', values: {} }, { toolId: 'demo', values: {} },
  ];
  let loads = 0;
  const check = await createBatchRowCheck(rows, host, { format: 'png' }, {
    getTool: async () => { loads++; return { manifest: manifestOf() }; },
  });
  for (let i = 0; i < rows.length; i++) check(rows[i]!, i, { srcIndex: i });
  assert.equal(calls, 1, 'the brand palette is run-invariant: one resolve, not one per row');
  assert.equal(loads, 1, 'one manifest load per DISTINCT template');
});

test('an experimental tool is reported once per row, as info', async () => {
  const rows: BatchRow[] = [{ toolId: 'demo', values: {}, format: 'png' }];
  const check = await createBatchRowCheck(rows, {}, {}, {
    getTool: async () => ({ manifest: manifestOf({ status: 'experimental' }) }),
  });
  const out = check(rows[0]!, 0, { srcIndex: 0 });
  const w = out.find(f => f.id === 'export.experimental-watermark');
  assert.ok(w);
  assert.equal(w!.severity, 'info');
});

test('a collector that throws costs the findings, never the run', async () => {
  const logged: string[] = [];
  const rows: BatchRow[] = [{ toolId: 'demo', values: {} }];
  const check = await createBatchRowCheck(rows, { log: (_l, m) => { logged.push(m); } }, {}, {
    getTool: async () => ({ manifest: manifestOf() }),
  });
  // A row whose `values` getter explodes: the collector swallows it and returns [].
  const hostile = { toolId: 'demo', get values(): Record<string, unknown> { throw new Error('boom'); } } as unknown as BatchRow;
  assert.deepEqual(check(hostile, 0, { srcIndex: 0 }), []);
  assert.equal(logged.length, 1);
});
