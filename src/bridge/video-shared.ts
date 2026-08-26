// SPDX-License-Identifier: MPL-2.0
/**
 * Shared WebCodecs codec selection - the one avc→vp9→vp8 ladder and the
 * per-container audio pick.
 *
 * These were copy-pasted three ways: `pickWebCodecsVideo`/`pickWebCodecsAudio` in
 * bridge/export.ts, reproduced verbatim in bridge/sequence-render.ts (whose header
 * names the "REPORTED DEBT: the right end state is a shared bridge/video-shared.ts
 * that both files import"), and a third copy as `pickVideoCodec`/`pickAudioCodec`
 * in lib/video-jobs.ts. This is that shared module. Behaviour is byte-for-byte what
 * the three carried - one probe list, one `isConfigSupported` gate, same order - so
 * the export goldens are unaffected. It is also the single edit point where plan
 * 153 WP-B (AV1/HEVC candidates) and plan 154 (10-bit HDR variants) add codecs.
 */
import type { EncodePick } from './video-encode-core.ts';

/** The video ladder: mp4 (AV1→H.264 High→Main) and webm (AV1→VP9→VP8). AV1 leads
 *  both where the browser encodes it (WP-B) - same visual quality at ~40% of the
 *  bytes, verified deterministic + luma-faithful on the browser tier - falling back
 *  to the universally-decodable H.264 / VP9 where AV1 encode is absent. HEVC is
 *  deliberately NOT in the default ladder (browsers frequently cannot DECODE hvc1),
 *  it is an explicit codec choice only. */
const MP4_LADDER: readonly EncodePick[] = [
  { container: 'mp4', codec: 'av01.0.08M.08', muxCodec: 'av1' },   // AV1 Main profile 0, 8-bit
  { container: 'mp4', codec: 'avc1.640033', muxCodec: 'avc' },   // H.264 High L5.1
  { container: 'mp4', codec: 'avc1.4d0033', muxCodec: 'avc' },   // H.264 Main L5.1
];
const WEBM_LADDER: readonly EncodePick[] = [
  { container: 'webm', codec: 'av01.0.08M.08', muxCodec: 'V_AV1' },   // AV1 Main profile 0, 8-bit
  { container: 'webm', codec: 'vp09.00.10.08', muxCodec: 'V_VP9' },   // VP9 profile 0, 8-bit
  { container: 'webm', codec: 'vp8', muxCodec: 'V_VP8' },
];

/** Reads the VideoEncoder global (present in both window and worker scope). */
function videoEncoder(): { isConfigSupported?: (c: unknown) => Promise<{ supported?: boolean }> } | undefined {
  return (globalThis as { VideoEncoder?: { isConfigSupported?: (c: unknown) => Promise<{ supported?: boolean }> } }).VideoEncoder;
}
function audioEncoder(): { isConfigSupported?: (c: unknown) => Promise<{ supported?: boolean }> } | undefined {
  return (globalThis as { AudioEncoder?: { isConfigSupported?: (c: unknown) => Promise<{ supported?: boolean }> } }).AudioEncoder;
}

/**
 * First encodable video codec for `width×height@fps`/`bitrate`, honouring the
 * caller's container preference (mp4 tries H.264 first, webm tries VP9/VP8 first).
 * Returns null when WebCodecs - or any codec at that size - is unavailable, so the
 * caller falls back to the MediaRecorder path.
 */
export async function pickWebCodecsVideo(
  preferred: 'mp4' | 'webm' | string, width: number, height: number, fps: number, bitrate: number,
): Promise<EncodePick | null> {
  const VE = videoEncoder();
  if (!VE?.isConfigSupported) return null;
  const ladder = preferred === 'webm' ? [...WEBM_LADDER, ...MP4_LADDER] : [...MP4_LADDER, ...WEBM_LADDER];
  for (const pick of ladder) {
    try {
      const s = await VE.isConfigSupported({ codec: pick.codec, width, height, bitrate, framerate: fps });
      if (s?.supported) return pick;
    } catch { /* try the next candidate */ }
  }
  return null;
}

/** A chosen audio codec plus the params it was probed at. */
export interface AudioPick { codec: string; muxCodec: string; sampleRate: number; numberOfChannels: number; bitrate: number }

/**
 * WebCodecs audio codec for `container`: AAC-LC (mp4) or Opus (webm), probed at
 * the given rate/channels/bitrate (defaults match the export/mix path: 48 kHz,
 * stereo, 128 kbps). Returns null when AudioEncoder or that codec is unavailable.
 * The probe params ride along so callers feed the encoder + muxer without
 * re-stating them.
 */
export async function pickWebCodecsAudio(
  container: 'mp4' | 'webm', sampleRate = 48_000, numberOfChannels = 2, bitrate = 128_000,
): Promise<AudioPick | null> {
  const AE = audioEncoder();
  if (!AE?.isConfigSupported) return null;
  const cand = container === 'mp4'
    ? { codec: 'mp4a.40.2', muxCodec: 'aac' }
    : { codec: 'opus', muxCodec: 'A_OPUS' };
  try {
    const s = await AE.isConfigSupported({ codec: cand.codec, sampleRate, numberOfChannels, bitrate });
    if (s?.supported) return { ...cand, sampleRate, numberOfChannels, bitrate };
  } catch { /* unsupported */ }
  return null;
}
