// SPDX-License-Identifier: MPL-2.0
/**
 * The generative-AI provenance pill — shared by the catalog view, its details modal,
 * and the asset picker so they read identically. Styled by `.genai-pill` in
 * styles/parts/catalog.css (a fixed violet, deliberately brand-independent, matching the
 * /verify AI banner). One markup for both forms: the default shows the "GEN AI" text and
 * hides the sparkle; `iconOnly` (or the narrow-tile media query) collapses it to just the
 * sparkle in a circle.
 *
 * The flag reaches `ref.meta.aiGenerated` two ways: authored on a catalog entry
 * (`aiGenerated` in the asset manifest) OR auto-detected from an uploaded file's C2PA
 * content credential (bridge/assets.ts, via the engine's digitalSourceType chain).
 */

export type AiKind = 'full' | 'partial';

// A filled sparkle (big + small twinkle) — the "generative AI" glyph, matching the
// verify view's aiSpark. Only visible when the pill collapses to a circle.
const AI_SPARK_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.5l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.9z"/><path d="M19 13.5l.8 2.4 2.4.8-2.4.8-.8 2.4-.8-2.4-2.4-.8 2.4-.8z"/></svg>';

/** Read the AI-provenance flag off a resolved asset ref's meta. Returns '' when the
 *  asset carries no AI flag (authored or credential-detected). */
export function assetAiKind(ref: { meta?: Record<string, unknown> } | null | undefined): AiKind | '' {
  const v = ref?.meta?.aiGenerated;
  return v === 'full' || v === 'partial' ? v : '';
}

/** The honest claim the badge asserts. We only state that the asset IS or CONTAINS
 *  AI-generated content — the authoritative degree + provenance live in the credential,
 *  surfaced by the Verify checker (see the details "Check credentials" link). */
export const GENAI_CLAIM = 'This asset is or contains AI-generated content';

/** Render the pill. `iconOnly` forces the sparkle-in-a-circle form (used in the dense
 *  picker grid); otherwise it shows the "GEN AI" text and self-collapses on narrow tiles.
 *  `kind` (full/partial) still gates whether the badge shows, but the wording stays the
 *  same honest claim regardless — we don't over-assert the degree from a badge. */
export function genAiPill(_kind: AiKind, iconOnly = false): string {
  return `<span class="genai-pill${iconOnly ? ' genai-pill--icon' : ''}" title="${GENAI_CLAIM}">${AI_SPARK_ICON}<span class="genai-pill-lbl">Gen AI</span></span>`;
}
