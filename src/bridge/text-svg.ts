// SPDX-License-Identifier: MPL-2.0
/**
 * Pure helpers for vectorising HTML text into SVG <path> via host.text.toPath.
 *
 * DOM-free at import so it's unit-testable under node:test (see text-svg.test.js).
 * The SUSE-specific font resolution lives HERE (the shell), never in the engine —
 * the engine stays brand-agnostic. The HarfBuzz shaping itself is the engine's
 * host.text primitive; this module only decides *which* font file to feed it and
 * *where* to place the resulting baseline-relative path.
 */

/** The slice of a computed style the font resolution reads. */
export interface FontStyleSlice {
  fontFamily?: string;
  fontWeight?: string;
  fontStyle?: string;
}

// Maps a CSS numeric font-weight to the nearest SUSE static TTF filename stem.
// SUSE Mono has no Black cut (its weight axis tops out at ExtraBold/800), so
// mono resolution caps there — matching how the browser clamps the variable font.
export function suseWeightName(weight: number, mono = false): string {
  const map = ([
    [100, 'Thin'], [200, 'ExtraLight'], [300, 'Light'], [400, 'Regular'],
    [500, 'Medium'], [600, 'SemiBold'], [700, 'Bold'], [800, 'ExtraBold'], [900, 'Black'],
  ] as [number, string][]).filter(([n]) => !mono || n <= 800);
  const w = Math.round(weight / 100) * 100;
  const entry = map.find(([n]) => n === w) ?? map.reduce((a, b) =>
    Math.abs(b[0] - weight) < Math.abs(a[0] - weight) ? b : a);
  return entry[1];
}

// Where the SUSE static TTFs live (served by the web shell from the lockup tool).
// Single source of truth shared by the SVG path emitter and the PDF embedder.
export const SUSE_FONT_DIR = '/catalog/fonts/ttf/';

export function suseFontFile(weight: number, italic: boolean, mono = false): string {
  return `SUSE${mono ? 'Mono' : ''}-${suseWeightName(weight, mono)}${italic ? 'Italic' : ''}.ttf`;
}

/**
 * Resolve a computed style to a SUSE TTF URL host.text.toPath can fetch, or null
 * if this run isn't set in the brand font. SUSE Mono resolves to the SUSEMono-*
 * statics. (Phase 2 will resolve non-SUSE/system fonts via a font registry or
 * @font-face src; until then those fall back to a plain <text> element — see
 * canVectoriseText.)
 */
export function resolveSuseFontUrl(style: FontStyleSlice): string | null {
  const family = (style.fontFamily || '').toLowerCase();
  if (!family.includes('suse')) return null;
  const mono = family.includes('mono');
  const weight = parseInt(style.fontWeight ?? '') || 400;
  const italic = style.fontStyle === 'italic' || style.fontStyle === 'oblique';
  return SUSE_FONT_DIR + suseFontFile(weight, italic, mono);
}

/**
 * Can this run be faithfully turned into paths right now? We fall back to <text>
 * only when there's no host.text primitive or no resolvable font file. Tracking
 * (letter-spacing) and OpenType feature toggles (ligatures/alternates) are baked
 * into the shaped path via toPath's letterSpacing/features opts, so they no longer
 * force a fallback — outlined text stays outlined.
 */
export function canVectoriseText(style: FontStyleSlice, fontUrl: string | null, hasTextApi: boolean): boolean {
  return Boolean(hasTextApi && fontUrl);
}

/**
 * Parse a computed CSS `font-feature-settings` value into HarfBuzz feature strings
 * (as host.text.toPath's `features` opt expects). "normal"/"" → []. Examples:
 *   `"liga" 0, "salt" 1`  → ['liga=0', 'salt=1']
 *   `"dlig"`              → ['dlig=1']   (bare tag = on)
 */
export function featureSettingsToHb(value: unknown): (string | null)[] {
  const v = String(value || '').trim();
  if (!v || v === 'normal') return [];
  return v.split(',').map((part) => {
    const m = part.trim().match(/^["']([A-Za-z0-9]{1,4})["']\s*(\d+|on|off)?$/);
    if (!m) return null;
    const tag = m[1]!;
    const raw = m[2];
    const val = raw == null || raw === 'on' ? '1' : raw === 'off' ? '0' : raw;
    return `${tag}=${val}`;
  }).filter(Boolean);
}

/** Parse a computed CSS letter-spacing (px) to a number; "normal"/"" → 0. */
export function letterSpacingPx(value: unknown): number {
  const v = String(value || '').trim();
  if (!v || v === 'normal') return 0;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Baseline y for one text line. host.text.toPath returns a path with the baseline
 * at y=0; to place it we need the line's baseline in canvas coordinates. Given the
 * line box (top, lineHeight) and the font's ascent/descent in px, leading is split
 * evenly above and below the font box (the CSS "normal" half-leading model).
 */
export function textBaselineY(top: number, lineHeight: number, ascent: number, descent: number): number {
  const leading = lineHeight - (ascent + descent);
  return top + leading / 2 + ascent;
}
