// SPDX-License-Identifier: MPL-2.0
/**
 * Portable brand pack - "hand your brand to someone else".
 *
 * Where data-transfer.ts moves a PERSON between devices, this moves a BRAND
 * between people: one `.zip` carrying the active design tokens, every locally
 * installed font face (the actual woff2 bytes - the receiver renders your type
 * with zero network), and the brand-adjacent preferences (theme). Export it
 * from Profile → Adjust your brand or the #/start wizard; anyone loads it from
 * the same places and their whole install wears the brand - chrome, tools,
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
 *
 * Published VERSIONS travel too (plans/97 §6a): `versions/<slug>.json` per
 * published version, `frozen/<sha12>.<ext>` for bytes a version pinned and the
 * head has since replaced, and `versions.json` for the ledger as published. Two
 * merge rules make that safe, and both are stated in the import result:
 *   - **a slug already in the LOCAL ledger is never overwritten.** Two teams' "v2"
 *     are different design systems, and a published version is permanent - so the
 *     incoming one is skipped and counted, not silently merged over the top.
 *   - **the pack's active version is adopted only when nothing is active locally.**
 *     Loading someone's pack must not change what every tool on this device
 *     renders against.
 * A pack from a system that never published carries none of these parts, and
 * loading it does exactly what it did before they existed.
 */

import { strToU8 } from 'fflate';
import type { Unzipped } from 'fflate';
import { zipAsync } from './lib/zip.ts';
import {
  BUNDLE_HEADER, README_NAME, buildIntegrity, readJson, unzipBundle, verifyIntegrity,
  type BundleEntry,
} from './lib/bundle.ts';
import { installUserTokens, USER_TOKENS_ID, VersionExistsError } from './bridge/tokens.ts';
import { applyChromeBrandVars } from './brand-vars.ts';
import { registerUserFonts, USER_FONT_PREFIX } from './user-fonts.ts';
import { USER_LOGO_PREFIX, LOGO_DEFAULT_IDENTITY, parseLogoAssetId } from './lib/brand-logos.ts';
import { FROZEN_PREFIX } from './bridge/version-assets.ts';
import {
  readVersionIndex, stripVersionIndex, versionAssetId, withVersionIndex,
} from './lib/design-system/versions.ts';
import type { PinnedAsset, VersionEntry, VersionIndex } from './lib/design-system/versions.ts';
import { TOKEN_EXT } from '@lolly/engine';
import type { UserFontsHost } from './user-fonts.ts';

export const BRAND_FORMAT = 'lolly-brand';
/** 2 adds the `versions/` + `frozen/` parts (plans/97 §6a). `minReader` stays 1
 *  on purpose: the parts are additive, so a reader that predates them loads the
 *  pack and counts them as skipped rather than refusing a file it can mostly use. */
export const BRAND_FORMAT_VERSION = 2;
export const BRAND_READER_VERSION = 1;

// The brand-adjacent localStorage keys that travel. Deliberately tiny: the
// theme is part of how a brand feels; everything else in prefs is personal.
const BRAND_PREF_KEYS = ['theme'];

const KNOWN_PARTS = new Set([
  'manifest.json', 'tokens.json', 'fonts.json', 'logos.json', 'prefs.json',
  'versions.json', 'frozen.json',
]);
const isKnownPart = (path: string): boolean =>
  KNOWN_PARTS.has(path) || path === README_NAME
  || path.startsWith('fonts/') || path.startsWith('logos/')
  || path.startsWith('versions/') || path.startsWith('frozen/');

/** The host slice a brand pack travels through - the same seams user-fonts
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
  /** Published design-system versions carried by the pack. */
  versions: number;
  /** Preserved files a version pins because the head's bytes moved on. */
  frozen: number;
}

