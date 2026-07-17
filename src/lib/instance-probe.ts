// SPDX-License-Identifier: MPL-2.0
/**
 * Pure helpers for components/instance-sheet.ts's connect flow — split out of
 * that module (rather than defined inline) so they stay importable with no
 * DOM/CSS/mountModal dependency: instance-sheet.ts has a top-level `import
 * '../styles/parts/instance-sheet.css'` for its dialog chrome, which a plain
 * `node --test` run can't load (unknown ".css" extension under ESM) — these
 * two have no such import, so instance-sheet.test.ts can exercise them
 * directly without pulling that in.
 */
import { normalizeInstanceBase } from './instance.ts';

export type UrlValidation = { ok: true; base: string } | { ok: false; message: string };

/** Validate + normalize a typed instance URL for display — turns
 *  normalizeInstanceBase's throw into a result the render loop can branch on
 *  without a try/catch at every call site. The message on failure is that
 *  function's own: lib/instance.ts has no i18n dependency, so its thrown
 *  strings stay untranslated — the same treatment profile.ts already gives a
 *  thrown backup-import error (err.message passed straight through). */
export function validateInstanceUrl(input: string): UrlValidation {
  try {
    return { ok: true, base: normalizeInstanceBase(input) };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

export type ProbeOutcome =
  | { ok: true; toolCount: number }
  | { ok: false; reason: 'http'; status: number }
  | { ok: false; reason: 'parse' }
  | { ok: false; reason: 'shape' };

/** Shape a fetched /catalog/tools/index.json response into a probe outcome.
 *  `body` is the already-parsed JSON (or undefined if parsing failed). Kept
 *  pure — no fetch, no i18n — so this classification and the render layer's
 *  (translated) copy for each reason stay independently testable. */
export function shapeProbeResult(status: number, ok: boolean, body: unknown): ProbeOutcome {
  if (!ok) return { ok: false, reason: 'http', status };
  if (body === undefined || body === null) return { ok: false, reason: 'parse' };
  const tools = (body as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) return { ok: false, reason: 'shape' };
  return { ok: true, toolCount: tools.length };
}
