// SPDX-License-Identifier: MPL-2.0
/**
 * Decode an image file into RGBA the engine's `imageColorCloud` can read, in the
 * widest space this browser will hand back.
 *
 * The whole reason this is not three lines: a 2D canvas is sRGB by default, and
 * drawing a Display-P3 photo into one CLIPS it before anything downstream sees a
 * byte. The plot would then show a wide-gamut image sitting neatly inside sRGB
 * and claim that as a finding. So the destination space is negotiated first and
 * the answer is returned alongside the pixels, never assumed.
 *
 * What this still cannot do, and says so rather than pretending: an image's own
 * embedded ICC profile is honoured by the BROWSER's decode into the destination
 * space, so a tagged file is handled correctly, but an UNTAGGED file is sRGB by
 * convention only. `assumed` reports which of those happened so the caller can
 * put it on screen.
 */

import { decodeImageBitmap } from '../bridge/image-resize.ts';
import type { CloudSpace } from '@lolly/engine';

export interface SampledImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  /** The space the bytes are in — pass this straight to `imageColorCloud`. */
  space: CloudSpace;
  /** True when the file carried no colour profile, so `space` is a convention. */
  assumed: boolean;
  /** The source's own pixel dimensions, before the sampling downscale. */
  sourceWidth: number;
  sourceHeight: number;
}

/**
 * Longest side the image is scaled to before sampling.
 *
 * 1400 is ~2M pixels, which is far more than the cloud needs (it samples ~200k)
 * but keeps the downscale itself cheap and leaves headroom for a caller wanting
 * a finer stride. Going smaller would start to lose the rare colours — a few
 * hundred pixels of one vivid object is exactly the thing worth finding.
 */
const MAX_SIDE = 1400;

export async function sampleImageFile(file: Blob): Promise<SampledImage> {
  const bitmap = await decodeImageBitmap(file);
  const sourceWidth = bitmap.width, sourceHeight = bitmap.height;
  const scale = Math.min(1, MAX_SIDE / Math.max(1, sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  // Which destination space to ask for is a real decision, not "the widest wins".
  //
  // Reading a file that is ALREADY sRGB through a Display-P3 canvas re-encodes
  // every pixel into P3's primaries at 8 bits, and that round trip does not land
  // where it started: measured across the sRGB cube, 5.2% of colours come back
  // reading as outside sRGB. On an ordinary photograph that produced a confident
  // "7.4% of this image is beyond sRGB" — about a file with nothing beyond sRGB
  // in it. So a source known or presumed to be sRGB is read in sRGB, where the
  // question does not arise, and only a file carrying a profile that might be
  // wider is worth the wider surface.
  const hint = await profileHint(file);
  const want: CloudSpace = hint === 'other' ? 'display-p3' : 'srgb';
  let ctx = canvas.getContext('2d', { colorSpace: want });
  let space = (ctx?.getContextAttributes?.().colorSpace ?? 'srgb') as CloudSpace;
  if (!ctx) {
    ctx = canvas.getContext('2d');
    space = 'srgb';
  }
  if (!ctx) throw new Error('no 2D context');
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();

  // Second, independent check. A browser that accepted the context option but not
  // this one either throws or hands back sRGB; either way the space collapses
  // here, BEFORE any pixel is interpreted, so the failure mode is "an sRGB
  // reading, correctly labelled" rather than "every colour shifted".
  let img: ImageData;
  try {
    img = ctx.getImageData(0, 0, width, height, { colorSpace: space });
  } catch {
    img = ctx.getImageData(0, 0, width, height);
    space = 'srgb';
  }
  if (img.colorSpace && img.colorSpace !== space) space = img.colorSpace as CloudSpace;

  return {
    data: img.data,
    width,
    height,
    space,
    assumed: hint === 'none',
    sourceWidth,
    sourceHeight,
  };
}

/** What the file says about its own colour space, without decoding it. */
export type ProfileHint =
  /** Nothing at all. sRGB by convention, which is a convention, not a fact. */
  | 'none'
  /** It says sRGB — a PNG `sRGB` chunk or a JFIF/Exif file with no ICC. */
  | 'srgb'
  /** It carries a real profile, which may be wider than sRGB. */
  | 'other';

/**
 * A byte sniff, not a parse: the only question is which destination space to
 * decode into, and that needs "might this be wide?", not the profile itself.
 * Covers the container shapes that turn up — JPEG's `ICC_PROFILE` APP2 marker,
 * PNG's `iCCP` / `cICP` / `sRGB` chunks, and WebP's `ICCP` chunk.
 *
 * Order matters: an embedded ICC wins over an `sRGB` chunk, because a file can
 * carry both and the ICC is the more specific claim. Anything unrecognised
 * answers 'none', which errs toward reading in sRGB and saying so — the safe
 * direction, since the failure is a caveat we did not need rather than a wide
 * colour silently invented.
 */
export async function profileHint(file: Blob): Promise<ProfileHint> {
  try {
    // 64 KB reaches past a JPEG's APP segments and a PNG's header chunks without
    // reading a 40 MB file to answer a three-way question.
    const head = new Uint8Array(await file.slice(0, 65536).arrayBuffer());
    const text = new TextDecoder('latin1').decode(head);
    if (/ICC_PROFILE|iCCP|cICP|ICCP/.test(text)) return 'other';
    if (/sRGB/.test(text)) return 'srgb';
    return 'none';
  } catch {
    return 'none';
  }
}
