// SPDX-License-Identifier: MPL-2.0
/**
 * `.lolly` share file - headless round-trip (plans/114 Wave 2).
 *
 * Builds a file for a session that references a device-local upload AND two catalog
 * assets (one licensed), then reads it back and asserts the closure rules hold:
 *   - user/* bytes always travel; catalog bytes travel by default;
 *   - a licensed/brand-pack asset travels only with includeLicensed, else it degrades
 *     to a resolve-local ref (never silently dropped);
 *   - the session round-trips byte-for-byte and integrity verifies;
 *   - the creator block honours the useDetails opt-in.
 *
 * Pure + DOM-free, exactly like beam-pack / data-transfer round-trip tests: a real
 * fflate zip, real Blobs, real Web Crypto integrity - no bridge, no browser.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BeamAssetRecord, BeamPackHost, BeamSessionRow } from './beam-pack.ts';
import {
  buildLollyFile,
  readLollyFile,
  ingestLollyFile,
  applyLollyRekey,
  creatorFromProfile,
  LOLLY_FILE_FORMAT,
  LOLLY_MIME,
  type LollyLibraryAsset,
} from './lolly-pack.ts';

/** A tiny in-memory beam host - the same seam beam-pack's own tests use, so the
 *  `.lolly` ingest (which drives ingestBeamItem) runs headlessly end to end. */
function memHost() {
  const userStore = new Map<string, BeamAssetRecord>();
  const slots = new Map<string, { data: unknown; thumb?: string | null }>();
  const host: BeamPackHost = {
    state: {
      list: async (): Promise<BeamSessionRow[]> => [...slots.keys()].map(slot => ({ slot })),
      load: async (slot: string) => slots.get(slot)?.data ?? null,
      save: async (slot: string, data: unknown, thumb?: string | null) => { slots.set(slot, { data, thumb }); },
      delete: async (slot: string) => { slots.delete(slot); },
    },
    assets: {
      _exportUserAssets: async () => [...userStore.values()],
      _uploadUserAsset: async (rec: BeamAssetRecord) => { userStore.set(rec.id, rec); },
      _getUserRecord: async (id: string) => userStore.get(id) ?? null,
      _deleteUserAsset: async (id: string) => { userStore.delete(id); },
    },
  };
  return { host, userStore, slots };
}

const PNG = (tag: number) => new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, tag, 0, 0]);

const UPLOAD_ID = 'user/upload/123-logo.png';
const CATALOG_ID = 'lolly-start/pattern/waves';   // ordinary catalog art
const BRAND_ID = 'suse/logo/primary';             // licensed / brand-pack

const uploadBytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4, 5]);
const catalogBytes = new Uint8Array([60, 115, 118, 103, 62]);          // "<svg>"
const brandBytes = new Uint8Array([66, 82, 65, 78, 68]);               // "BRAND"

function makeSession() {
  return {
    __toolId: 'demo-tool',
    __toolVersion: '3',
    __export_format: 'png',
    title: 'A design after many edits',
    logo: { source: 'user', id: UPLOAD_ID, url: 'blob:whatever' },
    background: { source: 'library', id: CATALOG_ID, url: '' },
    brandmark: { source: 'library', id: BRAND_ID, url: '' },
  };
}

const userAssets: BeamAssetRecord[] = [
  { id: UPLOAD_ID, type: 'raster', format: 'png', blob: new Blob([uploadBytes], { type: 'image/png' }), meta: { name: 'My Logo' } },
];

const resolveLibrary = async (id: string): Promise<LollyLibraryAsset | null> => {
  if (id === CATALOG_ID) return { bytes: catalogBytes, mime: 'image/svg+xml', type: 'vector', format: 'svg', label: 'Waves' };
  if (id === BRAND_ID) return { bytes: brandBytes, mime: 'image/svg+xml', type: 'vector', format: 'svg', label: 'SUSE Logo', licensed: true };
  return null;
};

