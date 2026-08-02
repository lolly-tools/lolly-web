// SPDX-License-Identifier: MPL-2.0
/**
 * Unit tests for the audio-only export encoders (wav / mp3 / m4a / opus).
 *
 * DOM-free, like bridge/export-hdr-png.test.ts: every encoder here takes planar
 * PCM and returns bytes, so node can drive all four. The two WebCodecs formats
 * use the REAL muxers (mp4-muxer / webm-muxer are pure JS) with a stub
 * AudioEncoder, so the container magic asserted below is the muxer's own output
 * and not a fixture. mp4-muxer type-checks chunks with `instanceof
 * EncodedAudioChunk`, so the stub chunk class is installed as that global.
 *
 * Run directly:  node --test shells/web/src/lib/audio-encode.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWav } from '../../../../engine/src/wav.ts';
import {
  encodeWav, encodeMp3, encodeM4a, encodeOpus, encodeAudio, renderAudioExport,
  sliceWithEnvelope, sniffAudioFormat, pcmFromAudioBuffer, NO_AUDIO_MSG,
  type AudioPcm,
} from './audio-encode.ts';

const RATE = 48_000;

/** A short deterministic stereo tone. */
function tone(frames: number, rate = RATE): AudioPcm {
  const l = new Float32Array(frames);
  const r = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    l[i] = Math.sin((2 * Math.PI * 440 * i) / rate) * 0.5;
    r[i] = Math.sin((2 * Math.PI * 220 * i) / rate) * 0.25;
  }
  return { channels: [l, r], sampleRate: rate };
}

async function bytesOf(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}
const tag = (u8: Uint8Array, at: number, len: number): string => String.fromCharCode(...u8.subarray(at, at + len));

// ── wav ───────────────────────────────────────────────────────────────────────

test('encodeWav: RIFF/WAVE magic and audio/wav type', async () => {
  const blob = encodeWav(tone(1000));
  assert.equal(blob.type, 'audio/wav');
  const u8 = await bytesOf(blob);
  assert.equal(tag(u8, 0, 4), 'RIFF');
  assert.equal(tag(u8, 8, 4), 'WAVE');
});

test('encodeWav: float32 round-trips through the engine parser to identical samples', async () => {
  const pcm = tone(1024);
  const back = parseWav(await bytesOf(encodeWav(pcm, { sampleFormat: 'float32' })));
  assert.equal(back.sampleRate, pcm.sampleRate);
  assert.equal(back.channels.length, 2);
  for (let ch = 0; ch < 2; ch++) assert.deepEqual(back.channels[ch], pcm.channels[ch]);
});

test('encodeWav: int16 round-trips exactly for samples already on the 1/32768 grid', async () => {
  const grid = new Float32Array([0, 0.5, -0.5, 0.25, -1, 1 / 32768]);
  const pcm: AudioPcm = { channels: [grid], sampleRate: 44_100 };
  const back = parseWav(await bytesOf(encodeWav(pcm)));
  assert.equal(back.sampleRate, 44_100);
  assert.deepEqual(back.channels[0], grid);
});

test('encodeWav: byte-deterministic', async () => {
  const pcm = tone(777);
  assert.deepEqual(await bytesOf(encodeWav(pcm)), await bytesOf(encodeWav(pcm)));
});

// ── mp3 ───────────────────────────────────────────────────────────────────────

test('encodeMp3: MPEG frame sync (or ID3) magic, and byte-deterministic', async () => {
  const pcm = tone(4 * 1152);
  const a = await bytesOf(await encodeMp3(pcm));
  const b = await bytesOf(await encodeMp3(pcm));
  assert.ok(a.length > 0);
  const id3 = tag(a, 0, 3) === 'ID3';
  const sync = a[0] === 0xff && (a[1]! & 0xe0) === 0xe0;
  assert.ok(id3 || sync, `expected ID3 or an MPEG frame sync, got ${a[0]!.toString(16)} ${a[1]!.toString(16)}`);
  assert.deepEqual(a, b);
});

// ── m4a / opus (stub AudioEncoder, real muxers) ───────────────────────────────

class StubChunk {
  type = 'key';
  timestamp: number;
  duration: number;
  bytes: Uint8Array;
  constructor(timestamp: number, duration: number, bytes: Uint8Array) {
    this.timestamp = timestamp;
    this.duration = duration;
    this.bytes = bytes;
  }
  get byteLength(): number { return this.bytes.length; }
  copyTo(dst: Uint8Array): void { dst.set(this.bytes); }
}

interface StubLog { configs: any[]; chunks: number }

/** An AudioEncoder that answers isConfigSupported with `supported` and emits one
 *  encoded chunk per encode() call. */
function stubEncoder(supported: boolean, log: StubLog, description = new Uint8Array([0x11, 0x90])) {
  return class {
    static async isConfigSupported(c: any) { return { supported, config: c }; }
    encodeQueueSize = 0;
    private out: (chunk: unknown, metadata: unknown) => void;
    constructor(init: { output: (chunk: unknown, metadata: unknown) => void; error: (e: unknown) => void }) {
      this.out = init.output;
    }
    configure(c: any): void { log.configs.push(c); }
    encode(data: any): void {
      log.chunks++;
      this.out(new StubChunk(data.timestamp, 20_000, new Uint8Array([1, 2, 3, 4])), { decoderConfig: { description } });
    }
    async flush(): Promise<void> {}
    close(): void {}
  };
}

