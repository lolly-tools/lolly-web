// SPDX-License-Identifier: MPL-2.0
/**
 * WP-G - streaming on-device video processing (lib/video-jobs.ts).
 *
 * Run:  node --import ./tests/css-stub.mjs --test shells/web/src/lib/video-jobs.test.ts
 *
 * jsdom with a real origin so the i18n chain the module pulls in never trips on
 * about:blank. No real codecs exist under node, so the pipeline is driven with a
 * SYNTHETIC frame source (a fake decoder/encoder pair injected through the deps).
 *
 * What is pinned:
 *   - the frame loop: decode → op → encode, progress reported, cancellation stops
 *     the loop between frames,
 *   - the matte temporal smoother: EMA smooths a steady shot, a luma-histogram
 *     scene cut resets it,
 *   - even-dimension crop rounding + the pure crop,
 *   - the provenance branch per op (matte/crop → plain edit, upscale → genAI
 *     partial) and the source carried as an ingredient,
 *   - the saved record: type/format/animated/aiGenerated per op.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://lolly.tools/' });
globalThis.window = dom.window as unknown as typeof globalThis.window;
globalThis.document = dom.window.document;

const {
  runFramePipeline, MatteAlphaSmoother, lumaHistogram, histogramDelta, SCENE_CUT_THRESHOLD,
  evenFloor, roundCropRect, cropFrame, videoProvenanceFor, runVideoJob, matteOutputFrames,
  extrapolateEstimate, scaledEvenDims, MATTE_MAX_OUTPUT_FRAMES,
  resizeFrameRGBA, makeChromaKeyOp, CHROMA_DEFAULT_KEY, clampMatteLongEdge, MATTE_MAX_INPUT_LONG_EDGE,
} = await import('./video-jobs.ts');
const { COMPOSITE_SOURCE_TYPE } = await import('@lolly/engine');

type Frame = { data: Uint8ClampedArray; width: number; height: number; timestampUs: number; durationUs: number };

/** A synthetic reader yielding `n` solid-colour frames. */
function fakeReader(n: number, width = 4, height = 4, fill = 128): {
  width: number; height: number; fps: number; frameCount: number;
  read(): AsyncGenerator<Frame, void, unknown>; close(): void; closed: boolean;
} {
  const state = { closed: false };
  return {
    width, height, fps: 12, frameCount: n, closed: false,
    async *read() {
      for (let i = 0; i < n; i++) {
        const data = new Uint8ClampedArray(width * height * 4).fill(fill);
        for (let p = 3; p < data.length; p += 4) data[p] = 255;
        yield { data, width, height, timestampUs: Math.round((i / 12) * 1e6), durationUs: Math.round(1e6 / 12) };
      }
    },
    close() { state.closed = true; (this as { closed: boolean }).closed = true; },
  };
}

/** A synthetic writer collecting frames. */
function fakeWriter(format = 'mp4'): {
  frames: Frame[]; aborted: boolean;
  write(f: Frame): void; finalize(): Promise<{ blob: Blob; format: string; width: number; height: number }>; abort(): void;
} {
  const frames: Frame[] = [];
  const w = {
    frames, aborted: false,
    write(f: Frame) { frames.push(f); },
    async finalize() { const f = frames[0]; return { blob: new Blob(['x']), format, width: f?.width ?? 0, height: f?.height ?? 0 }; },
    abort() { w.aborted = true; },
  };
  return w;
}

// ── the frame loop ────────────────────────────────────────────────────────────

test('pipeline: every frame flows decode → op → encode, progress reported', async () => {
  const reader = fakeReader(5);
  const writer = fakeWriter();
  const seen: Array<[number, number]> = [];
  const res = await runFramePipeline(reader, (f) => f, writer, { onProgress: (d, t) => seen.push([d, t]) });
  assert.equal(res.cancelled, false);
  assert.equal(writer.frames.length, 5);
  assert.deepEqual(seen, [[1, 5], [2, 5], [3, 5], [4, 5], [5, 5]]);
  assert.ok(res.result && res.result.format === 'mp4');
});

test('pipeline: the op transforms each frame (identity vs a real change)', async () => {
  const reader = fakeReader(3);
  const writer = fakeWriter();
  await runFramePipeline(reader, (f) => ({ ...f, width: 2, height: 2, data: new Uint8ClampedArray(2 * 2 * 4) }), writer);
  assert.ok(writer.frames.every((f) => f.width === 2 && f.height === 2));
});

