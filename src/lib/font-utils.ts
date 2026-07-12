/**
 * Font file utilities: metadata extraction, validation, format detection.
 * Supports TTF, OTF, WOFF, WOFF2 with minimal footprint.
 */

export interface FontMetadata {
  family: string;
  weight: number;
  style: 'normal' | 'italic' | 'oblique';
  unicodeRange?: string;
}

export type FontFormat = 'ttf' | 'otf' | 'woff' | 'woff2' | 'unknown';

/**
 * Detect font file format by magic bytes.
 */
export function detectFontFormat(buffer: ArrayBuffer): FontFormat {
  const view = new Uint8Array(buffer);
  if (view.length < 4) return 'unknown';

  const magic = ((view[0] ?? 0) << 24) | ((view[1] ?? 0) << 16) | ((view[2] ?? 0) << 8) | (view[3] ?? 0);

  // TTF: 0x00010000 or 'true'
  if (magic === 0x00010000 || magic === 0x74727565) return 'ttf';
  // OTF: 'OTTO'
  if (magic === 0x4f54544f) return 'otf';
  // WOFF: 'wOFF'
  if (magic === 0x774f4646) return 'woff';
  // WOFF2: 'wOF2'
  if (magic === 0x774f4632) return 'woff2';

  return 'unknown';
}

/**
 * Parse font metadata from TTF/OTF (TrueType/CFF outline) files.
 * Extracts family name, weight, style from name table and OS/2 table.
 */
export function parseFontMetadata(buffer: ArrayBuffer): FontMetadata | null {
  try {
    const view = new DataView(buffer);
    const format = detectFontFormat(buffer);

    if (format !== 'ttf' && format !== 'otf') return null;

    // TrueType/OTF structure: scaler type (4 bytes) + num tables (2) + search params (6)
    if (buffer.byteLength < 12) return null;

    const numTables = view.getUint16(4, false);
    let offset = 12;

    // Find 'name' and 'OS/2' tables
    let nameTableOffset = 0;
    let os2TableOffset = 0;

    for (let i = 0; i < numTables && offset + 16 <= buffer.byteLength; i++) {
      const tag = readTag(view, offset);
      const tableOffset = view.getUint32(offset + 8, false);

      if (tag === 'name') nameTableOffset = tableOffset;
      if (tag === 'OS/2') os2TableOffset = tableOffset;

      offset += 16;
    }

    if (!nameTableOffset) return null;

    // Extract family name from name table
    const family = extractFamilyName(view, nameTableOffset);
    const weight = os2TableOffset ? extractWeight(view, os2TableOffset) : 400;
    const style = extractStyle(view, nameTableOffset);

    return { family, weight, style };
  } catch {
    return null;
  }
}

function readTag(view: DataView, offset: number): string {
  const bytes = new Uint8Array(view.buffer, view.byteOffset + offset, 4);
  return String.fromCharCode(...bytes);
}

function extractFamilyName(view: DataView, nameTableOffset: number): string {
  try {
    // Name table: format (2) + count (2) + stringOffset (2)
    if (nameTableOffset + 6 > view.byteLength) return 'Unknown';

    const count = view.getUint16(nameTableOffset + 2, false);
    const stringOffset = view.getUint16(nameTableOffset + 4, false);

    let offset = nameTableOffset + 6;

    // Search for name ID 1 (Family name) or ID 16 (Typographic Family)
    for (let i = 0; i < count && offset + 12 <= view.byteLength; i++) {
      const platformId = view.getUint16(offset, false);
      const encodingId = view.getUint16(offset + 2, false);
      const languageId = view.getUint16(offset + 4, false);
      const nameId = view.getUint16(offset + 6, false);
      const length = view.getUint16(offset + 8, false);
      const stringOffset_ = view.getUint16(offset + 10, false);

      offset += 12;

      // Name ID 16 (Typographic Family) preferred, fallback to 1 (Family Name)
      if (nameId === 16 || nameId === 1) {
        const strOffset = nameTableOffset + stringOffset + stringOffset_;

        // Support Unicode (platformId 3, encodingId 1) and Mac (platformId 1, encodingId 0)
        if ((platformId === 3 && encodingId === 1) || (platformId === 1 && encodingId === 0)) {
          const str = readString(view, strOffset, length, platformId === 3);
          if (str) return str;
        }
      }
    }

    return 'Unknown';
  } catch {
    return 'Unknown';
  }
}

function extractWeight(view: DataView, os2TableOffset: number): number {
  try {
    // OS/2 table: usWeightClass at offset 4 (2 bytes)
    if (os2TableOffset + 6 > view.byteLength) return 400;
    return view.getUint16(os2TableOffset + 4, false);
  } catch {
    return 400;
  }
}

function extractStyle(view: DataView, nameTableOffset: number): 'normal' | 'italic' | 'oblique' {
  try {
    // Look for name ID 2 (Subfamily) to detect italic
    const count = view.getUint16(nameTableOffset + 2, false);
    const stringOffset = view.getUint16(nameTableOffset + 4, false);

    let offset = nameTableOffset + 6;

    for (let i = 0; i < count && offset + 12 <= view.byteLength; i++) {
      const nameId = view.getUint16(offset + 6, false);
      const length = view.getUint16(offset + 8, false);
      const stringOffset_ = view.getUint16(offset + 10, false);
      const platformId = view.getUint16(offset, false);

      if (nameId === 2 && ((platformId === 3) || (platformId === 1))) {
        const strOffset = nameTableOffset + stringOffset + stringOffset_;
        const str = readString(view, strOffset, length, platformId === 3);
        if (str?.toLowerCase().includes('italic')) return 'italic';
        if (str?.toLowerCase().includes('oblique')) return 'oblique';
      }

      offset += 12;
    }

    return 'normal';
  } catch {
    return 'normal';
  }
}

function readString(view: DataView, offset: number, length: number, isUnicode: boolean): string {
  try {
    if (offset + length > view.byteLength) return '';

    const bytes = new Uint8Array(view.buffer, view.byteOffset + offset, length);

    if (isUnicode) {
      // UTF-16 BE
      let str = '';
      for (let i = 0; i < bytes.length; i += 2) {
        const code = (bytes[i]! << 8) | bytes[i + 1]!;
        if (code > 0) str += String.fromCharCode(code);
      }
      return str;
    } else {
      // Mac Roman / ASCII
      return String.fromCharCode(...Array.from(bytes));
    }
  } catch {
    return '';
  }
}

/**
 * Validate uploaded font file.
 */
export function validateFontFile(file: File): { valid: boolean; error?: string; format?: FontFormat } {
  // Size check: max 5MB
  if (file.size > 5 * 1024 * 1024) {
    return { valid: false, error: 'Font file must be smaller than 5MB' };
  }

  // MIME type check (permissive, will validate by magic bytes)
  const validMimes = ['application/octet-stream', 'font/ttf', 'font/otf', 'application/font-woff', 'application/font-woff2'];
  if (file.type && !validMimes.includes(file.type) && !file.type.startsWith('font/')) {
    return { valid: false, error: 'Invalid font file type' };
  }

  return { valid: true };
}