/** AudioData stand-in: WebCodecs copies the payload, so this only needs the fields
 *  the encoder stub reads back. */
class StubAudioData {
  timestamp: number;
  constructor(init: { timestamp: number }) { this.timestamp = init.timestamp; }
  close(): void {}
}

test('encodeM4a: ftyp box at offset 4, and the encoder is configured at the PCM rate', async () => {
  const g = globalThis as any;
  const saved = g.EncodedAudioChunk;
  g.EncodedAudioChunk = StubChunk;                 // mp4-muxer instanceof-checks this
  try {
    const log: StubLog = { configs: [], chunks: 0 };
    const pcm = tone(48_000, 44_100);              // deliberately not 48 kHz
    const u8 = await bytesOf(await encodeM4a(pcm, {}, { AudioEncoder: stubEncoder(true, log), AudioData: StubAudioData }));
    assert.equal(tag(u8, 4, 4), 'ftyp');           // mp4-muxer writes the isom brand
    assert.equal(log.configs[0].codec, 'mp4a.40.2');
    assert.equal(log.configs[0].sampleRate, 44_100);
    assert.equal(log.configs[0].numberOfChannels, 2);
    assert.equal(log.chunks, Math.ceil(48_000 / 4800));
  } finally {
    g.EncodedAudioChunk = saved;
  }
});

test('encodeOpus: EBML magic, and mono PCM is declared mono', async () => {
  const g = globalThis as any;
  const saved = g.EncodedAudioChunk;
  g.EncodedAudioChunk = StubChunk;
  try {
    const log: StubLog = { configs: [], chunks: 0 };
    const pcm: AudioPcm = { channels: [new Float32Array(9600)], sampleRate: RATE };
    const u8 = await bytesOf(await encodeOpus(pcm, {}, { AudioEncoder: stubEncoder(true, log), AudioData: StubAudioData }));
    assert.deepEqual([...u8.subarray(0, 4)], [0x1a, 0x45, 0xdf, 0xa3]);
    assert.equal(log.configs[0].codec, 'opus');
    assert.equal(log.configs[0].numberOfChannels, 1);
  } finally {
    g.EncodedAudioChunk = saved;
  }
});

test('m4a/opus degrade with a message rather than throwing when WebCodecs is missing', async () => {
  await assert.rejects(
    () => encodeM4a(tone(100), {}, { AudioEncoder: undefined, AudioData: undefined }),
    /cannot encode that audio format/,
  );
});

test('m4a/opus degrade with a message when the platform refuses the config', async () => {
  const log: StubLog = { configs: [], chunks: 0 };
  await assert.rejects(
    () => encodeOpus(tone(100), {}, { AudioEncoder: stubEncoder(false, log), AudioData: StubAudioData }),
    /cannot encode that audio format/,
  );
  assert.equal(log.configs.length, 0, 'a refused config must not reach configure()');
});

// ── sniff / slice ─────────────────────────────────────────────────────────────

test('sniffAudioFormat: recognises each container, and nothing else', async () => {
  assert.equal(sniffAudioFormat(await bytesOf(encodeWav(tone(64)))), 'wav');
  assert.equal(sniffAudioFormat(new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0, 0, 0])), 'mp3');
  assert.equal(sniffAudioFormat(new Uint8Array([0xff, 0xfb, 0x90, 0, 0, 0, 0, 0, 0, 0, 0, 0])), 'mp3');
  assert.equal(sniffAudioFormat(new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20])), 'm4a');
  assert.equal(sniffAudioFormat(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0])), 'opus');
  assert.equal(sniffAudioFormat(new Uint8Array([1, 2, 3])), null);
});

test('sliceWithEnvelope: cuts the window and applies linear fades', () => {
  const src: AudioPcm = { channels: [new Float32Array(1000).fill(1)], sampleRate: 1000 };
  const cut = sliceWithEnvelope(src, 100, 600, { fadeIn: 0.1, fadeOut: 0.1, volume: 0.5 });
  const ch = cut.channels[0]!;
  assert.equal(ch.length, 500);
  assert.equal(ch[0], 0);                                   // fade starts at silence
  assert.ok(Math.abs(ch[250]! - 0.5) < 1e-6);               // full (volume) in the middle
  assert.ok(ch[499]! < 0.5 && ch[499]! > 0);                // fading out at the end
});

// ── renderAudioExport (source resolution + the pass-through rule) ─────────────

test('renderAudioExport: a whole, unmodified source in the requested format passes its ORIGINAL bytes through', async () => {
  const source = new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0, 0, 0, 9, 9, 9]);
  let decoded = 0;
  const blob = await renderAudioExport('mp3', {
    audio: { url: 'blob:x' },
    fetchBytes: async () => source.buffer.slice(0) as ArrayBuffer,
    decode: async () => { decoded++; return tone(1000); },
  });
  assert.equal(blob.type, 'audio/mpeg');
  assert.deepEqual(await bytesOf(blob), source);
  assert.equal(decoded, 1, 'the source is decoded once, to learn its true length');
});

