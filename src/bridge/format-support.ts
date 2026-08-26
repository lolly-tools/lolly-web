// SPDX-License-Identifier: MPL-2.0
// Capability probes for format availability. These are tiny, stateless (bar one
// memo) DOM/navigator/MediaRecorder feature checks the tool view calls at mount to
// gate the format picker. They live HERE, not in export.ts, so importing them does
// NOT drag the ~95 KB rasteriser onto the tool-open path - export.ts stays lazy
// (loaded only on an actual Get/Save). export.ts re-exports these for its dynamic
// callers, and imports canRecord for videoMimeType.
import { WEBM_CODECS, MP4_CODECS } from './video-mime.ts';

// Production needs canvas pixel readback (blocked by Tor / Firefox RFP, which
// breaks every raster export). Delivery is the TIFF-specific catch: the browser
// can't preview a CMYK TIFF, and mobile Safari / in-app WebViews route blob
// downloads to an in-page view - a dead end for a non-displayable file. So the
// format is offered on desktop only, until a previewable / colour-managed path
// exists. The shell calls this from keepFormat to hide the option where unusable.
let _cmykTiff: boolean | null = null;
export function cmykTiffSupport(): boolean {
  if (_cmykTiff !== null) return _cmykTiff;
  _cmykTiff = false;
  if (typeof document === 'undefined' || typeof navigator === 'undefined') return _cmykTiff;
  try {
    const c = document.createElement('canvas');
    c.width = c.height = 2;
    const ctx = c.getContext('2d');
    if (!ctx) return _cmykTiff;
    ctx.fillRect(0, 0, 1, 1);
    ctx.getImageData(0, 0, 1, 1);                     // throws if readback is blocked
  } catch { return _cmykTiff; }
  const ua = navigator.userAgent || '';
  const iOS = /iP(hone|ad|od)/.test(ua) || (/Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1);
  const mobile = iOS || /Android/.test(ua) || (/Mobi/.test(ua) && (navigator.maxTouchPoints || 0) > 0);
  _cmykTiff = !mobile;
  return _cmykTiff;
}

// The plain RGB TIFF has the same produce-and-deliver constraints as the CMYK one
// (canvas pixel readback to produce; no in-browser preview + mobile blob-download
// dead-end to deliver), so it's gated identically - desktop only. Separate export
// so callers read intent, not a CMYK-named check.
export function tiffSupport(): boolean {
  return cmykTiffSupport();
}

// The pro float interchange formats (OpenEXR, Radiance RGBE - plans/61-deeprichpixels.md
// section 4.2/section 6 B3). The engine owns the writers, but they are fed by a float rasterisation
// the WEB shell cannot do: packages/node-shell/src/raster.ts renders the tool to an
// SVG, rasterises it with resvg and hands the un-premultiplied RGBA to packExr /
// packRadiance. Nothing on this side produces that frame - the browser path ends at
// 8-bit canvas bytes - so the answer is a flat false, not a probe. section 10 item 4 puts
// these formats CLI-first on purpose: offering an option the shell then refuses is
// worse than not offering it. Flip this to a real probe (and add the encoders) if a
// float render path ever lands in the browser; keepFormat and the picker's Pro
// <optgroup> both read this one function, so nothing else has to change.
export function proFormatSupport(): boolean {
  return false;
}

// True only if this browser's MediaRecorder pipeline is usable at all (it also
// needs canvas.captureStream).
export function canRecord(): boolean {
  return typeof MediaRecorder !== 'undefined' &&
         typeof HTMLCanvasElement !== 'undefined' &&
         typeof HTMLCanvasElement.prototype.captureStream === 'function';
}

// Live capture ("Record live" on webm/mp4) needs a display-capture source plus a
// usable recorder. Deliberately does NOT require CropTarget: any browser with
// getDisplayMedia can take live-capture.ts's calibrated-crop tier - Chromium just
// gets the exact element crop for free. Mobile browsers (no getDisplayMedia) and
// Tauri WebViews fail the probe, so the toggle never shows where it can't work.
export function liveCaptureSupport(): boolean {
  return typeof navigator !== 'undefined' &&
         typeof navigator.mediaDevices?.getDisplayMedia === 'function' &&
         canRecord();
}

// The durable credential (opt-in TrustMark embed - tool-actions.ts, export.ts's
// durableEmbedCanvas) is a neural ONNX encode that lazily fetches a ~33 MB encoder
// model from the deploy origin. Under Tauri (desktop/mobile) that model isn't
// bundled and there's no origin server to pull it from, so the embed simply CAN'T
// work offline there - hide the toggle rather than offer a silent no-op. The web
// PWA fetches it from its own origin (then caches it in IndexedDB, so it keeps
// working offline once primed), so the toggle is offered there. Also requires
// WebAssembly for onnxruntime-web. If a Tauri build ever bundles the encoder under
// /models/trustmark/, revisit this gate (a bundled model would work offline).
export function durableSupport(): boolean {
  if (typeof WebAssembly === 'undefined') return false;
  const tauri = typeof window !== 'undefined' &&
    typeof (window as { __TAURI_INTERNALS__?: { invoke?: unknown } }).__TAURI_INTERNALS__?.invoke === 'function';
  return !tauri;
}

