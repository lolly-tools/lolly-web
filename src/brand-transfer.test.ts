// SPDX-License-Identifier: MPL-2.0
/**
 * Brand-pack round-trip tests: export on one in-memory install, import on a
 * fresh one, and the refusal paths (not-a-pack, future minReader, corruption).
 * Run directly:  node --test shells/web/src/brand-transfer.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { exportBrandPack, importBrandPack, BRAND_FORMAT } from './brand-transfer.ts';
import type { BrandTransferHost } from './brand-transfer.ts';
import { USER_FONT_PREFIX } from './user-fonts.ts';

function memoryHost(): BrandTransferHost & { store: Map<string, any> } {
  const store = new Map<string, any>();
  return {
    store,
    assets: {
      async _uploadUserAsset(record: any) { store.set(record.id, record); },
      async _deleteUserAsset(id: string) { store.delete(id); },
      async _exportUserAssets() { return [...store.values()]; },
      async _getBlob(id: string) { return store.get(id)?.blob ?? null; },
      // Brand discovery fallback — these tests always install user tokens.
      async _findMetaByType() { return null; },
    } as BrandTransferHost['assets'],
    profile: { async get() { return { firstname: 'Bilbo' }; } },
  };
}

function memoryStorage(seed: Record<string, string> = {}) {
  const m = new Map(Object.entries(seed));
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v); },
    dump: () => Object.fromEntries(m),
  };
}

const TOKENS = {
  color: { semantic: { primary: { $type: 'color', $value: '#4f83cc' } } },
  font: { brand: { $type: 'fontFamily', $value: ['Inter'] } },
};

async function seededHost() {
  const host = memoryHost();
  await host.assets._uploadUserAsset({
    id: 'user/tokens/brand', type: 'tokens', format: 'json',
    blob: new Blob([JSON.stringify(TOKENS)], { type: 'application/json' }),
  });
  await host.assets._uploadUserAsset({
    id: `${USER_FONT_PREFIX}inter/0`, type: 'font', format: 'woff2',
    blob: new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'font/woff2' }),
    version: '2026-07-09',
    meta: { family: 'Inter', weight: '100 900', style: 'normal', subset: 'latin', unicodeRange: 'U+0000-00FF' },
  });
  await host.assets._uploadUserAsset({
    id: `${USER_FONT_PREFIX}inter/1`, type: 'font', format: 'woff2',
    blob: new Blob([new Uint8Array([5, 6, 7, 8])], { type: 'font/woff2' }),
    meta: { family: 'Inter', weight: '100 900', style: 'normal', subset: 'latin-ext' },
  });
  // A user image that must NOT travel in a brand pack.
  await host.assets._uploadUserAsset({
    id: 'user/upload/1', type: 'raster', format: 'png',
    blob: new Blob([new Uint8Array(16)], { type: 'image/png' }),
  });
  return host;
}

test('round-trip: tokens + fonts + theme land intact on a fresh install', async () => {
  const src = await seededHost();
  const { blob, filename, summary } = await exportBrandPack(
    { host: src, storage: memoryStorage({ theme: 'dark' }) });
  assert.equal(summary.tokens, true);
  assert.equal(summary.fontFamilies, 1);
  assert.equal(summary.fontFiles, 2);
  assert.equal(summary.prefs, 1);
  assert.match(filename, /^LollyBrand-Bilbo-\d{4}-\d{2}-\d{2}\.zip$/);

  const dst = memoryHost();
  const storage = memoryStorage();
  const imported = await importBrandPack({ host: dst, storage }, await blob.arrayBuffer());
  assert.equal(imported.tokens, true);
  assert.equal(imported.fontFiles, 2);
  assert.equal(imported.fontFamilies, 1);
  assert.equal(imported.failedFonts, 0);
  assert.equal(imported.skipped, 0);
  assert.equal(storage.dump().theme, 'dark');

  const doc = JSON.parse(await dst.store.get('user/tokens/brand').blob.text());
  assert.deepEqual(doc.font.brand.$value, ['Inter']);
  const face = dst.store.get(`${USER_FONT_PREFIX}inter/0`);
  assert.equal(face.meta.unicodeRange, 'U+0000-00FF');
  assert.deepEqual(new Uint8Array(await face.blob.arrayBuffer()), new Uint8Array([1, 2, 3, 4]));
  assert.equal(dst.store.has('user/upload/1'), false); // images stay personal
});

test('a data backup (different format) is refused with a clear message', async () => {
  const zipBytes = zipSync({ 'manifest.json': strToU8(JSON.stringify({ format: 'lolly-backup' })) });
  await assert.rejects(
    importBrandPack({ host: memoryHost(), storage: memoryStorage() }, zipBytes),
    /doesn't look like a Lolly brand file/,
  );
});

test('a future minReader is refused (update-first message)', async () => {
  const zipBytes = zipSync({
    'manifest.json': strToU8(JSON.stringify({ format: BRAND_FORMAT, formatVersion: 99, minReader: 99 })),
  });
  await assert.rejects(
    importBrandPack({ host: memoryHost(), storage: memoryStorage() }, zipBytes),
    /newer version of the app/,
  );
});

test('a corrupted part fails its integrity check loudly', async () => {
  const src = await seededHost();
  const { blob } = await exportBrandPack({ host: src, storage: memoryStorage() });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  // Flip one byte inside a STORED (level 0) font entry — the woff2 payload.
  const marker = new TextEncoder().encode('fonts/inter-0.woff2');
  const at = bytes.findIndex((_, i) => marker.every((b, j) => bytes[i + j] === b));
  assert.ok(at > 0, 'font entry present in the zip');
  const flipAt = at + marker.length + 2; // a payload byte just past the local header name
  bytes[flipAt] = (bytes[flipAt] ?? 0) ^ 0xff;
  await assert.rejects(
    importBrandPack({ host: memoryHost(), storage: memoryStorage() }, bytes),
    /corrupted|unzipped|integrity/i,
  );
});

test('unknown parts from a newer writer are counted, not dropped silently', async () => {
  const src = await seededHost();
  const { blob } = await exportBrandPack({ host: src, storage: memoryStorage() });
  // Re-zip with an extra part a future writer might add.
  const { unzipSync } = await import('fflate');
  const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
  const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json']!));
  delete manifest.integrity; // adding a part would break the map; a newer writer re-signs
  files['manifest.json'] = strToU8(JSON.stringify(manifest));
  files['motion.json'] = strToU8('{}');
  const rezip = zipSync(files);
  const summary = await importBrandPack({ host: memoryHost(), storage: memoryStorage() }, rezip);
  assert.equal(summary.skipped, 1);
});