test('renderAudioExport: a trimmed excerpt is a real encode of exactly that window', async () => {
  const src = tone(4 * RATE);
  const bytes = (await bytesOf(encodeWav(src, { sampleFormat: 'float32' }))).buffer as ArrayBuffer;
  const blob = await renderAudioExport('wav', {
    audio: { url: 'blob:x', start: 1 },
    duration: 1,
    sampleFormat: 'float32',
    fetchBytes: async () => bytes,
    decode: async () => src,
  });
  const back = parseWav(await bytesOf(blob));
  assert.equal(back.channels[0]!.length, RATE);
  assert.deepEqual(back.channels[0], src.channels[0]!.slice(RATE, 2 * RATE));
  assert.deepEqual(back.channels[1], src.channels[1]!.slice(RATE, 2 * RATE));
});

test('renderAudioExport: a whole source in a DIFFERENT format is re-encoded, not passed through', async () => {
  const src = tone(2000);
  const mp3ish = new Uint8Array([0xff, 0xfb, 0x90, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const blob = await renderAudioExport('wav', {
    audio: { url: 'blob:x' },
    fetchBytes: async () => mp3ish.buffer.slice(0) as ArrayBuffer,
    decode: async () => src,
  });
  assert.equal(blob.type, 'audio/wav');
  assert.equal(tag(await bytesOf(blob), 0, 4), 'RIFF');
});

test('renderAudioExport: caller-supplied PCM wins over the URL and is never fetched', async () => {
  const blob = await renderAudioExport('wav', {
    pcm: tone(500),
    audio: { url: 'blob:x' },
    fetchBytes: async () => { throw new Error('must not fetch'); },
  });
  assert.equal(parseWav(await bytesOf(blob)).channels[0]!.length, 500);
});

test('renderAudioExport: no source at all is an error, never a file of silence', async () => {
  await assert.rejects(() => renderAudioExport('wav', {}), new RegExp(NO_AUDIO_MSG.slice(0, 24)));
});

test('renderAudioExport: a start past the end of the track warns and exports from 0:00', async () => {
  const src = tone(1000);
  const warnings: string[] = [];
  const blob = await renderAudioExport('wav', {
    audio: { url: 'blob:x', start: 99 },
    sampleFormat: 'float32',
    fetchBytes: async () => new ArrayBuffer(0),
    decode: async () => src,
    log: (l, m) => { if (l === 'warn') warnings.push(m); },
  });
  assert.equal(warnings.length, 1);
  assert.deepEqual(parseWav(await bytesOf(blob)).channels[0], src.channels[0]);
});

test('pcmFromAudioBuffer: folds an AudioBuffer-shaped source to at most stereo planes', () => {
  const plane = new Float32Array([0.1, 0.2]);
  const pcm = pcmFromAudioBuffer({ length: 2, numberOfChannels: 6, sampleRate: 32_000, getChannelData: () => plane });
  assert.equal(pcm.channels.length, 2);
  assert.equal(pcm.sampleRate, 32_000);
});

// ── the capability probe (bridge/format-support.ts) ──────────────────────────
// Its cache is module state, so these run in order, last, and each overwrites it.

test('audioSupport: wav and mp3 are unconditional; m4a/opus start false in a browser with no AudioEncoder', async () => {
  const { audioSupport } = await import('../bridge/format-support.ts');
  assert.deepEqual(audioSupport(), { wav: true, mp3: true, m4a: false, opus: false });
});

test('audioSupport: an AAC-only encoder unlocks m4a alone once the probe resolves', async () => {
  const { probeWebCodecsAudioSupport, audioSupport } = await import('../bridge/format-support.ts');
  const codecs: string[] = [];
  await probeWebCodecsAudioSupport({
    isConfigSupported: async (c: any) => { codecs.push(c.codec); return { supported: c.codec === 'mp4a.40.2' }; },
  });
  assert.deepEqual(audioSupport(), { wav: true, mp3: true, m4a: true, opus: false });
  assert.deepEqual(codecs.sort(), ['mp4a.40.2', 'opus']);
});

test('probeWebCodecsAudioSupport: a throwing isConfigSupported reads as unsupported, never rejects', async () => {
  const { probeWebCodecsAudioSupport, audioSupport } = await import('../bridge/format-support.ts');
  const r = await probeWebCodecsAudioSupport({ isConfigSupported: async () => { throw new Error('nope'); } });
  assert.deepEqual(r, { m4a: false, opus: false });
  assert.equal(audioSupport().opus, false);
});

test('encodeAudio: dispatches each format to its own container', async () => {
  const pcm = tone(2400);
  assert.equal(tag(await bytesOf(await encodeAudio('wav', pcm)), 0, 4), 'RIFF');
  assert.equal((await encodeAudio('mp3', pcm)).type, 'audio/mpeg');
});
