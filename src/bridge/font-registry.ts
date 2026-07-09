// SPDX-License-Identifier: MPL-2.0
/**
 * Which font file backs an outlined text run — the shell's answer to "vector
 * export needs an actual sfnt, not a CSS family name".
 *
 * Exports vectorise text (`Vector = text-as-paths`): HarfBuzz shapes the run and
 * we emit a <path>. That needs the FONT FILE, and until now only the SUSE statics
 * were resolvable — so a brand wearing a Google font (or the platform default,
 * Outfit) silently fell back to an SVG <text> element naming a family the
 * recipient's machine probably doesn't have. This module closes that hole: it
 * resolves a computed `font-family` stack to a fetchable sfnt URL, in order:
 *
 *   1. SUSE / SUSE Mono   → the shipped static TTFs (text-svg.ts, unchanged)
 *   2. a USER font        → the woff2 faces stored by user-fonts.ts, decompressed
 *   3. the platform face  → Outfit, shell-served as a variable TTF
 *
 * Two problems make (2) more than a lookup:
 *
 * **woff2 is not sfnt.** HarfBuzz cannot read it — feeding it a wOF2 blob yields
 * .notdef for every glyph (a silently blank export). Google Fonts serves woff2
 * to every browser and a browser cannot ask for anything else (`User-Agent` is a
 * forbidden fetch header), so we decompress on-device: `woff2-encoder/decompress`
 * is a lazily-imported ~127 KB-gz wasm module with the binary inlined as a data:
 * URI — no network, works offline, loads only when a vector export actually needs
 * it. The resulting sfnt is kept as an object URL for the session, never
 * persisted (it's ~2.5× the woff2 we already store).
 *
 * **Google's faces are variable and subsetted.** A family arrives as one file per
 * unicode subset (latin, latin-ext), each carrying the whole `wght` axis. So we
 * pick the face whose `unicode-range` covers the run, and pass the run's computed
 * weight to HarfBuzz as a variation (`wght=700`) — without which every weight
 * would outline at the face's default instance.
 *
 * Resolution is async (a face may need decompressing) and memoised per asset.
 * Anything unresolvable returns null, and the caller keeps its existing fallback.
 */

import { openDB } from './db.ts';
import { resolveSuseFontUrl } from './text-svg.ts';
import type { FontStyleSlice } from './text-svg.ts';

/** A face resolved for one run: the sfnt to shape with, plus its axis settings. */
export interface VectorFont {
  url: string;
  /** HarfBuzz variation strings for a variable face, e.g. `['wght=700']`. */
  variations?: string[];
  /** Sibling subsets of the same family, for characters `url` doesn't cover
   *  (Google's `latin` file has no `Ł`; its `latin-ext` file has no ASCII). */
  fallbacks?: Array<{ fontUrl: string; variations?: string[] }>;
}

/** One stored face as the registry models it. */
interface RegistryFace {
  /** Asset id for a user face; '' for a shell-served platform face. */
  assetId: string;
  /** Static URL for a platform face; '' when the bytes come from IndexedDB. */
  staticUrl: string;
  weight: string;   // '400' or a variable range '100 900'
  style: string;    // 'normal' | 'italic'
  unicodeRange: string;
}

// The shell's own default face (styles/fonts.css + tokens.css `--font-brand`).
// Shipped as a variable TTF beside the woff2s precisely so it needs no decoding.
// No unicode-range: it's the whole latin build, and the .notdef guard in the
// callers catches anything it can't draw.
const PLATFORM_FACES: Record<string, RegistryFace[]> = {
  outfit: [{ assetId: '', staticUrl: '/fonts/Outfit[wght].ttf', weight: '100 900', style: 'normal', unicodeRange: '' }],
};

const USER_FONT_PREFIX = 'user/fonts/';

// ── Pure helpers (exported for tests) ────────────────────────────────────────

/**
 * Split a computed CSS `font-family` into its families, in order, unquoted:
 * `"'Space Grotesk', Outfit, ui-sans-serif"` → `['Space Grotesk','Outfit','ui-sans-serif']`.
 * Commas inside quotes stay put (a family may legally contain one).
 */
