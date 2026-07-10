// SPDX-License-Identifier: MPL-2.0
/**
 * Palette download — export every swatch a brand carries (BrandSwatch[], from
 * brand-doc.ts) as a standalone file in one of five formats: a DTCG design-tokens
 * JSON (nested under each swatch's canonical dotted key), a plain CSS custom-
 * properties block, a set of CSS utility classes (bg/text/border), a GIMP .gpl
 * palette (name + 0-255 RGB only, no alpha), or a binary Adobe Swatch Exchange
 * (.ase) file. Pure — no DOM, no host — so it's unit-testable like brand-doc.ts.
 */
import type { BrandSwatch } from './brand-doc.ts';
import type { PaletteEntry } from '../palette.ts';

export type SwatchExportFormat = 'tokens-json' | 'css-vars' | 'css-classes' | 'gpl' | 'ase';

/**
 * The Catalog's Swatches section shows the LIVE palette (lib/live-palette.ts —
 * the resolved brand tokens, so catalog-shipped colours AND everything added in
 * the brand editor alike) as PaletteEntry rows. Rebuild BrandSwatch-shaped
 * entries from them so the same exporters serve that section's download links:
 * whatever the section shows is exactly what downloads.
 */
export function paletteEntriesToSwatches(entries: readonly PaletteEntry[]): BrandSwatch[] {
  return entries.map((e) => {
    const bucket = e.group === 'spectrum' ? 'spectrum' : e.group ? `ramp.${slug(e.group)}` : 'brand';
    const key = `color.${bucket}.${slug(e.label)}`;
    return {
      path: key.split('.'),
      key,
      group: e.group === 'spectrum' ? 'Spectrum' : (e.group ?? 'Brand'),
      name: e.label,
      raw: e.hex,
      hex: e.hex, // non-hex values ('transparent', oklch strings) are filtered by resolved()
      isAlias: false,
      kind: e.group === 'spectrum' ? 'spectrum' : e.group ? 'ramp' : 'other',
      set: null,
      deletable: false,
      lock: null,
    };
  });
}

interface ResolvedSwatch { key: string; name: string; group: string; hex: string; rgb: [number, number, number] }

const HEX6 = /^#[0-9a-f]{6}$/i;

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** Only swatches with a resolved literal colour — an unresolved alias or the
 *  empty/"transparent" tile has nothing to export. */
function resolved(swatches: BrandSwatch[]): ResolvedSwatch[] {
  return swatches
    .filter(s => HEX6.test(s.hex))
    .map(s => ({ key: s.key, name: s.name, group: s.group, hex: s.hex.toLowerCase(), rgb: hexToRgb(s.hex) }));
}

/** A swatch's canonical dotted key ('color.ramp.primary.5') slugged into a safe
 *  CSS identifier / JSON path segment ('color-ramp-primary-5'). Keys come from
 *  the token document's own JSON path, so collisions can't happen. */
function slug(key: string): string {
  return key.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'swatch';
}

const isPlainObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** A DTCG tokens document, colour leaves only, nested by each swatch's dotted key. */
export function swatchesToTokensJson(swatches: BrandSwatch[]): string {
  const root: Record<string, unknown> = {};
  for (const s of resolved(swatches)) {
    const segs = s.key.split('.');
    let node = root;
    for (let i = 0; i < segs.length - 1; i++) {
      const seg = segs[i]!;
      if (!isPlainObj(node[seg])) node[seg] = {};
      node = node[seg] as Record<string, unknown>;
    }
    node[segs[segs.length - 1]!] = { $value: s.hex, $type: 'color', $description: s.name };
  }
  return JSON.stringify(root, null, 2) + '\n';
}

/** `:root { --color-ramp-primary-5: #...; }` — one custom property per swatch. */
export function swatchesToCssVariables(swatches: BrandSwatch[]): string {
  const lines = resolved(swatches).map(s => `  --${slug(s.key)}: ${s.hex};`);
  return `:root {\n${lines.join('\n')}\n}\n`;
}

/** bg/text/border utility classes, one triad per swatch. */
export function swatchesToCssClasses(swatches: BrandSwatch[]): string {
  const blocks = resolved(swatches).flatMap(s => {
    const c = slug(s.key);
    return [
      `.bg-${c} { background-color: ${s.hex}; }`,
      `.text-${c} { color: ${s.hex}; }`,
      `.border-${c} { border-color: ${s.hex}; }`,
    ];
  });
  return blocks.join('\n') + '\n';
}

/** GIMP palette (.gpl) — name + space-padded 0-255 RGB triples, tab, then a
 *  human label. GPL carries no alpha and no colour-space metadata. */