export interface BrandImportSummary extends BrandPackSummary {
  skipped: number;
  failedFonts: number;
  /** Versions the pack carried whose slug was already published on this device.
   *  Kept as they were: a published version is permanent, and two systems' "v2"
   *  are not the same thing. */
  versionsSkipped: number;
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
/** A preserved (frozen) asset row. Same shape plus the asset `type`, which a
 *  frozen copy carries verbatim from whatever it froze - it can be a vector, a
 *  raster or a font face, so the restore cannot infer it from the extension. */
interface FrozenRow extends FontRow { type: string }

// The zip envelope - entry shape, SHA-256 integrity, the README banner, the
// minReader gate - is the shared bundle format (lib/bundle.ts), identical to the
// data backup's. Only the payload below differs.

function brandReadme(summary: BrandPackSummary, label: string, filename: string): string {
  // The version parts only exist when something was published, so they are only
  // listed when they are actually in the box - a file list naming files that are
  // not there is the one thing a README like this must not do.
  const versionFiles = summary.versions ? [
    'versions.json   the published versions of this design system (the list)',
    'versions/       each published version’s tokens',
  ] : [];
  const frozenFiles = summary.frozen ? [
    'frozen.json     files a published version pins (metadata)',
    'frozen/         those files themselves, kept so a published version cannot change',
  ] : [];
  return [
    BUNDLE_HEADER,
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
    `🏷  Versions        ${summary.versions}${summary.frozen ? ` (${summary.frozen} preserved file${summary.frozen === 1 ? '' : 's'})` : ''}`,
    '',
    '[ The files in this zip ]',
    '',
    'manifest.json   what the app reads to load this brand',
    'tokens.json     the brand’s design tokens (W3C DTCG / Tokens Studio)',
    'fonts.json      the installed font faces (metadata)',
    'fonts/          the font files themselves (woff2, from Google Fonts — OFL/Apache)',
    'logos.json      the brand’s logo marks (metadata)',
    'logos/          the logo images themselves (SVG/PNG/JPEG/WebP per slot)',
    ...versionFiles,
    ...frozenFiles,
    'prefs.json      theme',
    'lolly.txt       this summary (ignored on load)',
  ].join('\n') + '\n';
}

const nameToken = (value: unknown): string =>
  String(value ?? '').normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '').slice(0, 32);

const readTokensBlob = async (host: BrandTransferHost, id: string): Promise<Record<string, unknown> | null> => {
  try {
    const blob = await host.assets._getBlob(id);
    if (!blob) return null;
    const doc: unknown = JSON.parse(await blob.text());
    return typeof doc === 'object' && doc !== null ? doc as Record<string, unknown> : null;
  } catch { return null; }
};

/**
 * The active tokens doc: the user's installed doc first, else the discovered
 * catalog brand - the exact precedence the tokens bridge resolves with.
 *
 * The head's ID travels with it because a published version is addressed as
 * `<head>/<slug>`: exporting versions off a catalog-discovered head would
 * otherwise look for them under the user id and find nothing.
 */
