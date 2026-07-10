// SPDX-License-Identifier: MPL-2.0
/**
 * Portable brand pack — "hand your brand to someone else".
 *
 * Where data-transfer.ts moves a PERSON between devices, this moves a BRAND
 * between people: one `.zip` carrying the active design tokens, every locally
 * installed font face (the actual woff2 bytes — the receiver renders your type
 * with zero network), and the brand-adjacent preferences (theme). Export it
 * from Profile → Adjust your brand or the #/start wizard; anyone loads it from
 * the same places and their whole install wears the brand — chrome, tools,
 * exports.
 *
 * The envelope copies the backup bundle's proven rules (docs/data-transfer.md):
 * a `minReader` gate instead of an exact version match (additive parts keep
 * old readers working), SHA-256 per part so a mangled transfer fails loudly,
 * and unknown parts are counted, never silently dropped. Same fflate
 * worker/sync split, too.
 *
 * Import is merge-not-wipe: tokens install as `user/tokens/brand` (the same
 * write path as the wizard), fonts land as `type:'font'` user assets (quota-
 * checked; a full disk skips a face, never aborts the pack), and the primary
 * face follows the pack's `font.brand` token automatically because that IS the
 * doc. Nothing else on the device is touched.
 */

import { zip, unzip, zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import type { Unzipped } from 'fflate';
import { installUserTokens, USER_TOKENS_ID } from './bridge/tokens.ts';
import { applyChromeBrandVars } from './brand-vars.ts';
import { registerUserFonts, USER_FONT_PREFIX } from './user-fonts.ts';
import { USER_LOGO_PREFIX, LOGO_DEFAULT_IDENTITY, parseLogoAssetId } from './lib/brand-logos.ts';
import type { UserFontsHost } from './user-fonts.ts';

export const BRAND_FORMAT = 'lolly-brand';
export const BRAND_FORMAT_VERSION = 1;
export const BRAND_READER_VERSION = 1;

// The brand-adjacent localStorage keys that travel. Deliberately tiny: the
// theme is part of how a brand feels; everything else in prefs is personal.
const BRAND_PREF_KEYS = ['theme'];

const KNOWN_PARTS = new Set(['manifest.json', 'tokens.json', 'fonts.json', 'logos.json', 'prefs.json']);
const README_NAME = 'lolly.txt';
const isKnownPart = (path: string): boolean =>
  KNOWN_PARTS.has(path) || path === README_NAME || path.startsWith('fonts/') || path.startsWith('logos/');

/** The host slice a brand pack travels through — the same seams user-fonts
 *  drives, plus profile.get for the export filename. */
export interface BrandTransferHost extends UserFontsHost {
  profile?: { get(): Promise<Record<string, unknown>> };
  log?: (level: string, message: string, meta?: unknown) => void;
}

interface BrandStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface BrandPackSummary {
  tokens: boolean;
  fontFamilies: number;
  fontFiles: number;
  logos: number;
  prefs: number;
}

export interface BrandImportSummary extends BrandPackSummary {
  skipped: number;
  failedFonts: number;
}

/** One stored face's manifest row: its full asset record sans blob, plus the
 *  in-zip file it rebuilds from. A logo row is the same shape (an image asset). */
interface FontRow {
  id: string;
  format: string;
  version?: string;
  meta?: Record<string, unknown>;
  file: string;
  mime: string;
}
type LogoRow = FontRow;

const HAS_WORKER = typeof Worker !== 'undefined';
type BundleEntry = Uint8Array | [Uint8Array, { level: 0 }];

function zipAsync(entries: Record<string, BundleEntry>): Promise<Uint8Array> {
  if (!HAS_WORKER) return Promise.resolve(zipSync(entries));
  return new Promise((resolve, reject) => zip(entries, (err, data) => (err ? reject(err) : resolve(data))));
}

// A brand pack is a tokens doc + a handful of woff2s — tens of KB to a few MB.
// Bound inflation anyway so a hostile zip can't balloon (same stance as backups).
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;

function unzipAsync(bytes: Uint8Array): Promise<Unzipped> {
  let total = 0;
  let bomb: string | null = null;
  const filter = (f: { name: string; originalSize?: number }): boolean => {
    total += f.originalSize || 0;
    if ((f.originalSize || 0) > MAX_ENTRY_BYTES || total > MAX_TOTAL_BYTES) { bomb = f.name; return false; }
    return true;
  };
  const guard = (data: Unzipped): Unzipped => {
    if (bomb) throw new Error(`That brand file expands too large to load (${bomb}).`);
    return data;
  };
  if (!HAS_WORKER) return Promise.resolve().then(() => guard(unzipSync(bytes, { filter })));
  return new Promise((resolve, reject) => unzip(bytes, { filter }, (err, data) => {
    if (err) return reject(err);
    try { resolve(guard(data)); } catch (e) { reject(e); }
  }));
}

const SUBTLE = globalThis.crypto?.subtle ?? null;

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return btoa(bin);
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await SUBTLE!.digest('SHA-256', bytes as unknown as BufferSource);
  return 'sha256-' + bytesToBase64(new Uint8Array(digest));
}

