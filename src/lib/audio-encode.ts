// SPDX-License-Identifier: MPL-2.0
/**
 * MP3 transcode for the voice recorder's "MP3" download option.
 *
 * MediaRecorder gives us native opus (audio/webm) or aac (audio/mp4) for free; MP3
 * is the universally-playable extra a user might want, but the browser can't encode
 * it, so we do it here with lamejs. The encoder is LAZY-imported (dynamic import) so
 * it never enters the preload bundle — it loads only when someone actually picks MP3.
 */

/** Decode any recorded audio Blob and re-encode it to an MP3 Blob (audio/mpeg). */
export async function blobToMp3(blob: Blob, { bitrate = 160 }: { bitrate?: number } = {}): Promise<Blob> {
  const AC = globalThis.AudioContext ?? (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) throw new Error('Web Audio is not supported in this browser');
  const ctx = new AC();
  let audio: AudioBuffer;
  try {
    audio = await ctx.decodeAudioData(await blob.arrayBuffer());
  } finally {
    ctx.close().catch(() => {});
  }

  const { Mp3Encoder } = await import('@breezystack/lamejs');
  const channels = audio.numberOfChannels >= 2 ? 2 : 1;
  const enc = new Mp3Encoder(channels, audio.sampleRate, bitrate);
  const left = floatToInt16(audio.getChannelData(0));
  const right = channels === 2 ? floatToInt16(audio.getChannelData(1)) : null;

  const BLOCK = 1152; // lamejs works on 1152-sample frames
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < left.length; i += BLOCK) {
    const l = left.subarray(i, i + BLOCK);
    const buf = right ? enc.encodeBuffer(l, right.subarray(i, i + BLOCK)) : enc.encodeBuffer(l);
    if (buf.length) chunks.push(buf);
  }
  const tail = enc.flush();
  if (tail.length) chunks.push(tail);
  return new Blob(chunks as BlobPart[], { type: 'audio/mpeg' });
}

function floatToInt16(f32: Float32Array): Int16Array {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]!));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}
