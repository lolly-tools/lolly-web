// SPDX-License-Identifier: MPL-2.0
/**
 * url-budget.ts is the pure, DOM-free source of truth for what the SHARE link
 * contains and what each part costs. This suite is the authoritative behavioural
 * guard (the source-scan in views/share-parity.test.ts cannot exercise the real
 * encoding): it pins encodeModelParam BYTE-FOR-BYTE against what buildShareParams
 * emitted before the extraction, covers every path the two encoders diverge on
 * (blocks raw separators, encodeURIComponent charset, vector N-expansion, hex-strip,
 * default-skip, file/table skip, over-cap drops), and checks costUrlState's length /
 * fidelity / target math.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTO_PACK_MIN,
  BLOCKS_CAP,
  SCALAR_CAP,
  QR_TARGET,
  costUrlState,
  encodeModelParam,
  fidelityFromParams,
} from './url-budget.ts';
import type { InputModelItem } from '../../../../engine/src/inputs.ts';
import type { AssetRef } from '@lolly-tools/core/host-v1';
import { blocksForUrl } from '@lolly/engine';
import { stripHiddenRowIds } from './row-id.ts';

// encodeModelParam only reads spec + value; a partial cast keeps the fixtures honest
// without fabricating an InputControl.
function mk(spec: Partial<InputModelItem> & { id: string; type: string }): InputModelItem {
  return { isDirty: false, value: undefined, ...spec } as unknown as InputModelItem;
}
const only = (item: InputModelItem) => {
  const rows = encodeModelParam(item);
  assert.equal(rows.length, 1, `expected a single row for ${item.id}`);
  return rows[0]!;
};

// ── scalars ────────────────────────────────────────────────────────────────────
test('scalar: kept value emits encodeURIComponent(key)=encodeURIComponent(value)', () => {
  const r = only(mk({ id: 'title', type: 'text', value: 'Hi there' }));
  assert.equal(r.emit, 'title=Hi%20there'); // space is %20 (encodeURIComponent), NOT '+'
  assert.equal(r.status, 'kept');
});

test('scalar: encodeURIComponent charset — tilde/quote stay literal, not %XX', () => {
  const r = only(mk({ id: 'k', type: 'text', value: "a~b'c" }));
  assert.equal(r.emit, "k=a~b'c"); // '~' and "'" are unreserved under encodeURIComponent
});

test('scalar: value equal to its declared default is skipped (status default, no emit)', () => {
  const r = only(mk({ id: 'x', type: 'text', value: 'a', default: 'a' }));
  assert.equal(r.status, 'default');
  assert.equal(r.emit, '');
});

test('scalar: empty string and boolean false are absent from the link', () => {
  assert.equal(only(mk({ id: 'x', type: 'text', value: '' })).status, 'default');
  assert.equal(only(mk({ id: 'b', type: 'boolean', value: false })).status, 'default');
  assert.equal(only(mk({ id: 'b', type: 'boolean', value: true })).emit, 'b=true');
});

test('scalar: a value over the 150-char cap is DROPPED (dropped-len), not truncated', () => {
  const r = only(mk({ id: 'blurb', type: 'longtext', value: 'x'.repeat(SCALAR_CAP + 1), label: 'Blurb' }));
  assert.equal(r.status, 'dropped-len');
  assert.equal(r.emit, '');
  assert.equal(r.label, 'Blurb');
});

// ── colour ──────────────────────────────────────────────────────────────────────
test('colour: a plain hex value drops its leading # (saves %23 per param)', () => {
  const r = only(mk({ id: 'bg', type: 'color', value: '#ff8800', urlKey: 'b' }));
  assert.equal(r.emit, 'b=ff8800');
});

test('colour: a token-backed value emits its canonical ref (never [object Object]), un-#-stripped', () => {
  // A colour input can hold a { ref, value } token object; it must serialise to the ref
  // so the link re-resolves against the recipient's tokens — the whole reason the
  // isTokenValue branch exists. A regression here would stamp %5Bobject%20Object%5D.
  const r = only(mk({ id: 'bg', type: 'color', value: { ref: 'color.brand.primary', value: '#123456' } }));
  assert.equal(r.emit, 'bg=color.brand.primary');
  assert.equal(r.status, 'kept');
});

// ── asset ─────────────────────────────────────────────────────────────────────
test('asset: a library ref shares by id; a user/* upload is dropped (dropped-asset)', () => {
  const lib = only(
    mk({ id: 'logo', type: 'asset', value: { source: 'library', id: 'suse/logo/primary', url: 'x' } as AssetRef }),
  );
  assert.equal(lib.emit, 'logo=suse%2Flogo%2Fprimary');
  assert.equal(lib.status, 'kept');

  const up = only(
    mk({ id: 'photo', type: 'asset', value: { source: 'user', id: 'user/uploads/9', url: 'blob:x' } as AssetRef, label: 'Photo' }),
  );
  assert.equal(up.status, 'dropped-asset');
  assert.equal(up.emit, '');
  assert.equal(up.label, 'Photo');
});

// ── blocks ──────────────────────────────────────────────────────────────────────
test('blocks: compact form emits with RAW separators and a RAW key (byte-exact)', () => {
  const fields = [
    { id: 'a', type: 'text' },
    { id: 'b', type: 'text' },
  ];
  const value = [
    { a: 'x', b: 'y' },
    { a: 'z', b: 'w' },
  ];
  const r = only(mk({ id: 'blk', type: 'blocks', value, fields } as unknown as Partial<InputModelItem> & { id: string; type: string }));
  // separators '~'/',' literal, key not encodeURIComponent'd — matches tool.ts:4130
  assert.equal(r.emit, 'blk=x,y~z,w');
  assert.equal(r.status, 'kept');
});

test('blocks: an encoded form over the 8000-char cap is dropped (dropped-blocks)', () => {
  const fields = [{ id: 'a', type: 'text' }];
  const value = [{ a: 'a'.repeat(BLOCKS_CAP + 100) }];
  const r = only(mk({ id: 'blk', type: 'blocks', value, fields, label: 'Rows' } as unknown as Partial<InputModelItem> & { id: string; type: string }));
  assert.equal(r.status, 'dropped-blocks');
});

test('blocks: empty array is absent from the link', () => {
  assert.equal(only(mk({ id: 'blk', type: 'blocks', value: [] })).status, 'default');
});

test('blocks: a value containing a comma forces the JSON fallback (encodeURIComponent, raw key)', () => {
  // encodeBlocksCompact bails to null when a value carries a '~'/',' separator, so the
  // emit switches to the encodeURIComponent'd JSON form — a completely different byte
  // path. Pin it end-to-end through the real blocksForUrl/stripHiddenRowIds transforms.
  const fields = [{ id: 'a', type: 'text' }];
  const value = [{ a: 'x,y' }];
  const r = only(mk({ id: 'blk', type: 'blocks', value, fields } as unknown as Partial<InputModelItem> & { id: string; type: string }));
  assert.equal(r.status, 'kept');
  assert.equal(r.emit, `blk=${encodeURIComponent(JSON.stringify(blocksForUrl(stripHiddenRowIds(value))))}`);
  assert.match(r.emit, /%/); // percent-encoded, unlike the raw compact form
});

test('blocks: no declared fields also takes the JSON fallback', () => {
  const value = [{ a: 'x' }];
  const r = only(mk({ id: 'blk', type: 'blocks', value, fields: [] } as unknown as Partial<InputModelItem> & { id: string; type: string }));
  assert.equal(r.status, 'kept');
  assert.equal(r.emit, `blk=${encodeURIComponent(JSON.stringify(blocksForUrl(stripHiddenRowIds(value))))}`);
});

// ── vector ────────────────────────────────────────────────────────────────────
test('vector: one flat "id.field" param per non-default field', () => {
  const fields = [
    { id: 'x', default: 0 },
    { id: 'y', default: 20 },
  ];
  const rows = encodeModelParam(
    mk({ id: 'pos', type: 'vector', value: { x: 10, y: 20 }, fields } as unknown as Partial<InputModelItem> & { id: string; type: string }),
  );
  const kept = rows.filter((r) => r.status === 'kept');
  assert.equal(kept.length, 1, 'y is at its default and must be omitted');
  assert.equal(kept[0]!.emit, 'pos.x=10');
});

// ── file / table (the latent-bug fix) ───────────────────────────────────────────
test('file and table inputs are skipped entirely (no [object Object] garbage in the link)', () => {
  assert.deepEqual(encodeModelParam(mk({ id: 'doc', type: 'file', value: { __file: true, path: 'x' } })), []);
  assert.deepEqual(encodeModelParam(mk({ id: 'grid', type: 'table', value: { columns: [], rows: [] } })), []);
});

// ── costUrlState: length + math ─────────────────────────────────────────────────
test('costUrlState: readableLen is the full URL, and Σcost + joinOverhead + baseLen reconciles', () => {
  const base = 'https://lolly.tools/t/qr-code?';
  const model = [
    mk({ id: 'a', type: 'text', value: 'hello' }),
    mk({ id: 'b', type: 'text', value: 'world' }),
  ];
  const m = costUrlState({ model, exportParts: [] }, { base });
  assert.equal(m.baseLen, base.length);
  assert.equal(m.readableLen, base.length + 'a=hello&b=world'.length);
  const keptCost = m.params.filter((p) => p.status === 'kept').reduce((s, p) => s + p.cost, 0);
  assert.equal(keptCost + m.joinOverhead + m.baseLen, m.readableLen);
  assert.equal(m.band, 'ok');
  assert.equal(m.changedCount, 2);
  assert.equal(m.totalCount, 2);
});

test('costUrlState: fidelity is a faithful projection of the dropped rows', () => {
  const model = [
    mk({ id: 'big', type: 'longtext', value: 'x'.repeat(SCALAR_CAP + 1), label: 'Big' }),
    mk({ id: 'img', type: 'asset', value: { source: 'user', id: 'user/u/1', url: 'x' } as AssetRef, label: 'Img' }),
  ];
  const m = costUrlState({ model, exportParts: [] });
  assert.equal(m.fidelity.faithful, false);
  assert.deepEqual(m.fidelity.droppedScalars, [{ id: 'big', label: 'Big' }]);
  assert.deepEqual(m.fidelity.excludedAssets, [{ id: 'img', label: 'Img' }]);
  // the projector and the model agree
  assert.deepEqual(fidelityFromParams(m.params), m.fidelity);
});

test('costUrlState: model rows carry removable/simplifiable flags the ledger drives off', () => {
  const model = [
    mk({ id: 't', type: 'text', value: 'hi' }),
    mk({ id: 'big', type: 'longtext', value: 'x'.repeat(SCALAR_CAP + 1) }),
  ];
  const m = costUrlState({ model, exportParts: [] });
  const t = m.params.find((p) => p.id === 't')!;
  assert.equal(t.removable, true);
  assert.equal(t.simplifiable, true);
  const big = m.params.find((p) => p.id === 'big')!; // dropped-len → neither
  assert.equal(big.removable, false);
  assert.equal(big.simplifiable, false);
});

test('costUrlState: counts dedup by id across vector rows; length identity survives non-kept rows', () => {
  const fields = [
    { id: 'x', default: 0 },
    { id: 'y', default: 20 },
  ];
  const model = [
    mk({ id: 'pos', type: 'vector', value: { x: 10, y: 20 }, fields } as unknown as Partial<InputModelItem> & { id: string; type: string }),
    mk({ id: 'big', type: 'longtext', value: 'x'.repeat(SCALAR_CAP + 1) }), // dropped
    mk({ id: 'name', type: 'text', value: 'ok' }),
  ];
  const base = 'https://lolly.tools/t/z?';
  const m = costUrlState({ model, exportParts: [] }, { base });
  assert.equal(m.totalCount, 3); // pos (its 2 rows share an id), big, name — deduped
  assert.equal(m.changedCount, 3); // pos changed (x off default), big changed (dropped), name changed
  const keptCost = m.params.filter((p) => p.status === 'kept').reduce((s, p) => s + p.cost, 0);
  assert.equal(keptCost + m.joinOverhead + m.baseLen, m.readableLen);
});

test('costUrlState: export parts are costed as output-category, non-removable rows', () => {
  const m = costUrlState({ model: [], exportParts: ['format=png', 'nostage'] });
  const fmt = m.params.find((p) => p.id === 'format')!;
  assert.equal(fmt.cost, 'format=png'.length);
  assert.equal(fmt.category, 'output');
  assert.equal(fmt.removable, false);
  const flag = m.params.find((p) => p.id === 'nostage')!;
  assert.equal(flag.emit, 'nostage'); // bare flag, no '='
});

test('costUrlState: target bands — qr warns then goes over its tight ceiling', () => {
  const warn = costUrlState({ model: [], exportParts: [`x=${'a'.repeat(290)}`] }, { target: QR_TARGET });
  assert.equal(warn.readableLen, 292);
  assert.equal(warn.band, 'warn'); // 260 ≤ 292 < 300
  assert.equal(warn.overBy, 292 - QR_TARGET.warn);

  const over = costUrlState({ model: [], exportParts: [`x=${'a'.repeat(310)}`] }, { target: QR_TARGET });
  assert.equal(over.band, 'over'); // ≥ 300
});

test('costUrlState: packable/regime flip at AUTO_PACK_MIN, packedLenEstimate stays null (sync)', () => {
  const big = costUrlState({ model: [], exportParts: [`x=${'a'.repeat(AUTO_PACK_MIN + 50)}`] });
  assert.equal(big.packedLenEstimate, null); // never computed synchronously
  assert.equal(big.regime, 'packed'); // readable is over the pack threshold
  const small = costUrlState({ model: [], exportParts: ['x=hi'] });
  assert.equal(small.regime, 'readable');
});

test('costUrlState: default is the browser target, reach public', () => {
  const m = costUrlState({ model: [], exportParts: [] });
  assert.equal(m.target.name, 'browser');
  assert.equal(m.reach, 'public');
});
