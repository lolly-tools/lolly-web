// SPDX-License-Identifier: MPL-2.0
/**
 * Web implementation of the `recorder` capability — device A/V capture + a live
 * audio-level meter (engine bridge v1.17). The runtime drives a tool's `onLevel`
 * hook from these levels (a mic recorder's VU meter + coaching) and orchestrates a
 * recording session (runtime.startRecording → RecordSession).
 *
 * Like `media`, the whole MediaStream / MediaRecorder / AnalyserNode lives HERE, in
 * the shell — the engine only ever sees plain numbers (AudioLevel) and finished
 * Blobs, so it stays DOM-free. Audio is analysed + recorded on the device and never
 * leaves it.
 *
 * Two consumers share the design:
 *   - `meter`  — a pre-record "sound check": ref-counted getUserMedia({audio}) +
 *                AnalyserNode on a rAF loop, mirroring media.ts. Paused while hidden.
 *   - `record` — a full capture session (mic, optionally camera) via MediaRecorder;
 *                it taps its own AnalyserNode so levels keep flowing during the take.
 */

import type {
  RecorderAPI, MeterAPI, RecordOpts, RecordSession, AudioLevel,
} from '../../../../engine/src/bridge/host-v1.ts';
// Import the tiny mime-candidate list directly (NOT videoMimeType from export.ts) —
// recorder.ts is wired into the bridge at boot, and pulling in export.ts (the whole
// rasteriser) would drag it into the preload bundle. video-mime.ts is dependency-free.
import { videoMimeCandidates } from './video-mime.ts';
// Tiny dependency-free shell side channel — safe to import on the boot path.
import { publishRecordPreview } from '../lib/record-preview.ts';

/** Best supported recorder mime for a video capture (audio+video), or null. Local
 *  copy of export.ts's videoMimeType so the boot path never imports the rasteriser. */
function videoMimeType(preferred?: 'webm' | 'mp4', { audio = false }: { audio?: boolean } = {}): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  return videoMimeCandidates(preferred as string, { audio }).find(t => MediaRecorder.isTypeSupported?.(t)) ?? null;
}

type LevelCallback = (level: AudioLevel) => void;

const MAX_FPS = 30;
const MIN_INTERVAL = 1000 / MAX_FPS;
const CLIP_THRESHOLD = 0.99;      // peak at/above this = clipping
const FFT_SIZE = 2048;            // analyser window
// Light smoothing so the loudness bar reads like a real VU meter (fast attack,
// slower release) rather than jittering frame-to-frame. Peak uses a hold+decay.
const RMS_ATTACK = 0.5;
const RMS_RELEASE = 0.12;
// Peak marker: jump to a new peak, HANG at it briefly, then fall off with a gentle
// per-frame decay — a classic peak-hold whose visible slide back down reads the recent
// loudness history. The dB read-out (peak-derived) is separately EMA-eased so the number
// doesn't jitter frame-to-frame.
const PEAK_DECAY = 0.94;    // gentler per-frame fall (was 0.9) so the fall-off is a readable slide
const PEAK_HANG_MS = 700;   // hold the peak at its max this long BEFORE it starts falling off
const DB_SMOOTH_MS = 260;   // EMA time-constant for the dB READOUT so the number eases, not jitters
// Noise-floor tracker: snap down to any new quiet minimum instantly, release UP very
// slowly (~0.5 dB/s at 30fps) so the floor sits at the level in the gaps between
// speech, not the speech itself.
const FLOOR_RELEASE_DB = 0.5 / MAX_FPS;
// Mains-hum bands (50/60 Hz + first harmonics) — tonal electrical hum / ground loop.
const HUM_HZ = [50, 60, 100, 120, 150, 180];
// Spectral-flatness (hiss) is measured over a mid band, skipping low rumble + the
// very top where mic response rolls off.
const HISS_LO_HZ = 400, HISS_HI_HZ = 8000;
// Loudness-envelope steadiness: a fan / AC / hiss holds a near-CONSTANT rms, while speech
// MODULATES it (syllabic peaks + gaps). We track the raw rms mean + mean-abs-deviation
// over ~1.5s and map the coefficient of variation to 0..1 (steady drone → 1, speech → 0),
// so coaching can tell background noise from speech independent of level.
const STEADY_TAU_MS = 1500;    // envelope-stats time constant
const STEADY_MIN_RMS = 0.008;  // below this there's too little signal to judge
const STEADY_COV = 0.4;        // rms CoV at/above which the envelope reads as fully modulated (speech)

/** Bins (± a neighbour) covering the mains-hum frequencies, for a given bin width.
 *  Precomputed once per stream (binHz is fixed) to avoid per-frame allocation. */
