// SPDX-License-Identifier: MPL-2.0
/**
 * Reword-privacy DRIFT GUARD - a static source-scan of the reword worker, in
 * the speech-kokoro-privacy.test.ts mould. The "no text ever leaves the
 * device" promise rides on three assignments in lib/reword-worker.ts, and no
 * runtime unit test can see them (the worker needs transformers.js and a wasm
 * runtime to even import). A transformers.js upgrade or an innocent refactor
 * must not silently re-enable huggingface.co fetches.
 *
 * Run directly:  node --test shells/web/src/lib/reword-privacy.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const LIB_DIR = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(LIB_DIR, 'reword-worker.ts'), 'utf8');

describe('reword worker privacy pins', () => {
  test('remote models stay disabled outright', () => {
    assert.match(src, /env\.allowRemoteModels\s*=\s*false/,
      'the worker must set env.allowRemoteModels = false');
  });

  test('models load same-origin from /models/', () => {
    assert.match(src, /env\.localModelPath\s*=\s*'\/models\/'/,
      "the worker must set env.localModelPath = '/models/'");
  });

  test('the ONNX wasm runtime loads same-origin', () => {
    const m = src.match(/\.wasmPaths\s*=\s*([^;\n]+)/);
    assert.ok(m, 'the worker must set wasmPaths');
    const rhs = m![1]!.trim();
    if (/^['"]/.test(rhs)) {
      assert.match(rhs, /^['"]\/[^'"]*['"]$/, `wasmPaths literal must start with '/' (got ${rhs})`);
    } else {
      assert.equal(rhs, 'ORT_HF_BASE', `wasmPaths must be a same-origin literal or ORT_HF_BASE (got ${rhs})`);
      assert.match(src, /import\s*\{\s*ORT_HF_BASE\s*\}\s*from\s*'\.\/ort-hf-base\.ts'/,
        'ORT_HF_BASE must come from ./ort-hf-base.ts');
      const basePath = join(LIB_DIR, 'ort-hf-base.ts');
      assert.ok(existsSync(basePath), 'ort-hf-base.ts must exist (scripts/copy-transformers-ort.ts generates it)');
      assert.match(readFileSync(basePath, 'utf8'), /ORT_HF_BASE\s*=\s*'\/[^']*'/,
        "ORT_HF_BASE must be an origin-relative path starting with '/'");
    }
  });

  test('no huggingface.co (or any absolute http URL) in the worker source', () => {
    assert.ok(!src.includes('huggingface.co'), 'no huggingface.co reference');
    assert.ok(!/https?:\/\//.test(src.replace(/^\s*\*.*$/gm, '').replace(/\/\/.*$/gm, '')),
      'no absolute http(s) URL outside comments');
  });
});
