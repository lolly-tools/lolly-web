// SPDX-License-Identifier: MPL-2.0
/**
 * Unit tests for the DOM-free video-encode scheduling — the timestamp / keyframe /
 * PCM-chunk math the WebCodecs encode loop (export.ts) and a future worker-side encoder
 * both consume. The real VideoEncoder/AudioEncoder run only in a browser; this pins the
 * pure schedule they're driven by.
 *
 * Run directly:  node --test shells/web/src/bridge/video-mime.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { videoBitrate, videoFrameSchedule, audioChunkSchedule } from './video-mime.ts';

test('videoBitrate: scales with pixels×fps, clamped to 1–24 Mbps', () => {
  assert.equal(videoBitrate(1, 1, 1), 1_000_000);              // floor
  assert.equal(videoBitrate(10000, 10000, 60), 24_000_000);    // ceiling
  assert.equal(videoBitrate(1920, 1080, 30), Math.round(1920 * 1080 * 30 * 0.1));
});

test('videoFrameSchedule: µs timestamps + ~2s keyframe cadence', () => {
  const s = videoFrameSchedule(50, 24);
  assert.equal(s.length, 50);
  assert.deepEqual(s[0], { index: 0, timestampUs: 0, durationUs: Math.round(1e6 / 24), keyFrame: true });
  assert.equal(s[1]!.timestampUs, Math.round(1e6 / 24));
  // keyEvery = round(24*2) = 48 → keyframes at 0 and 48 only
  assert.deepEqual(s.filter((t) => t.keyFrame).map((t) => t.index), [0, 48]);
});

test('videoFrameSchedule: 0 frames → [], fps floored at 1', () => {
  assert.deepEqual(videoFrameSchedule(0, 30), []);
  assert.equal(videoFrameSchedule(1, 0)[0]!.durationUs, 1e6);   // fps clamped to 1
});

test('audioChunkSchedule: partitions frames, last chunk is the remainder', () => {
  const c = audioChunkSchedule(11_000, 48_000, 4800);
  assert.equal(c.length, 3);
  assert.deepEqual(c.map((x) => x.numFrames), [4800, 4800, 1400]);
  assert.equal(c[0]!.timestampUs, 0);
  assert.equal(c[1]!.timestampUs, Math.round((4800 / 48_000) * 1e6));
  assert.equal(c[2]!.offsetFrames, 9600);
});

test('audioChunkSchedule: exact multiple has no trailing empty chunk', () => {
  const c = audioChunkSchedule(9600, 48_000, 4800);
  assert.equal(c.length, 2);
  assert.equal(c[1]!.numFrames, 4800);
});
