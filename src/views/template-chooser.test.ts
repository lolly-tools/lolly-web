// SPDX-License-Identifier: MPL-2.0
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseTemplates, templateValuesById } from './template-chooser.ts';

// A manifest `templates[]` as it arrives off the loaded manifest (typed unknown[]).
const RAW = [
  {
    id: 'poster',
    name: 'Poster',
    category: 'Poster',
    description: 'One frame filling the canvas.',
    values: { boxes: [{ id: 'frame', kind: 'frame', x: 0, y: 0, w: 1080, h: 1080 }] },
  },
  {
    id: 'carousel',
    name: 'Carousel',
    category: 'Carousel',
    values: {
      boxes: [
        { id: 'slide1', kind: 'frame', x: 0 },
        { id: 'slide2', kind: 'frame', x: 1120 },
        { id: 'slide3', kind: 'frame', x: 2240 },
      ],
    },
  },
];

test('parseTemplates: keeps well-formed entries and their full values seed', () => {
  const parsed = parseTemplates(RAW);
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed.map(t => t.id), ['poster', 'carousel']);
  assert.equal(parsed[0]!.name, 'Poster');
  assert.equal(parsed[0]!.category, 'Poster');
  // values passes through verbatim — any size, read directly into the fresh session.
  const boxes = (parsed[1]!.values.boxes as unknown[]);
  assert.equal(boxes.length, 3);
});

test('parseTemplates: drops malformed entries rather than throwing', () => {
  const parsed = parseTemplates([
    { id: 'ok', name: 'OK', values: {} },
    { name: 'no-id', values: {} },      // missing id
    { id: 'no-name', values: {} },      // missing name
    { id: 'dup', name: 'A', values: {} },
    { id: 'dup', name: 'B', values: {} }, // duplicate id — first wins
    null,
    'nonsense',
    { id: 'bad-values', name: 'Bad', values: [1, 2] }, // array values → {}
  ]);
  assert.deepEqual(parsed.map(t => t.id), ['ok', 'dup', 'bad-values']);
  assert.equal(parsed.find(t => t.id === 'dup')!.name, 'A');
  assert.deepEqual(parsed.find(t => t.id === 'bad-values')!.values, {});
});

test('parseTemplates: non-array input is empty (a tool without templates[])', () => {
  assert.deepEqual(parseTemplates(undefined), []);
  assert.deepEqual(parseTemplates(null), []);
  assert.deepEqual(parseTemplates({}), []);
});

test('templateValuesById: resolves the reserved ?template=<id> seed, null on miss', () => {
  const seed = templateValuesById(RAW, 'carousel');
  assert.ok(seed);
  assert.equal((seed!.boxes as unknown[]).length, 3);
  assert.equal(templateValuesById(RAW, 'nope'), null);
  assert.equal(templateValuesById(undefined, 'poster'), null);
});
