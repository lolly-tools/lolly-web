// SPDX-License-Identifier: MPL-2.0
/**
 * Main-thread client for the ZzFXM render worker. Lazily spawns one worker, keys
 * concurrent renders by request id, and turns a song into an AudioBuffer on any
 * AudioContext. Shared by the Neurospicy player (live AudioContext) and the video
 * exporter (OfflineAudioContext for a music bed) so both take the identical
 * "zzfxm song → AudioBuffer" path.
 */
import type { ZzfxSong, RenderedPcm } from '../../../../engine/src/zzfxm.ts';

interface WorkerReply {
  id: number;
  left?: Float32Array;
  right?: Float32Array;
  sampleRate?: number;
  error?: string;
}

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (p: RenderedPcm) => void; reject: (e: unknown) => void }>();

function ensureWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./zzfxm-worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e: MessageEvent<WorkerReply>): void => {
    const { id, error, left, right, sampleRate } = e.data;
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (error || !left || !right || !sampleRate) {
      p.reject(new Error(error ?? 'zzfxm render failed'));
    } else {
      p.resolve({ left, right, sampleRate });
    }
  };
  worker.onerror = (): void => {
    for (const p of pending.values()) p.reject(new Error('zzfxm worker error'));
    pending.clear();
  };
  return worker;
}

/** Render a song to stereo PCM in the worker. */
export function renderSong(song: ZzfxSong): Promise<RenderedPcm> {
  const w = ensureWorker();
  const id = ++seq;
  return new Promise<RenderedPcm>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ id, song });
  });
}

/**
 * Encode rendered PCM to a 16-bit stereo WAV Blob. The video exporter is
 * URL-driven (every muxer path does `fetch(url)` + `decodeAudioData`), so a
 * zzfxm track is rendered to WAV and handed in as a blob URL — no export-bridge
 * change, and CD-quality PCM is transparent under the lossy AAC/Opus mux.
 */
function encodeWav({ left, right, sampleRate }: RenderedPcm): Blob {
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

/**
 * Fetch a ZzFXM song JSON, render it, and return a WAV blob URL — the shape the
 * video-export music picker feeds to the muxer for a zzfxm-format track.
 */
export async function songUrlToWavBlobUrl(url: string): Promise<string> {
  const song = (await (await fetch(url)).json()) as ZzfxSong;
  const pcm = await renderSong(song);
  return URL.createObjectURL(encodeWav(pcm));
}

/**
 * Render a song and wrap it in a stereo AudioBuffer on the given context.
 * `createBuffer` accepts the song's native sample rate even when it differs from
 * the context's — playback resamples. Throws if the song renders empty.
 */
export async function renderSongToAudioBuffer(ctx: BaseAudioContext, song: ZzfxSong): Promise<AudioBuffer> {
  const { left, right, sampleRate } = await renderSong(song);
  if (!left.length) throw new Error('zzfxm song rendered empty');
  const buf = ctx.createBuffer(2, left.length, sampleRate);
  // `.set()` takes any ArrayLike<number>, avoiding the Float32Array<ArrayBuffer>
  // vs <ArrayBufferLike> generic mismatch that copyToChannel's signature imposes.
  buf.getChannelData(0).set(left);
  buf.getChannelData(1).set(right);
  return buf;
}
