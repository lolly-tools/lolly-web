// SPDX-License-Identifier: MPL-2.0
/**
 * Google Fonts — fetch a family's css2 stylesheet and resolve it to a set of
 * downloadable woff2 files, so a chosen face can be stored ON-DEVICE (as
 * `type:'font'` user assets) and served from IndexedDB forever after. The
 * network is touched exactly once per family — at add time; from then on the
 * face is local, offline, and travels in the data backup like any user asset.
 *
 * Scope decisions (deliberate):
 *   - latin + latin-ext subsets only — matches the shell's own Outfit build
 *     (shells/web/public/fonts/) and keeps a family to a few hundred KB.
 *   - The variable-width axis when the family has one (wght@100..900), else
 *     regular + bold statics, else whatever single style the family ships.
 *     Italics are skipped in v1 (double the payload for a rarely-used axis).
 *   - Licensing: everything on Google Fonts is OFL/Apache/UFL — free to
 *     download, embed and redistribute; the css2 endpoint and fonts.gstatic.com
 *     both serve CORS `*`, and the service worker ignores cross-origin URLs,
 *     so a plain fetch works. The font's own licence rides along in meta.
 *
 * The css2 parser is pure and exported for tests; only fetchGoogleFont touches
 * the network.
 */

/** One @font-face block resolved out of a css2 response. */
export interface GoogleFontFace {
  family: string;
  style: string;          // 'normal' | 'italic'
  weight: string;         // '400' or a variable range '100 900'
  subset: string;         // 'latin', 'latin-ext', … (from the preceding comment)
  unicodeRange: string;   // the block's unicode-range, verbatim ('' if absent)
  url: string;            // the woff2 file on fonts.gstatic.com
}

/** A downloaded face: the parsed descriptor plus its bytes. */
export interface DownloadedFontFace extends GoogleFontFace {
  bytes: Uint8Array;
}

// The subsets worth carrying offline by default (see module header).
const SUBSETS_KEPT = new Set(['latin', 'latin-ext']);

const CSS2 = 'https://fonts.googleapis.com/css2';

// A family name as the css2 API accepts it: letters/digits/spaces (Google Fonts
// names are ASCII; "M PLUS Rounded 1c" is about as exotic as they get). Also the
// safety gate before the name lands in a CSS font-family value or an asset id.
export const GOOGLE_FAMILY_RE = /^[A-Za-z0-9][A-Za-z0-9 ]{0,63}$/;

/**
 * Parse a css2 response into faces. css2 emits one @font-face block per
 * subset, each preceded by a comment naming it — "latin-ext" then a block
 * with font-family/style/weight, a fonts.gstatic.com woff2 src, and that
 * subset's unicode-range. Pure; exported for tests.
 */
