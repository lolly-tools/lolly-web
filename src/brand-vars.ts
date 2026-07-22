// SPDX-License-Identifier: MPL-2.0
/**
 * Brand semantic CSS variables — the web half of the brand token contract
 * (plans/brand-token-contract.md §3/§5).
 *
 * applyBrandVars(el, host) resolves the seven `color.semantic.*` slots from the
 * active brand tokens (host.tokens) and mirrors them onto the tool-canvas root
 * as namespaced CSS custom properties, so tool templates can consume
 * `var(--brand-primary, #4f84ba)` — always with a fallback. A missing slot
 * REMOVES the property (it is never set to '') so the template fallback stays
 * in charge. Best-effort and async: it never throws and mounting never waits
 * on it (though exports may — see views/tool.ts brandVarsReady).
 *
 * Why `--brand-*`, not bare `--primary` (contract §3): the web shell's
 * styles/tokens.css defines `--primary`/`--muted`/… on `:root` as shadcn HSL
 * *triples*, and community utilities (compress-pdf, strip-data, text-helper)
 * deliberately consume that vocabulary inside the tool canvas as
 * `hsl(var(--primary, …))` — injecting full-colour values under the same names
 * would make those declarations invalid-at-computed-value-time, and would also
 * leak user brand colours into SUSE tools that use bare `var(--primary)` as a
 * private internal. The namespace removes both collision classes at zero cost
 * to template authors.
 */

import { colorToHex, isAlias, parseOklch, oklchToHex, hexToOklch, contrastRatio } from '@lolly/engine';

/** The seven semantic slots (token leaf under `color.semantic`) → CSS var. */
const SLOTS = [
  ['primary', '--brand-primary'],
  ['on-primary', '--brand-on-primary'],
  ['secondary', '--brand-secondary'],
  ['surface', '--brand-surface'],
  ['text', '--brand-text'],
  ['muted', '--brand-muted'],
  ['edge', '--brand-edge'],
] as const;

/** The host slice this module reads — the (optional) tokens resolver, plus
 * `colors()` for the warm-accent scan (see nearestWarmHex). */
interface BrandVarsHost {
  tokens?: {
    resolve(ref: string, opts?: { theme?: string }): Promise<unknown>;
    colors?(opts?: { theme?: string }): Promise<Array<{ value: string }>>;
  };
}

// ── Chrome (app UI) brand accent ─────────────────────────────────────────────
// The second half of the contract: the SHELL's own chrome follows the brand's
// primary. tokens.css hardcodes shadcn HSL-triple accents per theme; when the
// active brand resolves `color.semantic.primary`, we override the accent
// triples (--primary / --primary-foreground / --ring — deliberately nothing
// else: backgrounds, borders and text stay the shell's own) via one injected
// <style>, per shell theme so light/dark each take their brand-theme value.
// No semantic slots (the SUSE doc has none) → the style is removed and the
// hardcoded chrome stands. lolly-start's starter tokens alias primary to the
// neutral ink ramp, so the out-of-the-box chrome accent is black until the
// user installs a brand (#/start wizard / ingest).

const CHROME_STYLE_ID = 'brand-chrome-vars';

// ── Brand fonts ──────────────────────────────────────────────────────────────
// The platform's default faces are Outfit (UI/body) and SUSE Mono (code) —
// shell-served @font-face registrations (styles/fonts.css) behind the :root
// --font-brand / --font-mono stacks in tokens.css. When the active brand's
// tokens declare `font.brand` / `font.mono` (DTCG fontFamily), the resolved
// families are applied INLINE on <html> (style attribute beats the :root
// stylesheet default at equal cascade origin), with the default stack kept as
// the tail so an unloadable family degrades to the platform face. The applied
// stacks are cached in localStorage so index.html's pre-boot script can restore
// them before first paint (same trick as the theme flash guard) — without it,
// a branded profile would flash Outfit on every load until boot JS runs.

/** slot in the tokens doc (`font.<slot>`) → CSS var → default stack tail.
 *  display (h1/h2) and italic degrade to the brand face, so a brand that sets
 *  only those still reads coherently, and the tail also catches a font that
 *  fails to load. Their consumers (base.css) also `var(--font-display,
 *  var(--font-brand))`, so an UNSET slot falls through to the primary too. */
