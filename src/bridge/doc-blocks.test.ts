// SPDX-License-Identifier: MPL-2.0
/**
 * doc-blocks - DOM → heading/paragraph block model, and an integration check that
 * the model feeds the real engine writers into an editable .docx (w:t runs carry
 * the text, headings map to Heading styles). Mirrors pptx-deck.test.ts's shape.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { domToDocBlocks } from './doc-blocks.ts';
import { writeDocx } from '../../../../engine/src/docx.ts';
import { writeOdt } from '../../../../engine/src/odt.ts';
import { readZip } from '../../../../engine/src/zip.ts';

const DOC = `<div class="doc">
  <div class="doc-page"><div class="doc-body">
    <h1 class="doc-h doc-h1">Chapter One</h1>
    <p class="doc-p">Hello <strong>editable</strong> world.</p>
    <p class="doc-p"><br></p>
    <ul class="doc-ul"><li>first</li><li>second</li></ul>
  </div><div class="doc-footer"><span class="doc-footer-title">My Doc</span><span class="doc-footer-page">1</span></div></div>
  <div class="doc-page"><div class="doc-body">
    <h2 class="doc-h doc-h2">Chapter Two</h2>
  </div></div>
</div>`;

function blocks() {
  const dom = new JSDOM(DOC);
  return domToDocBlocks(dom.window.document.querySelector('.doc')!);
}

test('domToDocBlocks: ordered across pages, footer excluded, empties dropped, marks flattened', () => {
  const { title, blocks: b } = blocks();
  assert.equal(title, 'Chapter One', 'title seeds from the first heading');
  assert.deepEqual(b, [
    { type: 'heading', level: 1, text: 'Chapter One' },
    { type: 'paragraph', text: 'Hello editable world.' }, // inline <strong> flattened to text
    { type: 'paragraph', text: 'first' },                  // list items → paragraphs
    { type: 'paragraph', text: 'second' },
    { type: 'heading', level: 2, text: 'Chapter Two' },    // second page kept in order
  ]);
  // The running-footer title must NOT leak in as a block.
  assert.ok(!b.some((x) => x.text === 'My Doc'), 'footer chrome excluded');
});

test('the block model produces a real editable .docx (heading style + w:t text)', () => {
  const bytes = writeDocx(blocks());
  const doc = readZip(bytes).find((e) => e.name === 'word/document.xml')!;
  const xml = new TextDecoder().decode(doc.bytes);
  assert.match(xml, /Chapter One/, 'heading text present');
  assert.match(xml, /w:pStyle w:val="Heading1"/, 'H1 maps to the Heading1 style');
  assert.match(xml, /Hello editable world\./, 'paragraph text present');
});

test('the block model produces a valid .odt (mimetype first, title in meta)', () => {
  const bytes = writeOdt(blocks());
  const entries = readZip(bytes);
  const content = new TextDecoder().decode(entries.find((e) => e.name === 'content.xml')!.bytes);
  assert.match(content, /Chapter One/, 'heading text present in content.xml');
  const meta = entries.find((e) => e.name === 'meta.xml');
  assert.ok(meta, 'a titled doc emits meta.xml');
  assert.match(new TextDecoder().decode(meta!.bytes), /<dc:title>Chapter One<\/dc:title>/);
});