export function swatchesToGpl(swatches: BrandSwatch[], paletteName = 'Lolly brand'): string {
  const pad = (n: number): string => String(n).padStart(3, ' ');
  const rows = resolved(swatches).map(s => `${pad(s.rgb[0])} ${pad(s.rgb[1])} ${pad(s.rgb[2])}\t${s.group} ${s.name}`);
  return `GIMP Palette\nName: ${paletteName}\nColumns: 0\n#\n${rows.join('\n')}\n`;
}

// ── Adobe Swatch Exchange (.ase) — binary ───────────────────────────────────
// Spec (unofficial but widely implemented): 'ASEF' signature, u16 version major/minor,
// u32 block count, then N blocks. A colour-entry block: u16 type (0x0001), u32 data
// length (of everything after this field), u16 name length (UTF-16 code units,
// INCLUDING the null terminator), the UTF-16BE name itself, a 4-byte ASCII colour
// model ('RGB ' — space-padded to 4 chars), the channel values as big-endian
// float32 in 0..1, and a u16 colour type (0 Global / 1 Spot / 2 Normal).

function utf16beNameBytes(name: string): Uint8Array {
  const withNull = `${name}\u0000`;
  const out = new Uint8Array(withNull.length * 2);
  for (let i = 0; i < withNull.length; i++) {
    const code = withNull.charCodeAt(i);
    out[i * 2] = (code >> 8) & 0xff;
    out[i * 2 + 1] = code & 0xff;
  }
  return out;
}

function colorEntryBlock(name: string, rgb: [number, number, number]): Uint8Array {
  const nameBytes = utf16beNameBytes(name.slice(0, 255));
  const nameUnits = nameBytes.length / 2;
  const dataLen = 2 + nameBytes.length + 4 + 12 + 2; // nameLen + name + model + 3 floats + colour type
  const block = new Uint8Array(2 + 4 + dataLen);
  const dv = new DataView(block.buffer);
  let o = 0;
  dv.setUint16(o, 0x0001, false); o += 2;       // block type: colour entry
  dv.setUint32(o, dataLen, false); o += 4;      // length of everything below
  dv.setUint16(o, nameUnits, false); o += 2;
  block.set(nameBytes, o); o += nameBytes.length;
  block.set([0x52, 0x47, 0x42, 0x20], o); o += 4; // 'RGB '
  dv.setFloat32(o, rgb[0] / 255, false); o += 4;
  dv.setFloat32(o, rgb[1] / 255, false); o += 4;
  dv.setFloat32(o, rgb[2] / 255, false); o += 4;
  dv.setUint16(o, 2, false); o += 2;            // colour type: Normal
  return block;
}

/** Adobe Swatch Exchange — readable by Illustrator, Photoshop, Affinity, etc. */
export function swatchesToAse(swatches: BrandSwatch[]): Uint8Array {
  const blocks = resolved(swatches).map(s => colorEntryBlock(`${s.group} ${s.name}`, s.rgb));
  const headerLen = 4 + 2 + 2 + 4;
  const total = headerLen + blocks.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  out.set([0x41, 0x53, 0x45, 0x46], 0); // 'ASEF'
  const dv = new DataView(out.buffer);
  dv.setUint16(4, 1, false);  // version major
  dv.setUint16(6, 0, false);  // version minor
  dv.setUint32(8, blocks.length, false);
  let pos = headerLen;
  for (const b of blocks) { out.set(b, pos); pos += b.length; }
  return out;
}

/** One entry point for the UI: pick a format, get a ready-to-save Blob + filename. */
export function exportSwatches(
  swatches: BrandSwatch[], format: SwatchExportFormat, paletteName = 'Lolly brand',
): { blob: Blob; filename: string } {
  const base = slug(paletteName) || 'brand';
  switch (format) {
    case 'tokens-json':
      return { blob: new Blob([swatchesToTokensJson(swatches)], { type: 'application/json' }), filename: `${base}-tokens.json` };
    case 'css-vars':
      return { blob: new Blob([swatchesToCssVariables(swatches)], { type: 'text/css' }), filename: `${base}-variables.css` };
    case 'css-classes':
      return { blob: new Blob([swatchesToCssClasses(swatches)], { type: 'text/css' }), filename: `${base}-classes.css` };
    case 'gpl':
      return { blob: new Blob([swatchesToGpl(swatches, paletteName)], { type: 'text/plain' }), filename: `${base}.gpl` };
    case 'ase':
      return { blob: new Blob([swatchesToAse(swatches) as BlobPart], { type: 'application/octet-stream' }), filename: `${base}.ase` };
  }
}