// WebCodecs half of the video gate. renderVideo tries a VideoEncoder encode FIRST,
// so a browser whose MediaRecorder can't produce a container (e.g. no MediaRecorder
// mp4, but VideoEncoder AVC) still makes a real file - the picker must offer it.
// VideoEncoder.isConfigSupported is async while videoSupport() is a sync gate, so
// the probe is kicked off once at module load and cached; until it resolves
// videoSupport() reports the MediaRecorder-only answer. That transient under-report
// is deliberate progressive enhancement - the option appears on the next gate read,
// it is never wrongly offered. Exported (with the encoder injectable) so the
// resolve-then-OR behaviour is unit-testable under node.
const _wcVideo = { webm: false, mp4: false };
type ConfigProbe = { isConfigSupported?: (c: object) => Promise<{ supported?: boolean } | null | undefined> };
export async function probeWebCodecsVideoSupport(
  VE: ConfigProbe | undefined = (globalThis as { VideoEncoder?: ConfigProbe }).VideoEncoder,
): Promise<{ webm: boolean; mp4: boolean }> {
  const isSupported = VE?.isConfigSupported?.bind(VE);
  if (typeof isSupported !== 'function') return _wcVideo;
  const ok = async (codec: string): Promise<boolean> => {
    try {
      // Nominal 720p - export.ts's pickWebCodecsVideo re-probes at the real size.
      return !!(await isSupported({ codec, width: 1280, height: 720, bitrate: 2_000_000, framerate: 24 }))?.supported;
    } catch { return false; }
  };
  // The same codec candidates pickWebCodecsVideo tries, per container.
  const [mp4, webm] = await Promise.all([
    Promise.all(['avc1.640033', 'avc1.4d0033'].map(ok)).then((r) => r.some(Boolean)),
    Promise.all(['vp09.00.10.08', 'vp8'].map(ok)).then((r) => r.some(Boolean)),
  ]);
  _wcVideo.mp4 = mp4;
  _wcVideo.webm = webm;
  return _wcVideo;
}
void probeWebCodecsVideoSupport();

// Which video containers this browser can actually produce: what MediaRecorder can
// record (Safari/iOS = mp4 only; Firefox = webm only; recent Chrome = both), OR'd
// with the cached WebCodecs probe above. The view uses this to gate the format
// picker so users only see formats their browser can produce. Deliberately probes
// the video-only lists - audio is optional, so a browser that can't mux audio
// still offers the format (it records silent, with a log warning).
export function videoSupport(): { webm: boolean; mp4: boolean } {
  const ok = (t: string) => canRecord() && (MediaRecorder.isTypeSupported?.(t) ?? false);
  return { webm: WEBM_CODECS.some(ok) || _wcVideo.webm, mp4: MP4_CODECS.some(ok) || _wcVideo.mp4 };
}

// The audio-only export formats (lib/audio-encode.ts). wav and mp3 are pure JS
// (engine packWav / lamejs), so they are unconditional - no probe can fail them.
// m4a/aac and opus/ogg ride the platform's WebCodecs AudioEncoder, whose
// isConfigSupported is async while audioSupport() is a sync gate, so this follows
// the same shape as probeWebCodecsVideoSupport above: fire once at module load,
// cache, and report the safe answer (false) until it resolves. The option appears
// on the next gate read; it is never wrongly offered. Only TWO probes are needed:
// m4a and aac are the same AAC encoder in different containers (so they share the
// mp4a.40.2 result), and opus and ogg are the same Opus encoder (sharing the opus
// result). Nominal config only - audio-encode.ts re-probes at the clip's real
// sample rate before it encodes.
const _wcAudio = { m4a: false, opus: false };
export async function probeWebCodecsAudioSupport(
  AE: ConfigProbe | undefined = (globalThis as { AudioEncoder?: ConfigProbe }).AudioEncoder,
): Promise<{ m4a: boolean; opus: boolean }> {
  const isSupported = AE?.isConfigSupported?.bind(AE);
  if (typeof isSupported !== 'function') return _wcAudio;
  const ok = async (codec: string): Promise<boolean> => {
    try {
      return !!(await isSupported({ codec, sampleRate: 48_000, numberOfChannels: 2, bitrate: 128_000 }))?.supported;
    } catch { return false; }
  };
  // The same codecs export.ts's pickWebCodecsAudio uses, per container.
  const [m4a, opus] = await Promise.all([ok('mp4a.40.2'), ok('opus')]);
  _wcAudio.m4a = m4a;
  _wcAudio.opus = opus;
  return _wcAudio;
}
void probeWebCodecsAudioSupport();

// Which audio-only formats this browser can actually produce. The picker gates on
// this exactly as it does on videoSupport(). aac shares m4a's AAC encoder and ogg
// shares opus's Opus encoder, so each pair reports the same probe result.
export function audioSupport(): { wav: boolean; mp3: boolean; m4a: boolean; aac: boolean; opus: boolean; ogg: boolean } {
  return {
    wav: true, mp3: true,
    m4a: _wcAudio.m4a, aac: _wcAudio.m4a,
    opus: _wcAudio.opus, ogg: _wcAudio.opus,
  };
}