const entryBytes = (v: BundleEntry): Uint8Array => (v instanceof Uint8Array ? v : v[0]);

const HEADER = '📐 Lolly  •  ❤️ Give Fitzy an Ovation  •  🌏 https://lolly.tools';

function brandReadme(summary: BrandPackSummary, label: string, filename: string): string {
  return [
    HEADER,
    '-'.repeat(56),
    '',
    `[[ 🎨 ${filename} ]]`,
    '',
    `A portable Lolly brand${label ? ` — ${label}` : ''}: design tokens, fonts and theme in one file.`,
    'Open Lolly, go to Profile → Adjust your brand → “Load a brand file…” (or the',
    '#/start wizard) and choose this .zip. Everything installs on-device;',
    'nothing is uploaded anywhere.',
    '',
    "[ What's inside ]",
    '',
    `🎨 Design tokens   ${summary.tokens ? 'included' : 'not included'}`,
    `🔤 Font families   ${summary.fontFamilies} (${summary.fontFiles} file${summary.fontFiles === 1 ? '' : 's'})`,
    `🖼  Logo marks      ${summary.logos}`,
    `⚙  Preferences     ${summary.prefs}`,
    '',
    '[ The files in this zip ]',
    '',
    'manifest.json   what the app reads to load this brand',
    'tokens.json     the brand’s design tokens (W3C DTCG / Tokens Studio)',
    'fonts.json      the installed font faces (metadata)',
    'fonts/          the font files themselves (woff2, from Google Fonts — OFL/Apache)',
    'logos.json      the brand’s logo marks (metadata)',
    'logos/          the logo images themselves (SVG/PNG/JPEG/WebP per slot)',
    'prefs.json      theme',
    'lolly.txt       this summary (ignored on load)',
  ].join('\n') + '\n';
}

const nameToken = (value: unknown): string =>
  String(value ?? '').normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '').slice(0, 32);

/** The active tokens doc: the user's installed doc first, else the discovered
 *  catalog brand — the exact precedence the tokens bridge resolves with. */
async function activeTokensDoc(host: BrandTransferHost): Promise<Record<string, unknown> | null> {
  const read = async (id: string): Promise<Record<string, unknown> | null> => {
    try {
      const blob = await host.assets._getBlob(id);
      if (!blob) return null;
      const doc: unknown = JSON.parse(await blob.text());
      return typeof doc === 'object' && doc !== null ? doc as Record<string, unknown> : null;
    } catch { return null; }
  };
  const user = await read(USER_TOKENS_ID);
  if (user) return user;
  try {
    const meta = await (host.assets as unknown as {
      _findMetaByType(t: string): Promise<{ id: string } | null>;
    })._findMetaByType('tokens');
    return meta ? read(meta.id) : null;
  } catch { return null; }
}

/**
 * Pack the active brand into one zip Blob: tokens.json + fonts/* + prefs.json,
 * integrity-mapped manifest, human README. `label` names the pack (defaults to
 * the profile's name, then 'My brand').
 */