const FONT_SLOTS = [
  ['brand', '--font-brand', "'Outfit', ui-sans-serif, system-ui, sans-serif"],
  ['mono', '--font-mono', "'SUSE Mono', ui-monospace, monospace"],
  ['display', '--font-display', 'var(--font-brand)'],
  ['italic', '--font-italic', 'var(--font-brand)'],
] as const;

const FONT_CACHE_KEY = 'brand-fonts';

// Family names come from an untrusted imported tokens doc and land in a style
// value — allow only plain name characters (letters/digits/space/_/-), so no
// quotes, braces, url() or declaration smuggling can pass. Same stance as
// SAFE_CSS_COLOR in color-field.ts.
const FONT_FAMILY_RE = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$/;

/**
 * A resolved `font.*` token value → a safe CSS font-family stack ending in the
 * platform default `tail`, or null when nothing usable resolved. Accepts a
 * string or a DTCG fontFamily array; strips optional quotes; rejects any
 * family that isn't a plain name (see FONT_FAMILY_RE). Exported for tests.
 */
export function brandFontStack(value: unknown, tail: string): string | null {
  const fams = (Array.isArray(value) ? value : [value])
    .filter((f): f is string => typeof f === 'string' && !isAlias(f))
    .map(f => f.trim().replace(/^['"]+|['"]+$/g, '').trim())
    .filter(f => FONT_FAMILY_RE.test(f));
  if (!fams.length) return null;
  // A brand naming a platform default (SUSE's font.mono is 'SUSE Mono') would
  // otherwise emit the family twice — once from the token, again leading the
  // tail. Drop tail entries whose family the token already names.
  const named = new Set(fams.map(f => f.toLowerCase()));
  const restTail = tail.split(',')
    .filter(part => !named.has(part.trim().replace(/^['"]+|['"]+$/g, '').trim().toLowerCase()))
    .map(part => part.trim()).join(', ');
  return `${fams.map(f => `'${f}'`).join(', ')}${restTail ? `, ${restTail}` : ''}`;
}

/** Resolve the brand font slots and apply/clear them inline on <html>. */
async function applyBrandFonts(host: BrandVarsHost): Promise<void> {
  const applied: Record<string, string> = {};
  for (const [slot, cssVar, tail] of FONT_SLOTS) {
    let stack: string | null = null;
    try {
      stack = brandFontStack(await host.tokens?.resolve(`{font.${slot}}`), tail);
    } catch { /* no tokens / broken doc → platform default */ }
    if (stack) {
      document.documentElement.style.setProperty(cssVar, stack);
      applied[cssVar] = stack;
    } else {
      document.documentElement.style.removeProperty(cssVar);
    }
  }
  try {
    if (Object.keys(applied).length) localStorage.setItem(FONT_CACHE_KEY, JSON.stringify(applied));
    else localStorage.removeItem(FONT_CACHE_KEY);
  } catch { /* storage unavailable — pre-boot restore just won't happen */ }
}

// ── Brand shape (corner radius) ──────────────────────────────────────────────
// The one "shape" token: how rounded the app's OWN chrome (cards, buttons,
// panels — never a tool canvas; no template consumes var(--radius)) reads.
// Lives at `shape.radius` (DTCG dimension), applied to --radius on <html>
// exactly like the font stacks above — inline style beats the :root default
// at equal cascade origin — and cached in localStorage so index.html's
// pre-boot script restores it before first paint. Reserved for UNLOCKED
// brands (profile.ts gates the whole "Adjust your brand" card on brandLocked)
// — a locked catalog's shape is part of its fixed identity like its colours
// and fonts.

const RADIUS_CACHE_KEY = 'brand-radius';

// A DTCG dimension value as this app will ever emit or accept for --radius: a
// non-negative number (optional decimal) in rem/px/em only. Same defense-in-
// depth stance as FONT_FAMILY_RE/SAFE_CSS_COLOR above — an untrusted imported
// tokens doc's string lands directly in a CSSOM setProperty call.
const RADIUS_RE = /^\d+(\.\d+)?(rem|px|em)$/;

/** A resolved `shape.radius` token value → a safe CSS length, or null when it
 *  isn't one (missing slot, alias residue, or an unsafe/malformed string). */
export function brandRadiusValue(value: unknown): string | null {
  const v = typeof value === 'string' ? value.trim() : '';
  return v && !isAlias(v) && RADIUS_RE.test(v) ? v : null;
}

/** Resolve `shape.radius` and apply/clear it inline on <html>, caching the
 *  applied value (or clearing the cache) for index.html's pre-boot restore. */
async function applyBrandRadius(host: BrandVarsHost): Promise<void> {
  let radius: string | null = null;
  try {
    radius = brandRadiusValue(await host.tokens?.resolve('{shape.radius}'));
  } catch { /* no tokens / broken doc → platform default */ }
  if (radius) {
    document.documentElement.style.setProperty('--radius', radius);
    try { localStorage.setItem(RADIUS_CACHE_KEY, radius); } catch { /* storage unavailable */ }
  } else {
    document.documentElement.style.removeProperty('--radius');
    try { localStorage.removeItem(RADIUS_CACHE_KEY); } catch { /* storage unavailable */ }
  }
}

/** #rrggbb → a shadcn "H S% L%" triple (so hsl(var(--x) / α) keeps working). */
export function hexToHslTriple(hex: string): string | null {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return null;
  const r = parseInt(m[1]!, 16) / 255, g = parseInt(m[2]!, 16) / 255, b = parseInt(m[3]!, 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  const l = (max + min) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (d !== 0) {
    h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
  }
  const rnd = (v: number) => Math.round(v * 10) / 10;
  return `${rnd(h)} ${rnd(s * 100)}% ${rnd(l * 100)}%`;
}

/** A resolved token value → #rrggbb, or null when it isn't a usable colour.
 * Ramps store raw `oklch()` strings — the browser resolves those in var()
 * injection, but anything needing real RGB (the HSL-triple convention here,
 * the confetti chip pairs in lib/particles.ts) gamut-maps them through the
 * engine (the same path deriveBrandTokens uses). */
export function tokenValueToHex(value: unknown): string | null {
  if (typeof value === 'string' && /^(oklch|lch)\(/i.test(value.trim())) {
    const o = parseOklch(value);
    return o ? oklchToHex(o) : null;
  }
  const hex = colorToHex(typeof value === 'string' && isAlias(value) ? null : value);
  return typeof hex === 'string' && /^#[0-9a-f]{6}/i.test(hex) ? hex.slice(0, 7) : null;
}

// ── Warm accent (--brand-warn) ───────────────────────────────────────────────
// "Needs attention" UI (the render pill / editor toolbar's unsaved cue) used to
// hard-code an amber. Instead, scan the active brand's own colours (ramps,
// spectrum, semantic roles — whatever resolves) and pick whichever sits closest
// to the red→amber→yellow arc in OKLCH hue, so the cue is always ON BRAND and
// automatically follows any colour the user changes. Near-neutral swatches
// (low chroma) are skipped — a grey has no real hue to judge.
const WARM_TARGET_HUE = 50;   // OKLCH degrees — the red/amber/yellow arc's centre
const MIN_WARM_CHROMA = 0.04; // below this a swatch reads as grey, not warm

function hueDistance(h: number, target: number): number {
  const d = Math.abs(h - target) % 360;
  return Math.min(d, 360 - d);
}

/** Among `swatches`, the resolved hex whose OKLCH hue is nearest red/yellow,
 * plus whichever of black/white reads legibly on top of it — or null when none
 * resolve to a usable, sufficiently-chromatic colour (caller keeps its own
 * static fallback, e.g. `var(--brand-warn, #b28727)`). */
export function nearestWarmHex(swatches: ReadonlyArray<{ value: unknown }>): { hex: string; ink: string } | null {
  let best: { hex: string; dist: number } | null = null;
  const seen = new Set<string>();
  for (const s of swatches) {
    const hex = tokenValueToHex(s.value);
    if (!hex || seen.has(hex)) continue;
    seen.add(hex);
    const o = hexToOklch(hex);
    if (!o || o.c < MIN_WARM_CHROMA) continue;
    const dist = hueDistance(o.h, WARM_TARGET_HUE);
    if (!best || dist < best.dist) best = { hex, dist };
  }
  if (!best) return null;
  const ink = contrastRatio(best.hex, '#000000') >= contrastRatio(best.hex, '#ffffff') ? '#000000' : '#ffffff';
  return { hex: best.hex, ink };
}

/** One shell theme's accent overrides, or '' when primary didn't resolve. */
function accentBlock(selector: string, primary: string | null, onPrimary: string | null): string {
  const p = primary && hexToHslTriple(primary);
  if (!p) return '';
  const fg = onPrimary && hexToHslTriple(onPrimary);
  return `${selector} {\n  --primary: ${p};\n  --ring: ${p};\n${fg ? `  --primary-foreground: ${fg};\n` : ''}}`;
}

/**
 * Construct the `brand` theme — the mid-toned colored chrome — from the brand's
 * two primaries. The recipe is the old SUSE theme reverse-engineered into OKLCH
 * (its static block in tokens.css remains the SUSE-palette instance of exactly
 * this): SURFACES take the light primary's hue at low chroma across fixed
 * mid-dark lightness stops (Pine-tinted panels, in SUSE terms); the ACCENT is
 * the dark primary verbatim (Jungle). Chroma is anchored to the light primary's
 * own chroma, so a neutral starter brand (ink primary) yields a tastefully
 * grey chrome and a vivid brand yields a tinted one — never garish: surface
 * chroma is capped at 0.08.
 */
export function brandThemeCss(lightPrimaryHex: string, darkPrimaryHex: string, darkOnPrimaryHex: string | null): string {
  const surf = hexToOklch(lightPrimaryHex);
  const acc = hexToOklch(darkPrimaryHex);
  if (!surf || !acc) return '';
  const h = surf.h;
  const cBase = Math.min(Math.max(surf.c, 0.008), 0.055); // background chroma anchor
  const t = (l: number, cMul: number, hue = h) =>
    hexToHslTriple(oklchToHex({ l, c: Math.min(cBase * cMul, 0.08), h: hue }));
  const accent = hexToHslTriple(darkPrimaryHex);
  const accentFg = (darkOnPrimaryHex && hexToHslTriple(darkOnPrimaryHex)) ?? t(0.23, 0.7);
  const v = (name: string, val: string | null) => (val ? `  --${name}: ${val};\n` : '');
  // Lightness stops lifted from the SUSE construction: bg .29, card .35,
  // muted .38, secondary .39, accent-surface .40, border .51; text .95/.84.
  return `[data-theme="brand"] {
  color-scheme: dark;
${v('background', t(0.29, 1))}${v('foreground', t(0.95, 0.35))}${v('card', t(0.35, 1.18))}${v('card-foreground', t(0.95, 0.35))}${v('popover', t(0.35, 1.18))}${v('popover-foreground', t(0.95, 0.35))}${v('primary', accent)}${v('primary-foreground', accentFg)}${v('secondary', t(0.39, 1.27))}${v('secondary-foreground', t(0.95, 0.35))}${v('muted', t(0.38, 1.2))}${v('muted-foreground', t(0.84, 0.55))}${v('accent', t(0.40, 1.3))}${v('accent-foreground', t(0.95, 0.35))}${v('border', t(0.51, 1.45))}${v('input', t(0.51, 1.45))}${v('ring', accent)}${v('store-1', t(0.65, 0.75, acc.h))}${v('store-2', t(0.70, 0.75, acc.h))}${v('store-3', t(0.74, 0.75, acc.h))}${v('store-4', t(0.79, 0.75, acc.h))}${v('store-other', t(0.62, 0.4))}}`;
}

// ── Lolly's own mark, recoloured to the guest brand ──────────────────────────
// Lolly's IDENTITY (the green-and-white lollipop) is not a verdict — so when a
// guest brand is active it takes on the brand's hue. The mark exists as a raster
// bitmap (the app icon / Verify hero / favicon) and as a line-glyph + wordmark
// (the "Made with Lolly" badge):
//  • BITMAP  — the actual /icons/icon-192.png swirl is recoloured PROPERLY by a
//    canvas hue-remap (tintLogo): each green pixel takes the brand hue but keeps
//    its own saturation/lightness, the white swirl stays white. One data URL
//    drives the Verify hero (via --lolly-logo) AND the browser favicon.
//  • GLYPH/TEXT — the badge glyph + wordmark + the medallion's outer glow wear
//    --lolly-mark, Lolly's identity-green TONE hue-shifted to the brand.
// Everything falls back to Lolly green (bitmap: the plain swirl) when no brand is
// active, so an unbranded Lolly is unchanged. The green VERDICT signals (the
// "Credential intact" pill, the scorecard pips) deliberately stay green.

/** Lolly's identity-green tone in OKLCH, measured from the two `.lolly-badge`
 * greens (hsl 145 58% 34% / 145 52% 60%). The mark keeps this L/C and takes the
 * brand's hue. */
const LOLLY_TONE = { light: { l: 0.5586, c: 0.1286 }, dark: { l: 0.772, c: 0.1338 } } as const;
// Below this OKLCH chroma a "primary" has no hue worth adopting — a greyscale or
// near-black ink (the blank starter's ink, ~0.012) reads as no brand colour at
// all, so we leave Lolly its own green rather than tint it an arbitrary hue.
const MARK_MIN_CHROMA = 0.03;

/**
 * The chosen brand primary for the mark: the MORE CHROMATIC of the two primaries
 * wins, because a dark near-neutral ink has an unstable hue (SUSE's near-black
 * Pine measures teal ~181°, while its vivid Jungle green is the true ~157°). Null
 * when neither primary is chromatic enough to read as a real brand colour.
 */
export function brandMarkPrimary(lightHex: string | null, darkHex: string | null): string | null {
  const best = [lightHex, darkHex]
    .map((hex) => (hex ? { hex, o: hexToOklch(hex) } : null))
    .filter((x): x is { hex: string; o: { l: number; c: number; h: number } } =>
      !!x && !!x.o && x.o.c >= MARK_MIN_CHROMA)
    .sort((a, b) => b.o.c - a.o.c)[0];
  return best ? best.hex : null;
}

/** The brand's dominant OKLCH hue (for the tinted glyph/text tone), or null. */
export function brandMarkHue(lightHex: string | null, darkHex: string | null): number | null {
  const hex = brandMarkPrimary(lightHex, darkHex);
  const o = hex ? hexToOklch(hex) : null;
  return o ? o.h : null;
}

/** The brand-hued Lolly mark hex for one theme (Lolly's tone at the brand hue). */
export function lollyMarkHex(hue: number, theme: 'light' | 'dark'): string {
  return oklchToHex({ ...LOLLY_TONE[theme], h: hue });
}

/**
 * The `--lolly-*` block for the GLYPH/TEXT surfaces: `--lolly-mark` (the badge
 * glyph + wordmark, theme-adaptive) and `--lolly-coin-glow` (the made-with-Lolly
 * medallion's outer glow, so it matches the recoloured logo swirl filling it).
 * '' when the brand has no real hue, so the green fallbacks in valid.css /
 * catalog.css stand. The bitmap recolour (`--lolly-logo`) is handled separately
 * by applyBrandLogo, since it needs a canvas at runtime.
 */
export function lollyMarkCss(lightHex: string | null, darkHex: string | null): string {
  const hue = brandMarkHue(lightHex, darkHex);
  if (hue == null) return '';
  const markLight = lollyMarkHex(hue, 'light');
  return [
    `:root, [data-theme="light"] {\n  --lolly-mark: ${markLight};\n  --lolly-coin-glow: ${markLight}45;\n}`,
    `[data-theme="dark"], [data-theme="brand"] {\n  --lolly-mark: ${lollyMarkHex(hue, 'dark')};\n}`,
  ].join('\n');
}

/** The full injected stylesheet text. Exported for tests. Under the suse
 * PROFILE no semantic slots resolve, nothing is emitted, and the static
 * tokens.css blocks (including the brand theme's SUSE-palette defaults)
 * stand untouched. */
export function chromeBrandCss(
  light: { primary: string | null; onPrimary: string | null },
  dark: { primary: string | null; onPrimary: string | null },
): string {
  return [
    accentBlock(':root, [data-theme="light"]', light.primary, light.onPrimary),
    accentBlock('[data-theme="dark"]', dark.primary, dark.onPrimary),
    // The brand theme is CONSTRUCTED, not accent-patched: surfaces from the
    // light primary's hue, accent from the dark primary (see brandThemeCss).
    light.primary && dark.primary ? brandThemeCss(light.primary, dark.primary, dark.onPrimary) : '',
    // Lolly's own mark follows the brand hue (identity, not verdict).
    lollyMarkCss(light.primary, dark.primary),
  ].filter(Boolean).join('\n');
}

/**
 * Inject/refresh the chrome override stylesheet from already-resolved primary
 * (+ on-primary) hexes, per theme. The shared tail of applyChromeBrandVars
 * (below) — split out so the brand editor's live, in-memory DRAFT preview
 * (not yet installed, so nothing to resolve via host.tokens) can paint the
 * same chrome accent without going through the host at all.
 */
export function applyChromeAccent(
  light: { primary: string | null; onPrimary: string | null },
  dark: { primary: string | null; onPrimary: string | null },
): void {
  if (typeof document === 'undefined') return;
  const css = chromeBrandCss(light, dark);
  let styleEl = document.getElementById(CHROME_STYLE_ID);
  if (!css) { styleEl?.remove(); return; }
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = CHROME_STYLE_ID;
    document.head.appendChild(styleEl);
  }
  styleEl.textContent = css;
}

const FAVICON_ID = 'brand-favicon';
const LOGO_SRC = '/icons/icon-192.png'; // the green-and-white Lolly swirl (same origin)

/** HSL hue (degrees) of a #rrggbb, or null. Reuses the shell's hex→"H S% L%". */
function hexHslHue(hex: string): number | null {
  const triple = hexToHslTriple(hex);
  if (!triple) return null;
  const h = parseFloat(triple);
  return Number.isFinite(h) ? h : null;
}

/** HSL (h∈0..360, s,l∈0..1) → [r,g,b] each 0..255. */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

/**
 * Recolour the green-and-white Lolly logo bitmap to `hue` (HSL degrees, the
 * brand's main colour): every chromatic pixel keeps its OWN saturation &
 * lightness but takes the brand hue, so the swirl still reads as a glossy candy
 * in the brand colour; the white half and its anti-aliased edges are left
 * untouched. Returns a PNG data URL usable as an <img>/background AND a favicon,
 * or null if the canvas/image is unavailable. Best-effort: never throws.
 */
async function tintLogo(hue: number): Promise<string | null> {
  if (typeof document === 'undefined' || typeof Image === 'undefined') return null;
  try {
    const img = new Image();
    img.src = LOGO_SRC;
    await img.decode();
    const w = img.naturalWidth, h = img.naturalHeight;
    if (!w || !h) return null;
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, w, h); // same-origin → not tainted
    const px = data.data;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] === 0) continue; // transparent
      const r = (px[i] ?? 0) / 255, g = (px[i + 1] ?? 0) / 255, b = (px[i + 2] ?? 0) / 255;
      const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
      if (d < 0.08) continue; // white / near-grey → keep it white
      const l = (max + min) / 2;
      const s = d / (1 - Math.abs(2 * l - 1));
      const [nr, ng, nb] = hslToRgb(hue, s, l);
      px[i] = nr; px[i + 1] = ng; px[i + 2] = nb;
    }
    ctx.putImageData(data, 0, 0);
    return canvas.toDataURL('image/png');
  } catch {
    return null;
  }
}

/**
 * Paint the brand-recoloured logo everywhere it's a bitmap: the `--lolly-logo`
 * var (the Verify hero, via background-image) and the browser tab favicon (a
 * PNG <link rel=icon>, preferred over the static .ico). Null → the override is
 * removed and the default green swirl / .ico stand. Best-effort: never throws.
 */
function applyBrandLogo(dataUrl: string | null): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement.style;
  let link = document.getElementById(FAVICON_ID) as HTMLLinkElement | null;
  if (!dataUrl) {
    root.removeProperty('--lolly-logo');
    link?.remove();
    return;
  }
  root.setProperty('--lolly-logo', `url("${dataUrl}")`);
  if (!link) {
    link = document.createElement('link');
    link.id = FAVICON_ID;
    link.rel = 'icon';
    link.type = 'image/png';
    document.head.appendChild(link);
  }
  link.href = dataUrl;
}

/**
 * Resolve the brand primary per theme and inject/refresh the chrome override
 * stylesheet (appended to <head>, so it wins the tokens.css cascade at equal
 * specificity). Call at boot and again after installUserTokens — the bridge's
 * bust() empties the token caches but nothing re-paints chrome by itself.
 * Best-effort like applyBrandVars: never throws, removes the style when the
 * brand has no resolvable primary.
 */
export async function applyChromeBrandVars(host: BrandVarsHost): Promise<void> {
  // Nothing here to do without a document (a DOM-free shell / test bridge) —
  // and every branch below writes to documentElement, so bail before any of
  // them can throw a ReferenceError. This is the "never throws" contract: a
  // caller like setPrimaryFont must be able to await this unconditionally.
  if (typeof document === 'undefined') return;
  const root = document.documentElement.style;

  const resolveHex = async (slot: string, theme: string): Promise<string | null> => {
    try {
      return tokenValueToHex(await host.tokens?.resolve(`{color.semantic.${slot}}`, { theme }));
    } catch { return null; }
  };
  // Fonts and shape first, independently of the colour blocks below — a brand
  // may declare font/shape tokens without semantic colour slots (the SUSE doc)
  // or vice versa.
  await applyBrandFonts(host).catch(() => { /* never breaks boot */ });
  await applyBrandRadius(host).catch(() => { /* never breaks boot */ });
  // The warm "needs attention" accent scans every resolved colour (ramps,
  // spectrum, roles) — independent of the semantic primary/on-primary block
  // below, so it still finds SUSE's Persimmon even though that catalog
  // declares no color.semantic.* slots at all. The catch must NOT touch the
  // DOM (a resolve() rejection still leaves documentElement writable, but
  // keeping the handler pure means it can never itself throw).
  let warn: { hex: string; ink: string } | null = null;
  try {
    warn = nearestWarmHex(await host.tokens?.colors?.() ?? []);
  } catch { warn = null; }
  if (warn) {
    root.setProperty('--brand-warn', warn.hex);
    root.setProperty('--brand-warn-ink', warn.ink);
  } else {
    root.removeProperty('--brand-warn');
    root.removeProperty('--brand-warn-ink');
  }
  try {
    const [lp, lop, dp, dop] = await Promise.all([
      resolveHex('primary', 'light'), resolveHex('on-primary', 'light'),
      resolveHex('primary', 'dark'), resolveHex('on-primary', 'dark'),
    ]);
    applyChromeAccent({ primary: lp, onPrimary: lop }, { primary: dp, onPrimary: dop });
    // Expose the brand primary GLOBALLY on :root (not just the tool canvas that
    // applyBrandVars paints) so app chrome outside a tool — the gallery's
    // preview-loading trace, say — can wear it via var(--brand-primary, <fallback>).
    // Same precedent as --brand-warn above; a brand with no resolvable primary
    // (the SUSE catalog declares no semantic slots) removes it so the CSS
    // fallback stays in charge.
    if (lp) root.setProperty('--brand-primary', lp);
    else root.removeProperty('--brand-primary');
    // Recolour the actual Lolly logo bitmap to the brand's MAIN colour (the
    // chosen primary's HSL hue) and use it for the Verify hero + tab favicon.
    // Async (canvas + image load) and fire-and-forget: the chrome accent above
    // is already applied, and a null result just restores the plain green swirl.
    const primary = brandMarkPrimary(lp, dp);
    const hslHue = primary ? hexHslHue(primary) : null;
    if (hslHue == null) applyBrandLogo(null);
    else void tintLogo(hslHue).then(applyBrandLogo).catch(() => applyBrandLogo(null));
  } catch { /* cosmetic only — never break boot */ }
}

/**
 * Resolve each semantic slot and set/remove its custom property on `el`.
 * Injection rules (contract §3, identical to the CLI's applyBrandVars):
 * a resolved string passes through (hex or a raw `oklch()` string are both
 * valid CSS colours the browser resolves natively) — UNLESS it is alias
 * residue (a `{path}` that never resolved is a missing slot, not a colour);
 * a structured DTCG colour object is normalised via the engine's colorToHex
 * (null ⇒ missing slot). Missing slots remove the property.
 */
export async function applyBrandVars(el: HTMLElement, host: BrandVarsHost): Promise<void> {
  await Promise.all(SLOTS.map(async ([slot, cssVar]) => {
    let value: unknown;
    try {
      // TokenSet.resolve accepts the `{alias}` form or a bare dotted path —
      // both hit the same lookup (engine/src/tokens.ts strips the braces), so
      // the alias form alone covers both spellings.
      value = await host.tokens?.resolve(`{color.semantic.${slot}}`);
    } catch { /* no tokens / broken doc → treat the slot as missing */ }
    try {
      const css = typeof value === 'string' && value
        ? (isAlias(value) ? null : value)
        : colorToHex(value);
      if (css) el.style.setProperty(cssVar, css);
      else el.style.removeProperty(cssVar);
    } catch { /* cosmetic only — never break mounting */ }
  }));
}
