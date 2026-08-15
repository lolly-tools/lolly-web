// SPDX-License-Identifier: MPL-2.0
/**
 * URL-space cost model — the single source of truth for "what the shareable
 * link contains and what each part costs".
 *
 * WHY THIS EXISTS. Two encoders in views/tool.ts describe the URL, and they are
 * DELIBERATELY different serializations (do not try to merge them):
 *   - buildShareParams (the SHARE link): encodeURIComponent, default-skips, strips
 *     '#' from colours, encodes blocks WITHOUT keepUserIds, parseFloat w/h.
 *   - syncUrl (the ADDRESS BAR): URLSearchParams (space->'+', '~'->%7E), no
 *     default-skip (that is shrinkUrl's separate pass), keeps '#', keepUserIds.
 * For the same state these emit different bytes, so ONE function cannot model
 * both. The budget gauge/ledger and the Share dialog are about the SHARE link —
 * the thing you copy / QR / send — so this module reproduces buildShareParams'
 * share-link serialization EXACTLY, via one per-param decision primitive
 * (encodeModelParam) that buildShareParams itself now consumes. That makes
 * "the gauge's number" and "the copied link" the same bytes by construction.
 * syncUrl / shrinkUrl are left untouched; the gauge reads THIS model, never the
 * raw address bar (plan 115 §3).
 *
 * Pure and DOM-free by design (unit-tested in url-budget.test.ts). The one thing
 * that lives in the DOM — the export-panel controls — is read once by the shell's
 * collectExportParams() and passed in as already-formed `key=value` strings.
 */

import { assetIdForUrl, blocksForUrl, isPackAvailable, isTokenValue } from '@lolly/engine';
import type { AssetRef } from '@lolly-tools/core/host-v1';
import type { InputModelItem } from '../../../../engine/src/inputs.ts';
import { encodeBlocksCompact } from './blocks-url.ts';
import { stripHiddenRowIds } from './row-id.ts';
import { asRow } from '../views/tool-types.ts';

// ── Canonical thresholds (this module OWNS them; tool.ts + share-dialog.ts import) ──
/** A single scalar value longer than this can't ride in the URL and is dropped. */
export const SCALAR_CAP = 150;
/** A blocks value whose encoded form exceeds this is dropped. */
export const BLOCKS_CAP = 8000;
/** At/above this readable length the link auto-packs (`z=`) — the pack heuristic. */
export const AUTO_PACK_MIN = 1800;
/** At/above this readable length the Share dialog warns "very long". */
export const SHARE_WARN_LEN = 2000;
/** The engine's hard reopen ceiling — MIRROR of engine/src/tool-url.ts:61 (MAX_URL,
 *  not exported). A link past this won't reopen even compressed. */
export const URL_HARD_CAP = 4096;

// ── The fidelity report (moved here from share-dialog.ts — it is a projection of
//    the cost model). Every share surface reads this one shape. ──
export interface ShareFidelity {
  /** false when anything below is non-empty — the link would silently lose content. */
  faithful: boolean;
  /** input ids whose scalar value exceeded SCALAR_CAP. */
  droppedScalars: { id: string; label: string }[];
  /** blocks inputs whose encoded form exceeded BLOCKS_CAP. */
  droppedBlocks: { id: string; label: string }[];
  /** user/* (device-local) or otherwise-unshareable asset refs a link can't carry. */
  excludedAssets: { id: string; label: string }[];
}

/** Why a param is (or isn't) in the share link. */
export type UrlCostStatus =
  | 'kept' // in the link, costs bytes
  | 'default' // equals its default/baseline, so absent from the link (0 bytes)
  | 'baseline' // equals an active template baseline (distinct from tool default, for P3)
  | 'dropped-len' // scalar over SCALAR_CAP — silently lost today, recorded here
  | 'dropped-asset' // user/* or unshareable asset — silently lost today
  | 'dropped-blocks'; // blocks over BLOCKS_CAP — silently lost today

/** One row emitted by the per-param decision primitive (byte-exact to buildShareParams). */
export interface EncodedModelParam {
  id: string; // input id (drops report against this)
  key: string; // the raw url key (urlKey alias / "id.field" for vectors)
  label: string; // input.label ?? id — for the drop report + ledger
  /** The EXACT `key=value` string buildShareParams pushes, or '' when not kept. */
  emit: string;
  status: UrlCostStatus;
  value: unknown; // current raw value (ledger Remove/Simplify need it)
  type: string; // input type (ledger Simplify needs it)
  defaultValue: unknown; // reset target
  category: 'content' | 'output'; // group:'export' input ⇒ output
}