async function activeTokensDoc(
  host: BrandTransferHost,
): Promise<{ doc: Record<string, unknown>; headId: string } | null> {
  const user = await readTokensBlob(host, USER_TOKENS_ID);
  if (user) return { doc: user, headId: USER_TOKENS_ID };
  try {
    const meta = await (host.assets as unknown as {
      _findMetaByType(t: string): Promise<{ id: string } | null>;
    })._findMetaByType('tokens');
    if (!meta) return null;
    const doc = await readTokensBlob(host, meta.id);
    return doc ? { doc, headId: meta.id } : null;
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

  const head = await activeTokensDoc(host);
  const doc = head?.doc ?? null;
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

  // Brand logos - the canonical orientation×treatment slots plus any custom
  // variants and named identities (lib/brand-logos.ts), carried the same way as
  // fonts so the pack is a complete brand. Default-identity marks keep the
  // original `logos/<variant>.<ext>` name (what pre-identity packs used); other
  // identities get `logos/<identity>__<variant>.<ext>`. Import matches rows by
  // id - the filename only has to be unique - so both forms round-trip, and a
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

  // Published versions (plans/97 §6a). The ledger lives in the head document, the
  // payloads in sibling assets, and the preserved bytes under `user/frozen/*` - 
  // all three have to travel or a version arrives unloadable.
  //
  // A system that never published takes this branch to zero on the first line and
  // adds NOTHING to the zip: an unversioned pack is the same file it was before
  // versions existed, part for part.
  const ledger = readVersionIndex(doc);
  // A version is addressed relative to the head it belongs to, which is not always
  // the user id: a catalog-discovered design system publishes under its own
  // namespace, and looking for its versions under `user/…` would find nothing.
  const headId = head?.headId ?? USER_TOKENS_ID;
  const shipped: VersionEntry[] = [];
  const frozenIds = new Set<string>();
  for (const entry of ledger.versions) {
    const id = versionAssetId(headId, entry.slug);
    const blob = await host.assets._getBlob(id).catch(() => null);
    if (!blob) {
      // The ledger names it and the bytes are gone - carrying the entry anyway
      // would put a version in the pack that the receiver could never load.
      host.log?.('warn', 'Skipped a published version with no readable tokens asset', { id });
      continue;
    }
    entries[`versions/${entry.slug}.json`] = new Uint8Array(await blob.arrayBuffer());
    shipped.push(entry);
    for (const pin of entry.assets ?? []) if (pin.frozenId) frozenIds.add(pin.frozenId);
  }
  const frozenRows: FrozenRow[] = [];
  if (shipped.length) {
    for (const r of records) {
      if (!frozenIds.has(r.id) || !r.blob) continue;
      // Cast for the same reason the font branch above does: the stored record
      // carries format/version, the narrow host slice this module declares does not.
      const rec = r as FrozenRow & { blob: Blob };
      const fmt = String(rec.format ?? rec.meta?.format ?? 'bin');
      // The id IS the content key (`user/frozen/<sha12>`), so the filename can be
      // it: unique by construction, and readable next to the pin that names it.
      const file = `frozen/${r.id.slice(FROZEN_PREFIX.length)}.${fmt}`;
      entries[file] = new Uint8Array(await r.blob.arrayBuffer());
      const { blob: _b, ...rest } = rec;
      frozenRows.push({ ...rest, file, format: fmt, mime: r.blob.type || 'application/octet-stream' });
    }
    entries['versions.json'] = strToU8(JSON.stringify({
      list: shipped,
      // Only an active version we actually shipped: pointing at one that was
      // skipped above would activate nothing on arrival.
      active: ledger.active && shipped.some(v => v.slug === ledger.active) ? ledger.active : null,
    }, null, 2));
    entries['frozen.json'] = strToU8(JSON.stringify(frozenRows, null, 2));
  }

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
    versions: shipped.length,
    frozen: frozenRows.length,
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
  const integrity = await buildIntegrity(entries);
  if (integrity) manifest.integrity = integrity;
  entries['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2));
  entries[README_NAME] = strToU8(brandReadme(summary, label, filename));

  const zipped = await zipAsync(entries);
  return { blob: new Blob([zipped as BlobPart], { type: 'application/zip' }), filename, summary };
}

/** Unzip helper shared with the views (start.ts sniffs the manifest before
 *  deciding which importer a dropped .zip belongs to). */
export async function unzipBrandBytes(bytes: ArrayBuffer | Uint8Array): Promise<Unzipped> {
  // A brand pack is a tokens doc + a handful of woff2s - tens of KB to a few MB - 
  // so lib/zip.ts's DEFAULT bomb caps (64 MB entry / 256 MB total) are exactly
  // this payload's policy.
  return unzipBundle(bytes, {
    tooLarge: name => `That brand file expands too large to load (${name}).`,
    invalid: "That file isn't a valid brand pack — it couldn't be unzipped.",
  });
}

/**
 * The pack's version ledger, read through the ONE reader the rest of the feature
 * uses: `versions.json` stores the `{ list, active }` shape a head document
 * carries under its vendor extension, so it is wrapped back into that shape
 * rather than parsed a second way here. A pack with no `versions.json` (every
 * pack from a system that never published, and every pack written before format
 * version 2) reads as empty.
 */
function readPackLedger(files: Unzipped): VersionIndex {
  const raw = readJson(files, 'versions.json');
  // No `versions.json`: fall back to the ledger the head document carries. The
  // two are written from one source, so they agree - but a pack assembled by
  // hand, or one whose ledger part was lost, must not silently import zero
  // versions while its `versions/` payloads sit right there.
  if (!raw) return readVersionIndex(readJson(files, 'tokens.json'));
  return readVersionIndex({ $extensions: { [TOKEN_EXT]: { versions: raw } } });
}

/**
 * The ledger the head document gets after an import: what was already published
 * here, plus the versions that actually landed, in publish order.
 *
 * `null` when there is nothing on either side - the document is then written
 * exactly as the pack shipped it, which is what keeps an unversioned pack
 * byte-identical to the one this importer accepted before versions existed.
 *
 * The pack's active version is adopted ONLY when nothing is active locally.
 * Loading someone else's design system must not silently change which version
 * every tool on this device renders against.
 */
function mergeLedgers(local: VersionIndex, added: VersionEntry[], packActive: string | null): VersionIndex | null {
  if (!local.versions.length && !added.length) return null;
  const versions = [...local.versions, ...added]
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const adopted = packActive && added.some(v => v.slug === packActive) ? packActive : null;
  return { versions, active: local.active ?? adopted };
}

/**
 * Load a brand pack: verify, install the tokens doc, restore the font assets,
 * register the faces, apply the theme pref, repaint the chrome. Merge-only - 
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
  await verifyIntegrity(files, manifest.integrity, 'This brand file');

  const summary: BrandImportSummary = {
    tokens: false, fontFamilies: 0, fontFiles: 0, logos: 0, prefs: 0,
    versions: 0, frozen: 0, versionsSkipped: 0, skipped: 0, failedFonts: 0,
  };

  // Fonts BEFORE tokens: when the tokens land, applyChromeBrandVars reads
  // font.brand - the faces should already be present so the swap is one paint.
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

  // Logos - restore each image asset before tokens land (asset.logo.* refs
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

  // Preserved (frozen) bytes, then the published versions, then the head - the
  // same "assets before the document that names them" ordering the fonts and
  // logos branches above rely on. A pack from a system that never published has
  // none of these parts and skips the whole block.
  const frozenRows: FrozenRow[] = readJson(files, 'frozen.json') ?? [];
  const restored = new Set<string>();
  for (const row of frozenRows) {
    if (!row?.id || !String(row.id).startsWith(FROZEN_PREFIX) || !row.file) continue;
    const raw = files[row.file];
    if (!raw) continue;
    try {
      await host.assets._uploadUserAsset({
        id: row.id,
        type: row.type || 'raster',
        format: row.format || 'bin',
        blob: new Blob([raw as BlobPart], { type: row.mime || 'application/octet-stream' }),
        ...(row.version ? { version: row.version } : {}),
        ...(row.meta ? { meta: row.meta } : {}),
      });
      restored.add(row.id);
      summary.frozen++;
    } catch (e) {
      host.log?.('warn', 'Skipped restoring one preserved file (storage full?)', { id: String(row.id), error: String(e) });
    }
  }

  /**
   * A pin whose preserved bytes did not travel, and that this device does not
   * already hold, would leave the version naming a dead id. Drop the `frozenId`
   * so it falls back to the live asset instead: wrong-but-present is a render,
   * a broken reference is a hole, and the log says which version lost what.
   * (`scripts/ingest-brand.ts` makes the same repair on the pack-catalog side.)
   */
  const usablePin = async (slug: string, pin: PinnedAsset): Promise<PinnedAsset> => {
    if (!pin.frozenId || restored.has(pin.frozenId)) return pin;
    if (await host.assets._getBlob(pin.frozenId).catch(() => null)) return pin;
    host.log?.('warn', 'A published version pins preserved bytes this pack did not carry', { slug, id: pin.frozenId });
    const { frozenId: _drop, ...rest } = pin;
    return rest;
  };

  const localHead = await readTokensBlob(host, USER_TOKENS_ID);
  const localIndex = readVersionIndex(localHead);
  const packIndex = readPackLedger(files);
  const added: VersionEntry[] = [];
  for (const entry of packIndex.versions) {
    const payload = readJson(files, `versions/${entry.slug}.json`);
    if (!payload || typeof payload !== 'object') { summary.versionsSkipped++; continue; }
    try {
      // The chokepoint enforces immutability, so the "never overwrite a local
      // slug" rule is the SAME check the studio's own publish makes - one place
      // decides what a published name means, and this path cannot soften it.
      // The payload is stripped defensively: a version carries no ledger, and the
      // local list is the only one that could be authoritative here anyway.
      await installUserTokens(host as Parameters<typeof installUserTokens>[0], stripVersionIndex(payload), {
        label: entry.label,
        versionSlug: entry.slug,
        allowVersionWrite: true,
      });
      const pins = await Promise.all((entry.assets ?? []).map(p => usablePin(entry.slug, p)));
      added.push({ ...entry, assets: pins });
      summary.versions++;
    } catch (e) {
      if (e instanceof VersionExistsError) summary.versionsSkipped++;
      else host.log?.('warn', 'Skipped restoring one design-system version', { slug: entry.slug, error: String(e) });
    }
  }

  const doc = readJson(files, 'tokens.json');
  if (doc && typeof doc === 'object') {
    // The pack's document carries the PACK's ledger. Replace it with the merged
    // one - local entries plus the versions that actually landed, oldest first - 
    // or the receiver's own published history would be overwritten by a file
    // someone else exported. Untouched when neither side has a ledger, so an
    // unversioned pack installs the document exactly as it always did.
    const merged = mergeLedgers(localIndex, added, packIndex.active);
    const payload = merged ? withVersionIndex(doc, merged) : doc;
    await installUserTokens(host as Parameters<typeof installUserTokens>[0], payload, {
      label: typeof manifest.label === 'string' ? manifest.label : 'Imported brand',
    });
    summary.tokens = true;
  } else if (added.length) {
    // Payloads but no head document - a pack assembled by hand, or one whose
    // tokens.json was lost. The version ASSETS have landed; without this the
    // merged ledger is never written and the summary reports N imported versions
    // that nothing on this device lists. Write the ledger onto the LOCAL head
    // instead, which is the only document there is to carry it.
    const merged = mergeLedgers(localIndex, added, packIndex.active);
    if (merged && localHead && typeof localHead === 'object') {
      await installUserTokens(
        host as Parameters<typeof installUserTokens>[0], withVersionIndex(localHead, merged),
      );
    } else {
      // No head on either side: the versions are real assets belonging to a
      // design system that does not exist here, so say so rather than claim them.
      host.log?.('warn', 'Imported design-system versions have no design system to belong to', { versions: added.length });
      summary.versionsSkipped += added.length;
      summary.versions -= added.length;
    }
  }

  const prefs = readJson(files, 'prefs.json') ?? {};
  for (const key of BRAND_PREF_KEYS) {
    if (typeof prefs[key] === 'string') { storage.setItem(key, prefs[key]); summary.prefs++; }
  }

  await applyChromeBrandVars(host as Parameters<typeof applyChromeBrandVars>[0]).catch(() => { /* cosmetic */ });

  summary.skipped = Object.keys(files).filter(p => !isKnownPart(p)).length;
  return summary;
}