export function parseFontFamilies(css: string | undefined): string[] {
  const out: string[] = [];
  let cur = '';
  let quote = '';
  for (const ch of String(css ?? '')) {
    if (quote) {
      if (ch === quote) quote = '';
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ',') {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  out.push(cur.trim());
  return out.filter(Boolean);
}

/**
 * Parse a CSS `unicode-range` value to inclusive codepoint pairs.
 * Handles the three grammatical forms: `U+0-7F`, `U+2212`, and the wildcard
 * `U+4??` (which spans U+400–U+4FF). An empty/absent value → `[]`, which
 * `rangesCover` treats as "covers everything" (an unsubsetted face).
 */
export function parseUnicodeRange(spec: string | undefined): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const raw of String(spec ?? '').split(',')) {
    const t = raw.trim();
    if (!/^u\+/i.test(t)) continue;
    const body = t.slice(2);
    if (body.includes('?')) {
      const lo = parseInt(body.replace(/\?/g, '0'), 16);
      const hi = parseInt(body.replace(/\?/g, 'F'), 16);
      if (Number.isFinite(lo) && Number.isFinite(hi)) out.push([lo, hi]);
      continue;
    }
    const [a, b] = body.split('-');
    const lo = parseInt(a ?? '', 16);
    const hi = b == null ? lo : parseInt(b, 16);
    if (Number.isFinite(lo) && Number.isFinite(hi)) out.push([lo, hi]);
  }
  return out;
}

/** Does this face cover every codepoint in `text`? Whitespace is ignored (it
 *  never needs a glyph in an outline), and an empty range list means "all". */
export function rangesCover(ranges: Array<[number, number]>, text: string): boolean {
  if (!ranges.length) return true;
  for (const ch of text) {
    if (/\s/.test(ch)) continue;
    const cp = ch.codePointAt(0)!;
    if (!ranges.some(([lo, hi]) => cp >= lo && cp <= hi)) return false;
  }
  return true;
}

/** How many of `text`'s visible characters this face can draw. Ranks the
 *  fallback chain: the face carrying most of the run leads. An unsubsetted
 *  face (no ranges) claims everything. */
export function coverageCount(ranges: Array<[number, number]>, text: string): number {
  let n = 0;
  for (const ch of text) {
    if (/\s/.test(ch)) continue;
    const cp = ch.codePointAt(0)!;
    if (!ranges.length || ranges.some(([lo, hi]) => cp >= lo && cp <= hi)) n++;
  }
  return n;
}

/** Is this face a variable one (a `wght` RANGE rather than a single value)? */
const weightRange = (weight: string): [number, number] | null => {
  const parts = weight.trim().split(/\s+/).map(Number);
  return parts.length === 2 && parts.every(Number.isFinite) ? [parts[0]!, parts[1]!] : null;
};

/**
 * Choose the face to outline `text` with, and the axis settings for the run's
 * weight. Faces are filtered to those that (a) match the run's slant and (b)
 * cover every codepoint; among the survivors a variable face wins (it can hit
 * the exact weight), else the nearest static weight.
 *
 * Italic is deliberately strict: we never download italic faces, and outlining
 * an upright face for an italic run would silently un-slant the text. Returning
 * null keeps the caller's honest <text> fallback. Exported for tests.
 */
export function pickFace(faces: RegistryFace[], style: FontStyleSlice, text: string): { face: RegistryFace; variations?: string[] } | null {
  const italic = style.fontStyle === 'italic' || style.fontStyle === 'oblique';
  const weight = parseInt(style.fontWeight ?? '') || 400;
  const usable = faces.filter(f =>
    (f.style === 'italic') === italic && rangesCover(parseUnicodeRange(f.unicodeRange), text));
  if (!usable.length) return null;

  const variable = usable.find(f => weightRange(f.weight));
  if (variable) {
    const [lo, hi] = weightRange(variable.weight)!;
    const w = Math.min(hi, Math.max(lo, weight));
    return { face: variable, variations: [`wght=${w}`] };
  }
  const nearest = usable.reduce((a, b) =>
    Math.abs(parseInt(b.weight) - weight) < Math.abs(parseInt(a.weight) - weight) ? b : a);
  return { face: nearest };
}

// ── The registry ─────────────────────────────────────────────────────────────

/** family (lowercased) → faces. Rebuilt after any font install/removal. */
let registryPromise: Promise<Map<string, RegistryFace[]>> | null = null;
/** assetId → object URL of the DECOMPRESSED sfnt (session-lived). */
const sfntUrls = new Map<string, string>();
/** assetId → in-flight decompression, so two runs never decode the same face twice. */
const sfntPending = new Map<string, Promise<string>>();