/** A costed param row for the gauge/ledger. Superset of EncodedModelParam plus cost. */
export interface UrlParamCost {
  id: string;
  key: string;
  label: string;
  /** The exact `key=value` string in the link, or '' when not kept. */
  emit: string;
  cost: number; // bytes this row contributes to the readable query (0 if not kept)
  status: UrlCostStatus;
  source: 'model' | 'export-dom';
  category: 'content' | 'output';
  value: unknown;
  type: string;
  defaultValue: unknown;
  removable: boolean; // a model param at a non-default value the ledger can reset
  simplifiable: boolean; // a content text/number/colour the ledger can offer to shorten
}

/** Where the link is headed — sets the budget. Callers own the preset table. */
export interface UrlCostTarget {
  name: string;
  warn: number; // soft budget the gauge fills toward
  hard: number; // hard ceiling → band 'over'
}

/** The named presets (browser is the default). QR/SMS are far tighter. */
export const BROWSER_TARGET: UrlCostTarget = { name: 'browser', warn: SHARE_WARN_LEN, hard: URL_HARD_CAP };
export const QR_TARGET: UrlCostTarget = { name: 'qr', warn: 260, hard: 300 };
export const SMS_TARGET: UrlCostTarget = { name: 'sms', warn: 140, hard: 160 };
export const TARGETS: Record<string, UrlCostTarget> = { browser: BROWSER_TARGET, qr: QR_TARGET, sms: SMS_TARGET };

export type Reach = 'public' | 'trust-bounded' | 'org';

export interface UrlCostModel {
  params: UrlParamCost[]; // kept + default + dropped rows
  baseLen: number; // origin + /t/<id>? base, counted once
  readableLen: number; // FULL url: baseLen + joined query
  joinOverhead: number; // (#kept − 1) '&' chars, so Σcost + joinOverhead + baseLen == readableLen
  packable: boolean; // isPackAvailable() && readableLen >= AUTO_PACK_MIN
  packedLenEstimate: number | null; // null in the sync path; caller refines async (browser only)
  regime: 'readable' | 'packed'; // 'packed' ⇒ per-row costs are estimates, not guarantees
  fidelity: ShareFidelity; // pure projection of params[] (the dropped-* rows)
  target: UrlCostTarget;
  overBy: number; // effectiveLen − target.warn (signed; <0 = headroom)
  usedFraction: number; // effectiveLen / target.warn (may exceed 1)
  band: 'ok' | 'warn' | 'over';
  baselineId?: string; // P3: which baseline the deltas are against
  reach: Reach; // P3: who can resolve the baseline (default 'public')
  changedCount: number; // content inputs with ≥1 kept row ("changed N of M")
  totalCount: number; // content inputs total
}