function humBinsFor(binHz: number): Set<number> {
  const bins = new Set<number>();
  for (const f of HUM_HZ) { const b = Math.round(f / binHz); bins.add(b - 1); bins.add(b); bins.add(b + 1); }
  return bins;
}
/** Frequency-domain cues from an analyser's magnitude spectrum (dB per bin). Returns
 *  hum (0..1 mains-band share) and hiss (0..1 spectral flatness of the mid band).
 *  `humBins` + band edges are precomputed by the caller (constant for the stream). */
function spectralCues(freqDb: Float32Array, humBins: Set<number>, loBin: number, hiBin: number): { hum: number; hiss: number } {
  let total = 0, mains = 0;             // linear-amplitude sums for the hum ratio
  let logSum = 0, linSum = 0, n = 0;    // for flatness over the mid band
  for (let i = 1; i < freqDb.length; i++) {
    const amp = Math.pow(10, freqDb[i]! / 20);   // dB → linear amplitude
    total += amp;
    if (humBins.has(i)) mains += amp;
    if (i >= loBin && i <= hiBin) {
      linSum += amp;
      logSum += Math.log(amp + 1e-12);
      n++;
    }
  }
  const hum = total > 1e-9 ? Math.min(1, mains / total) : 0;
  const geo = n ? Math.exp(logSum / n) : 0;
  const arith = n ? linSum / n : 0;
  const hiss = arith > 1e-9 ? Math.min(1, geo / arith) : 0;
  return { hum, hiss };
}

const hasGetUserMedia = (): boolean =>
  typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia);
const hasRecorder = (): boolean =>
  typeof MediaRecorder !== 'undefined';

