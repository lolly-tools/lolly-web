// SPDX-License-Identifier: MPL-2.0
/**
 * MediaRecorder mimetype candidates for the video export path (export.js).
 *
 * Kept DOM-free (no MediaRecorder probing here) so the ordering logic is
 * unit-testable in node — same split as views/export-size.js. export.js owns
 * the isTypeSupported() probe; this module owns which strings to try, in
 * which order.
 *
 * Audio: when a music bed is being muxed in, the mimetype must name (or at
 * least permit) an audio codec — some browsers throw NotSupportedError when
 * the stream carries an audio track but the mimeType pins video-only codecs.
 * So the audio candidates are audio-codec forms first, then the bare
 * containers (which let the recorder pick its default audio codec), and
 * never the video-only-pinned forms.
 */

export const WEBM_CODECS = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
// H.264 profiles, best→worst: High@4.0 (avc1.640028), Main@4.0 (avc1.4D0028), then
// the generic strings, then Constrained Baseline@3.0 (avc1.42E01E, ~720p ceiling) as
// the last resort. The recorder probe (isTypeSupported) picks the first the browser
// can actually encode, so 1080p output isn't pinned to Baseline where a better
// profile is available, and older browsers still fall back cleanly.
export const MP4_CODECS  = ['video/mp4;codecs=avc1.640028', 'video/mp4;codecs=avc1.4D0028', 'video/mp4;codecs=h264', 'video/mp4;codecs=avc1', 'video/mp4;codecs=avc1.42E01E', 'video/mp4'];

export const WEBM_AUDIO_CODECS = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
export const MP4_AUDIO_CODECS  = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1.4D0028,mp4a.40.2', 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4'];

/**
 * Ordered mimetype candidates, preferring the requested container
 * ('webm' | 'mp4') but falling back to the other so a deep-link/CLI request
 * still produces a video (Safari records mp4 only, Firefox webm only).
 */
export function videoMimeCandidates(preferred: string, { audio = false }: { audio?: boolean } = {}): string[] {
  const [first, second]: [string[], string[]] = audio
    ? [WEBM_AUDIO_CODECS, MP4_AUDIO_CODECS]
    : [WEBM_CODECS, MP4_CODECS];
  return preferred === 'mp4' ? [...second, ...first] : [...first, ...second];
}

// ── Encode bitrate ────────────────────────────────────────────────────────────
// Left to its defaults, MediaRecorder encodes at a flat browser default (~2.5 Mbps
// in Chromium) regardless of resolution — soft/blocky at 1080p+, and wasteful for a
// tiny clip. Scale the target with pixels × fps, clamped to 1–24 Mbps so a huge
// canvas can't request a runaway rate.
//   bitsPerPixel 0.1  (default) — offline tool renders: flat fills, text, few
//                                 gradients, frame-perfect delivery
//   bitsPerPixel 0.15           — live capture (screen/camera): real motion, one
//                                 take, no chance to re-render
export const LIVE_BITS_PER_PIXEL = 0.15;
export function videoBitrate(width: number, height: number, fps: number, bitsPerPixel = 0.1): number {
  const raw = Math.round(width * height * fps * bitsPerPixel);
  return Math.max(1_000_000, Math.min(raw, 24_000_000));
}

// ── WebCodecs encode scheduling (pure — DOM-free, unit-tested) ────────────────
// The per-frame timing + keyframe cadence for the WebCodecs video encode, and the audio
// PCM chunk boundaries, split out of the encode loop (export.ts encodeVideoWithWebCodecs)
// so the timestamp / keyframe / chunking math is verifiable without a real VideoEncoder —
// and so a Worker-side encoder can reuse the exact same schedule. Same numbers as before.

/** One frame's encode timing: microsecond timestamp + duration, and whether it's a keyframe. */
export interface FrameTiming { index: number; timestampUs: number; durationUs: number; keyFrame: boolean }

/** Timestamps (µs) + a ~2s keyframe cadence for `frameCount` frames at `fps`. */
export function videoFrameSchedule(frameCount: number, fps: number): FrameTiming[] {
  const f = Math.max(1, fps);
  const keyEvery = Math.max(1, Math.round(f * 2));   // a keyframe roughly every 2s
  const durationUs = Math.round(1e6 / f);
  const out: FrameTiming[] = [];
  for (let i = 0; i < Math.max(0, frameCount); i++) {
    out.push({ index: i, timestampUs: Math.round(i * 1e6 / f), durationUs, keyFrame: i % keyEvery === 0 });
  }
  return out;
}

/** One audio PCM slice: start offset + length in frames, and its µs timestamp. */
export interface AudioChunkSpan { offsetFrames: number; numFrames: number; timestampUs: number }

/** Partition `totalFrames` of PCM into `chunkFrames`-sized spans with µs timestamps. */
export function audioChunkSchedule(totalFrames: number, sampleRate: number, chunkFrames: number): AudioChunkSpan[] {
  const out: AudioChunkSpan[] = [];
  const step = Math.max(1, chunkFrames);
  const sr = Math.max(1, sampleRate);
  for (let off = 0; off < totalFrames; off += step) {
    out.push({ offsetFrames: off, numFrames: Math.min(step, totalFrames - off), timestampUs: Math.round((off / sr) * 1e6) });
  }
  return out;
}