// ── The per-param decision primitive — reproduces buildShareParams' input loop
//    EXACTLY (order and bytes). buildShareParams and costUrlState both call this,
//    so the copied link and the gauge never disagree. ──
export function encodeModelParam(input: InputModelItem): EncodedModelParam[] {
  const id = input.id;
  const type = input.type as string;
  const value = input.value;
  const key = input.urlKey ?? id;
  const label = input.label ?? id;
  const category: 'content' | 'output' = input.group === 'export' ? 'output' : 'content';
  const base = { id, key, label, category };
  const row = (o: Partial<EncodedModelParam>): EncodedModelParam => ({
    ...base,
    emit: '',
    status: 'default',
    value,
    type,
    defaultValue: input.default,
    ...o,
  });

  // file / table: a user's file bytes or a table object are never URL-expressible.
  // buildShareParams had no branch, so they fell through to the scalar path and stamped
  // garbage `key=%5Bobject%20Object%5D` into the link — a latent bug we fix by skipping
  // them (pinned in url-budget.test.ts). syncUrl skips 'file' too; it does NOT yet skip
  // 'table', so a table input's ADDRESS BAR still shows that garbage — a follow-up.
  if (type === 'file' || type === 'table') return [];

  if (type === 'asset') {
    // A baked ref shares as its provenance URL, never its data: bytes or dead
    // 'baked/…' id; any other ref shares by id. user/* uploads can't travel.
    const ref = value as AssetRef | null;
    const assetId = ref ? assetIdForUrl(ref) : undefined;
    if (assetId && !assetId.startsWith('user/')) {
      return [row({ status: 'kept', emit: `${encodeURIComponent(key)}=${encodeURIComponent(assetId)}` })];
    }
    if (ref) return [row({ status: 'dropped-asset' })];
    return [row({ status: 'default' })];
  }

  if (type === 'blocks') {
    if (!Array.isArray(value) || value.length === 0) return [row({ status: 'default' })];
    // Share policy: encodeBlocksCompact WITHOUT keepUserIds (never export user/ ids
    // off-device); JSON fallback when there are no fields. The cap is on the
    // pre-URL-encoded length; the emitted value is raw compact or an
    // encodeURIComponent'd JSON blob, and the KEY is pushed raw (matches tool.ts:4130).
    const compact = encodeBlocksCompact(value, input.fields ?? []);
    const encoded = compact ?? JSON.stringify(blocksForUrl(stripHiddenRowIds(value)));
    if (encoded.length > BLOCKS_CAP) return [row({ status: 'dropped-blocks' })];
    const emit = `${key}=${compact != null ? encoded : encodeURIComponent(encoded)}`;
    return [row({ status: 'kept', emit })];
  }

  if (type === 'vector') {
    // One flat param per field ("<inputId>.<fieldId>"); fields at their default are omitted.
    if (!value || typeof value !== 'object') return [];
    const vv = asRow(value);
    const out: EncodedModelParam[] = [];
    for (const f of input.fields ?? []) {
      const fv = vv[f.id];
      if (fv == null) continue;
      const atDefault = f.default !== undefined && String(fv) === String(f.default);
      out.push({
        ...base,
        key: `${key}.${f.id}`,
        emit: atDefault ? '' : `${encodeURIComponent(`${key}.${f.id}`)}=${encodeURIComponent(String(fv))}`,
        status: atDefault ? 'default' : 'kept',
        value: fv,
        type: 'vector-field',
        defaultValue: f.default,
      });
    }
    return out;
  }

  // Scalars (text/longtext/number/boolean/color/select/date/time/url/…).
  if (value == null || value === '') return [row({ status: 'default' })];
  if (typeof value === 'boolean' && !value) return [row({ status: 'default' })];

  const def = input.default;
  if (def != null && String(value) === String(def)) return [row({ status: 'default' })];

  // Token-backed colour → its canonical token ref (re-resolves against the
  // recipient's tokens; never leaks "[object Object]"). Cap is on the pre-hex-strip
  // string, matching tool.ts:4163-4168.
  let str = type === 'color' && isTokenValue(value) ? value.ref : String(value);
  if (str.length > SCALAR_CAP) return [row({ status: 'dropped-len' })];
  if (type === 'color' && str.startsWith('#')) str = str.slice(1);
  return [row({ status: 'kept', emit: `${encodeURIComponent(key)}=${encodeURIComponent(str)}` })];
}

/** Project the fidelity report out of the costed rows — one derivation, shared by
 *  costUrlState and (implicitly, via the same encodeModelParam statuses) buildShareParams. */
export function fidelityFromParams(params: UrlParamCost[]): ShareFidelity {
  const pick = (s: UrlCostStatus) =>
    params.filter((p) => p.status === s).map((p) => ({ id: p.id, label: p.label }));
  const droppedScalars = pick('dropped-len');
  const droppedBlocks = pick('dropped-blocks');
  const excludedAssets = pick('dropped-asset');
  return {
    faithful: excludedAssets.length === 0 && droppedScalars.length === 0 && droppedBlocks.length === 0,
    droppedScalars,
    droppedBlocks,
    excludedAssets,
  };
}

function costRowFromModel(p: EncodedModelParam): UrlParamCost {
  const kept = p.status === 'kept';
  return {
    id: p.id,
    key: p.key,
    label: p.label,
    emit: p.emit,
    // Dropped rows carry cost 0 — they are fidelity loss, not length; kept for the
    // ledger's red rows. Only kept rows cost bytes.
    cost: kept ? p.emit.length : 0,
    status: p.status,
    source: 'model',
    category: p.category,
    value: p.value,
    type: p.type,
    defaultValue: p.defaultValue,
    removable: kept,
    simplifiable:
      kept &&
      p.category === 'content' &&
      (p.type === 'text' || p.type === 'longtext' || p.type === 'url' || p.type === 'number' || p.type === 'color'),
  };
}

