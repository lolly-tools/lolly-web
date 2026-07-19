// SPDX-License-Identifier: MPL-2.0
/**
 * DOM-free image-metadata byte-stampers, extracted verbatim from bridge/export.ts
 * (stage 1 of the export.ts split — same precedent as export-css.ts). Pure
 * bytes-in/bytes-out helpers that splice DPI, provenance metadata and ICC colour
 * profiles into PNG / JPEG / SVG / GIF output, plus the zlib inflate/deflate
 * wrappers the PNG iCCP path (and the CMYK PDF content-stream rewrite in
 * export.ts) depend on. All best-effort: any parse hiccup returns the input
 * bytes untouched. No DOM and no module state.
 */
import { crc32 } from '@lolly/engine';
import type { ExportMeta } from '../../../../engine/src/bridge/host-v1.ts';
import type { ExportOpts } from './export.ts';

// ── PNG physical-resolution metadata ────────────────────────────────────────
//
// dom-to-image PNGs carry no DPI, so they're assumed 96 — a 2480px-wide A4
// raster would print ~26 inches wide. insertPngPhys (below) injects a pHYs chunk
// recording the real DPI so print/layout software places the image at its
// intended physical size. All the byte-level stampers here take and return a
// Uint8Array (the caller reads/writes the Blob once) and are best-effort: any
// parse hiccup returns the input bytes untouched.

// JPEG carries DPI in the JFIF APP0 segment (right after SOI). Browsers emit one
// with no/72 density; patch the density-unit + X/Y density so placing apps size
// it physically. Best-effort: anything unexpected returns the bytes untouched.
export function patchJpegDpi(b: Uint8Array, dpi: number): Uint8Array {
  if (!(dpi > 0)) return b;
  try {
    // FFD8 (SOI) FFE0 (APP0) … "JFIF\0" at byte 6.
    if (b[0] !== 0xFF || b[1] !== 0xD8 || b[2] !== 0xFF || b[3] !== 0xE0) return b;
    if (!(b[6] === 0x4A && b[7] === 0x46 && b[8] === 0x49 && b[9] === 0x46 && b[10] === 0x00)) return b;
    const out = b.slice();
    const d = Math.min(0xFFFF, Math.round(dpi));
    out[13] = 1;                // density units: dots per inch
    out[14] = (d >> 8) & 0xFF;  // Xdensity
    out[15] = d & 0xFF;
    out[16] = (d >> 8) & 0xFF;  // Ydensity
    out[17] = d & 0xFF;
    return out;
  } catch {
    return b;
  }
}

export const readU32 = (b: Uint8Array, o: number): number => ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
export function writeU32(b: Uint8Array, o: number, v: number): void { b[o] = (v >>> 24) & 255; b[o + 1] = (v >>> 16) & 255; b[o + 2] = (v >>> 8) & 255; b[o + 3] = v & 255; }

// CRC-32 comes from the engine barrel (zip-crypto's table-driven implementation:
// reflected poly 0xEDB88320, init/xorout 0xFFFFFFFF — verified bit-identical to
// the local table this module carried before the stage-1 split).

export function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(12 + data.length);
  writeU32(chunk, 0, data.length);
  for (let i = 0; i < 4; i++) chunk[4 + i] = type.charCodeAt(i);
  chunk.set(data, 8);
  writeU32(chunk, 8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
  return chunk;
}

// Splice a pHYs chunk (pixels-per-metre, unit=metre) in right after IHDR.
export function insertPngPhys(png: Uint8Array, dpi: number): Uint8Array | null {
  const SIG = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) if (png[i] !== SIG[i]) return null;
  const ihdrLen = readU32(png, 8);
  const insertAt = 8 + 12 + ihdrLen; // sig + (len+type+data+crc) of IHDR
  const ppm = Math.round(dpi / 0.0254); // px per inch → px per metre
  const data = new Uint8Array(9);
  writeU32(data, 0, ppm);
  writeU32(data, 4, ppm);
  data[8] = 1; // unit specifier: metres
  const phys = pngChunk('pHYs', data);
  const out = new Uint8Array(png.length + phys.length);
  out.set(png.subarray(0, insertAt), 0);
  out.set(phys, insertAt);
  out.set(png.subarray(insertAt), insertAt + phys.length);
  return out;
}

