// SPDX-License-Identifier: MPL-2.0
/**
 * The platform's bundled (local) typefaces — the single source of truth mirrored from
 * the @font-face registrations in styles/fonts.css. Shared by the Platform view (specimen
 * cards) and the Catalog view (specimen + download links).
 *
 * There is no machine-readable font manifest; this is the hand-maintained mirror. The
 * variable filenames contain LITERAL `[wght]` brackets — they resolve unencoded in an
 * href (see main.ts's preload), so don't URL-encode them.
 */

/** A downloadable file for a typeface (variable axis or webfont). */
export interface FontDownload { label: string; href: string; }

/** One bundled (local) typeface, mirroring an @font-face block in fonts.css. */
export interface FontSpec {
  family: string;
  role: string;
  stack: string;
  variable: boolean;
  weights: string;
  styles: string[];
  /** The primary (upright variable) source, shown as a code path. */
  source: string;
  /** Downloadable files offered in the Catalog view. */
  downloads: FontDownload[];
}

const FONT_DIR = '/catalog/fonts';

// Mirrors the @font-face registrations in styles/fonts.css. These are the platform's
// local (bundled) typefaces — no webfont / CDN dependency at runtime. Downloads cover the
// variable axis (upright + italic) as both TTF (desktop) and WOFF2 (web); the per-weight
// statics under otf/ + ttf/ exist on disk too but aren't surfaced (the variable file is
// the canonical one).
// Shell-served platform defaults (public/fonts/ — present on every profile).
const SHELL_FONT_DIR = '/fonts';

export const FONTS: FontSpec[] = [
  {
    family: 'Outfit',
    role: 'UI & body (platform default)',
    stack: "'Outfit', ui-sans-serif, system-ui, sans-serif",
    variable: true,
    weights: '100–900',
    styles: ['normal'],
    source: `${SHELL_FONT_DIR}/Outfit[wght].ttf`,
    downloads: [
      { label: 'Variable TTF', href: `${SHELL_FONT_DIR}/Outfit[wght].ttf` },
      { label: 'Variable WOFF2 (latin)', href: `${SHELL_FONT_DIR}/Outfit-latin[wght].woff2` },
      { label: 'Variable WOFF2 (latin-ext)', href: `${SHELL_FONT_DIR}/Outfit-latin-ext[wght].woff2` },
    ],
  },
  {
    family: 'SUSE Mono',
    role: 'Monospace (platform default)',
    stack: "'SUSE Mono', ui-monospace, monospace",
    variable: true,
    weights: '100–900',
    styles: ['normal', 'italic'],
    source: `${SHELL_FONT_DIR}/SUSEMono[wght].woff2`,
    downloads: [
      { label: 'Variable WOFF2', href: `${SHELL_FONT_DIR}/SUSEMono[wght].woff2` },
      { label: 'Variable WOFF2 (italic)', href: `${SHELL_FONT_DIR}/SUSEMono-Italic[wght].woff2` },
    ],
  },
  {
    family: 'SUSE',
    role: 'Brand — display, UI & body',
    stack: "'SUSE', system-ui, sans-serif",
    variable: true,
    weights: '100–900',
    styles: ['normal', 'italic'],
    source: `${FONT_DIR}/variable/SUSE[wght].ttf`,
    downloads: [
      { label: 'Variable TTF', href: `${FONT_DIR}/variable/SUSE[wght].ttf` },
      { label: 'Variable TTF (italic)', href: `${FONT_DIR}/variable/SUSE-Italic[wght].ttf` },
      { label: 'Variable WOFF2', href: `${FONT_DIR}/webfonts/SUSE[wght].woff2` },
      { label: 'Variable WOFF2 (italic)', href: `${FONT_DIR}/webfonts/SUSE-Italic[wght].woff2` },
    ],
  },
];

/** The weight steps a specimen shows. */
export const WEIGHT_RAMP: number[] = [100, 300, 400, 500, 700, 900];

/** The OFL licence the bundled fonts ship under. */
export const FONT_LICENSE = { label: 'SIL Open Font License 1.1', href: `${FONT_DIR}/OFL.txt` };