test('pipeline: cancellation stops the loop between frames and aborts the writer', async () => {
  const reader = fakeReader(10);
  const writer = fakeWriter();
  let done = 0;
  const res = await runFramePipeline(reader, (f) => f, writer, {
    onProgress: () => { done++; },
    isCancelled: () => done >= 2, // cancel AFTER the 2nd frame's progress
  });
  assert.equal(res.cancelled, true);
  assert.equal(res.result, undefined);
  assert.equal(writer.frames.length, 2); // 3rd iteration's cancel check fires before the op
  assert.equal(writer.aborted, true);
});

// ── matte temporal smoother (EMA + scene-cut) ──────────────────────────────────

test('lumaHistogram + histogramDelta: identical frames → 0, black vs white → 1', () => {
  const black = new Uint8ClampedArray(16 * 4); // all 0 rgb
  for (let i = 3; i < black.length; i += 4) black[i] = 255;
  const white = new Uint8ClampedArray(16 * 4).fill(255);
  const hb = lumaHistogram(black);
  const hw = lumaHistogram(white);
  assert.equal(histogramDelta(hb, hb), 0);
  assert.ok(Math.abs(histogramDelta(hb, hw) - 1) < 1e-9);
  assert.ok(histogramDelta(hb, hw) > SCENE_CUT_THRESHOLD);
});

test('MatteAlphaSmoother: EMA smooths a steady shot (new = 0.6·prev + 0.4·cur)', () => {
  const s = new MatteAlphaSmoother();
  // Frame 1: RGB 128, alpha 200. First frame is a cut → alpha untouched.
  const f1 = { data: new Uint8ClampedArray(4 * 4 * 4), width: 4, height: 4 };
  f1.data.fill(128); for (let i = 3; i < f1.data.length; i += 4) f1.data[i] = 200;
  s.apply(f1);
  assert.equal(s.lastWasCut, true);
  assert.equal(f1.data[3], 200);
  // Frame 2: SAME rgb (128 → identical histogram, not a cut), alpha 100 → blend.
  const f2 = { data: new Uint8ClampedArray(4 * 4 * 4), width: 4, height: 4 };
  f2.data.fill(128); for (let i = 3; i < f2.data.length; i += 4) f2.data[i] = 100;
  s.apply(f2);
  assert.equal(s.lastWasCut, false);
  assert.equal(f2.data[3], Math.round(0.6 * 200 + 0.4 * 100)); // 160
});

test('MatteAlphaSmoother: a scene cut (luma jump) resets the EMA — alpha unblended', () => {
  const s = new MatteAlphaSmoother();
  const black = { data: new Uint8ClampedArray(4 * 4 * 4), width: 4, height: 4 };
  for (let i = 3; i < black.data.length; i += 4) black.data[i] = 220; // rgb 0, alpha 220
  s.apply(black);
  const white = { data: new Uint8ClampedArray(4 * 4 * 4).fill(255), width: 4, height: 4 };
  for (let i = 3; i < white.data.length; i += 4) white.data[i] = 80; // rgb 255, alpha 80
  s.apply(white);
  assert.equal(s.lastWasCut, true);
  assert.equal(white.data[3], 80); // used as-is, no blend across the cut
});

// ── even-dimension crop rounding ───────────────────────────────────────────────

test('evenFloor: rounds down to an even value ≥ 2', () => {
  assert.equal(evenFloor(11), 10);
  assert.equal(evenFloor(10), 10);
  assert.equal(evenFloor(1), 2);
  assert.equal(evenFloor(0), 2);
  assert.equal(evenFloor(3), 2);
});

test('roundCropRect: even offsets + even lengths, clamped inside the frame', () => {
  const r = roundCropRect({ x: 3, y: 5, w: 101, h: 51 }, 200, 100);
  assert.equal(r.x % 2, 0);
  assert.equal(r.y % 2, 0);
  assert.equal(r.w % 2, 0);
  assert.equal(r.h % 2, 0);
  assert.ok(r.x + r.w <= 200 && r.y + r.h <= 100);
  // An oversized rect is clamped to the frame.
  const full = roundCropRect({ x: 0, y: 0, w: 999, h: 999 }, 640, 360);
  assert.deepEqual(full, { x: 0, y: 0, w: 640, h: 360 });
});

test('cropFrame: copies the rect out into a smaller RGBA buffer', () => {
  // 4×2 frame, distinct rows; crop the bottom-left 2×2.
  const f = { data: new Uint8ClampedArray(4 * 2 * 4), width: 4, height: 2, timestampUs: 0, durationUs: 1 };
  for (let i = 0; i < f.data.length; i += 4) { f.data[i] = i; f.data[i + 3] = 255; }
  const out = cropFrame(f as never, { x: 0, y: 0, w: 2, h: 2 });
  assert.equal(out.width, 2);
  assert.equal(out.height, 2);
  assert.equal(out.data.length, 2 * 2 * 4);
  assert.equal(out.data[0], f.data[0]); // top-left pixel preserved
});