// ── Provenance metadata (authorship embedded per format) ─────────────────────
//
// A generic record assembled by the engine (engine/src/metadata.js) is mapped
// here onto each format's native mechanism: PNG iTXt, JPEG EXIF (IFD0), PDF info
// dict (in renderPdf/renderCmykPdf), SVG <metadata>+<title>/<desc>, GIF comment,
// and the video containers via the engine's video-meta.js (MP4 udta/ilst,
// Matroska Tags — see withVideoMeta beside renderVideo).
// All best-effort: anything unexpected returns the input untouched.

const xmlEsc = (s: unknown): string => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// PNG: one UTF-8 iTXt chunk per metadata field, spliced in after IHDR.
export function iTXtChunk(keyword: string, text: string): Uint8Array {
  const enc = new TextEncoder();
  const kw = enc.encode(keyword);
  const txt = enc.encode(text);
  const data = new Uint8Array(kw.length + 5 + txt.length);
  let o = 0;
  data.set(kw, o); o += kw.length;
  data[o++] = 0; // keyword terminator
  data[o++] = 0; // compression flag (uncompressed)
  data[o++] = 0; // compression method
  data[o++] = 0; // language tag (empty) terminator
  data[o++] = 0; // translated keyword (empty) terminator
  data.set(txt, o);
  return pngChunk('iTXt', data);
}

export function insertPngMeta(png: Uint8Array, meta: ExportMeta | null | undefined): Uint8Array {
  if (!meta) return png;
  try {
    const SIG = [137, 80, 78, 71, 13, 10, 26, 10];
    for (let i = 0; i < 8; i++) if (png[i] !== SIG[i]) return png;
    const pairs = ([
      ['Software', meta.software], ['Author', meta.author],
      ['Source', meta.source], ['Description', meta.description], ['Comment', meta.contact],
      // 'Copyright' is a PNG-registered text keyword; 'License' is conventional.
      // User-asserted (bindToMeta) — empty on ordinary exports, filtered out below.
      ['Copyright', meta.copyright || ''], ['License', meta.license || ''],
    ] as [string, string][]).filter(([, v]) => v);
    if (!pairs.length) return png;
    const chunks = pairs.map(([k, v]) => iTXtChunk(k, v));
    const at = 8 + 12 + readU32(png, 8); // after IHDR
    const extra = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(png.length + extra);
    out.set(png.subarray(0, at), 0);
    let o = at;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    out.set(png.subarray(at), o);
    return out;
  } catch {
    return png;
  }
}

// JPEG: a minimal little-endian EXIF TIFF (IFD0, ASCII tags) in an APP1 segment,
// inserted after the JFIF APP0. Tags: ImageDescription, Software, Artist, Copyright
// (ascending tag order, as TIFF requires).
export function buildExifTiff(fields: { tag: number; value: string }[]): Uint8Array | null {
  const enc = new TextEncoder();
  const entries = fields.map(f => {
    const s = enc.encode(f.value);
    const data = new Uint8Array(s.length + 1); data.set(s, 0); // NUL-terminated
    return { tag: f.tag, count: data.length, data };
  }).filter(e => e.count > 1);
  const n = entries.length;
  if (!n) return null;
  const dataStart = 8 + 2 + n * 12 + 4; // header + IFD(count + entries + next)
  const dataLen = entries.reduce((s, e) => s + (e.count > 4 ? e.count : 0), 0);
  const tiff = new Uint8Array(dataStart + dataLen);
  const dv = new DataView(tiff.buffer);
  tiff[0] = 0x49; tiff[1] = 0x49;            // "II" little-endian
  dv.setUint16(2, 0x002A, true);
  dv.setUint32(4, 8, true);                  // IFD0 offset
  dv.setUint16(8, n, true);
  let entryOff = 10, dataOff = dataStart;
  for (const e of entries) {
    dv.setUint16(entryOff, e.tag, true);
    dv.setUint16(entryOff + 2, 2, true);     // type ASCII
    dv.setUint32(entryOff + 4, e.count, true);
    if (e.count <= 4) tiff.set(e.data, entryOff + 8);
    else { dv.setUint32(entryOff + 8, dataOff, true); tiff.set(e.data, dataOff); dataOff += e.count; }
    entryOff += 12;
  }
  dv.setUint32(10 + n * 12, 0, true);        // next IFD = none
  return tiff;
}

