// SPDX-License-Identifier: MPL-2.0
/**
 * Preflight in the export panel — "Before you export" (plans/preflight-and-cost.md §8, phase 1).
 *
 * The engine owns the RULES (`engine/src/preflight.ts`, a pure synchronous
 * `preflight(job) -> PreflightReport`); this module owns only the two shell-side
 * halves the engine must never have: turning a report into a VIEW, and writing
 * that view into the panel's DOM. `views/tool-actions.ts` collects the facts.
 *
 * Four decisions that are load-bearing and must not erode:
 *
 * 1. **It is a statement, not a setting**, so it sits LAST in the panel, below
 *    every control it describes and immediately above the Download button. A card
 *    that appears above a control the user is still adjusting is the one that gets
 *    clicked through.
 * 2. **Collapsed by default, always** — never pre-opened on error, no dismiss
 *    control, no auto-focus, no animation, and it never gates Download. The
 *    severity rides the collapsed summary, so "1 to fix" is legible without
 *    opening and opening stays a choice the user makes for a reason. The panel's
 *    own precedent (`.export-protection`) pre-opens only for an explicitly
 *    deep-linked SETTING; a default-on state never opens anything.
 * 3. **A real `<details>`.** `parts/disclosure.css` documents why the other export
 *    cards are JS-toggled instead: they hold INPUTS whose values must survive a
 *    collapse. This card holds no fields, only reading matter, so that reason does
 *    not apply and the native element is strictly better — keyboard toggling, AT
 *    semantics and find-in-page auto-open for free, with no `aria-expanded` to
 *    keep in sync. Escape is NOT intercepted: the export popup owns Escape, and
 *    teaching the disclosure to close on it would make the user press it twice.
 * 4. **`Finding.message` is never printed here.** The engine has no `t()` and must
 *    not gain one, so its messages are the CLI/JSON English and the translation
 *    FALLBACK. The panel translates by finding `id` through {@link COPY} and
 *    re-interpolates from `evidence`. Ids not in the map fall through to the
 *    English `message` — which is the normal, documented path for a new check, not
 *    a defect.
 *
 * There is no currency, rate or price in this module, and none may be added.
 */
import { t } from '../i18n.ts';
import { escape } from '../utils.ts';
import { icon } from '../lib/icons.ts';
import { preflightGoverned } from '../lib/preflight-policy.ts';
import type { Count, Finding, PreflightReport } from '@lolly/engine';

// ─── The view model (pure — this is the tested half) ────────────────────────

/**
 * How a body row is toned.
 *
 * `gap` is its own tone, not a shade of `note`, and that distinction is the point
 * of the whole module. Every named gap carries `severity: 'info'` by the engine's
 * invariant, so toning off severity alone rendered "Lolly could not check this"
 * in exactly the same box as a measured fact — which is most of the way back to
 * omitting it. `gap` is MUTED, never warning-toned: a refusal is not a problem.
 */
export type PreflightTone = 'error' | 'warn' | 'note' | 'gap';

export interface PreflightRow {
  readonly tone: PreflightTone;
  readonly id: string;
  readonly text: string;
}

/** One label/value line. Same anatomy as the /valid view's `fact()`. */
export interface PreflightFact {
  readonly label: string;
  readonly value: string;
}

export interface PreflightView {
  /** False when the report says nothing at all: the card is not rendered. */
  readonly show: boolean;
  readonly tone: 'clean' | 'know' | 'fix';
  readonly verdict: string;
  readonly facts: readonly PreflightFact[];
  readonly rows: readonly PreflightRow[];
}

/** What the shell knows about the job that is not in the report. */
export interface PreflightContext {
  /** The format's display label (`fmtLabel`), never the raw id. */
  readonly formatLabel: string;
  /** e.g. "210 × 297 mm at 300 DPI". Empty string to omit the row. */
  readonly sizeText: string;
  /** e.g. "3 mm". Null when the job carries no bleed setting at all. */
  readonly bleedText?: string | null;
}

// ─── Copy ───────────────────────────────────────────────────────────────────

const evStr = (f: Finding, key: string): string => {
  const v = f.evidence?.[key];
  return v === null || v === undefined ? '' : String(v);
};

/**
 * The translated panel copy, keyed by finding id.
 *
 * DELIBERATELY the minimum set (plan §8 / the surface brief §3): the five
 * findings a user can act on. Every other id falls through to `finding.message`,
 * the engine's resolved English — visible, honest, and one export/import cycle
 * away from being translated if it earns it. Each entry costs a chrome string in
 * 26 locales, so a row is added here because someone argued for it.
 */