/** Parse a `key=value` (or bare-flag) export part into a costed row. */
function costRowFromExport(part: string): UrlParamCost {
  const eq = part.indexOf('=');
  const key = eq === -1 ? part : part.slice(0, eq);
  return {
    id: key,
    key,
    label: key,
    emit: part,
    cost: part.length,
    status: 'kept',
    source: 'export-dom',
    category: 'output',
    value: eq === -1 ? true : part.slice(eq + 1),
    type: 'export',
    defaultValue: undefined,
    removable: false,
    simplifiable: false,
  };
}

export interface CostInput {
  /** runtime.getModel() output — the tool's live input model. */
  model: InputModelItem[];
  /** Already-formed `key=value` (or bare-flag) strings from collectExportParams(). */
  exportParts: string[];
}

export interface CostOpts {
  /** Full-URL base incl. trailing '?' (e.g. "https://…/t/qr-code?"), for honest length. */
  base?: string;
  target?: UrlCostTarget;
  /** P3: a resolved template baseline to diff against instead of tool defaults. */
  baseline?: { id?: string; values?: Record<string, unknown>; reach?: Reach };
}

/**
 * The cost model. Pure and synchronous: packedLenEstimate is null and the caller
 * (the P1 gauge) refines it with a debounced, seq-guarded real packQuery for the
 * BROWSER target only. Never blocks a keystroke; never lies about packing.
 */
export function costUrlState(input: CostInput, opts: CostOpts = {}): UrlCostModel {
  const target = opts.target ?? BROWSER_TARGET;
  const base = opts.base ?? '';
  const reach: Reach = opts.baseline?.reach ?? 'public';

  const params: UrlParamCost[] = [];
  const changedContent = new Set<string>();
  const contentInputs = new Set<string>();

  for (const item of input.model) {
    const rows = encodeModelParam(item);
    for (const r of rows) {
      const cr = costRowFromModel(r);
      params.push(cr);
      if (cr.category === 'content') {
        contentInputs.add(cr.id);
        // "Changed" = any non-default edit, INCLUDING one a link had to drop (a long
        // value, a user/* image): the user did change it — it just can't travel — and
        // it already surfaces separately as a red fidelity row. Counting only kept rows
        // would read "changed 0 of 1" for a tool whose sole input was filled.
        if (cr.status !== 'default' && cr.status !== 'baseline') changedContent.add(cr.id);
      }
    }
  }
  for (const part of input.exportParts) params.push(costRowFromExport(part));

  // The kept rows are already in model-then-export order; their emits joined by '&'
  // ARE the exact readable query buildShareParams produces, so readableLen is truth.
  const keptEmits = params.filter((p) => p.status === 'kept').map((p) => p.emit);
  const queryStr = keptEmits.join('&');
  const joinOverhead = keptEmits.length > 0 ? keptEmits.length - 1 : 0;
  const readableLen = base.length + queryStr.length;

  const packable = isPackAvailable() && readableLen >= AUTO_PACK_MIN;
  // regime rides packable, not just the length: in a shell with no CompressionStream a
  // 2500-char link ships readable (and can blow URL_HARD_CAP), so we must NOT tell the
  // consumer "per-row costs are estimates, packing will rescue this" when it can't.
  const regime: 'readable' | 'packed' = packable ? 'packed' : 'readable';
  const packedLenEstimate: number | null = null;

  const effectiveLen = readableLen; // sync: packed length unknown until the caller refines
  const overBy = effectiveLen - target.warn;
  const usedFraction = target.warn > 0 ? effectiveLen / target.warn : 0;
  const band: 'ok' | 'warn' | 'over' =
    effectiveLen >= target.hard ? 'over' : effectiveLen >= target.warn ? 'warn' : 'ok';

  return {
    params,
    baseLen: base.length,
    readableLen,
    joinOverhead,
    packable,
    packedLenEstimate,
    regime,
    fidelity: fidelityFromParams(params),
    target,
    overBy,
    usedFraction,
    band,
    baselineId: opts.baseline?.id,
    reach,
    changedCount: changedContent.size,
    totalCount: contentInputs.size,
  };
}