export function insertJpegExif(b: Uint8Array, meta: ExportMeta | null | undefined): Uint8Array {
  if (!meta) return b;
  try {
    const desc = [meta.description, meta.contact].filter(Boolean).join(' · ');
    // The © notice + any licence in one broadly-read field (Finder, Lightroom, …).
    const rights = [meta.copyright, meta.license].filter(Boolean).join(' · ');
    const tiff = buildExifTiff([
      { tag: 0x010E, value: desc },          // ImageDescription
      { tag: 0x0131, value: meta.software }, // Software
      { tag: 0x013B, value: meta.author },   // Artist
      { tag: 0x8298, value: rights },        // Copyright (© notice + licence) — tag order ascending
    ].filter(f => f.value));
    if (!tiff) return b;
    const id = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif\0\0"
    const segLen = 2 + id.length + tiff.length;       // length field includes itself
    if (segLen > 0xFFFF) return b;
    const app1 = new Uint8Array(2 + segLen);
    app1[0] = 0xFF; app1[1] = 0xE1;
    app1[2] = (segLen >> 8) & 0xFF; app1[3] = segLen & 0xFF;
    app1.set(id, 4); app1.set(tiff, 4 + id.length);

    if (b[0] !== 0xFF || b[1] !== 0xD8) return b; // not JPEG
    let at = 2; // after SOI; skip an APP0 (JFIF) if present so order stays valid
    if (b[2] === 0xFF && b[3] === 0xE0) at = 4 + ((b[4]! << 8) | b[5]!);
    const out = new Uint8Array(b.length + app1.length);
    out.set(b.subarray(0, at), 0);
    out.set(app1, at);
    out.set(b.subarray(at), at + app1.length);
    return out;
  } catch {
    return b;
  }
}

// ── ICC colour profile embedding ─────────────────────────────────────────────
//
// Tags raster output with the colour space its pixels were rendered in (sRGB —
// what the browser canvas produces), so colour-managed software reproduces them
// faithfully instead of guessing. Profile bytes come from the engine (the single
// source of truth); the shell only splices them into each format's native slot:
// PNG iCCP chunk, JPEG APP2 segment. Best-effort: any hiccup returns the blob.

// Embed when a profile is requested (default 'srgb') and this isn't a thumbnail.
export function iccWanted(opts: ExportOpts): boolean {
  return opts.colorProfile !== 'none' && !opts.thumbnail;
}

// PNG: an iCCP chunk (profile name + compression method 0 + zlib-deflated
// profile) spliced in right after IHDR, before IDAT — where the spec requires it.
export async function insertPngIcc(png: Uint8Array, iccBytes: Uint8Array): Promise<Uint8Array> {
  try {
    const SIG = [137, 80, 78, 71, 13, 10, 26, 10];
    for (let i = 0; i < 8; i++) if (png[i] !== SIG[i]) return png;
    const name = new TextEncoder().encode('sRGB'); // 1–79 bytes, Latin-1
    const compressed = await deflateBytes(iccBytes);
    const data = new Uint8Array(name.length + 2 + compressed.length);
    data.set(name, 0);
    data[name.length] = 0;     // name terminator
    data[name.length + 1] = 0; // compression method: zlib/deflate
    data.set(compressed, name.length + 2);
    const chunk = pngChunk('iCCP', data);
    const at = 8 + 12 + readU32(png, 8); // after IHDR
    const out = new Uint8Array(png.length + chunk.length);
    out.set(png.subarray(0, at), 0);
    out.set(chunk, at);
    out.set(png.subarray(at), at + chunk.length);
    return out;
  } catch {
    return png;
  }
}

// JPEG: one or more APP2 "ICC_PROFILE\0" segments (the profile is split across
// 65 519-byte chunks when large), inserted after the leading APP0/APP1 segments.
export function insertJpegIcc(b: Uint8Array, iccBytes: Uint8Array): Uint8Array {
  try {
    if (b[0] !== 0xFF || b[1] !== 0xD8) return b; // not JPEG
    const id = [0x49, 0x43, 0x43, 0x5F, 0x50, 0x52, 0x4F, 0x46, 0x49, 0x4C, 0x45, 0x00]; // "ICC_PROFILE\0"
    const MAX = 0xFFFF - 2 - id.length - 2; // payload room per APP2 (after len + id + seq/count)
    const count = Math.ceil(iccBytes.length / MAX);
    if (count > 255) return b; // ICC caps at 255 chunks
    const segs: Uint8Array[] = [];
    for (let i = 0; i < count; i++) {
      const part = iccBytes.subarray(i * MAX, i * MAX + MAX);
      const segLen = 2 + id.length + 2 + part.length; // length field includes itself
      const app2 = new Uint8Array(2 + segLen);
      app2[0] = 0xFF; app2[1] = 0xE2;
      app2[2] = (segLen >> 8) & 0xFF; app2[3] = segLen & 0xFF;
      app2.set(id, 4);
      app2[4 + id.length] = i + 1;   // chunk sequence number (1-based)
      app2[5 + id.length] = count;   // total chunks
      app2.set(part, 6 + id.length);
      segs.push(app2);
    }
    // Insert after a leading APP0 (JFIF) and/or APP1 (EXIF) so marker order stays valid.
    let at = 2;
    while (b[at] === 0xFF && (b[at + 1] === 0xE0 || b[at + 1] === 0xE1)) {
      at += 2 + ((b[at + 2]! << 8) | b[at + 3]!);
    }
    const extra = segs.reduce((n, s) => n + s.length, 0);
    const out = new Uint8Array(b.length + extra);
    out.set(b.subarray(0, at), 0);
    let o = at;
    for (const s of segs) { out.set(s, o); o += s.length; }
    out.set(b.subarray(at), o);
    return out;
  } catch {
    return b;
  }
}