const COPY: Record<string, (f: Finding) => string> = {
  // (A) The correctness fix. A brand can declare that a spot ink IS a finish. The
  // CMYK sinks no longer give it the swatch's colour build — `FINISH_MASK_CMYK`
  // (engine/src/cmyk-palette.ts) routes every declared finish to 100% K in all four
  // of them — so these strings describe the SHIPPED behaviour, and they name the
  // defect that is actually left: overprint is implemented nowhere, so the finish
  // plate knocks out the artwork under it. Telling the user "your foil will print
  // gold" would send them to fix something that is already fixed.
  'print.finish-separates-as-ink': f => t(
    '“{name}” is a {finish} finish. Lolly writes it as its own named plate with a 100% black process fallback, and it is not overprinted, so it knocks out the artwork beneath it. Agree with your printer how they want the finish supplied before sending this.',
    { name: evStr(f, 'swatch') || evStr(f, 'spotName'), finish: evStr(f, 'finish') },
  ),
  'print.finish-flattened-into-process': f => t(
    '“{name}” is a {finish} finish, and this format has no separation plates. It is written into the process build as solid black, so it is a mask rather than a finish, and it is not overprinted. Supply the finish as its own artwork.',
    { name: evStr(f, 'swatch') || evStr(f, 'spotName'), finish: evStr(f, 'finish') },
  ),
  'print.no-bleed': () => t(
    'This is a print format with bleed set to zero. Artwork that runs to the edge will show a white sliver after trimming.',
  ),
  'print.trim-not-physical': () => t(
    'The page size is in pixels, so there is no trim size and no print area. Set the size in mm, cm or inches.',
  ),
  'plates.no-spots-declared': () => t(
    'This brand declares no spot inks, so there are no spot plates to count.',
  ),
};

/** The sentence to show for `f`: translated by id, else the engine's English. */
export function messageFor(f: Finding): string {
  const fn = COPY[f.id as string];
  if (!fn) return f.message;
  try { return fn(f); } catch { return f.message; }
}

// ─── Number formatting ──────────────────────────────────────────────────────

/** Square metres, at the precision a sheet is actually discussed in. */
const areaText = (n: number): string => {
  if (!Number.isFinite(n)) return '';
  const s = n < 1 ? n.toFixed(4) : n.toFixed(2);
  return `${s.replace(/\.?0+$/, '')} m²`;
};

const areaCount = (report: PreflightReport, box: 'trim' | 'bleed'): Count | undefined =>
  report.counts.find(c => c?.kind === 'area' && c.box === box && Number.isFinite(c.value));

/**
 * The page count, ONLY when it is exact.
 *
 * A ceiling is never promoted into a bare fact row (§6 rule 4): when the count is
 * a ceiling it stays in the body list, where the engine's own sentence still says
 * "up to". Suppressing the row costs nothing and removes the one place a bound
 * could be laundered.
 */
const exactPages = (report: PreflightReport): Count | undefined =>
  report.counts.find(c => c?.kind === 'pages' && c.bound === 'exact' && Number.isFinite(c.value));

// ─── report → view ──────────────────────────────────────────────────────────

/**
 * Turn a report into everything the card renders. Pure: no DOM, no globals
 * beyond the i18n catalog, so it is the half worth testing.
 */
