// SPDX-License-Identifier: MPL-2.0
/**
 * The offline pre-download must pull EXACTLY the model files the dialogs fetch on
 * demand - same store, same file names - or "Available offline" writes bytes the
 * runtime never reads. Cache-parity is the whole point of model-prefetch.ts; these
 * pin the offline file lists to the staged roster so the two can't drift.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { upscaleOfflineFiles, matteOfflineFiles } from './model-prefetch.ts';
import { UPSCALE_MODEL_FILES, UPSCALE_FACE_DETECT_FILE, stagedUpscaleModels } from './upscale-models.ts';
import { MATTE_MODEL_FILES, matteModelsFor } from './matte-models.ts';

test('the upscale offline part vendors every staged upscaler + the face detector', () => {
  const files = upscaleOfflineFiles();
  for (const m of stagedUpscaleModels()) {
    assert.ok(files.includes(UPSCALE_MODEL_FILES[m.id]), `${m.id} is pre-downloaded`);
  }
  assert.ok(files.includes(UPSCALE_FACE_DETECT_FILE), 'the GFPGAN face detector rides along');
  assert.equal(new Set(files).size, files.length, 'no duplicate files');
});

test('the illustration/anime model is in the offline part (the fix)', () => {
  assert.ok(
    upscaleOfflineFiles().includes(UPSCALE_MODEL_FILES['realesrgan-x4plus-anime']),
    'pre-downloading Upscaling models pulls the anime model so Illustration works offline',
  );
});

test('the matte offline part vendors exactly the cut-out models this shell can run', () => {
  // Cache parity is against what the picker OFFERS, which is backend-gated: the
  // native-only full BiRefNet (~467 MB) is withheld where it can't run, so the
  // offline section must not pre-download it there either. This test runs with no
  // Tauri backend (isTauriShell() === false), so matteOfflineFiles() is the
  // wasm-runnable subset - matteModelsFor(false).
  assert.deepEqual(
    [...matteOfflineFiles()].sort(),
    matteModelsFor(false).map(m => MATTE_MODEL_FILES[m.id]).sort(),
  );
  // The native-only heavyweight is explicitly NOT vendored on the web/CLI side.
  assert.ok(!matteOfflineFiles().includes(MATTE_MODEL_FILES['birefnet']),
    'the wasm-impossible full BiRefNet is not offered for web offline download');
});