export function parseGoogleFontCss(css: string): GoogleFontFace[] {
  const faces: GoogleFontFace[] = [];
  // Walk "<comment>? @font-face { … }" pairs; the comment names the subset.
  const block = /(?:\/\*\s*([\w-]+)\s*\*\/\s*)?@font-face\s*\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = block.exec(css))) {
    const subset = m[1] ?? '';
    const body = m[2] ?? '';
    const prop = (name: string): string =>
      new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(body)?.[1]?.trim() ?? '';
    const url = /src\s*:[^;]*url\((['"]?)([^)'"]+)\1\)/.exec(body)?.[2] ?? '';
    if (!url || !/\.woff2(\?|$)/.test(url)) continue; // woff2 only — no legacy ttf fallbacks
    faces.push({
      family: prop('font-family').replace(/^['"]|['"]$/g, ''),
      style: prop('font-style') || 'normal',
      weight: prop('font-weight') || '400',
      subset,
      unicodeRange: prop('unicode-range'),
      url,
    });
  }
  return faces;
}

/** The faces worth storing: kept subsets only (or everything when the css names
 *  no subsets at all — some single-script families skip the comments). */
export function keepFaces(faces: GoogleFontFace[]): GoogleFontFace[] {
  const named = faces.filter(f => f.subset);
  if (!named.length) return faces;
  return named.filter(f => SUBSETS_KEPT.has(f.subset));
}

/** css2 axis-spec attempts, best first: the full variable weight range (static
 *  families 400 that request), then regular+bold statics, then the bare family
 *  (single-style faces like Bebas Neue reject explicit weight lists). */
function specLadder(family: string): string[] {
  const enc = family.trim().replace(/ /g, '+');
  return [
    `${enc}:wght@100..900`,
    `${enc}:wght@400;700`,
    enc,
  ];
}

/**
 * Fetch + parse + download one family: css2 (first axis spec the API accepts),
 * filter to the kept subsets, then pull every face's woff2 bytes. Throws with a
 * user-presentable message when the family doesn't exist or the network is out.
 */
export async function fetchGoogleFont(family: string): Promise<DownloadedFontFace[]> {
  const name = family.trim();
  if (!GOOGLE_FAMILY_RE.test(name)) {
    throw new Error(`"${family}" doesn't look like a Google Fonts family name.`);
  }
  let css = '';
  for (const spec of specLadder(name)) {
    let resp: Response;
    try {
      resp = await fetch(`${CSS2}?family=${spec}&display=swap`);
    } catch {
      throw new Error('Couldn’t reach Google Fonts — check your connection and try again.');
    }
    if (resp.ok) { css = await resp.text(); break; }
    // 400 = this axis spec doesn't fit the family (e.g. not variable) — try the next.
    if (resp.status !== 400) {
      throw new Error(`Google Fonts didn't recognise "${name}".`);
    }
  }
  if (!css) throw new Error(`Google Fonts didn't recognise "${name}".`);

  const faces = keepFaces(parseGoogleFontCss(css));
  if (!faces.length) throw new Error(`"${name}" has no downloadable latin faces.`);

  const downloaded: DownloadedFontFace[] = [];
  for (const face of faces) {
    const resp = await fetch(face.url).catch(() => null);
    if (!resp?.ok) throw new Error(`Downloading "${name}" failed partway — try again.`);
    downloaded.push({ ...face, bytes: new Uint8Array(await resp.arrayBuffer()) });
  }
  return downloaded;
}

// ─── Pinned brand fonts (SUSE era) ────────────────────────────────────────────
// TEMPORARY, SUSE-branded ordering: these families surface at the TOP of the
// add-font picker (in this exact order) ahead of the alphabetical rest, so the
// brand's own faces are one keystroke away. SWITCH THIS BACK ON 2026-08-29 —
// when the SUSE branding leaves the public build, delete PINNED_FAMILIES and
// export the plain alphabetical `ALPHABETICAL_FAMILIES` as POPULAR_FAMILIES.
// (This ordering is intentionally NOT gated on the active content profile: the
// web bundle has no runtime profile signal, so the revert is a one-line edit.)
const PINNED_FAMILIES: readonly string[] = [
  'Outfit', 'SUSE', 'SUSE Mono', 'Overpass', 'Overpass Mono',
  'JetBrains Mono', 'Ubuntu', 'Ubuntu Mono', 'Red Hat Display', 'Red Hat Mono',
];

/**
 * A hand-curated slice of the most-used Google Fonts families (alphabetical),
 * for the add-font <datalist> — suggestion only (any family name can be typed;
 * the list is names, not availability). Static data, no API key, works offline.
 */
const ALPHABETICAL_FAMILIES: readonly string[] = [
  'Albert Sans', 'Alegreya', 'Anton', 'Archivo', 'Archivo Black', 'Arimo',
  'Asap', 'Assistant', 'Atkinson Hyperlegible', 'Barlow', 'Be Vietnam Pro',
  'Bebas Neue', 'Bitter', 'Bricolage Grotesque', 'Cabin', 'Catamaran',
  'Caveat', 'Chivo', 'Comfortaa', 'Cormorant Garamond', 'Crimson Text',
  'DM Mono', 'DM Sans', 'DM Serif Display', 'Dancing Script', 'Dosis',
  'EB Garamond', 'Exo 2', 'Figtree', 'Fira Code', 'Fira Sans', 'Fraunces',
  'Gabarito', 'Geist', 'Geist Mono', 'Hanken Grotesk', 'Heebo', 'IBM Plex Mono',
  'IBM Plex Sans', 'IBM Plex Serif', 'Inconsolata', 'Instrument Sans', 'Inter',
  'JetBrains Mono', 'Josefin Sans', 'Kanit', 'Karla', 'Lato', 'Lexend',
  'Libre Baskerville', 'Libre Franklin', 'Lobster', 'Lora', 'M PLUS Rounded 1c',
  'Manrope', 'Maven Pro', 'Merriweather', 'Montserrat', 'Mulish', 'Noto Sans',
  'Noto Serif', 'Nunito', 'Nunito Sans', 'Onest', 'Open Sans', 'Oswald',
  'Outfit', 'Overpass', 'Overpass Mono', 'Oxanium', 'PT Sans', 'PT Serif', 'Pacifico',
  'Playfair Display', 'Plus Jakarta Sans', 'Poppins', 'Prompt', 'Public Sans',
  'Quicksand', 'Raleway', 'Red Hat Display', 'Red Hat Mono', 'Red Hat Text', 'Righteous',
  'Roboto', 'Roboto Condensed', 'Roboto Mono', 'Roboto Slab', 'Rubik',
  'Schibsted Grotesk', 'Signika', 'Sora', 'Source Code Pro', 'Source Sans 3',
  'Source Serif 4', 'Space Grotesk', 'Space Mono', 'Spectral', 'SUSE', 'SUSE Mono', 'Syne',
  'Titillium Web', 'Ubuntu', 'Ubuntu Mono', 'Unbounded', 'Urbanist',
  'Varela Round', 'Vollkorn', 'Work Sans', 'Zilla Slab',
];

/**
 * The picker order: pinned brand fonts first (see PINNED_FAMILIES), then every
 * other family alphabetically, de-duplicated so a pinned family never repeats
 * further down. The <datalist> renders in array order, which is the display
 * order until the user starts typing.
 */
export const POPULAR_FAMILIES: readonly string[] = (() => {
  const pinned = new Set(PINNED_FAMILIES);
  return [...PINNED_FAMILIES, ...ALPHABETICAL_FAMILIES.filter((f) => !pinned.has(f))];
})();