test('.lolly build → read round-trips the session and carries user + catalog bytes', async () => {
  const { blob, filename, manifest, summary } = await buildLollyFile({
    session: makeSession(), toolId: 'demo-tool', toolVersion: '3', name: 'My Design',
    userAssets, resolveLibrary, appVersion: 'Lolly 1.0.0',
    creator: creatorFromProfile({ firstname: 'Ada', lastname: 'L', email: 'ada@x.io', org: 'ACME', useDetails: true }, { appVersion: 'Lolly 1.0.0', now: '2026-08-13T00:00:00.000Z' }),
  });

  assert.equal(blob.type, LOLLY_MIME);
  assert.equal(filename, 'My-Design.lolly');
  assert.equal(manifest.format, LOLLY_FILE_FORMAT);
  assert.equal(manifest.kind, 'session');
  assert.equal(manifest.tool.id, 'demo-tool');
  assert.equal(manifest.tool.version, '3');

  // Default (no includeLicensed): user + ordinary catalog carry bytes; brand asset is a ref.
  assert.equal(summary.assetCount, 2, 'user upload + ordinary catalog carried');
  assert.equal(summary.byReferenceCount, 1, 'the licensed brand asset is not embedded');
  assert.equal(summary.hasLicensed, true);
  assert.equal(summary.licensedExcluded, 1);
  assert.equal(summary.creatorName, 'Ada L');

  const upload = manifest.assets.find(a => a.id === UPLOAD_ID)!;
  assert.equal(upload.kind, 'asset');
  assert.equal(upload.source, 'user');
  assert.equal(upload.bytes, uploadBytes.length);
  assert.equal(upload.label, 'My Logo');
  assert.ok(upload.path && upload.path.startsWith('assets/blobs/'));

  const cat = manifest.assets.find(a => a.id === CATALOG_ID)!;
  assert.equal(cat.kind, 'asset');
  assert.equal(cat.source, 'library');

  const brand = manifest.assets.find(a => a.id === BRAND_ID)!;
  assert.equal(brand.kind, 'asset-ref', 'licensed asset is a ref by default');
  assert.equal(brand.licensed, true);
  assert.equal(brand.bytes, undefined);

  // Read back.
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const parsed = await readLollyFile(bytes);
  assert.deepEqual(parsed.session, makeSession(), 'session round-trips byte-for-byte');
  assert.ok(parsed.files[upload.path!], 'the upload bytes are in the archive');
  assert.deepEqual([...parsed.files[upload.path!]!], [...uploadBytes], 'upload bytes are byte-exact');
  assert.deepEqual([...parsed.files[cat.path!]!], [...catalogBytes], 'catalog bytes are byte-exact');
  assert.ok(!('assets/blobs' in parsed.files) || !parsed.files[brand.path as string], 'no bytes for the held-back brand asset');

  // Integrity is exercised headlessly (Web Crypto present in the test runtime).
  if (manifest.integrity) {
    assert.ok(manifest.integrity[upload.path!], 'integrity map covers the upload');
    assert.equal(upload.checksum, manifest.integrity[upload.path!], 'asset checksum mirrors the integrity map');
  }
});

test('.lolly carries a licensed brand asset only with includeLicensed', async () => {
  const { manifest, summary } = await buildLollyFile({
    session: makeSession(), toolId: 'demo-tool', userAssets, resolveLibrary, includeLicensed: true,
  });
  const brand = manifest.assets.find(a => a.id === BRAND_ID)!;
  assert.equal(brand.kind, 'asset', 'licensed asset now carries bytes');
  assert.equal(brand.bytes, brandBytes.length);
  assert.equal(summary.assetCount, 3);
  assert.equal(summary.byReferenceCount, 0);
  assert.equal(summary.licensedExcluded, 0);
  assert.equal(summary.hasLicensed, true);
});

test('.lolly records a stale/missing user ref instead of dropping it', async () => {
  // The session references an upload we no longer hold the bytes for.
  const { manifest, summary } = await buildLollyFile({
    session: { logo: { source: 'user', id: 'user/upload/gone.png', url: '' } },
    toolId: 'demo-tool', userAssets: [], resolveLibrary,
  });
  assert.equal(summary.assetCount, 0);
  assert.equal(summary.byReferenceCount, 1);
  const ref = manifest.assets[0]!;
  assert.equal(ref.kind, 'asset-ref');
  assert.equal(ref.source, 'user');
  assert.equal(ref.id, 'user/upload/gone.png');
});

