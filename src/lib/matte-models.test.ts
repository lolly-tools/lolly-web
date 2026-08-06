// SPDX-License-Identifier: MPL-2.0
/**
 * host.matte catalogue (lib/matte-models.ts) — the honesty gates.
 *
 * The one property that MUST hold: nothing is offered until its licence + weights
 * are verified. A model may only appear once MATTE_STAGED flips (in the same change
 * that lands its verified pin). This test is the tripwire on that gate — it pins the
 * exact staged set, so a NEW flip fails here until whoever flipped it re-affirms the
 * verification by updating this test in the same change.
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

test('HONESTY GATE: exactly the verified models are offered', () => {
  // When you stage a model, you are asserting you have re-read its LICENSE and
  // verified its ONNX (see scripts/fetch-matte-models.ts gate list). Flipping a
  // flag without that verification is exactly the mistake this guards.
  //
  // Staged roster as of 2026-08-06: u2netp (fast) + birefnet-lite (default) + birefnet
  // (max quality, full Swin-L, ~490 MB fp16) + modnet (portraits). Each has a real
  // sha256/byte-verified pin (fetch-matte-models.ts), its ONNX graph inspected in
  // onnxruntime (tensor shape/dtype, per-model normalization + activation confirmed),
  // and a permissive licence (Apache-2.0 ×2, MIT ×2 — MPL-compatible). Matte runs
  // WASM-only, so no WebGPU gate applies. If this fails, a staged flag changed — re-affirm
  // the licence + pin were actually verified, then update this list in the SAME change.
  assert.deepEqual(stagedMatteModels().map(m => m.id).sort(), ['birefnet', 'birefnet-lite', 'modnet', 'u2netp'],
    'the staged set must match the verified models');
});

test('matteModel round-trips even an unstaged (withheld) id', () => {
  for (const m of MATTE_MODELS) assert.equal(matteModel(m.id)?.id, m.id);
});