// ── provenance branches ────────────────────────────────────────────────────────

test('videoProvenanceFor: matte = plain c2pa.edited, no aiGenerated', () => {
  const p = videoProvenanceFor('matte', { model: 'U²-Net lite (fast)', version: 'u2netp' });
  assert.equal(p.tool, 'Remove background');
  assert.equal(p.actions[0]!.action, 'c2pa.edited');
  assert.equal(p.actions[0]!.digitalSourceType, undefined);
  assert.match(p.actions[0]!.description!, /Background removed with U²-Net lite \(fast\) u2netp/);
  assert.equal(p.aiGenerated, undefined);
});

test('videoProvenanceFor: crop = plain c2pa.cropped, no aiGenerated', () => {
  const p = videoProvenanceFor('crop');
  assert.equal(p.tool, 'Crop');
  assert.equal(p.actions[0]!.action, 'c2pa.cropped');
  assert.equal(p.aiGenerated, undefined);
});

test('videoProvenanceFor: upscale = genAI partial with the composite source type', () => {
  const p = videoProvenanceFor('upscale', { model: 'Real-ESRGAN', version: 'v3', scale: 4 });
  assert.equal(p.tool, 'Upscale');
  assert.equal(p.actions[0]!.digitalSourceType, COMPOSITE_SOURCE_TYPE);
  assert.equal(p.aiGenerated, 'partial');
  assert.match(p.actions[0]!.description!, /Upscaled 4× with Real-ESRGAN v3/);
});

// ── runVideoJob end-to-end with fakes (record + stamp branch) ──────────────────

function fakeHost() {
  const uploaded: Array<Record<string, unknown>> = [];
  const host = {
    log() {},
    matte: {
      isAvailable: () => true,
      models: () => [{ id: 'u2netp', name: 'U²-Net lite (fast)', version: 'u2netp' }],
      run: async (frame: { width: number; height: number; data: Uint8ClampedArray }) => ({
        width: frame.width, height: frame.height, data: new Uint8ClampedArray(frame.data),
      }),
    },
    upscale: {
      isAvailable: () => true,
      models: () => [{ id: 'realesr-general-x4v3', name: 'Real-ESRGAN general', version: 'v3', scale: 4 }],
      run: async (frame: { width: number; height: number; data: Uint8ClampedArray }) => ({
        width: frame.width * 4, height: frame.height * 4, data: new Uint8ClampedArray(frame.width * 4 * frame.height * 4 * 4),
      }),
    },
    assets: {
      _uploadUserAsset: async (rec: Record<string, unknown>) => { uploaded.push(rec); },
      get: async (id: string) => ({ id, type: 'video', url: `blob:${id}`, format: 'x' }),
    },
  };
  return { host, uploaded };
}

function baseDeps(stampCapture: { calls: Array<{ format: string; o: Record<string, unknown> }> }, ingredient: unknown | null, writer: ReturnType<typeof fakeWriter>) {
  return {
    fetchBytes: async () => ({ blob: new Blob(['src']), bytes: new Uint8Array([1, 2, 3]) }),
    openReader: async () => fakeReader(3),
    openMatteWriter: () => writer,
    openVideoWriter: async () => writer,
    decodeAudio: async () => null,
    extractIngredient: () => ingredient,
    stamp: async (_h: unknown, blob: Blob, format: string, o: Record<string, unknown>) => { stampCapture.calls.push({ format, o }); return blob; },
  };
}

test('runVideoJob matte: raster+animated record, plain-edit stamp, source ingredient carried', async () => {
  const { host, uploaded } = fakeHost();
  const cap = { calls: [] as Array<{ format: string; o: Record<string, unknown> }> };
  const writer = fakeWriter('webp');
  const ref = await runVideoJob(host as never, {
    op: 'matte', source: { id: 'user/video/clip', type: 'video', url: 'blob:clip', format: 'mp4' } as never, sourceName: 'clip.mp4',
    matte: { model: 'u2netp', format: 'webp', fps: 12, longEdge: 720 },
  }, {}, baseDeps(cap, { marker: 'ingredient' }, writer) as never);
  assert.ok(ref);
  const rec = uploaded[0]!;
  assert.equal(rec.type, 'raster');
  assert.equal(rec.format, 'webp');
  assert.equal((rec.meta as Record<string, unknown>).animated, true);
  assert.equal(rec.aiGenerated, undefined);
  // No 'renders' tag on a catalog-initiated job.
  assert.equal((rec.meta as { tags?: unknown }).tags, undefined);
  // Container-level stamp: plain edit + the source as an ingredient.
  const stamp = cap.calls[0]!;
  assert.equal(stamp.format, 'webp');
  assert.equal((stamp.o.actions as Array<{ action: string }>)[0]!.action, 'c2pa.edited');
  assert.deepEqual(stamp.o.ingredients, [{ marker: 'ingredient' }]);
});