test('.lolly import lands assets + session, rewriting user AND carried-library refs', async () => {
  const userPng = PNG(1), libPng = PNG(2);
  const session = {
    __toolId: 'demo-tool', __toolVersion: '3',
    logo: { source: 'user', id: 'user/upload/aaa.png', url: 'blob:x' },
    bg: { source: 'library', id: 'lolly-start/pattern/waves', url: '' },
  };
  const built = await buildLollyFile({
    session, toolId: 'demo-tool', toolVersion: '3',
    userAssets: [{ id: 'user/upload/aaa.png', type: 'raster', format: 'png', blob: new Blob([userPng], { type: 'image/png' }), meta: { name: 'Logo' } }],
    resolveLibrary: async (id) => id === 'lolly-start/pattern/waves'
      ? { bytes: libPng, mime: 'image/png', type: 'raster', format: 'png', label: 'Waves' } : null,
  });
  assert.equal(built.summary.assetCount, 2, 'both the upload and the (non-licensed) catalog asset carry bytes');

  const store = memHost();
  const res = await ingestLollyFile(new Uint8Array(await built.blob.arrayBuffer()), store.host);

  assert.equal(res.imported, 2, 'both assets written to the user store');
  assert.equal(res.deduped, 0);
  assert.equal(res.toolId, 'demo-tool');
  assert.ok(store.slots.has(res.slot), 'a new session slot was minted');

  const s = res.session as { logo: { source: string; id: string }; bg: { source: string; id: string } };
  assert.equal(s.logo.source, 'user');
  assert.notEqual(s.logo.id, 'user/upload/aaa.png');            // re-keyed to a receiver-local id
  assert.ok(store.userStore.has(s.logo.id), 'the upload landed under its new id');
  assert.equal(s.bg.source, 'user', 'the carried catalog asset became a local user asset');
  assert.notEqual(s.bg.id, 'lolly-start/pattern/waves');
  assert.ok(store.userStore.has(s.bg.id));

  const back = store.userStore.get(s.logo.id)!;
  assert.deepEqual([...new Uint8Array(await back.blob!.arrayBuffer())], [...userPng], 'bytes are byte-exact through the round trip');
});

test('.lolly import dedups an asset already on the device (by checksum)', async () => {
  const png = PNG(7);
  const built = await buildLollyFile({
    session: { logo: { source: 'user', id: 'user/upload/dup.png', url: '' } },
    toolId: 'demo-tool',
    userAssets: [{ id: 'user/upload/dup.png', type: 'raster', format: 'png', blob: new Blob([png], { type: 'image/png' }), meta: { name: 'Dup' } }],
  });
  const store = memHost();
  const bytes = new Uint8Array(await built.blob.arrayBuffer());

  const first = await ingestLollyFile(bytes, store.host);
  assert.equal(first.imported, 1);
  const second = await ingestLollyFile(bytes, store.host);
  assert.equal(second.imported, 0, 'the second import writes no new asset row');
  assert.equal(second.deduped, 1, 'it is deduped by checksum');
  assert.equal(store.userStore.size, 1, 'only one copy of the bytes lives on the device');
  // Both imported sessions point at the same, single, receiver-local asset id.
  const a = (first.session as { logo: { id: string } }).logo.id;
  const b = (second.session as { logo: { id: string } }).logo.id;
  assert.equal(a, b);
});

test('applyLollyRekey leaves un-mapped and baked refs untouched', () => {
  const rekey = new Map([['user/upload/x.png', 'user/lolly/1']]);
  const out = applyLollyRekey({
    a: { source: 'user', id: 'user/upload/x.png', url: 'blob:x' },
    b: { source: 'library', id: 'suse/logo/primary', url: '' },          // not carried ⇒ left as a catalog ref
    c: { source: 'user', id: 'user/upload/x.png', url: '', meta: { baked: true } }, // baked ⇒ never rewritten
  }, rekey) as Record<'a' | 'b' | 'c', { source: string; id: string }>;
  assert.equal(out.a.source, 'user');
  assert.equal(out.a.id, 'user/lolly/1');
  assert.equal(out.b.source, 'library');
  assert.equal(out.b.id, 'suse/logo/primary');
  assert.equal(out.c.id, 'user/upload/x.png', 'a baked ref keeps its own bytes');
});

test('creatorFromProfile embeds identity only with the useDetails opt-in', () => {
  const optedOut = creatorFromProfile({ firstname: 'Ada', lastname: 'L', email: 'ada@x.io', org: 'ACME' }, { appVersion: 'Lolly 1.0.0' });
  assert.equal(optedOut.name, undefined, 'no name without opt-in');
  assert.equal(optedOut.email, undefined);
  assert.equal(optedOut.org, undefined);
  assert.equal(optedOut.createdWith, 'Lolly 1.0.0', 'the non-personal "made with" line always travels');

  const optedIn = creatorFromProfile({ firstname: 'Ada', lastname: 'L', useDetails: true }, { orgFallback: 'Contoso Inc' });
  assert.equal(optedIn.name, 'Ada L');
  assert.equal(optedIn.org, 'Contoso Inc', 'the instance name fills the org line when the user has none');
});