export function preflightView(report: PreflightReport | null | undefined, ctx: PreflightContext): PreflightView {
  const findings: readonly Finding[] = report?.findings ?? [];
  if (!report || findings.length === 0) {
    return { show: false, tone: 'clean', verdict: '', facts: [], rows: [] };
  }

  const fix = findings.filter(f => f.severity === 'error' || f.severity === 'warn').length;
  // Counted and NOT-COUNTED are different answers and are never summed into one
  // number. A job where the palette did not resolve, the size is not physical and
  // the stage says nothing used to read "5 things to know", identically to a job
  // where five quantities were successfully measured.
  const gaps = findings.filter(f => !!f.needs).length;
  const know = findings.length - fix - gaps;

  // Facts first: the counted measurements. Counting IS the feature, so a clean
  // body is never empty — "nothing to fix" with no numbers under it would read as
  // a lint pass rather than a measurement.
  const facts: PreflightFact[] = [];
  if (ctx.formatLabel) facts.push({ label: t('Format'), value: ctx.formatLabel });
  if (ctx.sizeText)    facts.push({ label: t('Size'), value: ctx.sizeText });
  if (ctx.bleedText)   facts.push({ label: t('Bleed'), value: ctx.bleedText });

  const trim = areaCount(report, 'trim');
  const bleedArea = areaCount(report, 'bleed');
  const pages = exactPages(report);
  if (trim)      facts.push({ label: t('Trim'), value: areaText(trim.value) });
  if (bleedArea) facts.push({ label: t('With bleed'), value: areaText(bleedArea.value) });
  if (pages)     facts.push({ label: t('Pages'), value: String(pages.value) });

  // A finding whose number is already a fact row is not repeated in the list.
  // Identity, not shape: `report.counts` holds the very objects the findings
  // carry, so this can never accidentally swallow a different measurement.
  const consumed = new Set<Count>([trim, bleedArea, pages].filter(Boolean) as Count[]);

  const rows: PreflightRow[] = findings
    .filter(f => !(f.count && consumed.has(f.count)))
    .map(f => ({
      // `needs` is read FIRST: it is the honest distinction, and severity is only
      // the fallback for a finding that asserts something.
      tone: (f.needs ? 'gap' : f.severity === 'error' ? 'error' : f.severity === 'warn' ? 'warn' : 'note') as PreflightTone,
      id: String(f.id),
      text: messageFor(f),
    }));

  // The summary carries the VERDICT only; the numbers live in the body. Keeping
  // counts out of the header stops it reflowing on every keystroke, and halves
  // the plural-aware string budget.
  //
  // `refuse.output-file-size` is emitted unconditionally by the engine's registry,
  // so `gaps` is never 0 in practice and the "counted" leg is the one that can be.
  // Four strings, inside the plan's 8-12 chrome-string budget.
  const verdict = fix > 0
    ? (gaps > 0
      ? t('{fix} to fix, {gaps} not checked', { fix, gaps })
      : t('{fix} to fix, {know} to know', { fix, know }))
    : gaps > 0
      ? t('{know} counted, {gaps} not checked', { know, gaps })
      : know === 1
        ? t('One thing to know')
        : t('{n} things to know', { n: know });

  return { show: true, tone: fix > 0 ? 'fix' : 'know', verdict, facts, rows };
}

// ─── DOM ────────────────────────────────────────────────────────────────────

/**
 * The card's static markup, assembled with the rest of the panel — or '' when
 * the deployment hasn't enabled the preflight surface (see setPreflightGoverned).
 *
 * Real `<details>`/`<summary>`, reusing the shared `.section-card` box and the
 * canonical `.section-card-head`/`.section-card-icon` anatomy from
 * parts/disclosure.css. Hidden until {@link applyPreflight} has something true to
 * say, so the panel never shows a permanently empty header.
 */
export function preflightRowHtml(): string {
  // Deployment-governed, default off — see lib/preflight-policy.ts for why.
  if (!preflightGoverned()) return '';
  return `
      <details class="section-card export-preflight" data-preflight-section style="display:none">
        <summary class="section-card-head preflight-head">${icon('checklist', { className: 'section-card-icon' })}<span>${escape(t('Before you export'))}</span><span class="preflight-verdict" data-preflight-verdict></span></summary>
        <div class="preflight-body" data-preflight-body></div>
      </details>`;
}

/** The body markup for `view`. Exported for the test; escaped throughout. */
export function preflightBodyHtml(view: PreflightView): string {
  const facts = view.facts.map(f =>
    `<div class="preflight-fact"><span class="preflight-fact-label">${escape(f.label)}</span><span class="preflight-fact-value">${escape(f.value)}</span></div>`).join('');
  const rows = view.rows.length
    ? `<ul class="preflight-findings">${view.rows.map(r =>
        `<li class="preflight-finding is-${r.tone}" data-finding-id="${escape(r.id)}">${escape(r.text)}</li>`).join('')}</ul>`
    : '';
  return facts + rows;
}

/**
 * Write `view` into the panel, or hide the card when there is nothing to say.
 *
 * Never opens the card, never moves focus, never touches the Download button.
 * The open/closed state the user chose is preserved across refreshes: only the
 * summary text and the body are rewritten.
 */
export function applyPreflight(panel: Element | null | undefined, view: PreflightView): void {
  const card = panel?.querySelector<HTMLElement>('[data-preflight-section]');
  if (!card) return;
  if (!view.show) {
    card.style.display = 'none';
    card.removeAttribute('open');   // nothing to read; do not leave a stale body open
    return;
  }
  card.style.display = 'flex';
  card.dataset.tone = view.tone;
  const verdictEl = card.querySelector<HTMLElement>('[data-preflight-verdict]');
  if (verdictEl) verdictEl.textContent = view.verdict;
  const body = card.querySelector<HTMLElement>('[data-preflight-body]');
  if (body) body.innerHTML = preflightBodyHtml(view);
}