test('runVideoJob crop: video record, c2pa.cropped stamp', async () => {
  const { host, uploaded } = fakeHost();
  const cap = { calls: [] as Array<{ format: string; o: Record<string, unknown> }> };
  const writer = fakeWriter('mp4');
  await runVideoJob(host as never, {
    op: 'crop', source: { id: 'c', type: 'video', url: 'blob:c', format: 'mp4' } as never, sourceName: 'c.mp4',
    crop: { rect: { x: 0, y: 0, w: 4, h: 4 }, fps: 30, bitrate: 8_000_000 },
  }, {}, baseDeps(cap, null, writer) as never);
  const rec = uploaded[0]!;
  assert.equal(rec.type, 'video');
  assert.equal(rec.aiGenerated, undefined);
  assert.equal((cap.calls[0]!.o.actions as Array<{ action: string }>)[0]!.action, 'c2pa.cropped');
  // No ingredient when the source carries no credential.
  assert.equal(cap.calls[0]!.o.ingredients, undefined);
});

test('runVideoJob upscale: aiGenerated partial + composite source type stamp', async () => {
  const { host, uploaded } = fakeHost();
  const cap = { calls: [] as Array<{ format: string; o: Record<string, unknown> }> };
  const writer = fakeWriter('mp4');
  await runVideoJob(host as never, {
    op: 'upscale', source: { id: 'u', type: 'video', url: 'blob:u', format: 'mp4' } as never, sourceName: 'u.mp4',
    upscale: { model: 'realesr-general-x4v3', fps: 30, bitrate: 12_000_000 },
  }, {}, baseDeps(cap, null, writer) as never);
  const rec = uploaded[0]!;
  assert.equal(rec.type, 'video');
  assert.equal(rec.aiGenerated, 'partial');
  const action = (cap.calls[0]!.o.actions as Array<{ digitalSourceType?: string }>)[0]!;
  assert.equal(action.digitalSourceType, COMPOSITE_SOURCE_TYPE);
});

test('runVideoJob: a cancel before any output resolves null and saves nothing', async () => {
  const { host, uploaded } = fakeHost();
  const cap = { calls: [] as Array<{ format: string; o: Record<string, unknown> }> };
  const writer = fakeWriter('webp');
  const ref = await runVideoJob(host as never, {
    op: 'matte', source: { id: 'x', type: 'video', url: 'blob:x', format: 'mp4' } as never, sourceName: 'x.mp4',
    matte: { model: 'u2netp', format: 'webp', fps: 12, longEdge: 720 },
  }, { isCancelled: () => true }, baseDeps(cap, null, writer) as never);
  assert.equal(ref, null);
  assert.equal(uploaded.length, 0);
  assert.equal(cap.calls.length, 0);
});

// ── caps + estimate helpers ────────────────────────────────────────────────────

test('matteOutputFrames: fps × duration, clamped to the in-memory cap', () => {
  assert.equal(matteOutputFrames(10, 12), 120);
  assert.ok(matteOutputFrames(10_000, 12) === MATTE_MAX_OUTPUT_FRAMES);
});

test('extrapolateEstimate + scaledEvenDims', () => {
  const est = extrapolateEstimate({ perFrameMs: 100, sampleFrameBytes: 1000 }, 300);
  assert.equal(est.totalMs, 30000);
  assert.equal(est.totalBytes, 300000);
  const d = scaledEvenDims(1920, 1080, 720);
  assert.equal(Math.max(d.width, d.height), 720);
  assert.equal(d.width % 2, 0);
  assert.equal(d.height % 2, 0);
});

// ── colour-range (chroma) key: destination resolution + model-free background removal ─

/** An RGBA frame filled with one colour, fully opaque. */
function solidRGBA(w: number, h: number, r: number, g: number, b: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) { data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255; }
  return data;
}

