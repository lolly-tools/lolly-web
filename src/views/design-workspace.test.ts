// SPDX-License-Identifier: MPL-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { designOutcome, inferDesignIntent, validDesignIntent } from './design-workspace.ts';

test('template intent chooses useful formats without treating posters as print', () => {
  assert.equal(inferDesignIntent({ templateId: 'slide-deck' }), 'slides');
  assert.equal(inferDesignIntent({ templateId: 'carousel' }), 'carousel');
  assert.equal(inferDesignIntent({ templateId: 'youtube-screencast' }), 'screencast');
  assert.equal(inferDesignIntent({ templateId: 'poster' }), 'general');
  assert.equal(designOutcome('slides', []).defaultFormat, 'pptx');
  assert.equal(designOutcome('video', []).defaultFormat, 'mp4');
});

test('older unmarked multi-artboard documents get a conservative intent', () => {
  assert.equal(inferDesignIntent({ boxes: [
    { kind: 'frame', w: 1080, h: 1350 }, { kind: 'frame', w: 1080, h: 1350 },
  ] }), 'carousel');
  assert.equal(inferDesignIntent({ boxes: [
    { kind: 'frame', w: 1920, h: 1080 }, { kind: 'frame', w: 1920, h: 1080 },
  ] }), 'slides');
  assert.equal(validDesignIntent('poster'), null);
});

test('outcome copy reports the real artboard fan-out count', () => {
  const out = designOutcome('carousel', [
    { kind: 'frame' }, { kind: 'frame' }, { kind: 'frame' }, { kind: 'text' },
  ]);
  assert.equal(out.downloadLabel, 'Download 3 images');
  assert.match(out.summary, /one file per artboard in a ZIP/);
});
