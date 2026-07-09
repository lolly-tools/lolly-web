// SPDX-License-Identifier: MPL-2.0
/**
 * Brand logo variants — the four brand marks (horizontal · vertical · mono ·
 * reverse) as on-device USER ASSETS, mirroring user-fonts.ts. Each variant is
 * one `type:'image'` asset at `user/logo/<variant>`, with a matching
 * `asset.logo.<variant>` token recording which asset id fills the slot — so the
 * brand file carries them (see brand-transfer.ts) and tools can reference them
 * later. Every variant is optional; any one is enough.
 *
 * The doc surgery (withLogoToken / logoGroupOf) is pure + testable; the blob I/O
 * rides the same bridge methods fonts use. Logos render as `<img src=blobURL>`,
 * so an uploaded SVG's markup is drawn, not executed.
 */

import { installUserTokens, USER_TOKENS_ID } from '../bridge/tokens.ts';
import type { UserFontsHost } from '../user-fonts.ts';

/** Every logo asset id starts here (fixed namespace, like USER_FONT_PREFIX). */
export const USER_LOGO_PREFIX = 'user/logo/';

export const LOGO_VARIANTS = ['horizontal', 'vertical', 'mono', 'reverse'] as const;
export type LogoVariant = typeof LOGO_VARIANTS[number];

/** Human labels + a one-line hint per slot (shown in the editor panel). */
export const LOGO_META: Record<LogoVariant, { label: string; hint: string }> = {
  horizontal: { label: 'Horizontal', hint: 'Wordmark + symbol in a row — the default lockup.' },
  vertical: { label: 'Vertical', hint: 'Stacked lockup for square and tall spaces.' },
  mono: { label: 'Monochrome', hint: 'One-colour mark for stamps, watermarks, faxes.' },
  reverse: { label: 'Reverse', hint: 'Light mark for dark backgrounds.' },
};

export interface LogoSlot {
  variant: LogoVariant;
  assetId: string;
  /** Object URL for an <img> preview (revoke when the panel re-renders). */
  url: string;
  format: string;
  bytes: number;
}

// PNG / JPEG / SVG / WebP, up to 4 MB — a logo, not a hero photo.
const ACCEPT = /^image\/(png|jpeg|svg\+xml|webp)$/;
const EXT: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/svg+xml': 'svg', 'image/webp': 'webp',
};
const MAX_BYTES = 4 * 1024 * 1024;

// ── Doc surgery (pure) ────────────────────────────────────────────────────────
type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Which set to write the `asset` group into — `base` on a layered doc, else root. */
function assetTargetOf(out: Rec): Rec {
  const layered = Array.isArray(out.$themes) && out.$themes.length > 0;
  if (!layered) return out;
  return (isRec(out.base) ? out.base : (out.base = {} as Rec)) as Rec;
}

/** The `asset.logo` token group in a doc (layered or plain), or null. */
export function logoGroupOf(doc: unknown): Rec | null {
  if (!isRec(doc)) return null;
  const layered = Array.isArray(doc.$themes) && doc.$themes.length > 0;
  const holder = layered
    ? (['base', ...Object.keys(doc).filter(k => !k.startsWith('$'))]
      .map(k => doc[k])
      .find(v => isRec(v) && isRec((v as Rec).asset) && isRec(((v as Rec).asset as Rec).logo)) as Rec | undefined)
    : doc;
  const asset = holder && isRec(holder.asset) ? holder.asset as Rec : null;
  return asset && isRec(asset.logo) ? asset.logo as Rec : null;
}

/**
 * Merge (or clear, with null) `asset.logo.<variant>` into a tokens doc, on a
 * copy. Pure; exported for tests. `$type:'asset'` + `$value` = the user asset id.
 */
export function withLogoToken(doc: unknown, variant: LogoVariant, assetId: string | null): Rec {
  const out = structuredClone(isRec(doc) ? doc : {}) as Rec;
  const target = assetTargetOf(out);
  const asset = isRec(target.asset) ? target.asset as Rec : {};
  const logo = isRec(asset.logo) ? asset.logo as Rec : {};
  if (assetId) logo[variant] = { $type: 'asset', $value: assetId };
  else delete logo[variant];
  if (Object.keys(logo).filter(k => !k.startsWith('$')).length) { asset.logo = logo; target.asset = asset; }
  else { delete asset.logo; if (!Object.keys(asset).filter(k => !k.startsWith('$')).length) delete target.asset; }
  return out;
}

// ── Bridge-backed I/O ─────────────────────────────────────────────────────────
type LogoHost = UserFontsHost;

/** The user's installed tokens doc, or an empty doc when none is installed yet. */
async function userDoc(host: LogoHost): Promise<Rec> {
  try {
    const blob = await host.assets._getBlob(USER_TOKENS_ID);
    if (blob) { const parsed = JSON.parse(await blob.text()); if (isRec(parsed)) return parsed; }
  } catch { /* no/corrupt doc — start from empty, same as the font path */ }
  return {};
}

/** Every stored logo variant, each with a fresh object URL for preview. */
export async function listLogos(host: LogoHost): Promise<LogoSlot[]> {
  const records = await host.assets._exportUserAssets().catch(() => []);
  const out: LogoSlot[] = [];
  for (const r of records) {
    if (!r.id.startsWith(USER_LOGO_PREFIX) || !r.blob) continue;
    const variant = r.id.slice(USER_LOGO_PREFIX.length) as LogoVariant;
    if (!LOGO_VARIANTS.includes(variant)) continue;
    out.push({
      variant, assetId: r.id, url: URL.createObjectURL(r.blob),
      format: (r.meta?.format as string) || '', bytes: r.blob.size,
    });
  }
  return out;
}

/** Store `file` as the given variant (replacing any existing) + record the token. */
export async function installLogo(host: LogoHost, variant: LogoVariant, file: File): Promise<void> {
  if (!LOGO_VARIANTS.includes(variant)) throw new Error(`Unknown logo variant "${variant}".`);
  if (!ACCEPT.test(file.type)) throw new Error('Use a PNG, JPEG, SVG or WebP image.');
  if (file.size > MAX_BYTES) throw new Error(`That logo is ${(file.size / 1024 / 1024).toFixed(1)} MB — the limit is 4 MB.`);
  const id = USER_LOGO_PREFIX + variant;
  const format = EXT[file.type] || 'png';
  await host.assets._uploadUserAsset({ id, type: 'image', format, blob: file, meta: { format, variant } });
  const doc = withLogoToken(await userDoc(host), variant, id);
  await installUserTokens(host as Parameters<typeof installUserTokens>[0], doc, { label: 'My brand' });
}

/** Remove a variant's asset + clear its token. */
export async function removeLogo(host: LogoHost, variant: LogoVariant): Promise<void> {
  await host.assets._deleteUserAsset(USER_LOGO_PREFIX + variant).catch(() => {});
  const doc = withLogoToken(await userDoc(host), variant, null);
  await installUserTokens(host as Parameters<typeof installUserTokens>[0], doc, { label: 'My brand' });
}