// The per-pixel keying MATH (key/far/soft-edge, OKLab perceptual distance, spill,
// determinism) is owned by the engine module and pinned in engine/src/chroma-key.test.ts.
// Here we pin only how the PIPELINE uses it: scale-then-key, and the model-free run.

test('clampMatteLongEdge: feeds the chosen resolution but never upscales past the source or the matte cap', () => {
  assert.equal(clampMatteLongEdge(1080, 1920), 1080, 'fits under the source → the request wins');
  assert.equal(clampMatteLongEdge(1080, 720), 720, 'clamped down to the source (no upscaling)');
  assert.equal(clampMatteLongEdge(720, 4000), 720, 'a huge source leaves the request intact');
  assert.equal(clampMatteLongEdge(3000, 4000), MATTE_MAX_INPUT_LONG_EDGE, 'capped at the matte input ceiling');
  assert.equal(clampMatteLongEdge(720, 0), 720, 'an unknown source falls back to the request');
});

test('resizeFrameRGBA: downscales to the target dims and never aliases the source buffer', () => {
  const src = { data: solidRGBA(8, 8, 10, 20, 30), width: 8, height: 8 };
  const out = resizeFrameRGBA(src, 4, 4);
  assert.equal(out.width, 4);
  assert.equal(out.height, 4);
  assert.equal(out.data.length, 4 * 4 * 4);
  // A same-size resize returns a COPY, so mutating it can't corrupt the reader's frame.
  const copy = resizeFrameRGBA(src, 8, 8);
  assert.notEqual(copy.data, src.data);
  copy.data[0] = 250;
  assert.equal(src.data[0], 10, 'the source is untouched');
});

test('makeChromaKeyOp: scales to the destination long edge AND removes a flat background', async () => {
  const op = makeChromaKeyOp({ keyColor: CHROMA_DEFAULT_KEY, tolerance: 0.12, softness: 0.1, spill: 0 }, 4);
  const frame = { data: solidRGBA(8, 8, 0, 177, 64), width: 8, height: 8, timestampUs: 0, durationUs: 1000 };
  const out = await op(frame as never);
  assert.equal(Math.max(out.width, out.height), 4, 'the destination-resolution long edge is honoured');
  // The whole frame was the key colour → every pixel keys out.
  let maxAlpha = 0;
  for (let i = 3; i < out.data.length; i += 4) maxAlpha = Math.max(maxAlpha, out.data[i]!);
  assert.equal(maxAlpha, 0, 'a flat key-coloured frame becomes fully transparent');
});

test('videoProvenanceFor: matte via colour key = plain c2pa.edited, no model name, no aiGenerated', () => {
  const p = videoProvenanceFor('matte', { method: 'chroma' });
  assert.equal(p.tool, 'Remove background');
  assert.equal(p.actions[0]!.action, 'c2pa.edited');
  assert.match(p.actions[0]!.description ?? '', /colour key/i);
  assert.equal(p.aiGenerated, undefined);
});

test('runVideoJob matte via chroma: model-free, plain colour-key stamp, source content credential carried', async () => {
  const { host, uploaded } = fakeHost();
  // Prove the chroma path never touches the model: make the model throw if called.
  (host.matte as { run: unknown }).run = async () => { throw new Error('the model must not run for a colour key'); };
  const cap = { calls: [] as Array<{ format: string; o: Record<string, unknown> }> };
  const writer = fakeWriter('webp');
  // The source video carries a Content Credential; it MUST survive as an ingredient.
  const ref = await runVideoJob(host as never, {
    op: 'matte', source: { id: 'user/video/clip', type: 'video', url: 'blob:clip', format: 'mp4' } as never, sourceName: 'clip.mp4',
    matte: { model: 'u2netp', format: 'webp', fps: 12, longEdge: 720, method: 'chroma', chroma: { keyColor: { r: 255, g: 255, b: 255 }, tolerance: 0.12, softness: 0.1, spill: 0.5 } },
  }, {}, baseDeps(cap, { marker: 'source-credential' }, writer) as never);
  assert.ok(ref, 'the job completed without the model');
  const rec = uploaded[0]!;
  assert.equal(rec.type, 'raster');
  assert.equal(rec.format, 'webp');
  assert.equal((rec.meta as Record<string, unknown>).animated, true);
  assert.equal(rec.aiGenerated, undefined, 'a colour key is not AI-generated');
  const stamp = cap.calls[0]!;
  assert.match((stamp.o.actions as Array<{ description?: string }>)[0]!.description ?? '', /colour key/i);
  assert.deepEqual(stamp.o.ingredients, [{ marker: 'source-credential' }], 'the source video Content Credential is preserved as an ingredient');
});
