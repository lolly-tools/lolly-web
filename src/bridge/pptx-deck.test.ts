/**
 * Authored-deck-model lowering tests (the pure tool→native-pptx half).
 * Run under node:test. Covers colour parsing, px→EMU, defensive coercion of untrusted
 * tool JSON, and a full lowering → buildPptxParts integration so real OOXML is asserted.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deckColor, deckFill, deckPara, deckSyncShape, deckTheme, parseDeckModel, emuOf, asStr } from './pptx-deck.ts';
import { buildPptxParts, EMU_PER_PX } from '../../../../engine/src/pptx.ts';
import type { PptxTable, PptxText, PptxRect, PptxSlide } from '../../../../engine/src/pptx.ts';

test('deckColor parses hex (3/4/6/8), rgb, rgba; rejects junk', () => {
  assert.deepEqual(deckColor('#30BA78'), { hex: '30BA78', alpha: undefined });
  assert.deepEqual(deckColor('30ba78'), { hex: '30BA78', alpha: undefined });
  assert.deepEqual(deckColor('#3bf'), { hex: '33BBFF', alpha: undefined });          // shorthand expands
  assert.equal(deckColor('#3bf8')!.hex, '33BBFF');                                    // 4-digit → rgb + alpha
  assert.ok(Math.abs(deckColor('#3bf8')!.alpha! - 0x88 / 255) < 1e-6);
  assert.deepEqual(deckColor('rgb(48,186,120)'), { hex: '30BA78', alpha: undefined });
  assert.ok(Math.abs(deckColor('rgba(0,0,0,0.5)')!.alpha! - 0.5) < 1e-6);
  assert.equal(deckColor('transparent'), null);
  assert.equal(deckColor('rgba(0,0,0,0)'), null);
  assert.equal(deckColor('not-a-color'), null);
  assert.equal(deckColor(42), null);
});

test('emuOf converts px→EMU and is NaN-safe', () => {
  assert.equal(emuOf(96), Math.round(96 * EMU_PER_PX));
  assert.equal(emuOf(NaN, 10), Math.round(10 * EMU_PER_PX));
  assert.equal(emuOf('x' as unknown, 0), 0);
});

test('deckFill handles a solid colour and a gradient; needs ≥2 stops', () => {
  assert.deepEqual(deckFill('#000000'), { solid: '000000', alpha: undefined });
  const g = deckFill({ grad: { stops: [{ pos: 0, color: '#fff' }, { pos: 1, color: '#000' }], angle: 90 } });
  assert.ok(g && 'grad' in g && g.grad.length === 2 && g.angle === 90);
  assert.equal(deckFill({ grad: { stops: [{ pos: 0, color: '#fff' }] } }), undefined); // 1 stop → none
  assert.equal(deckFill('bogus'), undefined);
});

test('deckPara lowers bullets/levels/spacing and drops unknown bullet shapes', () => {
  const p = deckPara({ align: 'ctr', level: 2, bullet: 'number', lineSpacingPct: 150, spaceBeforePt: 6, runs: [{ text: 'x', sizePt: 14, underline: true }] });
  assert.equal(p.align, 'ctr'); assert.equal(p.level, 2); assert.equal(p.bullet, 'number');
  assert.equal(p.lineSpacingPct, 150); assert.equal(p.spaceBeforePt, 6);
  assert.equal(p.runs[0]!.underline, true);
  assert.deepEqual(deckPara({ bullet: { char: '★' }, runs: [] }).bullet, { char: '★' });
  assert.equal(deckPara({ bullet: 'weird', runs: [] }).bullet, undefined);            // junk bullet dropped
  assert.equal(deckPara({ align: 'diagonal', runs: [] }).align, undefined);           // junk align dropped
});

test('deckSyncShape builds rect/text/table; image and unknown → null', () => {
  const rect = deckSyncShape({ t: 'rect', x: 10, y: 20, w: 100, h: 50, fill: '#123456', radius: 8 }) as PptxRect;
  assert.equal(rect.kind, 'rect'); assert.equal(rect.x, emuOf(10)); assert.equal(rect.cx, emuOf(100));
  assert.deepEqual(rect.fill, { solid: '123456', alpha: undefined });

  const text = deckSyncShape({ t: 'text', x: 0, y: 0, w: 200, h: 40, anchor: 'ctr', paras: [{ runs: [{ text: 'hi', sizePt: 18 }] }] }) as PptxText;
  assert.equal(text.kind, 'text'); assert.equal(text.anchor, 'ctr'); assert.equal(text.paras[0]!.runs[0]!.text, 'hi');

  const table = deckSyncShape({ t: 'table', x: 0, y: 0, w: 300, h: 100, firstRow: true, cols: [150, 150],
    rows: [{ cells: [{ text: 'A', bold: true, fill: '#eee' }, { text: 'B', colSpan: 1 }] }] }) as PptxTable;
  assert.equal(table.kind, 'table'); assert.equal(table.cols.length, 2); assert.equal(table.firstRow, true);
  assert.equal(table.rows[0]!.cells[0]!.text, 'A'); assert.equal(table.rows[0]!.cells[0]!.fill, 'EEEEEE');

  assert.equal(deckSyncShape({ t: 'image', src: 'x' }), null);   // async → caller
  assert.equal(deckSyncShape({ t: 'bogus' }), null);
  assert.equal(deckSyncShape({} as Record<string, unknown>), null);
});

test('deckTheme maps css colours→hex + fonts; empty → undefined', () => {
  const t = deckTheme({ name: 'SUSE', colors: { accent1: '#30BA78', dk2: 'rgb(12,50,44)' }, fonts: { major: 'SUSE' } });
  assert.equal(t!.name, 'SUSE'); assert.equal(t!.colors!.accent1, '30BA78'); assert.equal(t!.colors!.dk2, '0C322C');
  assert.equal(t!.fonts!.major, 'SUSE');
  assert.equal(deckTheme({}), undefined);
  assert.equal(deckTheme(null), undefined);
});

test('parseDeckModel accepts a valid deck, rejects blanks/malformed/empty-slides', () => {
  assert.ok(parseDeckModel('{"slides":[{"elements":[]}]}'));
  assert.equal(parseDeckModel('{"slides":[]}'), null);   // empty slides → DOM-walk fallback
  assert.equal(parseDeckModel('not json'), null);
  assert.equal(parseDeckModel(''), null);
  assert.equal(parseDeckModel(null), null);
  assert.equal(parseDeckModel('{"nope":1}'), null);
});

test('asStr guards non-strings', () => {
  assert.equal(asStr('a'), 'a');
  assert.equal(asStr(1), undefined);
  assert.equal(asStr(undefined), undefined);
});

// ── integration: a lowered deck produces valid OOXML via the engine ──────────
test('a lowered deck flows through buildPptxParts to real DrawingML', () => {
  const model = parseDeckModel(JSON.stringify({
    size: { w: 1280, h: 720 },
    theme: { colors: { accent1: '#30BA78' }, fonts: { major: 'SUSE' } },
    slides: [{
      bg: '#0C322C',
      notes: 'hi',
      elements: [
        { t: 'text', x: 80, y: 80, w: 1120, h: 120, paras: [{ runs: [{ text: 'Title', sizePt: 40, bold: true, color: '#FFFFFF' }] }] },
        { t: 'table', x: 80, y: 240, w: 1120, h: 200, firstRow: true, cols: [560, 560],
          rows: [{ cells: [{ text: 'H', fill: '#30BA78', colSpan: 2 }] }, { cells: [{ text: 'a' }, { text: 'b' }] }] },
      ],
    }],
  }))!;
  // Lower exactly as renderPptxFromDeck does (minus async images).
  const shapes = [] as PptxSlide['shapes'];
  const bg = deckFill((model.slides as Record<string, unknown>[])[0]!.bg);
  if (bg) shapes.push({ kind: 'rect', x: 0, y: 0, cx: emuOf(1280), cy: emuOf(720), fill: bg });
  for (const el of (model.slides as Record<string, unknown>[])[0]!.elements as Record<string, unknown>[]) {
    const s = deckSyncShape(el); if (s) shapes.push(s);
  }
  const slide: PptxSlide = { shapes, media: [], notes: asStr((model.slides as Record<string, unknown>[])[0]!.notes) };
  const parts = buildPptxParts([slide], { emuW: emuOf(1280), emuH: emuOf(720), theme: deckTheme(model.theme) });
  const xml = parts['ppt/slides/slide1.xml'] as string;
  assert.match(xml, /<a:t>Title<\/a:t>/);
  assert.match(xml, /<a:tbl>/);
  assert.match(xml, /<a:tc gridSpan="2">/);
  assert.match(xml, /<a:srgbClr val="0C322C"\/>/);       // bg rect
  assert.match(parts['ppt/theme/theme1.xml'] as string, /<a:accent1><a:srgbClr val="30BA78"\/>/);
  assert.match(parts['ppt/theme/theme1.xml'] as string, /typeface="SUSE"/);
  assert.ok('ppt/notesSlides/notesSlide1.xml' in parts);
});

// ── adversarial-verify Phase-2 findings (B1, M4, M5) ─────────────────────────
test('B1: a malformed rgb() never emits a NaN hex channel', () => {
  // '.' / '1.2.3' parse to NaN via unary-plus; hex2 must degrade to 00, not "NAN".
  for (const bad of ['rgb(.,.,.)', 'rgb(1.2.3,4,5)', 'rgba(.,0,0,1)']) {
    const c = deckColor(bad);
    assert.ok(c, `${bad} still parses`);
    assert.match(c!.hex, /^[0-9A-F]{6}$/, `${bad} → valid 6-hex, got ${c!.hex}`);
    assert.doesNotMatch(c!.hex, /NAN/);
  }
  assert.equal(deckColor('rgb(.,.,.)')!.hex, '000000');
});

test('M5: emuOf clamps an absurd coordinate to the ST_Coordinate bound', () => {
  const ST_MAX = 27273042316900;
  assert.ok(emuOf(1e12) <= ST_MAX && emuOf(1e12) > 0);
  assert.ok(emuOf(-1e12) >= -ST_MAX && emuOf(-1e12) < 0);
  assert.equal(emuOf(96), Math.round(96 * (914400 / 96))); // normal value untouched
});

test('M4: table rows/cols are capped at the engine limits', () => {
  const cols = Array.from({ length: 1000 }, () => 100);
  const rows = Array.from({ length: 5000 }, () => ({ cells: [{ text: 'x' }] }));
  const t = deckSyncShape({ t: 'table', x: 0, y: 0, w: 500, h: 500, cols, rows }) as PptxTable;
  assert.ok(t.cols.length <= 128, `cols capped, got ${t.cols.length}`);
  assert.ok(t.rows.length <= 512, `rows capped, got ${t.rows.length}`);
});