async function buildRegistry(): Promise<Map<string, RegistryFace[]>> {
  const byFamily = new Map<string, RegistryFace[]>();
  for (const [family, faces] of Object.entries(PLATFORM_FACES)) byFamily.set(family, [...faces]);
  try {
    const db = await openDB();
    const records = await db.getAll('user-assets') as Array<{
      id: string; type: string; meta?: Record<string, unknown>;
    }>;
    for (const r of records) {
      if (r.type !== 'font' || !r.id.startsWith(USER_FONT_PREFIX)) continue;
      const family = String(r.meta?.family ?? '').trim();
      if (!family) continue;
      const key = family.toLowerCase();
      // A user font SHADOWS a platform face of the same name — they installed it.
      const list = byFamily.get(key)?.filter(f => f.assetId) ?? [];
      list.push({
        assetId: r.id,
        staticUrl: '',
        weight: String(r.meta?.weight ?? '400'),
        style: String(r.meta?.style ?? 'normal'),
        unicodeRange: String(r.meta?.unicodeRange ?? ''),
      });
      byFamily.set(key, list);
    }
  } catch { /* IDB unavailable — platform faces still resolve */ }
  return byFamily;
}

/** Drop the cached registry (and every decoded face) after an install/removal. */
export function bustFontRegistry(): void {
  registryPromise = null;
  for (const url of sfntUrls.values()) URL.revokeObjectURL(url);
  sfntUrls.clear();
  sfntPending.clear();
}

/**
 * The face's bytes as a fetchable URL. A platform face is already an sfnt on
 * disk; a user face is a stored woff2 that must be decompressed first (once per
 * session, memoised — including the in-flight promise, so concurrent runs of an
 * export share the single decode).
 */
async function faceUrl(face: RegistryFace): Promise<string> {
  if (face.staticUrl) return face.staticUrl;
  const cached = sfntUrls.get(face.assetId);
  if (cached) return cached;
  const pending = sfntPending.get(face.assetId);
  if (pending) return pending;

  const job = (async () => {
    const db = await openDB();
    const rec = await db.get('user-assets', face.assetId) as { blob?: Blob } | undefined;
    if (!rec?.blob) throw new Error(`font-registry: no bytes for ${face.assetId}`);
    const bytes = new Uint8Array(await rec.blob.arrayBuffer());
    // Already an sfnt (a hand-uploaded TTF/OTF, or a future format change)? The
    // woff2 magic is 'wOF2'; anything else goes to HarfBuzz untouched.
    const isWoff2 = bytes[0] === 0x77 && bytes[1] === 0x4f && bytes[2] === 0x46 && bytes[3] === 0x32;
    const sfnt = isWoff2
      ? await (await import('woff2-encoder/decompress')).default(bytes)
      : bytes;
    const url = URL.createObjectURL(new Blob([sfnt as BlobPart], { type: 'font/otf' }));
    sfntUrls.set(face.assetId, url);
    return url;
  })().finally(() => sfntPending.delete(face.assetId));

  sfntPending.set(face.assetId, job);
  return job;
}

/**
 * Resolve a computed style + the text it will render into the sfnt that can
 * outline it, or null when nothing can (the caller falls back to <text>).
 *
 * Families are tried IN CASCADE ORDER — the first one that resolves wins, which
 * is what the browser does when it picks a face. (The old SUSE-only resolver
 * substring-matched the whole stack, so a brand stack ending in the `--font-mono`
 * tail could wrongly claim a SUSE face for a run drawn in Inter.)
 */
export async function resolveVectorFont(style: FontStyleSlice, text: string): Promise<VectorFont | null> {
  const families = parseFontFamilies(style.fontFamily);
  const registry = (registryPromise ??= buildRegistry());
  let faces: Map<string, RegistryFace[]>;
  try { faces = await registry; }
  catch { registryPromise = null; faces = new Map(); }

  for (const family of families) {
    const key = family.toLowerCase();
    if (key === 'suse' || key === 'suse mono') {
      const url = resolveSuseFontUrl({ ...style, fontFamily: family });
      if (url) return { url };
      continue;
    }
    const list = faces.get(key);
    if (!list?.length) continue;
    const hit = pickFace(list, style, text);
    if (!hit) continue;
    try {
      const url = await faceUrl(hit.face);
      return hit.variations ? { url, variations: hit.variations } : { url };
    } catch {
      continue; // this face's bytes are unreadable — try the next family
    }
  }
  return null;
}