// SVG: <title>/<desc> + a Dublin-Core <metadata> block, injected right after the
// opening <svg> tag of the serialized markup (avoids DOM-namespace gymnastics).
export function svgMetaBlock(meta: ExportMeta): string {
  const lines: string[] = [];
  if (meta.tool) lines.push(`<title>${xmlEsc(meta.tool)}</title>`);
  const desc = [meta.description, meta.contact].filter(Boolean).join(' · ');
  if (desc) lines.push(`<desc>${xmlEsc(desc)}</desc>`);
  lines.push(
    '<metadata>',
    '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:dc="http://purl.org/dc/elements/1.1/">',
    '<rdf:Description rdf:about="">',
  );
  if (meta.author) lines.push(`<dc:creator>${xmlEsc(meta.author)}</dc:creator>`);
  const rights = [meta.copyright, meta.license].filter(Boolean).join(' · ');
  if (rights) lines.push(`<dc:rights>${xmlEsc(rights)}</dc:rights>`);
  lines.push(`<dc:publisher>${xmlEsc(meta.software)}</dc:publisher>`);
  lines.push(`<dc:source>${xmlEsc(meta.source)}</dc:source>`, '</rdf:Description>', '</rdf:RDF>', '</metadata>');
  return lines.join('\n');
}

export function injectSvgMeta(xml: string, meta: ExportMeta | null | undefined): string {
  if (!meta) return xml;
  const m = xml.match(/<svg\b[^>]*?>/);
  if (!m) return xml;
  const at = m.index! + m[0]!.length;
  return xml.slice(0, at) + '\n' + svgMetaBlock(meta) + xml.slice(at);
}

// GIF: a Comment Extension (0x21 0xFE …) inserted right after the header + LSD +
// global colour table, before the first frame.
export function withGifComment(bytes: Uint8Array, text: string | undefined): Uint8Array {
  if (!text || bytes.length < 13) return bytes;
  const packed = bytes[10]!;
  const gctSize = (packed & 0x80) ? 3 * (1 << ((packed & 0x07) + 1)) : 0;
  const at = 13 + gctSize;
  const txt = new TextEncoder().encode(text);
  const subs: number[] = [];
  for (let i = 0; i < txt.length; i += 255) {
    const chunk = txt.subarray(i, i + 255);
    subs.push(chunk.length, ...chunk);
  }
  const ext = new Uint8Array(2 + subs.length + 1);
  ext[0] = 0x21; ext[1] = 0xFE; ext.set(subs, 2); ext[ext.length - 1] = 0x00;
  const out = new Uint8Array(bytes.length + ext.length);
  out.set(bytes.subarray(0, at), 0);
  out.set(ext, at);
  out.set(bytes.subarray(at), at + ext.length);
  return out;
}

// Decompresses a zlib/FlateDecode byte buffer using the browser Streams API.
export async function inflateBytes(data: Uint8Array): Promise<Uint8Array> {
  return pipeThroughTransform(new DecompressionStream('deflate'), data);
}

// Compresses bytes to zlib/FlateDecode format using the browser Streams API.
export async function deflateBytes(data: Uint8Array): Promise<Uint8Array> {
  return pipeThroughTransform(new CompressionStream('deflate'), data);
}

async function pipeThroughTransform(transform: any, data: Uint8Array): Promise<Uint8Array> {
  const writer = transform.writable.getWriter();
  writer.write(data);
  writer.close();
  const reader = transform.readable.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let i = 0;
  for (const c of chunks) { out.set(c, i); i += c.length; }
  return out;
}