export async function exportBrandPack(
  { host, storage }: { host: BrandTransferHost; storage: BrandStorage },
  opts: { label?: string } = {},
): Promise<{ blob: Blob; filename: string; summary: BrandPackSummary }> {
  const entries: Record<string, BundleEntry> = {};

  const doc = await activeTokensDoc(host);
  if (doc) entries['tokens.json'] = strToU8(JSON.stringify(doc, null, 2));

  // Every stored font face, bytes + full record (sans blob) for a faithful rebuild.
  const records = await host.assets._exportUserAssets().catch(() => []);
  const fontRows: FontRow[] = [];
  const families = new Set<string>();
  for (const r of records) {
    if (r.type !== 'font' || !r.id.startsWith(USER_FONT_PREFIX) || !r.blob) continue;
    const file = `fonts/${r.id.slice(USER_FONT_PREFIX.length).replace(/\//g, '-')}.woff2`;
    entries[file] = [new Uint8Array(await r.blob.arrayBuffer()), { level: 0 }]; // woff2 is already compressed
    const { blob: _blob, ...rest } = r as FontRow & { blob: Blob; type: string };
    fontRows.push({ ...(rest as unknown as FontRow), file, mime: r.blob.type || 'font/woff2' });
    families.add(String(r.meta?.family ?? r.meta?.name ?? r.id));
  }
  entries['fonts.json'] = strToU8(JSON.stringify(fontRows, null, 2));

  // Brand logos — the canonical orientation×treatment slots plus any custom
  // variants and named identities (lib/brand-logos.ts), carried the same way as
  // fonts so the pack is a complete brand. Default-identity marks keep the
  // original `logos/<variant>.<ext>` name (what pre-identity packs used); other
  // identities get `logos/<identity>__<variant>.<ext>`. Import matches rows by
  // id — the filename only has to be unique — so both forms round-trip, and a
  // row's meta carries the variant's label. Malformed ids fall back to the old
  // slash-flattened name rather than being dropped.
  const logoRows: LogoRow[] = [];
  for (const r of records) {
    if (!r.id.startsWith(USER_LOGO_PREFIX) || !r.blob) continue;
    const fmt = String(r.meta?.format ?? 'png');
    const parsed = parseLogoAssetId(r.id);
    const file = parsed && parsed.identity !== LOGO_DEFAULT_IDENTITY
      ? `logos/${parsed.identity}__${parsed.variant}.${fmt}`
      : `logos/${r.id.slice(USER_LOGO_PREFIX.length).replace(/\//g, '-')}.${fmt}`;
    entries[file] = new Uint8Array(await r.blob.arrayBuffer());
    const { blob: _b, ...rest } = r as LogoRow & { blob: Blob; type: string };
    logoRows.push({ ...(rest as unknown as LogoRow), file, format: fmt, mime: r.blob.type || 'image/png' });
  }
  entries['logos.json'] = strToU8(JSON.stringify(logoRows, null, 2));

  const prefs: Record<string, string> = {};
  for (const key of BRAND_PREF_KEYS) {
    const v = storage.getItem(key);
    if (v != null) prefs[key] = v;
  }
  entries['prefs.json'] = strToU8(JSON.stringify(prefs, null, 2));

  const summary: BrandPackSummary = {
    tokens: !!doc,
    fontFamilies: families.size,
    fontFiles: fontRows.length,
    logos: logoRows.length,
    prefs: Object.keys(prefs).length,
  };

  const profile = await host.profile?.get().catch(() => null) ?? null;
  const label = opts.label
    || [profile?.firstname, profile?.lastname].filter(Boolean).join(' ')
    || 'My brand';
  const date = new Date().toISOString().slice(0, 10);
  const filename = `LollyBrand-${nameToken(label) || 'MyBrand'}-${date}.zip`;

  const manifest: Record<string, unknown> = {
    format: BRAND_FORMAT,
    formatVersion: BRAND_FORMAT_VERSION,
    minReader: BRAND_READER_VERSION,
    app: 'lolly',
    exportedAt: new Date().toISOString(),
    label,
    counts: summary,
  };
  if (SUBTLE) {
    const integrity: Record<string, string> = {};
    for (const [path, value] of Object.entries(entries)) integrity[path] = await sha256(entryBytes(value));
    manifest.integrity = integrity;
  }
  entries['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2));
  entries[README_NAME] = strToU8(brandReadme(summary, label, filename));

  const zipped = await zipAsync(entries);
  return { blob: new Blob([zipped as BlobPart], { type: 'application/zip' }), filename, summary };
}

/** True when these zip contents are a brand pack (vs a data backup or noise) —
 *  lets one file input accept both kinds and route accordingly. */
export function isBrandPack(files: Unzipped): boolean {
  return readJson(files, 'manifest.json')?.format === BRAND_FORMAT;
}

/** Unzip helper shared with the views (start.ts sniffs the manifest before
 *  deciding which importer a dropped .zip belongs to). */
export async function unzipBrandBytes(bytes: ArrayBuffer | Uint8Array): Promise<Unzipped> {
  try {
    return await unzipAsync(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  } catch {
    throw new Error("That file isn't a valid brand pack — it couldn't be unzipped.");
  }
}

/**
 * Load a brand pack: verify, install the tokens doc, restore the font assets,
 * register the faces, apply the theme pref, repaint the chrome. Merge-only —
 * nothing outside the pack's own ids is touched.
 */
export async function importBrandPack(
  { host, storage }: { host: BrandTransferHost; storage: BrandStorage },
  bytes: ArrayBuffer | Uint8Array | Unzipped,
): Promise<BrandImportSummary> {
  const files: Unzipped = (bytes instanceof ArrayBuffer || bytes instanceof Uint8Array)
    ? await unzipBrandBytes(bytes)
    : bytes;

  const manifest = readJson(files, 'manifest.json');
  if (!manifest || manifest.format !== BRAND_FORMAT) {
    throw new Error("That doesn't look like a Lolly brand file.");
  }
  const required = manifest.minReader ?? manifest.formatVersion ?? 1;
  if (required > BRAND_READER_VERSION) {
    throw new Error('This brand file needs a newer version of the app. Update first, then load it.');
  }
  if (manifest.integrity && SUBTLE) {
    for (const [path, expected] of Object.entries(manifest.integrity as Record<string, string>)) {
      const part = files[path];
      if (!part) throw new Error(`This brand file is incomplete — "${path}" is missing.`);
      if ((await sha256(part)) !== expected) {
        throw new Error(`This brand file appears corrupted — "${path}" failed its integrity check.`);
      }
    }
  }

  const summary: BrandImportSummary = { tokens: false, fontFamilies: 0, fontFiles: 0, logos: 0, prefs: 0, skipped: 0, failedFonts: 0 };

  // Fonts BEFORE tokens: when the tokens land, applyChromeBrandVars reads
  // font.brand — the faces should already be present so the swap is one paint.
  const fontRows: FontRow[] = readJson(files, 'fonts.json') ?? [];
  const families = new Set<string>();
  for (const row of fontRows) {
    if (!row?.id || !String(row.id).startsWith(USER_FONT_PREFIX) || !row.file) continue;
    const raw = files[row.file];
    if (!raw) continue;
    try {
      await host.assets._uploadUserAsset({
        id: row.id,
        type: 'font',
        format: row.format || 'woff2',
        blob: new Blob([raw as BlobPart], { type: row.mime || 'font/woff2' }),
        ...(row.version ? { version: row.version } : {}),
        ...(row.meta ? { meta: row.meta } : {}),
      });
      summary.fontFiles++;
      families.add(String(row.meta?.family ?? row.id));
    } catch (e) {
      summary.failedFonts++;
      host.log?.('warn', 'Skipped restoring one font face (storage full?)', { id: String(row.id), error: String(e) });
    }
  }
  summary.fontFamilies = families.size;
  await registerUserFonts(host).catch(() => { /* faces load lazily at next boot */ });

  // Logos — restore each image asset before tokens land (asset.logo.* refs
  // resolve to assets that are already present). Row-id-driven, so old packs
  // (`logos/<variant>.<ext>`) and identity-namespaced ones both land verbatim;
  // meta (incl. variant labels) travels on the row.
  const logoRows: LogoRow[] = readJson(files, 'logos.json') ?? [];
  for (const row of logoRows) {
    if (!row?.id || !String(row.id).startsWith(USER_LOGO_PREFIX) || !row.file) continue;
    const raw = files[row.file];
    if (!raw) continue;
    try {
      await host.assets._uploadUserAsset({
        id: row.id,
        type: (row.format === 'svg' ? 'vector' : 'raster'),
        format: row.format || 'png',
        blob: new Blob([raw as BlobPart], { type: row.mime || 'image/png' }),
        ...(row.version ? { version: row.version } : {}),
        ...(row.meta ? { meta: row.meta } : {}),
      });
      summary.logos++;
    } catch (e) {
      host.log?.('warn', 'Skipped restoring one logo (storage full?)', { id: String(row.id), error: String(e) });
    }
  }

  const doc = readJson(files, 'tokens.json');
  if (doc && typeof doc === 'object') {
    await installUserTokens(host as Parameters<typeof installUserTokens>[0], doc, {
      label: typeof manifest.label === 'string' ? manifest.label : 'Imported brand',
    });
    summary.tokens = true;
  }

  const prefs = readJson(files, 'prefs.json') ?? {};
  for (const key of BRAND_PREF_KEYS) {
    if (typeof prefs[key] === 'string') { storage.setItem(key, prefs[key]); summary.prefs++; }
  }

  await applyChromeBrandVars(host as Parameters<typeof applyChromeBrandVars>[0]).catch(() => { /* cosmetic */ });

  summary.skipped = Object.keys(files).filter(p => !isKnownPart(p)).length;
  return summary;
}

function readJson(files: Unzipped, name: string): any {
  const u8 = files[name];
  if (!u8) return null;
  try { return JSON.parse(strFromU8(u8)); } catch { return null; }
}
