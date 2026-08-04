// SPDX-License-Identifier: MPL-2.0
/**
 * host.matte catalogue (lib/matte-models.ts) — the honesty gates.
 *
 * The one property that MUST hold: nothing is offered until its licence + weights
 * are verified. Every model ships staged-off; the picker must therefore offer
 * nothing today, and a model may only appear once MATTE_STAGED flips (in the same
 * change that lands its verified pin). This test is the tripwire on that gate.
 *
 * Run: node --test shells/web/src/lib/matte-models.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MATTE_DEFAULT_MODEL, MATTE_MODELS, MATTE_MODEL_BYTES, MATTE_MODEL_FILES,
  MATTE_MODEL_SPEC, MATTE_STAGED, matteModel, stagedMatteModels,
} from './matte-models.ts';

test('every catalogue model has a file, a byte size, a spec, and a staged flag', () => {
  for (const m of MATTE_MODELS) {
    assert.ok(MATTE_MODEL_FILES[m.id], `${m.id} has a filename`);
    assert.ok(MATTE_MODEL_BYTES[m.id] > 0, `${m.id} has a size`);
    assert.ok(MATTE_MODEL_SPEC[m.id], `${m.id} has a tensor spec`);
    assert.equal(typeof MATTE_STAGED[m.id], 'boolean', `${m.id} has a staged flag`);
    assert.ok(['Apache-2.0', 'MIT'].includes(m.license), `${m.id} is permissively licensed (${m.license})`);
    assert.ok(m.attribution.length > 0, `${m.id} carries its attribution`);
  }
});

test('MATTE_MODEL_BYTES is derived from the catalogue (cannot drift)', () => {
  for (const m of MATTE_MODELS) assert.equal(MATTE_MODEL_BYTES[m.id], m.approxBytes);
});

test('the default model is a real catalogue entry', () => {
  assert.ok(matteModel(MATTE_DEFAULT_MODEL), 'default resolves in the full catalogue');
});

test('HONESTY GATE: no model is offered until its licence + pin are verified', () => {
  // When you stage a model, you are asserting you have re-read its LICENSE and
  // verified its ONNX (see scripts/fetch-matte-models.ts gate list). Flipping a
  // flag here without that verification is exactly the mistake this guards.
  assert.deepEqual(stagedMatteModels(), [],
    'every matte model must be staged-off until verified; if this fails, a model was staged — confirm the licence + pin were actually verified, then update this test in the SAME change');
});

test('matteModel round-trips even an unstaged (withheld) id', () => {
  for (const m of MATTE_MODELS) assert.equal(matteModel(m.id)?.id, m.id);
});
