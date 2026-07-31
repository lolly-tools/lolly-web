// SPDX-License-Identifier: MPL-2.0
/**
 * Unit tests for videoSupport()'s WebCodecs-OR gate.
 *
 * Runs under node: no MediaRecorder / VideoEncoder globals exist, so the module's
 * load-time probe is a no-op and both halves of the gate start false. Each test
 * drives probeWebCodecsVideoSupport through its injectable encoder (or installs a
 * MediaRecorder-shaped global) and asserts what the sync gate reports. The probe
 * cache is module state, so the tests are ordered: each one overwrites it.
 *
 * Run directly:  node --test shells/web/src/bridge/format-support.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeWebCodecsVideoSupport, videoSupport } from './format-support.ts';

/** VideoEncoder.isConfigSupported stub: supported iff the codec matches `re`. */
const stubVE = (re: RegExp, log: string[] = []) => ({
  isConfigSupported: async (c: { codec?: string; width?: number; height?: number }) => {
    log.push(c.codec ?? '');
    assert.equal(typeof c.width, 'number');
    assert.equal(typeof c.height, 'number');
    return { supported: re.test(c.codec ?? '') };
  },
});

test('videoSupport: before any probe resolves it reports the MediaRecorder-only answer (both false in node)', () => {
  assert.deepEqual(videoSupport(), { webm: false, mp4: false });
});

test('videoSupport: a WebCodecs AVC-only encoder unlocks mp4 (not webm) once the probe resolves', async () => {
  const codecs: string[] = [];
  await probeWebCodecsVideoSupport(stubVE(/^avc1\./, codecs));
  assert.deepEqual(videoSupport(), { webm: false, mp4: true });
  // The probe tries the same candidates renderVideo's pickWebCodecsVideo does.
  assert.deepEqual(codecs.sort(), ['avc1.4d0033', 'avc1.640033', 'vp09.00.10.08', 'vp8']);
});

test('videoSupport: a VP-only encoder unlocks webm and revokes the stale mp4 answer', async () => {
  await probeWebCodecsVideoSupport(stubVE(/^vp/));
  assert.deepEqual(videoSupport(), { webm: true, mp4: false });
});

test('probeWebCodecsVideoSupport: a throwing isConfigSupported reads as unsupported, never rejects', async () => {
  const result = await probeWebCodecsVideoSupport({ isConfigSupported: async () => { throw new Error('nope'); } });
  assert.deepEqual(result, { webm: false, mp4: false });
  assert.deepEqual(videoSupport(), { webm: false, mp4: false });
});

test('probeWebCodecsVideoSupport: no VideoEncoder leaves the cache untouched', async () => {
  await probeWebCodecsVideoSupport(stubVE(/^avc1\./));
  const before = videoSupport();
  await probeWebCodecsVideoSupport(undefined);
  assert.deepEqual(videoSupport(), before);
});

test('videoSupport: MediaRecorder and the WebCodecs cache OR together per container', async () => {
  await probeWebCodecsVideoSupport(stubVE(/^avc1\./));   // WebCodecs: mp4 only
  const g = globalThis as any;
  const saved = { MediaRecorder: g.MediaRecorder, HTMLCanvasElement: g.HTMLCanvasElement };
  class FakeCanvas {}
  (FakeCanvas.prototype as any).captureStream = () => ({});
  g.HTMLCanvasElement = FakeCanvas;
  g.MediaRecorder = { isTypeSupported: (t: string) => t.includes('webm') };  // recorder: webm only
  try {
    assert.deepEqual(videoSupport(), { webm: true, mp4: true });
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete g[k]; else g[k] = v; }
  }
});
