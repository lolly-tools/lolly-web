// SPDX-License-Identifier: MPL-2.0
/**
 * DOM-free WebCodecs encode + mux core — the compute half of the video export's fast
 * path, extracted from bridge/export.ts so it runs UNCHANGED in either context:
 *   • the main thread (export.ts encodeVideoWithWebCodecs wraps it + adds provenance);
 *   • a Web Worker (video-encode.worker.ts), fed transferred ImageBitmaps + planar PCM,
 *     so the encode/mux runs off the main thread.
 *
 * Everything here is DOM-free: VideoEncoder / VideoFrame / AudioEncoder / AudioData are
 * globals in both window and worker scope, and the muxers (mp4-muxer / webm-muxer) are
 * pure-JS + lazily imported. Audio arrives as PLANAR channel Float32Arrays (not an
 * AudioBuffer, which isn't transferable) so the worker path can transfer it. Returns the
 * muxed bytes + container type; the CALLER wraps them in a Blob and embeds provenance
 * (withVideoMeta) — kept on the main thread where the metadata writers already live.
 *
 * The per-frame timing + keyframe cadence and the audio chunking come from the pure
 * schedules in video-mime.ts, so the ordering is unit-tested and identical to before.
 */
import { videoFrameSchedule, audioChunkSchedule } from './video-mime.ts';

export interface EncodePick { container: 'mp4' | 'webm'; codec: string; muxCodec: string }

/** Audio for the encode as planar channels (worker-transferable), plus its codec. */
export interface EncodeAudio {
  channels: Float32Array[];
  sampleRate: number;
  numberOfChannels: number;
  codec: string;
  muxCodec: string;
  bitrate: number;
}

export interface EncodeOpts {
  width: number;
  height: number;
  fps: number;
  bitrate: number;
  audio?: EncodeAudio | null;
}

/** Encode frames (+ optional audio) and mux → { muxed bytes, container MIME }. Throws on
 *  any encoder error. Identical logic to the former inline loop in export.ts. */
export async function encodeMuxWebCodecs(
  frames: ImageBitmap[], pick: EncodePick, o: EncodeOpts,
): Promise<{ buffer: ArrayBuffer; type: string }> {
  const { width, height, fps, bitrate } = o;
  const a = o.audio ?? null;
  const isMp4 = pick.container === 'mp4';
  const mux: any = isMp4 ? await import('mp4-muxer') : await import('webm-muxer');
  const target = new mux.ArrayBufferTarget();
  const audioTrack = a ? { codec: a.muxCodec, numberOfChannels: a.numberOfChannels, sampleRate: a.sampleRate } : null;
  const muxer = new mux.Muxer(isMp4
    ? { target, fastStart: 'in-memory', video: { codec: 'avc', width, height }, ...(audioTrack ? { audio: audioTrack } : {}) }
    : { target, firstTimestampBehavior: 'offset', video: { codec: pick.muxCodec, width, height, frameRate: fps }, ...(audioTrack ? { audio: audioTrack } : {}) });

  let encErr: unknown = null;
  const encoder = new VideoEncoder({
    output: (chunk, metadata) => { try { muxer.addVideoChunk(chunk, metadata); } catch (e) { encErr = e; } },
    error: (e) => { encErr = e; },
  });
  const config: any = { codec: pick.codec, width, height, bitrate, framerate: fps };
  if (isMp4) config.avc = { format: 'avc' };   // length-prefixed avcC, as mp4-muxer expects
  encoder.configure(config);

  for (const t of videoFrameSchedule(frames.length, fps)) {
    if (encErr) break;
    const frame = new VideoFrame(frames[t.index]!, { timestamp: t.timestampUs, duration: t.durationUs });
    encoder.encode(frame, { keyFrame: t.keyFrame });
    frame.close();
    if (encoder.encodeQueueSize > 20) await new Promise<void>((r) => setTimeout(r, 0));
  }
  await encoder.flush();
  encoder.close();

  if (a && !encErr) {
    const { channels, sampleRate, numberOfChannels, bitrate: aBitrate } = a;
    const aEnc = new AudioEncoder({
      output: (chunk, metadata) => { try { muxer.addAudioChunk(chunk, metadata); } catch (e) { encErr = e; } },
      error: (e) => { encErr = e; },
    });
    aEnc.configure({ codec: a.codec, sampleRate, numberOfChannels, bitrate: aBitrate });
    const total = channels[0]?.length ?? 0;      // frames per channel
    const CHUNK = 4800;                           // ~0.1s @ 48k
    const planar = new Float32Array(CHUNK * numberOfChannels);
    for (const span of audioChunkSchedule(total, sampleRate, CHUNK)) {
      if (encErr) break;
      const n = span.numFrames;
      // f32-planar layout for this chunk: [ch0: n samples][ch1: n samples] (stride n).
      for (let ch = 0; ch < numberOfChannels; ch++) {
        const plane = channels[Math.min(ch, channels.length - 1)]!;
        planar.set(plane.subarray(span.offsetFrames, span.offsetFrames + n), ch * n);
      }
      const audioData = new AudioData({
        format: 'f32-planar', sampleRate, numberOfFrames: n, numberOfChannels,
        timestamp: span.timestampUs,                       // microseconds
        data: planar.subarray(0, n * numberOfChannels),    // AudioData copies the data
      });
      aEnc.encode(audioData);
      audioData.close();
      if (aEnc.encodeQueueSize > 20) await new Promise<void>((r) => setTimeout(r, 0));
    }
    await aEnc.flush();
    aEnc.close();
  }

  if (encErr) throw encErr instanceof Error ? encErr : new Error('VideoEncoder error');
  muxer.finalize();
  return { buffer: target.buffer as ArrayBuffer, type: isMp4 ? 'video/mp4' : 'video/webm' };
}
