// Capability probes for format availability. These are tiny, stateless (bar one
// memo) DOM/navigator/MediaRecorder feature checks the tool view calls at mount to
// gate the format picker. They live HERE, not in export.ts, so importing them does
// NOT drag the ~95 KB rasteriser onto the tool-open path — export.ts stays lazy
// (loaded only on an actual Get/Save). export.ts re-exports these for its dynamic
// callers, and imports canRecord for videoMimeType.
import { WEBM_CODECS, MP4_CODECS } from './video-mime.ts';

// Production needs canvas pixel readback (blocked by Tor / Firefox RFP, which
// breaks every raster export). Delivery is the TIFF-specific catch: the browser
// can't preview a CMYK TIFF, and mobile Safari / in-app WebViews route blob
// downloads to an in-page view — a dead end for a non-displayable file. So the
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
// dead-end to deliver), so it's gated identically — desktop only. Separate export
// so callers read intent, not a CMYK-named check.
export function tiffSupport(): boolean {
  return cmykTiffSupport();
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
// getDisplayMedia can take live-capture.ts's calibrated-crop tier — Chromium just
// gets the exact element crop for free. Mobile browsers (no getDisplayMedia) and
// Tauri WebViews fail the probe, so the toggle never shows where it can't work.
export function liveCaptureSupport(): boolean {
  return typeof navigator !== 'undefined' &&
         typeof navigator.mediaDevices?.getDisplayMedia === 'function' &&
         canRecord();
}

// Which video containers this browser can actually record. Safari/iOS = mp4 only;
// Firefox = webm only; recent Chrome = both. The view uses this to gate the format
// picker so users only see formats their browser can produce. Deliberately probes
// the video-only lists — audio is optional, so a browser that can't mux audio
// still offers the format (it records silent, with a log warning).
export function videoSupport(): { webm: boolean; mp4: boolean } {
  const ok = (t: string) => canRecord() && (MediaRecorder.isTypeSupported?.(t) ?? false);
  return { webm: WEBM_CODECS.some(ok), mp4: MP4_CODECS.some(ok) };
}