type AudioContextCtor = typeof AudioContext;
function audioContextCtor(): AudioContextCtor | null {
  return (globalThis.AudioContext ?? (globalThis as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext) ?? null;
}

/**
 * Analyse a live MediaStream's audio into AudioLevel samples pushed to `emit` on a
 * rAF loop (throttled, paused while hidden). Returns a stop() that tears the graph
 * down. Shared by the meter and each record session.
 */
function analyseStream(stream: MediaStream, emit: (l: AudioLevel) => void): () => void {
  const AC = audioContextCtor();
  if (!AC || !stream.getAudioTracks().length) return () => {};
  const ctx = new AC();
  const srcNode = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = FFT_SIZE;
  srcNode.connect(analyser);
  const buf = new Float32Array(analyser.fftSize);
  const freqBuf = new Float32Array(analyser.frequencyBinCount); // dB per bin
  const binHz = ctx.sampleRate / analyser.fftSize;
  // Precompute the mains-hum bins + flatness band edges ONCE — binHz is fixed for the
  // life of the AudioContext, so recomputing them every frame would just churn the GC.
  const humBins = humBinsFor(binHz);
  const loBin = Math.max(1, Math.floor(HISS_LO_HZ / binHz));
  const hiBin = Math.min(freqBuf.length - 1, Math.ceil(HISS_HI_HZ / binHz));
  let rafId = 0;
  let last = 0;
  let rmsSmoothed = 0;
  let peakHold = 0;
  let peakHangUntil = 0;       // peakHold stays put until now passes this, then it falls off
  let dbfsSmoothed = -Infinity; // eased dB read-out (separate from the raw peak dbfs)
  // Loudness-envelope stats for the `steady` (noise-vs-speech) metric.
  let rmsEnvMean = 0;   // slow mean of the RAW rms
  let rmsEnvDev = 0;    // slow mean-abs-deviation of the raw rms about that mean
  // dBFS min-hold of the loudness (the quiet-gap level). Starts HIGH so the first real
  // sample snaps it down; then it tracks the minimum with a slow upward release.
  let noiseFloor = Infinity;
  let stopped = false;

  const tick = (now: number): void => {
    if (stopped) return;
    rafId = requestAnimationFrame(tick);
    if (now - last < MIN_INTERVAL) return;
    const dt = last ? now - last : MIN_INTERVAL;   // ms since the last PROCESSED frame (for time-based EMAs)
    last = now;
    if (typeof document !== 'undefined' && document.hidden) return; // don't meter a backgrounded tab
    analyser.getFloatTimeDomainData(buf);
    let sumSq = 0;
    let peak = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = buf[i]!;
      sumSq += v * v;
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
    }
    const rms = Math.sqrt(sumSq / buf.length);
    // Envelope steadiness: track the RAW rms mean + mean-abs-deviation over ~1.5s; their
    // ratio (coefficient of variation) is high for speech (peaks/gaps), low for a drone.
    const envA = Math.min(1, dt / STEADY_TAU_MS);
    rmsEnvMean += (rms - rmsEnvMean) * envA;
    rmsEnvDev += (Math.abs(rms - rmsEnvMean) - rmsEnvDev) * envA;
    const cov = rmsEnvMean > STEADY_MIN_RMS ? rmsEnvDev / rmsEnvMean : 0;
    const steady = rmsEnvMean > STEADY_MIN_RMS ? Math.max(0, 1 - cov / STEADY_COV) : 0;
    // Attack fast (sound arriving), release slow (bar falls smoothly).
    const k = rms > rmsSmoothed ? RMS_ATTACK : RMS_RELEASE;
    rmsSmoothed = rmsSmoothed + (rms - rmsSmoothed) * k;
    // Peak-hold with hang-then-fall-off: snap up to any new peak and hold it for
    // PEAK_HANG_MS, then decay so the marker slides back down (a visible fall-off).
    if (peak >= peakHold) { peakHold = peak; peakHangUntil = now + PEAK_HANG_MS; }
    else if (now >= peakHangUntil) { peakHold *= PEAK_DECAY; }
    const clampedPeak = Math.min(1, peakHold);
    // Noise floor: track the RMS in dBFS, snapping down to any new minimum and
    // releasing up slowly so it settles at the level between words (the room floor).
    const rmsDb = rms > 1e-7 ? 20 * Math.log10(rms) : -140;
    noiseFloor = rmsDb < noiseFloor ? rmsDb : noiseFloor + FLOOR_RELEASE_DB;
    // dB read-out: EMA-ease the peak dBFS so the number slides rather than flickering
    // its last digit every frame (the marker's own hold/fall-off drives the raw value).
    const dbfsRaw = clampedPeak > 0 ? 20 * Math.log10(clampedPeak) : -Infinity;
    if (!isFinite(dbfsRaw)) dbfsSmoothed = -Infinity;
    else dbfsSmoothed = isFinite(dbfsSmoothed) ? dbfsSmoothed + (dbfsRaw - dbfsSmoothed) * Math.min(1, dt / DB_SMOOTH_MS) : dbfsRaw;
    const dbfs = dbfsSmoothed;
    analyser.getFloatFrequencyData(freqBuf);
    const { hum, hiss } = spectralCues(freqBuf, humBins, loBin, hiBin);
    // SNR compares like with like — the RMS signal against the RMS-tracked floor (NOT
    // the peak dbfs, which would overstate it by the crest factor).
    const snr = isFinite(noiseFloor) ? Math.round((rmsDb - noiseFloor) * 10) / 10 : undefined;
    emit({
      rms: Math.min(1, rmsSmoothed),
      peak: clampedPeak,
      dbfs,
      clipping: peak >= CLIP_THRESHOLD,
      noiseFloor: isFinite(noiseFloor) ? Math.round(noiseFloor * 10) / 10 : -Infinity,
      snr,
      hum: Math.round(hum * 100) / 100,
      hiss: Math.round(hiss * 100) / 100,
      steady: Math.round(steady * 100) / 100,
      t: now,
    });
  };
  rafId = requestAnimationFrame(tick);
  ctx.resume?.().catch(() => {});

  return () => {
    stopped = true;
    if (rafId) cancelAnimationFrame(rafId);
    try { srcNode.disconnect(); } catch { /* ignore */ }
    ctx.close().catch(() => {});
  };
}

// Audio-only recorder mime, honouring the preferred container (mp4 → aac, else
// opus/webm), filtered to what THIS browser can actually record.
function audioMimeType(preferred?: 'webm' | 'mp4'): string {
  const webm = ['audio/webm;codecs=opus', 'audio/webm'];
  const mp4  = ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4'];
  const order = preferred === 'mp4' ? [...mp4, ...webm] : [...webm, ...mp4];
  return order.find(t => MediaRecorder.isTypeSupported?.(t)) ?? '';
}

function createMeter(): MeterAPI {
  let stream: MediaStream | null = null;
  let stopAnalyse: (() => void) | null = null;
  let refcount = 0;
  let starting: Promise<void> | null = null;
  const subscribers = new Set<LevelCallback>();

  const emit = (level: AudioLevel): void => {
    for (const cb of [...subscribers]) {
      try { cb(level); } catch { /* one bad subscriber must not kill the loop */ }
    }
  };

  function teardown(): void {
    if (stopAnalyse) { stopAnalyse(); stopAnalyse = null; }
    if (stream) { stream.getTracks().forEach(t => { try { t.stop(); } catch { /* ignore */ } }); stream = null; }
  }

  async function start(): Promise<void> {
    refcount++;
    if (stream) return;
    if (starting) return starting;
    starting = (async () => {
      // The meter is a pre-record SOUND CHECK, so open the mic RAW — no echo
      // cancellation, no noise suppression, no auto-gain. It never plays audio back,
      // so raw is safe, and it's the only way to honestly measure the room's true
      // level + background noise (a recording session keeps suppression ON for a
      // clean file — see openSession). autoGainControl:false already kept levels true.
      const s = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        video: false,
      });
      stream = s;
      stopAnalyse = analyseStream(s, emit);
    })();
    try {
      await starting;
    } catch (e) {
      refcount = Math.max(0, refcount - 1);
      teardown();
      throw e;
    } finally {
      starting = null;
    }
  }

  function stop(): void {
    refcount = Math.max(0, refcount - 1);
    if (refcount === 0) teardown();
  }

  function subscribe(cb: LevelCallback): () => void {
    subscribers.add(cb);
    return () => subscribers.delete(cb);
  }

  return { start, stop, subscribe };
}

