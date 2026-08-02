// SPDX-License-Identifier: MPL-2.0
/**
 * markdownToSpokenText is the dialog's one pure piece — the rest is element
 * wiring over host.speech, verified in a real browser. What matters here is the
 * speech contract: structure goes, words stay, and nothing unspeakable (code,
 * image URLs, table plumbing) leaks into the synthesized clip.
 *
 * The module imports its stylesheet (a Vite-only construct), so the run relies
 * on the stylesheet-import stub the `test` script registers (tests/css-stub.mjs).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markdownToSpokenText, SOFT_CHAR_CAP } from './script-audio.ts';

test('plain text passes through unchanged', () => {
  assert.equal(markdownToSpokenText('Hello there. Two sentences.'), 'Hello there. Two sentences.');
});

test('empty and whitespace-only input come back empty', () => {
  assert.equal(markdownToSpokenText(''), '');
  assert.equal(markdownToSpokenText('   \n\t\n  '), '');
});

test('fenced code blocks drop entirely, including an unterminated one', () => {
  assert.equal(
    markdownToSpokenText('Before.\n```js\nconst x = 1;\n```\nAfter.'),
    'Before.\nAfter.',
  );
  assert.equal(markdownToSpokenText('Before.\n```\nnever closed'), 'Before.');
});

test('images drop, links keep their text', () => {
  assert.equal(
    markdownToSpokenText('See ![a chart](chart.png) and [the docs](https://example.com/docs).'),
    'See and the docs.',
  );
});

test('inline code keeps its content, loses the ticks', () => {
  assert.equal(markdownToSpokenText('Run `npm install` first.'), 'Run npm install first.');
});

test('headings keep their text', () => {
  assert.equal(markdownToSpokenText('## Welcome\n\nBody text.'), 'Welcome\n\nBody text.');
});

test('quote and list markers strip, the words stay', () => {
  assert.equal(
    markdownToSpokenText('> A quote.\n- First\n- Second\n1. Third\n2) Fourth'),
    'A quote.\nFirst\nSecond\nThird\nFourth',
  );
});

test('emphasis markers strip pairwise', () => {
  assert.equal(
    markdownToSpokenText('This is **bold**, *italic*, __also bold__ and ~~gone~~.'),
    'This is bold, italic, also bold and gone.',
  );
});

test('a lone underscore inside a word survives', () => {
  assert.equal(markdownToSpokenText('The snake_case name stays.'), 'The snake_case name stays.');
});

test('horizontal rules drop and are not read as list items', () => {
  assert.equal(markdownToSpokenText('Above.\n\n---\n\nBelow.'), 'Above.\n\nBelow.');
  assert.equal(markdownToSpokenText('Above.\n- - -\nBelow.'), 'Above.\nBelow.');
});

test('table separator rows drop and cell pipes become spaces', () => {
  assert.equal(
    markdownToSpokenText('| Name | Role |\n| --- | --- |\n| Ada | Engineer |'),
    'Name Role\nAda Engineer',
  );
});

test('runs of blank lines collapse to one', () => {
  assert.equal(markdownToSpokenText('One.\n\n\n\nTwo.'), 'One.\n\nTwo.');
});

test('the soft cap is exported and sane', () => {
  assert.equal(typeof SOFT_CHAR_CAP, 'number');
  assert.ok(SOFT_CHAR_CAP >= 1000);
});
