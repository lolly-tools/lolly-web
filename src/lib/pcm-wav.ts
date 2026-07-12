// SPDX-License-Identifier: MPL-2.0
/**
 * Encode rendered stereo PCM to a 16-bit WAV Blob. The video exporter is URL-driven
 * (every muxer path does `fetch(url)` + `decodeAudioData`), so a synthesized/decoded
 * track — a ZzFXM song (zzfxm-render.ts) or a tracker module (mod-render.ts) — is
 * rendered to WAV and handed in as a blob URL: no export-bridge change, and CD-quality
 * PCM is transparent under the lossy AAC/Opus mux. Shared by both render paths.
 */
import type { RenderedPcm } from '../../../../engine/src/zzfxm.ts';

export function pcmToWavBlob({ left, right, sampleRate }: RenderedPcm): Blob {
  const frames = left.length;
  const blockAlign = 4; // 2 channels × 16-bit
  const dataLen = frames * blockAlign;
  const buf = new ArrayBuffer(44 + dataLen);
  const dv = new DataView(buf);
  const str = (o: number, s: string): void => {
    for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  dv.setUint32(4, 36 + dataLen, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  dv.setUint32(16, 16, true); // fmt chunk size
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, 2, true); // channels
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * blockAlign, true); // byte rate
  dv.setUint16(32, blockAlign, true);
  dv.setUint16(34, 16, true); // bits per sample
  str(36, 'data');
  dv.setUint32(40, dataLen, true);
  let o = 44;
  for (let i = 0; i < frames; i++) {
    const l = Math.max(-1, Math.min(1, left[i] ?? 0));
    const r = Math.max(-1, Math.min(1, right[i] ?? 0));
    dv.setInt16(o, l < 0 ? l * 0x8000 : l * 0x7fff, true);
    dv.setInt16(o + 2, r < 0 ? r * 0x8000 : r * 0x7fff, true);
    o += 4;
  }
  return new Blob([buf], { type: 'audio/wav' });
}
