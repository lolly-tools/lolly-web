// SPDX-License-Identifier: MPL-2.0
// The pure half of the generated text thumbnails: size buckets, the focused
// excerpt, and the model built from a real analysis. The mount (fetch, observer,
// palette) is DOM/network and belongs to a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { textThumbSize, textThumbExcerpt, textThumbModel, type ThumbMark } from './text-thumbs.ts';

test('textThumbSize: document length picks the type scale, quote to wall', () => {
  assert.equal(textThumbSize(40), 'xl');
  assert.equal(textThumbSize(200), 'lg');
  assert.equal(textThumbSize(600), 'md');
  assert.equal(textThumbSize(5000), 'sm');
});

test('excerpt with no marks: the head of the text, ellipsis only at the cut end', () => {
  const text = `${'word '.repeat(200)}end`;
  const runs = textThumbExcerpt(text, []);
  assert.notEqual(runs[0]?.text, '… ', 'no leading ellipsis at the start of a document');
  assert.equal(runs[runs.length - 1]?.text, ' …', 'a cut tail is marked');
  assert.ok(runs.every((r) => r.bucket == null));
});

test('excerpt focuses the hottest mark with context before and after', () => {
  const before = 'plain human words '.repeat(40);   // ~720 chars of preamble
  const flagged = 'FLAGGEDSPAN';
  const after = ' more ordinary words follow here '.repeat(10);
  const text = before + flagged + after;
  const marks: ThumbMark[] = [
    { index: 4, length: 5, heat: 0.3 },                       // a cool early mark
    { index: before.length, length: flagged.length, heat: 0.9 }, // the hot focus
  ];
  const runs = textThumbExcerpt(text, marks);
  assert.equal(runs[0]?.text, '… ', 'a mid-document focus opens with an ellipsis');
  const hot = runs.find((r) => r.bucket === 5);
  assert.ok(hot, 'the hot span is present and bucketed t5');
  assert.equal(hot?.text, flagged);
  const joined = runs.map((r) => r.text).join('');
  assert.ok(joined.includes('words ' + flagged), 'context before the span survives');
  assert.ok(joined.includes(flagged + ' more'), 'context after the span survives');
});

test('excerpt runs reassemble to a contiguous slice of the source', () => {
  const text = `${'alpha beta gamma '.repeat(30)}delta`;
  const marks: ThumbMark[] = [{ index: 200, length: 10, heat: 0.6 }];
  const runs = textThumbExcerpt(text, marks).filter((r) => r.text !== '… ' && r.text !== ' …');
  const joined = runs.map((r) => r.text).join('');
  assert.ok(text.includes(joined), 'no dropped or duplicated characters inside the window');
});

test('textThumbModel: AI-flavoured text yields bucketed runs and a score; plain text stays calm', () => {
  const ai = "In today's ever-evolving landscape it's important to note that we must delve into the "
    + 'rich tapestry of modern tools. A robust and seamless approach will foster a holistic '
    + 'workflow that showcases how teams leverage comprehensive systems to garner results.';
  const m = textThumbModel(ai, ai.length);
  assert.ok(m.score >= 45, `expected notable+, got ${m.score}`);
  assert.ok(m.runs.some((r) => r.bucket != null), 'flagged spans reach the excerpt');
  const human = 'The cat sat on the mat and watched the rain.';
  const h = textThumbModel(human, human.length);
  assert.equal(h.band, 'none');
  assert.ok(h.runs.every((r) => r.bucket == null));
  assert.equal(h.size, 'xl');
});