async function openSession(opts: RecordOpts): Promise<RecordSession> {
  const wantAudio = opts.audio !== false;
  const wantVideo = opts.video === true;
  const edge = opts.maxEdge && opts.maxEdge > 0 ? Math.round(opts.maxEdge) : 1280;
  const constraints: MediaStreamConstraints = {
    audio: wantAudio
      ? { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      : false,
    video: wantVideo
      ? { facingMode: opts.facingMode ?? 'user', width: { ideal: edge }, height: { ideal: edge } }
      : false,
  };
  const stream = await navigator.mediaDevices.getUserMedia(constraints);

  const mimeType = wantVideo
    ? (videoMimeType(opts.format ?? 'mp4', { audio: wantAudio }) ?? videoMimeType(opts.format ?? 'mp4') ?? '')
    : audioMimeType(opts.format);
  let recorder: MediaRecorder;
  try {
    try {
      recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    } catch {
      recorder = new MediaRecorder(stream); // let the browser pick if the hinted mime is rejected
    }
  } catch (e) {
    // Even the browser-default MediaRecorder can't encode this stream (no supported format):
    // release the camera/mic we just acquired so the hardware indicator never stays lit with
    // no recording running, then surface the failure to the caller.
    stream.getTracks().forEach(t => { try { t.stop(); } catch { /* ignore */ } });
    throw e;
  }
  const chunks: Blob[] = [];
  recorder.ondataavailable = e => { if (e.data && e.data.size > 0) chunks.push(e.data); };
  // Video take: expose the live capture stream to the shell so the tool view can show a
  // self-view during the take (the framing viewfinder is torn down once we open this
  // stream). The DOM-free engine stays out of it — this is a shell-internal side channel.
  if (wantVideo) publishRecordPreview(stream);

  // Live levels during the take (only meaningful with an audio track).
  const subscribers = new Set<LevelCallback>();
  const stopAnalyse = wantAudio
    ? analyseStream(stream, (l) => { for (const cb of [...subscribers]) { try { cb(l); } catch { /* ignore */ } } })
    : () => {};

  let maxTimer = 0;
  let settle: ((b: Blob) => void) | null = null;
  const finished = new Promise<Blob>((resolve) => { settle = resolve; });

  const releaseDevices = (): void => {
    if (maxTimer) { clearTimeout(maxTimer); maxTimer = 0; }
    stopAnalyse();
    if (wantVideo) publishRecordPreview(null);
    stream.getTracks().forEach(t => { try { t.stop(); } catch { /* ignore */ } });
  };

  recorder.onstop = () => {
    releaseDevices();
    const type = recorder.mimeType || mimeType || (wantVideo ? 'video/webm' : 'audio/webm');
    // Normalise the container label (drop the codecs= tail) for the Blob type so
    // downstream extension/derivation sees a clean 'audio/webm' / 'video/mp4'.
    const container = type.split(';')[0] || type;
    settle?.(new Blob(chunks, { type: container }));
  };

  recorder.start();
  if (opts.maxMs && opts.maxMs > 0) {
    maxTimer = window.setTimeout(() => { try { recorder.stop(); } catch { /* already stopped */ } }, opts.maxMs);
  }

  let stopping = false;
  return {
    subscribe(cb: LevelCallback): () => void {
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    },
    async stop(): Promise<Blob> {
      if (!stopping) {
        stopping = true;
        try { recorder.stop(); } catch { releaseDevices(); settle?.(new Blob(chunks)); }
      }
      return finished;
    },
    cancel(): void {
      stopping = true;
      try { recorder.stop(); } catch { /* ignore */ }
      releaseDevices();
      settle?.(new Blob([])); // resolve any pending stop() with nothing
    },
  };
}

export function createRecorderAPI(): RecorderAPI {
  const meter = createMeter();
  return {
    isAvailable(_kind?: 'audio' | 'video'): boolean {
      return hasGetUserMedia() && hasRecorder();
    },
    meter,
    record(opts: RecordOpts = {}): Promise<RecordSession> {
      return openSession(opts);
    },
  };
}
