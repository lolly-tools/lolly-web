// SPDX-License-Identifier: MPL-2.0
/**
 * /valid — on-device Content Credentials check.
 *
 * Drop any stamped export (pdf, png/apng, jpg, gif, svg, tiff, webp, mp4,
 * webm) and the engine verifier (engine/src/c2pa-verify.js) re-checks the
 * credential the export pipeline embeds: assertion hashed-URIs, the COSE claim
 * signature, the certificate window and the hard binding. Nothing leaves the
 * device. When a Lolly CA root is pinned (src/ca-root.js) it is passed as a
 * trust anchor, so a signing chain that verifies against it upgrades the
 * result to a CA-verified identity — "signed by <email>"; otherwise a green
 * result means "the file is exactly what its credential signed" — integrity,
 * not identity. Check codes mirror c2patool /
 * verify.contentauthenticity.org so the two reports read side-by-side.
 *
 * The headline answer is the one users actually ask for: was this genuinely
 * made with Lolly? When the credential is intact AND records Lolly, the hero
 * flips to the "Made with Lolly" callout and surfaces the export context the
 * writer recorded (tool, author from the profile, browser engine, OS).
 *
 * Shares the platform/capabilities `.plat-*` chrome so it reads as a sibling
 * dashboard; the CLI exposes the same engine verifier as `validate <file>`.
 */

import '../styles/parts/valid.css';   // async CSS chunk (lazy view — not on the landing)
import { verifyC2pa, verifySeal, pemToDer, c2paTrustAnchors, extractFileMetadata, META_GROUP_ORDER, META_GROUP_LABEL, stripMetadata, isStrippableFormat, detectWatermark, detectWatermarkSearch, analyzeLsb, isPptx, pptxMediaImages } from '@lolly/engine';
import type { FileMetadata, MetaGroup, StripFormat, SealVerifyResult } from '@lolly/engine';
import { looksLikePptxFile, inflatePptx, PPTX_MIME } from '../bridge/pptx.ts';
import { resolveSealKey } from '../lib/seal-dns.ts';
import { WORLD_VIEWBOX, WORLD_LAND_PATH, projectLatLon } from './world-map.ts';
import { CA_ROOT_PEM } from '../ca-root.ts';
import { escape } from '../utils.ts';
// Aliased (not `icon`) — this file has function parameters named `icon` (fact(),
// the change-history `section` builder) that would otherwise shadow the import.
import { icon as glyph, type IconName } from '../lib/icons.ts';
import { t } from '../i18n.ts';
import { armViewEnter } from '../view-enter.ts';
import { playSfx } from '../lib/sfx.ts';
import { takePendingVerify } from '../lib/verify-handoff.ts';
import { langFabHtml, attachLangMenu } from '../components/lang-menu.ts';
import type { HostV1 } from '../../../../engine/src/bridge/host-v1.ts';

// Local mirror of the engine verifier's report shape (c2pa-verify's C2paReport
// is not re-exported through the barrel). Structural — the awaited result of
// verifyC2pa() is assignable to it.
interface Check { code: string; ok: boolean; explanation: string; }
interface SignerIdentity { email: string | null; issuer: string | undefined; }
interface Signer {
  commonName: string | undefined;
  organization: string | undefined;
  notBefore: string;
  notAfter: string;
  selfSigned: boolean;
  alg: string;
  identity?: SignerIdentity;
}
interface Claim {
  title: unknown;
  format: unknown;
  claimGenerator: unknown;
  generatorInfo: Record<string, string | number | boolean> | null;
  instanceId: unknown;
  manifestLabel: string;
  actions: Array<{ action: unknown; when: unknown; softwareAgent: unknown; digitalSourceType?: unknown; description?: unknown }>;
}
interface VerifyReport {
  found: boolean;
  state: 'valid' | 'invalid' | 'none';
  trusted: boolean;
  madeWithLolly: boolean;
  likelyMadeWithLolly: boolean;
  partsMadeWithLolly: boolean;
  delivered: boolean;
  format: string | null;
  checks: Check[];
  reason?: string;
  claim?: Claim;
  environment?: (Record<string, string | number | boolean> & { inputs?: Record<string, string> }) | null;
  author?: { name: string; email?: string };
  signer?: Signer;
  aiGenerated?: { kind: 'generated' | 'composite'; sourceType: string };
  history?: Array<{ action: unknown; when: unknown; softwareAgent: unknown; digitalSourceType?: unknown; description?: unknown; generator?: unknown }>;
}

// The pixel-watermark detection result (engine detectWatermark), surfaced only
// when present — a durable, lower-confidence provenance signal that lives in the
// pixels rather than the C2PA metadata container.
interface Watermark {
  present: boolean;
  score: number;
  // Set when the mark was found INSIDE a container file's embedded raster
  // (a .pptx slide image, a PDF image XObject) rather than in the dropped file's
  // own pixels — the note/pip wording changes to say so.
  embedded?: boolean;
}

// Trust anchors: the pinned Lolly CA root (identity for Lolly-signed assets)
// plus the vendored C2PA trust list (Google/Gemini, the camera makers, Bria,
// …), so a credential from a recognised signer upgrades from "valid" to a
// named, CA-verified identity — "signed by <issuer>". A self-signed on-device
// export still reads as intact-but-untrusted (it chains to none of these).
const VERIFY_OPTS: { trustAnchors: Uint8Array[] } = {
  trustAnchors: [
    ...(CA_ROOT_PEM ? [pemToDer(CA_ROOT_PEM)] : []),
    ...c2paTrustAnchors(),
  ],
};

// Verification reads the WHOLE file into memory (and the PDF extractor makes a
// byte-transparent string copy on top), so bound what a drop can pull in. Far
// above any real credentialed asset; a multi-GB drop must fail with a message,
// not an OOM'd tab.
const MAX_VERIFY_BYTES = 256 * 1024 * 1024;

// Path data for all of these (including 'shield'/'chevronDown' below) lives in
// lib/icons.ts — the shared registry (see plans/component-audit.md rec 5).
// 'globe', 'calendar', 'package' and 'image' are deduped there against
// near-identical glyphs from catalog-summary.ts/category-icons.ts/profile.ts.
const ICON_SHIELD = glyph('shield');
const ICON_CHEVRON = glyph('chevronDown');

// Small line icons, wrapped consistently — shared by the hero check scorecard
// and the per-fact <dt> labels. /valid's icons are a hair thinner (1.9) than
// the registry default (2).
const svgIcon = (name: IconName): string => glyph(name, { strokeWidth: 1.9 });
const STATUS_WORD = { pass: 'passed', fail: 'failed', warn: 'invalid', na: 'n/a' };

const STATE_COPY = {
  valid: {
    cls: 'is-valid',
    title: 'Credential intact',
    sub: 'The file is exactly what its embedded credential signed. Signed with an on-device key — integrity, not identity.',
  },
  invalid: {
    cls: 'is-invalid',
    title: 'Credential broken',
    sub: 'The file carries Content Credentials, but they no longer match its bytes — it was modified after signing, or the credential is damaged.',
  },
  none: {
    cls: 'is-none',
    title: 'No Content Credentials',
    sub: 'This file carries no C2PA manifest. It was still inspected on-device for a Lolly Imprint, embedded metadata and hidden data.',
  },
  // state 'valid' + the signing chain verifies against the pinned Lolly CA
  // root: integrity plus a CA-verified signer identity. What was made — and
  // with which app — remains the signer’s own claim.
  trusted: {
    cls: 'is-valid is-trusted',
    title: 'Verified',
    sub: 'The file is exactly what its embedded credential signed, and the signing certificate chains to the pinned Lolly CA root — integrity plus a CA-verified identity. What it records about how it was made is still the signer’s own claim.',
  },
  // state 'valid' + the claim records Lolly → the answer users came for.
  lolly: {
    cls: 'is-valid is-lolly',
    title: 'Made with Lolly',
    sub: 'The credential is intact and records a Lolly export — the file has not changed since it was made. (Integrity plus the maker’s claim; an on-device key, not a CA identity.)',
  },
  // state 'valid' + trusted + a c2pa.published (not created) action: an existing
  // asset Lolly distributes but did not author. Honest journey — verified
  // authentic, delivered by Lolly, made by someone else (shown below).
  delivered: {
    cls: 'is-valid is-delivered',
    title: 'Delivered by Lolly',
    sub: 'This is the genuine official version, delivered by Lolly. The credential chains to the pinned Lolly CA root, so the file is intact and its origin is CA-verified. Lolly delivered this asset — it did not create it; who made it is recorded below as the signer’s own claim.',
  },
  // Every check passed EXCEPT the cert validity window: the bytes still match
  // what was signed — saying "modified after signing" here would be false.
  expired: {
    cls: 'is-none is-expired',
    title: 'Credential expired',
    sub: 'The file still matches exactly what its credential signed — nothing was modified — but the signing certificate (a short-lived on-device key; the lifetime is picked at export) has lapsed, so the credential no longer validates.',
  },
  // state 'invalid', but ONLY the hard binding (the file's own bytes) failed —
  // the claim signature and every hashed-URI-bound assertion (the actions and
  // export context this page shows as edit history / "made from") checked out,
  // and the claim records a Lolly creation. A softer, honest middle ground
  // between the flat "Made with Lolly" and "Credential broken".
  likelyLolly: {
    cls: 'is-none is-likelylolly',
    title: 'Likely made with Lolly',
    sub: 'The credential’s own content checks out — its signature is valid and everything it references matches — and it records a Lolly export, but the file’s bytes no longer match the hard binding, so this exact copy can’t be vouched for. It was probably re-saved, re-encoded, or re-uploaded through something that left the manifest alone.',
  },
};

// True when the ONLY failure (beyond the always-present untrusted marker) is
// the certificate validity window.
function isExpiredOnly(report: VerifyReport): boolean {
  const fails = report.checks.filter((c) => !c.ok && c.code !== 'signingCredential.untrusted');
  return fails.length === 1 && fails[0]!.code === 'signingCredential.expired';
}

// The untrusted marker is the designed posture, not damage — render it as an
// informational row, never as a failure.
const isExpectedRow = (c: Check): boolean => c.code === 'signingCredential.untrusted';

// Eight canonical C2PA checks for the hero scorecard. The verifier emits a
// variable number of rows (one hashed-URI per assertion, trusted vs untrusted,
// …); this collapses them onto a stable eight so the hero reads as a consistent
// glance, with each pip's state (pass / fail / warn / not-applicable) derived
// from the actual rows — never hard-coded.
interface ScorecardItem { icon: IconName; label: string; status: keyof typeof STATUS_WORD; hideStatus?: boolean; ash?: boolean; statusWord?: string; }
// A pip's status word: the shared pass/fail vocabulary unless the item carries
// its own (the Lolly Imprint says "detected" — presence, not a graded check).
const pipStatusWord = (it: ScorecardItem): string => it.statusWord ?? t(STATUS_WORD[it.status]);
function scorecardModel(report: VerifyReport, watermark?: Watermark, extra: ScorecardItem[] = []): ScorecardItem[] {
  const cs = report.checks || [];
  const okRow = (code: string): boolean => cs.some((c) => c.ok && c.code === code);
  const badRow = (...codes: string[]): boolean => cs.some((c) => !c.ok && !isExpectedRow(c) && codes.includes(c.code));
  const present = (code: string): boolean => cs.some((c) => c.code === code);
  const found = !!report.found;
  const na = 'na';

  const readable = present('credential.unreadable') ? 'fail' : found ? 'pass' : na;
  const assertions = badRow('assertion.hashedURI.mismatch', 'assertion.missing') ? 'fail'
    : okRow('assertion.hashedURI.match') ? 'pass' : na;
  const signature = badRow('claimSignature.mismatch') ? 'fail' : okRow('claimSignature.validated') ? 'pass' : na;
  const validity = present('signingCredential.expired') ? 'warn' : okRow('claimSignature.insideValidity') ? 'pass' : na;
  const binding = badRow('assertion.dataHash.mismatch', 'assertion.bmffHash.mismatch') ? 'fail'
    : (okRow('assertion.dataHash.match') || okRow('assertion.bmffHash.match')) ? 'pass' : na;
  const trust = okRow('signingCredential.trusted') ? 'pass'
    : (report.signer?.identity && present('signingCredential.expired')) ? 'warn' : na;
  const lollyMade = !!report.madeWithLolly;
  const lollyLikely = !!report.likelyMadeWithLolly;
  const lollyParts = !!report.partsMadeWithLolly;

  return [
    // Yes/no, not a graded check: "Made with Lolly" (green tick), a "Likely"
    // amber middle ground (manifest content checks out, file bytes don't), or
    // a plain "Not made with Lolly" — none of these show a status pill, "not
    // applicable"/"invalid" would misword the amber and grey cases.
    {
      icon: 'lollipop',
      label: lollyMade ? t('Made with Lolly') : lollyLikely ? t('Likely made with Lolly')
        : lollyParts ? t('Parts made with Lolly') : t('Not made with Lolly'),
      status: lollyMade ? 'pass' : (lollyLikely || lollyParts) ? 'warn' : na,
      hideStatus: !lollyMade,
    },
    // The Lolly Imprint — detected in the pixels ON this device, so it earns a
    // real pass pip, seated right beside the Made-with-Lolly verdict it backs.
    // Present ONLY when found: absence is uninformative (resize erases it;
    // non-Lolly rasters never carry it), so there is no fail/na state.
    ...(watermark?.present ? [{ icon: 'imprint' as IconName, label: t('Lolly Imprint'), status: 'pass' as const, statusWord: watermark.embedded ? t('in an image') : t('detected') }] : []),
    // Extra signal pips, seated up top with the other watermark facts: the
    // SynthID/Meta likelihood pip (aiMarkPip) and the steganalysis heuristics
    // (stegoPips) — built by the caller so both scorecards stay in sync.
    ...extra,
    { icon: 'document', label: t('Manifest found'), status: found ? 'pass' : na },
    { icon: 'eye', label: t('Manifest readable'), status: readable },
    { icon: 'link', label: t('Assertions bound to the claim'), status: assertions },
    { icon: 'pen', label: t('Claim signature valid'), status: signature },
    { icon: 'clock', label: t('Certificate within validity'), status: validity },
    { icon: 'hash', label: t('File bytes match (hard binding)'), status: binding },
    // "Signer identity" has no CA answer when the file was signed with a
    // self-signed on-device key — so say that plainly (dark-ash card) rather
    // than a bare "not applicable".
    (trust === 'na' && report.signer?.selfSigned
      ? { icon: 'cpu', label: t('Signed with an on-device key'), status: na, hideStatus: true, ash: true }
      : { icon: 'userCheck', label: t('Signer identity (CA-verified)'), status: trust }),
  ];
}

// One scorecard pip's markup — factored out of scorecardHtml so the
// deep-scan click handler (mountValid) can append a freshly-found TrustMark
// pip to a LIVE `<ul class="valid-score">` after the fact, using the exact
// same template rather than re-rendering (and losing scroll/expand state)
// on the whole report.
function scorecardPipHtml(it: ScorecardItem, i: number): string {
  return `<li class="valid-score-pip is-${it.status}${it.ash ? ' is-ash' : ''}" style="--i:${i}" aria-label="${escape(it.label)}${it.hideStatus ? '' : `: ${escape(pipStatusWord(it))}`}">` +
      `<span class="valid-score-ic" aria-hidden="true">${svgIcon(it.icon)}</span>` +
      `<span class="valid-score-label" aria-hidden="true">${escape(it.label)}</span>` +
      (it.hideStatus ? '' : `<span class="valid-score-status" aria-hidden="true">${escape(pipStatusWord(it))}</span>`) +
    `</li>`;
}

// The compact, icon-only pip the mini scorecard uses in a collapsed report row.
// Shared by miniScoreHtml and injectDeepScanPip so a passively-found deep-scan
// pip matches the rest of the mini row exactly.
function miniScorePipHtml(it: ScorecardItem): string {
  return `<li class="valid-score-pip is-${it.status}${it.ash ? ' is-ash' : ''}" title="${escape(it.label)}${it.hideStatus ? '' : `: ${escape(pipStatusWord(it))}`}"><span class="valid-score-ic">${svgIcon(it.icon)}</span></li>`;
}

function scorecardHtml(report: VerifyReport, watermark?: Watermark, extra?: ScorecardItem[]): string {
  return `<ul class="valid-score" aria-label="${escape(t('Verification checks at a glance'))}">${scorecardModel(report, watermark, extra).map(scorecardPipHtml).join('')}</ul>`;
}

function checkRow(c: Check, i = 0): string {
  const cls = c.ok ? 'ok' : isExpectedRow(c) ? 'info' : 'bad';
  const mark = c.ok ? '✓' : isExpectedRow(c) ? 'ℹ' : '✕';
  return `
    <li class="valid-check valid-check--${cls}" style="--i:${i}">
      <span class="valid-check-mark" aria-hidden="true">${mark}</span>
      <span class="valid-check-text"><code>${escape(c.code)}</code><span>${escape(c.explanation)}</span></span>
    </li>`;
}

function fact(label: string, value: unknown, icon: IconName): string {
  if (value == null || value === '') return '';
  return `<div class="valid-fact"><dt><span class="valid-fact-ic" aria-hidden="true">${svgIcon(icon)}</span><span>${escape(label)}</span></dt><dd>${escape(String(value))}</dd></div>`;
}

// The scalar-input digest recorded by the writer's tools.lolly.export assertion
// (env.inputs) — "what this was made from": the colours, sizes, toggles and short
// text the tool rendered with. Boxed as its own panel (matching change-history/
// assertion-log) and placed ABOVE change history so an inspected asset tells its
// "what it's made from" story before its "what happened to it" story. Empty in →
// nothing rendered (so panelsBlock silently drops this column when there's no digest).
// `recreate` (the /verify path only — the catalog/gallery callers pass none) adds
// the "Recreate with these settings" CTA: the anchor's plain href opens a blank
// session as the fallback; mountValid's delegated [data-recreate] handler upgrades
// the click into a digest-seeded link (lib/seed-url.ts). Settings-honest wording:
// the digest is scalar-only, so this reopens the recorded settings, not a clone.
export function inputsDigestHtml(
  inputs: Record<string, string> | undefined,
  recreate?: { toolId: string; toolName: string; fileIndex: number },
): string {
  const entries = inputs ? Object.entries(inputs).filter(([, v]) => v != null && v !== '') : [];
  if (!entries.length) return '';
  const isColor = (v: string): boolean => /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v.trim());
  const rows = entries.map(([k, v]) => {
    const sw = isColor(v) ? `<span class="valid-input-swatch" style="background:${escape(v)}" aria-hidden="true"></span>` : '';
    return `<div class="valid-input-row"><dt>${escape(k)}</dt><dd>${sw}<span>${escape(v)}</span></dd></div>`;
  }).join('');
  const cta = recreate ? `
      <a class="btn valid-recreate" style="margin-top:.65rem" href="#/tool/${escape(recreate.toolId)}"
         data-recreate="${recreate.fileIndex}" data-recreate-tool="${escape(recreate.toolId)}">${t('Recreate with these settings in {tool}', { tool: escape(recreate.toolName) })}</a>` : '';
  return `
    <div class="valid-inputs valid-panel">
      <h3>${svgIcon('sparkle')}<span>${t('Made from')}</span></h3>
      <dl class="valid-input-list">${rows}</dl>${cta}
    </div>`;
}

// "Recreate in <tool>": env.tool records the tool's display NAME (the id only as
// a fallback — engine/src/metadata.ts), and in whatever language the EXPORTER ran;
// resolve it back to a live tool id against the loaded tool index by matching id,
// name, and every i18n sidecar name, case-insensitively. No index yet, or no match
// (a retired or foreign tool) → undefined and the CTA simply isn't offered.
function resolveRecreateTool(recorded: unknown): { toolId: string; toolName: string } | undefined {
  const wanted = typeof recorded === 'string' ? recorded.trim().toLowerCase() : '';
  if (!wanted) return undefined;
  for (const tool of window.__toolIndex?.tools ?? []) {
    const i18nNames = Object.values((tool.i18n ?? {}) as Record<string, { name?: unknown } | undefined>).map((o) => o?.name);
    const names = [tool.id, tool.name, ...i18nNames];
    if (names.some((n) => typeof n === 'string' && n.trim().toLowerCase() === wanted)) {
      return { toolId: tool.id, toolName: typeof tool.name === 'string' && tool.name ? tool.name : tool.id };
    }
  }
  return undefined;
}

// The "checked on this device" footnote, wrapped as a professional callout: a
// lock chip (privacy — nothing left the device) beside the explanatory prose.
const deviceNote = (inner: string): string =>
  `<div class="valid-note">
    <span class="valid-note-ic" aria-hidden="true">${svgIcon('lock')}</span>
    <p class="valid-note-body">${inner}</p>
  </div>`;

// "You made this here" — the checked bytes hash-match an entry in this device's
// own export history (lib/export-history.ts contentHash), so beyond anything the
// credential claims we KNOW this exact file left this browser, and can reopen the
// tool with the exact state it was downloaded with (the entry's reopen query).
// Local knowledge only — independent of (and shown regardless of) the C2PA verdict.
interface LocalExportMatch { href: string; at: number }
const mineNote = (mine: LocalExportMatch): string =>
  `<div class="valid-note valid-note--mine">
    <span class="valid-note-ic" aria-hidden="true">${svgIcon('userCheck')}</span>
    <p class="valid-note-body">${t('<strong>You made this here.</strong> This exact file matches one you exported on this device ({when}).', { when: escape(fmtDate(mine.at)) })} <a href="${escape(mine.href)}">${t('Reopen it exactly as it was')}</a></p>
  </div>`;

const fmtDate = (iso: unknown): string => {
  const d = new Date(iso as string | number | Date);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};

interface ResolvedState {
  state: (typeof STATE_COPY)[keyof typeof STATE_COPY];
  sub: string;
  identity: SignerIdentity | undefined;
}
// Resolve the hero state (which STATE_COPY entry it maps to) and the occasionally
// reworded sub-line. Shared by the full report body AND the collapsed summary so the
// two never disagree on the headline. Defence in depth: a green "trusted" hero must
// never outrank a broken credential — the engine only sets report.trusted when the
// file is intact, but the view never trusts that invariant blind, so an invalid file
// always resolves to its failure state whatever `trusted` says.
function resolveState(report: VerifyReport): ResolvedState {
  const trusted = report.trusted && report.state === 'valid';
  const state = report.madeWithLolly ? STATE_COPY.lolly
    : trusted && report.delivered ? STATE_COPY.delivered
    : trusted ? STATE_COPY.trusted
    : report.state === 'invalid' && report.likelyMadeWithLolly ? STATE_COPY.likelyLolly
    : report.state === 'invalid' && isExpiredOnly(report) ? STATE_COPY.expired
    : (STATE_COPY[report.state] ?? STATE_COPY.none);
  // Set only when the signing chain verified against the pinned root: a still-valid
  // cert (report.trusted true) or an anchored-but-expired one (identity CA-verified,
  // signing time unprovable).
  const identity = report.signer?.identity;
  // Two subs would lie once a chain verifies against the anchor: the lolly one claims
  // "an on-device key, not a CA identity" and the expired one blames "a one-year
  // on-device key". Swap the wording, keep the state.
  // The default trusted copy is Lolly-specific ("the pinned Lolly CA root"),
  // which is wrong for a third-party signer (Google, Adobe, Microsoft…). When
  // the chain verified against a NON-Lolly anchor, name the actual root and the
  // signer's organisation instead. Delivered/lolly stay Lolly-worded (they ARE
  // Lolly). signerOrg comes from the CA-verified cert — only used once trusted.
  const signerOrg = report.signer?.organization || report.signer?.commonName;
  const thirdPartyRoot = !!identity?.issuer && !/\blolly\b/i.test(identity.issuer);
  // NB: `sub` is rendered as raw HTML (so the signer/anchor names can be <strong>).
  // The static STATE_COPY subs carry no HTML metacharacters; any cert-derived value
  // interpolated here (issuer, signerOrg) MUST be escape()'d — it is attacker-controlled.
  const sub = state === STATE_COPY.lolly && report.trusted
    ? t('The credential is intact and records a Lolly export — the file has not changed since it was made. (Integrity plus the maker’s claim, signed under a CA-verified identity.)')
    : state === STATE_COPY.expired && identity
      ? t('The file still matches exactly what its credential signed — nothing was modified — but the short-lived signing certificate has expired, so the credential no longer validates. Without a trusted timestamp the time of signing cannot be proven.')
      : state === STATE_COPY.trusted && thirdPartyRoot
        ? t('The file is exactly what its embedded credential signed, and the signing certificate chains to <strong>{issuer}</strong> — a recognised C2PA trust anchor{signer}. Integrity plus a CA-verified identity; what it records about how it was made is still the signer’s own claim.', {
            issuer: escape(identity!.issuer!),
            signer: signerOrg ? t(', identifying the signer as <strong>{org}</strong>', { org: escape(signerOrg) }) : '',
          })
        : t(state.sub);
  return { state, sub, identity };
}

// A single tone for the collapsed summary's badge / card stripe. good = intact
// (valid / lolly / trusted / delivered), warn = expired-only, bad = broken, none
// = no credential.
function stateTone(report: VerifyReport): 'good' | 'bad' | 'warn' | 'none' {
  const { state } = resolveState(report);
  if (state === STATE_COPY.invalid) return 'bad';
  if (state === STATE_COPY.expired || state === STATE_COPY.likelyLolly) return 'warn';
  if (state === STATE_COPY.none) return 'none';
  return 'good';
}

// Icon-only mirror of the hero scorecard for the collapsed summary — the "highlights
// showing when collapsed". Same eight pips, same colour = state, label as a tooltip.
function miniScoreHtml(report: VerifyReport, watermark?: Watermark, extra?: ScorecardItem[]): string {
  if (!report.found && !watermark?.present && !extra?.length) return '';
  return `<ul class="valid-score valid-score--mini" aria-hidden="true">${scorecardModel(report, watermark, extra).map(miniScorePipHtml).join('')}</ul>`;
}

// The always-visible summary row of a collapsible report: state badge, filename,
// signer identity (when CA-verified), and the mini scorecard glance.
// The maker(s) behind a report — the active manifest's generator first, then any
// distinct upstream makers from the provenance chain (preserved ingredients),
// as short brand names. `lolly` when Lolly is anywhere in the mix. null when the
// generator can't be read.
function reportMaker(report: VerifyReport): { names: string[]; lolly: boolean } | null {
  const gi = report.claim?.generatorInfo;
  const primaryRaw = (gi && typeof gi.name === 'string' && gi.name)
    || (typeof report.claim?.claimGenerator === 'string' && report.claim.claimGenerator) || '';
  const primary = primaryRaw ? shortAgent(String(primaryRaw)) : (report.madeWithLolly ? 'Lolly' : '');
  if (!primary) return null;
  const names = [primary];
  const seen = new Set([primary.toLowerCase()]);
  for (const s of report.history ?? []) {
    const raw = (typeof s.softwareAgent === 'string' && s.softwareAgent)
      || (typeof s.generator === 'string' && s.generator) || '';
    if (!raw) continue;
    const v = shortAgent(String(raw));
    if (!seen.has(v.toLowerCase())) { seen.add(v.toLowerCase()); names.push(v); }
  }
  return { names, lolly: report.madeWithLolly || names.some((n) => /lolly/i.test(n)) };
}

function summaryInner(fileName: string, report: VerifyReport, meta?: FileMetadata, watermark?: Watermark, seal?: SealVerifyResult): string {
  const { state, identity } = resolveState(report);
  // Attribution chip: OIDC email for a device credential, else the CA signer's
  // organisation (Google, Adobe…). Only when the chain reached a pinned anchor.
  const who = identity ? (identity.email || report.signer?.organization || report.signer?.commonName) : null;
  const tone = stateTone(report);
  const maker = reportMaker(report);
  // An intact credential leads with WHO made it — "Made with Google" (grey),
  // "Made with Lolly" (green), several vendors joined when a chain preserved
  // ingredients — matching the timeline's maker pills. A broken / expired / no-
  // credential file leads with the verdict badge instead: the problem is the
  // headline, and its maker isn't something to vouch for.
  const lead = (tone === 'good' && maker)
    ? `<span class="valid-item-maker ${maker.lolly ? 'is-lolly' : 'is-other'}" title="${escape(t(state.title))}">${t('Made with {names}', { names: escape(maker.names.join(' · ')) })}</span>`
    : `<span class="valid-item-badge is-${tone}">${escape(t(state.title))}</span>`;
  const aiDecl = report.aiGenerated ? t('Content Credential declares AI-generated content')
    : meta?.ai ? t('Embedded metadata declares AI-generated content') : null;
  const { origin, makerHint } = deriveAi(report, meta);
  const isVideo = PREVIEW_VID.has((report.format || fileName.split('.').pop() || '').toLowerCase());
  return `
    ${lead}
    ${aiDecl ? `<span class="valid-item-ai" title="${escape(aiDecl)}">${svgIcon('aiSpark')}<span>${t('AI')}</span></span>` : ''}
    <span class="valid-item-name">${escape(fileName)}${report.format ? ` <span class="valid-fmt">${escape(report.format)}</span>` : ''}</span>
    ${who ? `<span class="valid-item-signer" title="${escape(t('Signed by {who}', { who }))}">${svgIcon('mail')}<span>${escape(who)}</span></span>` : ''}
    ${miniScoreHtml(report, watermark, [...extraPips(origin, makerHint, isVideo, meta), ...(sealPip(seal) ? [sealPip(seal)!] : [])])}
    <span class="valid-item-chev" aria-hidden="true">${ICON_CHEVRON}</span>`;
}

// Which glyph heads each metadata section.
const META_GROUP_ICON: Record<MetaGroup, IconName> = {
  location: 'mapPin', device: 'cpu', capture: 'camera', software: 'tool',
  authorship: 'user', timestamps: 'calendar', description: 'document', technical: 'hash',
};

// An offline world locator: the photo's GPS fix plotted on an embedded land
// outline (no tile server — the coordinates never leave the device). Rendered
// full-width above the sections when a file records a position.
function renderLocator(lat: number, lon: number): string {
  const { x, y } = projectLatLon(lat, lon);
  return `<svg class="valid-locator" viewBox="${WORLD_VIEWBOX}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${escape(t('World map with a pin at the recorded location'))}">
      <rect class="valid-locator-sea" x="151.67" y="242.58" width="656.66" height="288.84" rx="7"/>
      <path class="valid-locator-land" d="${WORLD_LAND_PATH}"/>
      <g class="valid-locator-pin" transform="translate(${x.toFixed(1)} ${y.toFixed(1)})">
        <path class="valid-locator-tick" d="M0,-15V-7 M0,7V15 M-15,0H-7 M7,0H15"/>
        <circle class="valid-locator-halo" r="9"/>
        <circle class="valid-locator-dot" r="3"/>
      </g>
    </svg>`;
}

// The embedded-metadata reveal — everything the file discloses about the device,
// place, person, and software behind it, read on-device from its own bytes and
// laid out clinically by section. Independent of the C2PA verdict: a file with no
// credential can still be dense with EXIF. Empty in → nothing rendered.
function renderMetadata(meta: FileMetadata | undefined, preview: Preview | undefined, fileIndex: number): string {
  if (!meta || !meta.fields.length) return '';
  const loc = meta.fields.filter((f) => f.group === 'location');
  const groups = META_GROUP_ORDER
    .filter((g) => g !== 'location')
    .map((g) => ({ g, items: meta.fields.filter((f) => f.group === g) }))
    .filter((x) => x.items.length);
  const sensitive = meta.fields.some((f) => f.sensitive);
  const n = meta.fields.length;
  const section = (g: MetaGroup, label: string, icon: IconName, rows: string): string => `
    <section class="valid-meta-group${g === 'description' ? ' valid-meta-group--desc' : ''}">
      <h4>${svgIcon(icon)}<span>${escape(label)}</span></h4>
      <dl>${rows}</dl>
    </section>`;
  const row = (f: { label: string; value: string; sensitive?: boolean }): string =>
    `<div class="valid-meta-row${f.sensitive ? ' is-sensitive' : ''}"><dt>${escape(f.label)}</dt><dd>${escape(f.value)}</dd></div>`;
  const locationBlock = meta.gps ? `
    <section class="valid-meta-location">
      <h4>${svgIcon('mapPin')}<span>${t('Location')}</span></h4>
      ${renderLocator(meta.gps.lat, meta.gps.lon)}
      <div class="valid-meta-loc-read">
        ${loc.map((f) => `<span class="valid-meta-loc-item"><span class="k">${escape(f.label)}</span><span class="v">${escape(f.value)}</span></span>`).join('')}
        ${meta.mapUrl ? `<a class="valid-meta-map" href="${escape(meta.mapUrl)}" target="_blank" rel="noopener noreferrer">OpenStreetMap ↗</a>` : ''}
      </div>
    </section>` : '';
  return `
    <section class="valid-meta">
      <div class="valid-meta-head">
        <h3>${svgIcon('eye')}<span>${t('Embedded metadata')}</span></h3>
        <span class="valid-meta-count">${n === 1 ? t('1 field') : t('{n} fields', { n })}${meta.format ? ` · ${escape(meta.format)}` : ''}</span>
      </div>
      ${mediaPreviewHtml(preview, 'sm')}
      <p class="valid-meta-note">${t("Read on this device from the file's own bytes — the EXIF, XMP and container data it carries wherever it travels.")}${sensitive ? ` ${t('Values that can identify a person, place or device are marked.')}` : ''} ${isStrippableFormat(meta.format)
    ? t('{button} or use the {link} tool for more control.', {
        button: `<button type="button" class="valid-clean-link" data-clean-copy="${fileIndex}" data-clean-format="${escape(meta.format)}">${t('Download a cleaned copy')}</button>`,
        link: `<a href="#/tool/strip-data">${t('Hidden Data')}</a>`,
      })
    : t('Remove it with the {link} tool.', { link: `<a href="#/tool/strip-data">${t('Hidden Data')}</a>` })}</p>
      <div class="valid-meta-grid">
        ${locationBlock}
        ${groups.map((x) => section(x.g, t(META_GROUP_LABEL[x.g]), META_GROUP_ICON[x.g], x.items.map(row).join(''))).join('')}
      </div>
    </section>`;
}

// ── AI-generated flag ───────────────────────────────────────────────────────
// The loudest marker on the page: when the file declares its pixels came from
// a trained model, we say so in a purple, animated, unmissable banner. Two
// declaration sources, two strengths of claim: a signed C2PA assertion
// (report.aiGenerated), or the bare IPTC DigitalSourceType tag in the file's
// embedded metadata (meta.ai) — the sidecar flag Gemini/Imagen, Midjourney and
// Meta AI write alongside their invisible pixel watermarks. Either way the
// banner also points at the invisible-watermark layer (SynthID, Video Seal…)
// that we canNOT read on-device — declared honestly instead of over-claimed.
interface AiOrigin { kind: 'generated' | 'composite'; via: 'credential' | 'metadata'; credit?: string }
const AI_FLAG_COPY = {
  credential: {
    generated: {
      title: 'AI-generated content',
      sub: 'This file’s Content Credential declares it was generated by AI — produced by a trained algorithmic model, not captured or hand-made.',
    },
    composite: {
      title: 'Contains AI-generated content',
      sub: 'This file’s Content Credential declares AI-generated elements were composited in — part of it was produced by a trained algorithmic model.',
    },
  },
  metadata: {
    generated: {
      title: 'AI-generated content',
      sub: 'This file’s embedded metadata declares it was generated by AI — the IPTC “digital source type” tag its generator wrote next to the pixels. The tag is genuine when present but trivially stripped, so its absence never proves the opposite.',
    },
    composite: {
      title: 'Contains AI-generated content',
      sub: 'This file’s embedded metadata declares AI-generated elements were composited in — a tag written by the editing tool, and easily stripped.',
    },
  },
};
// Matches the makers whose AI output carries Google's SynthID pixel watermark
// (Gemini/Imagen/Veo — and "Nano Banana", Gemini's image-model brand).
const SYNTHID_MAKERS = /google|gemini|imagen|veo|nano.?banana/i;
function aiFlagHtml(origin: AiOrigin | undefined, makerHint = ''): string {
  if (!origin) return '';
  const c = AI_FLAG_COPY[origin.via][origin.kind];
  // The invisible-watermark layer: Google (and partners) stamp SynthID into the
  // pixels themselves. We can't read it on-device, so we just share what's likely
  // — we don't route users to a maker's proprietary detector or make excuses for
  // what we can't do.
  const note = SYNTHID_MAKERS.test(`${origin.credit ?? ''} ${makerHint}`)
    ? t('Google’s AI models also stamp an invisible <strong>SynthID</strong> watermark into the pixels themselves, so this file very likely carries one — it survives even when this label is stripped.')
    : t('Large AI generators also typically stamp an invisible watermark into the pixels themselves (Google’s SynthID — also adopted by OpenAI — or Meta’s Video Seal), which survives metadata stripping.');
  return `
    <div class="valid-ai-flag" role="alert">
      <span class="valid-ai-flag-ic" aria-hidden="true">${svgIcon('aiSpark')}</span>
      <span class="valid-ai-flag-text">
        <strong>${escape(t(c.title))}</strong>
        <span>${escape(t(c.sub))}</span>
        ${origin.credit ? `<span class="valid-ai-flag-credit">“${escape(origin.credit)}”</span>` : ''}
        <span class="valid-ai-flag-note">${note}</span>
      </span>
      <span class="valid-ai-flag-tag" aria-hidden="true">${t('AI')}</span>
    </div>`;
}

// ── Lolly Imprint (our pixel watermark) ──────────────────────────────────────
// Shown ONLY when the in-pixel mark is found (absence is uninformative — resize
// erases it and non-Lolly rasters never carry it, so "not found" must never read
// as "not made with Lolly"). Deliberately quiet and clearly secondary to the
// C2PA verdict: a durable hint, not a cryptographic guarantee.
function watermarkNote(wm: Watermark | undefined): string {
  if (!wm?.present) return '';
  return `
    <div class="valid-wm" role="note">
      <span class="valid-wm-ic" aria-hidden="true">${svgIcon('imprint')}</span>
      <div class="valid-wm-text">
        <strong>${wm.embedded ? t('Lolly Imprint found in an embedded image') : t('Lolly Imprint present')}</strong>
        <span>${wm.embedded
    ? t("This file isn't a raster Lolly signs directly, but one of the images embedded inside it carries the Lolly Imprint — an imperceptible watermark Lolly can embed in the pixels of a raster it renders. It rides in the image itself and survives recompression, so it's a durable hint that an image in this file came from Lolly. A supporting signal, not a cryptographic guarantee.")
    : t("The Lolly Imprint is an imperceptible watermark Lolly can embed in the pixels of a raster export. Unlike the Content Credential — which travels in metadata and is lost to a re-save or strip — it rides in the image itself and survives recompression, so it's a durable hint that the image came from Lolly. A supporting signal, not a cryptographic guarantee.")}</span>
      </div>
    </div>`;
}

// The scorecard pip for a detected Lolly Imprint — the exact item scorecardModel
// seats beside the verdict, reused so a Tier-2 (opt-in resize search) recovery
// injects an IDENTICAL pip. Presence is presence: the wording never depends on
// which tier found it or on the scale/offset it was recovered at.
const lollyImprintPip = (): ScorecardItem => ({ icon: 'imprint', label: t('Lolly Imprint'), status: 'pass', statusWord: t('detected') });

// ── Opt-in Tier-2 "resized Imprint" search ───────────────────────────────────
// The automatic pixel pass (pixelChecks) runs Tier 0 (plain detect) + Tier 1 (the
// cheap block-phase OFFSET search, crop recovery). It deliberately does NOT run
// Tier 2 — the resample-heavy SCALE grid — because that costs a bilinear resample
// + detect per cell and the common case on a public /verify page is an unmarked
// file, so paying it silently on every miss is unacceptable. Exactly like the
// TrustMark deep-scan button, it's offered PER FILE, ONLY when nothing was found
// yet, and only for a raster we can decode. Honest scope: it recovers a CROPPED or
// MODERATELY-resized Imprint (~0.5×–2×); it does NOT survive an aggressive social-
// media downscale (that needs a resize-invariant scheme, out of scope here).
function imprintRescanBlock(fileIndex: number, format: string | null, fileName: string, present: boolean, madeWithLolly: boolean): string {
  if (present || madeWithLolly || !isDeepScannable(format, fileName)) return '';
  return `
    <div class="valid-wm valid-wm--action" data-imprint-rescan-block="${fileIndex}">
      <span class="valid-wm-ic" aria-hidden="true">${svgIcon('imprint')}</span>
      <div class="valid-wm-text">
        <strong>${t('Was this image resized or cropped?')}</strong>
        <span>${t('No Lolly Imprint was found in the pixels as they are. If this image was cropped or moderately resized, a deeper pixel search can still recover the Imprint. It runs entirely on this device and won’t survive an aggressive social-media downscale.')}</span>
        <div data-imprint-rescan-result="${fileIndex}"></div>
      </div>
      <button type="button" class="btn valid-wm-rescan" data-imprint-rescan="${fileIndex}">${t('Search for a resized Imprint')}</button>
    </div>`;
}

// ── SEAL (hackerfactor) signature — byte-level cryptographic provenance ──────
// DISTINCT from Meta's "Content Seal" pixel watermark (contentSealPip/Note
// below): SEAL signs the FILE BYTES and publishes its public key in DNS. It runs
// on the DEFAULT verify path (byte-level, like the C2PA / metadata reads — NOT
// the neural deep scan). Only a positive OR a present-but-failed result renders;
// a file with no SEAL record shows nothing (absence is never "clean"). SEAL
// proves DOMAIN control + byte integrity — not a CA-verified legal identity, and
// nothing about the visual content.
function sealPip(seal: SealVerifyResult | undefined): ScorecardItem | null {
  if (!seal?.found) return null;
  if (seal.valid && seal.keySource === 'dns') return { icon: 'seal', label: t('SEAL signature'), status: 'pass', statusWord: t('verified') };
  // Valid but the key came from the file itself (no DNS confirmation) — integrity
  // without domain attribution, so it's an amber "present", not a green verdict.
  if (seal.valid) return { icon: 'seal', label: t('SEAL signature'), status: 'warn', statusWord: t('unconfirmed key') };
  return { icon: 'seal', label: t('SEAL signature'), status: 'fail', statusWord: t('failed') };
}
function sealNoteHtml(seal: SealVerifyResult | undefined): string {
  if (!seal?.found) return '';
  const domain = seal.domain ? escape(seal.domain) : t('an undisclosed domain');
  const idLine = seal.signerId ? ` ${t('Signer id: {id}.', { id: escape(seal.signerId) })}` : '';
  const whenLine = seal.timestamp ? ` ${t('Self-asserted signing time: {when}.', { when: escape(seal.timestamp) })}` : '';
  if (seal.valid && seal.keySource === 'dns') {
    const coverage = seal.coversWholeFile
      ? t('The signature covers the whole file, so its bytes are unchanged since it was signed.')
      : t('The signature covers only part of the file, so only that portion is proven unchanged.');
    return `
    <div class="valid-wm" role="note">
      <span class="valid-wm-ic" aria-hidden="true">${svgIcon('seal')}</span>
      <div class="valid-wm-text">
        <strong>${t('Signed by {domain} (SEAL)', { domain })}</strong>
        <span>${t('A SEAL cryptographic signature over the file’s bytes verified against the public key published in DNS for this domain.')} ${coverage}${idLine}${whenLine}</span>
        <span>${t('SEAL proves control of the domain — domain-level attribution, not a CA-verified legal identity — and says nothing about the visual content. Checked on this device; only a public-key DNS lookup left the device, never the file.')}</span>
      </div>
    </div>`;
  }
  if (seal.valid) {
    // Verified against the record's OWN inline key — internally consistent, but
    // the key was never confirmed against DNS, so the domain is unattested.
    return `
    <div class="valid-wm valid-wm--warn" role="note">
      <span class="valid-wm-ic" aria-hidden="true">${svgIcon('seal')}</span>
      <div class="valid-wm-text">
        <strong>${t('SEAL signature is internally consistent')}</strong>
        <span>${t('This file’s SEAL signature verifies against a public key the file itself supplied, but that key was not confirmed against DNS for {domain} — so the bytes are self-consistent, without proven domain attribution.', { domain })}${idLine}${whenLine}</span>
      </div>
    </div>`;
  }
  return `
    <div class="valid-wm valid-wm--warn" role="note">
      <span class="valid-wm-ic" aria-hidden="true">${svgIcon('seal')}</span>
      <div class="valid-wm-text">
        <strong>${t('SEAL signature did not verify')}</strong>
        <span>${t('This file carries a SEAL signature record naming {domain}, but it did not validate: {reason}', { domain, reason: escape(seal.reason) })}</span>
      </div>
    </div>`;
}

// ── Appended-payload extraction (view + download) ────────────────────────────
// The steganalysis reader already surfaces trailing bytes as a metadata row
// (see file-metadata.ts's `appended`); this callout goes one step further and
// lets a viewer actually see and pull out what's riding after the container
// ends — same "reveal, never launder" stance as the clean-copy action below.
// Shown for EVERY appended payload, including the legitimate motion-photo
// case (no warning pip there — see stegoPips — but "here's the trailing data"
// is still a neutral, useful action). The View/Download handlers themselves
// live in mountValid (they need activeFiles); this only builds the markup.
const PAYLOAD_EXT: Record<string, string> = {
  'zip archive': 'zip', 'gzip data': 'gz', 'PDF document': 'pdf',
  'Windows executable': 'bin', 'ELF executable': 'bin',
  'video (motion photo)': 'mp4', text: 'txt',
};
/** Extension for a downloaded payload, derived from the engine's best-effort
 *  `kind` sniff. Anything not explicitly named above (images, RAR, generic
 *  binary data) falls back to a neutral `.bin` rather than guessing wrong. */
function payloadExt(kind: string): string {
  return PAYLOAD_EXT[kind] ?? 'bin';
}
function appendedPayloadHtml(meta: FileMetadata | undefined, fileIndex: number): string {
  if (!meta?.appended) return '';
  const isMotion = meta.appended.kind === 'video (motion photo)';
  // Reuse the already-formatted "kind — size" string from the metadata row
  // instead of reformatting the byte count here.
  const detail = meta.fields.find((f) => f.label === 'Appended data')?.value ?? meta.appended.kind;
  return `
    <div class="valid-wm${isMotion ? '' : ' valid-wm--warn'}" role="note" data-payload-block="${fileIndex}">
      <span class="valid-wm-ic" aria-hidden="true">${svgIcon('package')}</span>
      <div class="valid-wm-text">
        <strong>${isMotion ? t('Appended video data') : t('Appended data found')}</strong>
        <span>${escape(detail)}</span>
        <div class="valid-payload-actions">
          <button type="button" class="valid-clean-link" data-payload-view="${fileIndex}">${t('View')}</button>
          <button type="button" class="valid-clean-link" data-payload-download="${fileIndex}">${t('Download')}</button>
        </div>
        <div class="valid-payload-view" data-payload-panel="${fileIndex}" hidden></div>
      </div>
    </div>`;
}
// Hex dump with an ASCII gutter — 16 bytes/row, classic layout. The payload is
// attacker-controlled bytes; the caller escapes this output before it ever
// touches innerHTML (see payloadPreviewHtml), so nothing here needs escaping
// itself, but every byte is rendered as its numeric hex/period form, never as
// a live character — there is no path from payload bytes to markup.
function hexDump(bytes: Uint8Array): string {
  const lines: string[] = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const row = bytes.subarray(i, Math.min(i + 16, bytes.length));
    const hex = Array.from(row, (b) => b.toString(16).padStart(2, '0')).join(' ').padEnd(47, ' ');
    const ascii = Array.from(row, (b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
    lines.push(`${i.toString(16).padStart(8, '0')}  ${hex}  |${ascii}|`);
  }
  return lines.join('\n');
}
const PAYLOAD_PREVIEW_MAX = 2048;
/** Renders the first ~2 KB of a (possibly hostile) payload as plain escaped
 *  text — a hex dump for anything binary, decoded UTF-8 for the `text` kind.
 *  SECURITY: this is the only thing ever done with payload bytes on this
 *  page — no parsing, no rendering as an image/HTML/script, and the result is
 *  always passed through `escape()` before reaching innerHTML, so a payload
 *  crafted to look like markup can never execute or inject. */
function payloadPreviewHtml(bytes: Uint8Array, kind: string): string {
  const truncated = bytes.length > PAYLOAD_PREVIEW_MAX;
  const slice = bytes.subarray(0, PAYLOAD_PREVIEW_MAX);
  const body = kind === 'text'
    ? new TextDecoder('utf-8', { fatal: false }).decode(slice)
    : hexDump(slice);
  const more = truncated ? `\n\n${t('… {n} more bytes not shown', { n: bytes.length - PAYLOAD_PREVIEW_MAX })}` : '';
  return `<pre class="valid-payload-dump">${escape(body)}${escape(more)}</pre>`;
}

// ── Deep scan for third-party watermarks (Adobe TrustMark + Meta Content Seal) ──
// See plans/watermark-detectors.md. The two neural decoders (lib/trustmark.ts,
// lib/contentseal.ts) each pull in onnxruntime-web + a model and must NEVER load
// on the default verify path — they're lazily dynamic-imported. The scan runs
// AUTOMATICALLY (scanOne/scanAllDecodable in mountValid) once the models are
// on-device; the one-time ~90 MB download is offered once per batch via the
// header banner (deepScanBannerHtml → enableDeepScan), so a single consent
// serves every file. Reuses the Lolly Imprint's `.valid-wm` styling for the
// positive-result notes (same "a durable in-pixel mark was found" idea).
const TRUSTMARK_DETECTED_PIP: ScorecardItem = {
  icon: 'imprint', label: '', status: 'pass', statusWord: '',
};
/** Builds the scorecard pip for a positive TrustMark decode — a real
 *  on-device, ECC-validated read, so (like the Lolly Imprint) it earns a
 *  green pass pip rather than the amber SynthID/Meta likelihood wording. */
function trustmarkPip(): ScorecardItem {
  return { ...TRUSTMARK_DETECTED_PIP, label: t('TrustMark'), statusWord: t('detected') };
}
function trustmarkNoteHtml(payloadHex: string, schema: string): string {
  return `
    <div class="valid-wm" role="note">
      <span class="valid-wm-ic" aria-hidden="true">${svgIcon('imprint')}</span>
      <div class="valid-wm-text">
        <strong>${t('Adobe TrustMark detected')}</strong>
        <span>${t('A TrustMark watermark ({schema}) was decoded from the pixels and passed its error-correction check — a real, on-device read, not a guess. Recovered payload: {payload}', { schema: escape(schema), payload: `<code>${escape(payloadHex)}</code>` })}</span>
      </div>
    </div>`;
}
/** The pip for a positive Content Seal read — a consistent message survived
 *  four re-encodings on THIS device. Unlike TrustMark this has NO error-
 *  correcting gate (it's a statistical consensus that a flat/low-detail image
 *  can trip), so it reads as an amber "likely", not a green "detected". */
function contentSealPip(): ScorecardItem {
  return { icon: 'imprint', label: t('Content Seal'), status: 'warn', statusWord: t('likely') };
}
// The Content Seal positive note ALWAYS carries the Muse-proprietary caveat: the
// open Pixel Seal / Video Seal extractor is not Meta's production "Muse" variant,
// so a hit must never be read as "this is Meta Muse / Meta AI output". Absence is
// never shown at all (see scanOne), so this only appears on a real detection.
function contentSealNoteHtml(messageHex: string): string {
  const msg = messageHex
    ? ` ${t('Recovered message: {payload}', { payload: `<code>${escape(messageHex)}</code>` })}`
    : '';
  return `
    <div class="valid-wm" role="note">
      <span class="valid-wm-ic" aria-hidden="true">${svgIcon('imprint')}</span>
      <div class="valid-wm-text">
        <strong>${t('Meta Content Seal likely')}</strong>
        <span>${t('An open Pixel Seal image watermark decoded consistently from the pixels across several re-encodings. Unlike a Content Credential or TrustMark — which carry an error-correcting check — this is a statistical match with no cryptographic gate, so a low-detail or flat image can occasionally read as a false positive.')}${msg}</span>
        <span>${t('This reads only Meta’s open-source Pixel Seal / Video Seal image watermark. Meta’s production “Muse” image pipeline uses a separate proprietary variant this cannot read, so a hit does not mean Meta Muse or Meta AI, and its absence rules nothing out.')}</span>
      </div>
    </div>`;
}
// Per-file deep-scan slot: the pip-injection anchor + a notes area, appended
// below the hero scorecard. Gated to formats the pixel decode can read
// (WM_DECODABLE) — omitted for PDF/video/TIFF/SVG. There is NO per-file button:
// the scan runs automatically once the detector models are on-device, and the
// one-time download is offered ONCE per batch in the header banner
// (deepScanBannerHtml) so every file benefits from a single consent.
function deepScanBlock(fileIndex: number, format: string | null, fileName: string): string {
  if (!isDeepScannable(format, fileName)) return '';
  return `
    <div class="valid-deepscan" data-deepscan-block="${fileIndex}" hidden>
      <div data-deepscan-result="${fileIndex}"></div>
    </div>`;
}
function isDeepScannable(format: string | null, fileName: string): boolean {
  return WM_DECODABLE.has((format || fileName.split('.').pop() || '').toLowerCase());
}
// The batch-level consent banner, shown at the top of the report when deep-scan
// models aren't yet on-device and at least one file is a decodable raster. One
// click downloads the detectors once (~90 MB) and then every image in the batch
// is scanned automatically; on a later visit (models cached) this never appears
// and scanning is silent/automatic.
function deepScanBannerHtml(count: number): string {
  return `
    <div class="valid-deepscan-banner" data-deepscan-banner role="note">
      <span class="valid-deepscan-banner-ic" aria-hidden="true">${svgIcon('imprint')}</span>
      <div class="valid-deepscan-banner-text">
        <strong>${t('Scan for invisible watermarks?')}</strong>
        <span data-deepscan-banner-msg>${t('Check {n} image(s) for Adobe TrustMark / Meta Content Seal watermarks in the pixels. Downloads a detector once (~90 MB), then runs automatically for every file — on-device, nothing uploaded.', { n: count })}</span>
        <div class="valid-deepscan-progress" data-deepscan-progress role="progressbar" aria-label="${escape(t('Downloading the watermark detector'))}" hidden>
          <div class="valid-deepscan-progress-fill" data-deepscan-progress-fill></div>
        </div>
      </div>
      <button type="button" class="btn valid-deepscan-enable" data-deep-scan-enable>${t('Enable')}</button>
    </div>`;
}

// ── AI declaration + third-party watermark pip ──────────────────────────────
// The AI declaration, from either source: the signed credential wins (stronger
// claim), else the bare IPTC tag in the file's embedded metadata (meta.ai).
// `makerHint` joins everything that names the maker — the claim generator, the
// agents on AI-sourced history steps, and the software/credit fields read from
// bare metadata — for the SynthID/Meta maker checks.
function deriveAi(report: VerifyReport, meta: FileMetadata | undefined): { origin: AiOrigin | undefined; makerHint: string } {
  const origin: AiOrigin | undefined = report.aiGenerated
    ? { kind: report.aiGenerated.kind, via: 'credential' }
    : meta?.ai
      ? { kind: meta.ai.kind, via: 'metadata', credit: meta.ai.credit }
      : undefined;
  if (!origin) return { origin, makerHint: '' };
  const gen = report.claim?.generatorInfo?.name != null ? String(report.claim.generatorInfo.name)
    : typeof report.claim?.claimGenerator === 'string' ? report.claim.claimGenerator : '';
  const makerHint = [
    gen,
    ...(report.history ?? []).filter((a) => AI_SOURCE_SLUGS[sourceSlug(a)]).map(stepAgent),
    ...(meta?.fields ?? []).filter((f) => f.group === 'software' || f.label === 'Credit').map((f) => f.value),
  ].filter(Boolean).join(' ');
  return { origin, makerHint };
}

// SynthID / Meta's in-pixel watermarks can't be read outside their makers, so
// their scorecard pip states likelihood: an amber pip whose label carries the
// whole claim (no status word — "passed"/"invalid" would both misword it),
// shown when the file's own AI declaration names a maker whose policy is to
// watermark all AI output. The Lolly Imprint pip (a real on-device detection)
// is appended in scorecardModel; this one rides beside it.
const META_MAKERS = /meta\s?ai|imagined?\s+with\s+ai|\bemu\b/i;
function aiMarkPip(origin: AiOrigin | undefined, makerHint: string, isVideo: boolean): ScorecardItem | null {
  if (!origin) return null;
  const hay = `${origin.credit ?? ''} ${makerHint}`;
  if (SYNTHID_MAKERS.test(hay)) return { icon: 'aiSpark', label: t('SynthID likely'), status: 'warn', hideStatus: true };
  if (META_MAKERS.test(hay)) return { icon: 'aiSpark', label: isVideo ? t('Meta Video Seal likely') : t('Meta AI watermark likely'), status: 'warn', hideStatus: true };
  return null;
}

// Steganalysis pips — amber heuristics from the byte read (a payload appended
// after the image container ends) and the shell's pixel pass (chi-square LSB
// analysis, engine steganalysis.ts). The legitimate motion-photo append stays
// out of the scorecard — it's disclosed in the metadata panel instead.
function stegoPips(meta: FileMetadata | undefined): ScorecardItem[] {
  const pips: ScorecardItem[] = [];
  if (meta?.appended && meta.appended.kind !== 'video (motion photo)') {
    pips.push({ icon: 'package', label: t('Hidden data appended'), status: 'warn', hideStatus: true });
  }
  if (meta?.lsb?.suspicious) {
    pips.push({ icon: 'eye', label: t('LSB steganography likely'), status: 'warn', hideStatus: true });
  }
  return pips;
}

// One list for both scorecards: the SynthID/Meta likelihood pip + steganalysis.
function extraPips(origin: AiOrigin | undefined, makerHint: string, isVideo: boolean, meta: FileMetadata | undefined): ScorecardItem[] {
  const ai = aiMarkPip(origin, makerHint, isVideo);
  return [...(ai ? [ai] : []), ...stegoPips(meta)];
}

// ── Change history (the recorded C2PA actions) ──────────────────────────────
// Human labels + a glyph per C2PA action code; unknown codes fall back to the
// bare code with the c2pa. prefix stripped.
const ACTION_LABEL: Record<string, string> = {
  'c2pa.created': 'Created', 'c2pa.edited': 'Edited', 'c2pa.opened': 'Opened',
  'c2pa.placed': 'Placed', 'c2pa.removed': 'Removed', 'c2pa.published': 'Published',
  'c2pa.converted': 'Converted', 'c2pa.cropped': 'Cropped', 'c2pa.resized': 'Resized',
  'c2pa.filtered': 'Filtered', 'c2pa.color_adjustments': 'Colour adjusted',
  'c2pa.drawing': 'Retouched', 'c2pa.transcoded': 'Transcoded', 'c2pa.repackaged': 'Repackaged',
  'c2pa.managed': 'Managed', 'c2pa.saved': 'Saved', 'c2pa.printed': 'Printed',
  'c2pa.unknown': 'Modified',
};
const ACTION_ICON: Record<string, IconName> = {
  'c2pa.created': 'sparkle', 'c2pa.edited': 'pen', 'c2pa.opened': 'eye',
  'c2pa.placed': 'package', 'c2pa.published': 'package', 'c2pa.drawing': 'pen',
  'c2pa.color_adjustments': 'droplet', 'c2pa.filtered': 'sliders', 'c2pa.cropped': 'crop',
  'c2pa.resized': 'resize', 'c2pa.converted': 'convert', 'c2pa.transcoded': 'convert',
};
// A composite source type reads as stacked layers regardless of the action code
// carrying it (a created/opened step that merged multiple elements). Keyed on the
// IPTC digitalSourceType slug — takes precedence over ACTION_ICON in stepsHtml().
const SOURCE_ICON: Partial<Record<string, IconName>> = {
  composite: 'layers',
  compositeWithTrainedAlgorithmicMedia: 'layers',
  // Sensor origin — a live camera frame or a recording. A mic-only take is
  // re-pointed to the mic glyph in stepsHtml() from its description.
  digitalCapture: 'camera',
  computationalCapture: 'camera',
  // A display capture is its own origin — a screen, never a camera.
  screenCapture: 'monitor',
};
// Friendly wording for an action's IPTC DigitalSourceType (the last path segment).
const SOURCE_TYPE_LABEL: Record<string, string> = {
  trainedAlgorithmicMedia: 'Generated by AI',
  compositeWithTrainedAlgorithmicMedia: 'Composited with AI',
  algorithmicMedia: 'Algorithmically generated',
  digitalCreation: 'Created in software',
  digitalCapture: 'Captured by a camera',
  computationalCapture: 'Computational capture',
  screenCapture: 'Captured from a screen',
  digitalArt: 'Digital art',
  minorHumanEdits: 'Minor human edits',
  composite: 'Composite of multiple elements',
  softwareImage: 'Software-generated image',
};
const AI_SOURCE_SLUGS: Record<string, 'generated' | 'composite'> = {
  trainedAlgorithmicMedia: 'generated',
  compositeWithTrainedAlgorithmicMedia: 'composite',
};
const sourceSlug = (a: { digitalSourceType?: unknown }): string =>
  (typeof a.digitalSourceType === 'string' ? a.digitalSourceType : '').split('/').pop() ?? '';

// Tidy a verbose generator string into a short pill label. Known makers collapse
// to their brand; anything else keeps its first token (truncated), so the pill
// stays legible ("Google", "Lolly", "Adobe" — not "Google C2PA Core Generator…").
const AGENT_BRANDS = ['Lolly', 'Nano Banana', 'Gemini', 'Google', 'Adobe', 'Photoshop', 'Firefly', 'OpenAI', 'DALL·E', 'Microsoft', 'Meta', 'Midjourney', 'Canva', 'Figma', 'Leica', 'Sony', 'Nikon', 'Canon'];
function shortAgent(name: string): string {
  const s = name.trim();
  for (const b of AGENT_BRANDS) if (new RegExp(b.replace(/[.·]/g, '.?').replace(/\s+/g, '\\s*'), 'i').test(s)) return b;
  const first = s.split(/[\s/,]/)[0] || s;
  return first.length > 15 ? first.slice(0, 14) + '…' : first;
}
// The "who did this step": the action's softwareAgent if set, else the recording
// manifest's generator. null when neither is present.
const stepAgent = (a: { softwareAgent?: unknown; generator?: unknown }): string | null => {
  const raw = (typeof a.softwareAgent === 'string' && a.softwareAgent) || (typeof a.generator === 'string' && a.generator) || '';
  return raw ? String(raw) : null;
};
// Strip a trailing "… by <maker>." now that the maker rides in the pill, and
// drop the description entirely if what remains just echoes the step label
// (e.g. "Resized by Google Generative AI." → "" beside a "Resized" row).
function tidyStepDescription(desc: string, label: string): string {
  const cleaned = desc.replace(/\s+by\s+[^.]+\.?\s*$/i, '').trim();
  return cleaned.toLowerCase() === label.toLowerCase() ? '' : cleaned;
}

export function stepsHtml(report: VerifyReport): string {
  // The full provenance chain (all manifests) when the engine surfaced it, else
  // just the active manifest's own actions.
  const acts = report.history?.length ? report.history : (report.claim?.actions ?? []);
  if (!acts.length) return '';
  const rowData = acts.map((a) => {
    const code = String(a.action ?? '');
    const label = ACTION_LABEL[code] ? t(ACTION_LABEL[code]!) : (code.replace(/^c2pa\./, '') || t('Step'));
    const slug = sourceSlug(a);
    const isAi = !!AI_SOURCE_SLUGS[slug];
    const desc = a.description ? tidyStepDescription(String(a.description), label) : '';
    // A mic-only capture (digitalCapture whose description says microphone, not
    // camera) must NOT read "Captured by a camera": swap to the mic glyph and let
    // the description carry the wording instead of the camera source line.
    const isCapture = slug === 'digitalCapture' || slug === 'computationalCapture';
    const isMicCapture = isCapture && /microphone/i.test(desc) && !/camera/i.test(desc);
    const src = isMicCapture || !SOURCE_TYPE_LABEL[slug] ? undefined : t(SOURCE_TYPE_LABEL[slug]!);
    // A composite/capture source type wins the glyph; else the action's own icon.
    const icon = isMicCapture ? 'mic' : (SOURCE_ICON[slug] ?? ACTION_ICON[code] ?? 'clock');
    // Who did it → a left-side pill. Lolly reads bold green (mark our own edits
    // prominently), an AI-sourced step reads purple, any other maker solid grey.
    const agent = stepAgent(a);
    const agentCls = agent && /lolly/i.test(agent) ? 'lolly' : isAi ? 'ai' : 'other';
    const meta = [
      desc ? escape(desc) : null,
      a.when ? escape(fmtDate(a.when)) : null,
    ].filter(Boolean).join('<span class="valid-step-dot" aria-hidden="true">·</span>');
    // The source-type note (e.g. "Generated by AI") always gets its own line —
    // it's a distinct claim from the description/timestamp, not more list prose.
    const srcLine = src ? `<span class="valid-step-src">${isAi ? `${svgIcon('aiSpark')} ` : ''}${escape(src)}</span>` : '';
    return { agent, agentCls, label, icon, meta, srcLine };
  });
  // The rail segment spanning the FIRST through LAST step credited to Lolly reads
  // green (matching the lolly pill's own colour) — so the "Lolly leg" of a file's
  // journey visually pops even when other makers' steps sit before/after it.
  const lollyIdxs = rowData.reduce<number[]>((acc, r, i) => (r.agentCls === 'lolly' ? [...acc, i] : acc), []);
  const firstLolly = lollyIdxs[0];
  const lastLolly = lollyIdxs[lollyIdxs.length - 1];
  const rows = rowData.map((r, i) => {
    const railLolly = firstLolly !== undefined && i >= firstLolly && i < lastLolly!;
    return `
      <li class="valid-step is-${r.agentCls}${railLolly ? ' valid-step--rail-lolly' : ''}">
        <span class="valid-step-agent" title="${r.agent ? escape(r.agent) : escape(t('Unknown source'))}">${escape(r.agent ? shortAgent(r.agent) : '—')}</span>
        <div class="valid-step-main">
          <span class="valid-step-label"><span class="valid-step-ic" aria-hidden="true">${svgIcon(r.icon)}</span>${escape(r.label)}</span>
          ${r.meta ? `<span class="valid-step-meta">${r.meta}</span>` : ''}
          ${r.srcLine}
        </div>
      </li>`;
  }).join('');
  return `
    <div class="valid-steps valid-panel">
      <h3>${svgIcon('clock')}<span>${t('Change history')}</span></h3>
      <ol class="valid-steps-list">${rows}</ol>
    </div>`;
}

// The assertion/validation log, boxed as a panel matching Change history — the raw,
// per-check result behind the hero scorecard's eight collapsed pips (every
// hashed-URI assertion, the claim signature, the certificate window, the hard
// binding, trust). Paired with stepsHtml() into .valid-panels so "what happened"
// and "what was checked" read as two distinct boxes, side by side when there's room.
function checksHtml(report: VerifyReport): string {
  if (!report.checks.length) return '';
  return `
    <div class="valid-checks-panel valid-panel">
      <h3>${svgIcon('checklist')}<span>${t('Assertion log')}</span></h3>
      <ul class="valid-checks">${report.checks.map(checkRow).join('')}</ul>
    </div>`;
}

// ── Uploaded-media preview ──────────────────────────────────────────────────
// A look at the actual file being checked: a large view at the top of the card,
// a smaller one beside the embedded metadata. Images and video render inline;
// PDF gets the browser's native viewer; formats a browser can't decode (TIFF,
// MKV) fall back to a labelled placeholder. The object URL is owned by handle().
type PreviewKind = 'image' | 'video' | 'pdf' | 'none';
interface Preview { url?: string; kind: PreviewKind; format: string; name: string; }
const PREVIEW_IMG = new Set(['png', 'apng', 'jpg', 'jpeg', 'gif', 'svg', 'webp']);
const PREVIEW_VID = new Set(['mp4', 'm4v', 'mov', 'webm']);
// Raster formats a <canvas> can decode to RGBA — shared by the Lolly-Imprint/
// LSB pixel pass (mountValid's pixelChecks) AND the TrustMark deep-scan
// button's gating (deepScanBlock below), so both agree on what's checkable.
// SVG is deliberately excluded even though it's in PREVIEW_IMG: watermarks
// live in RASTER pixels, and rasterising a vector for the sake of a scan
// would be meaningless (there is no pixel grid to have carried a mark).
const WM_DECODABLE = new Set(['png', 'apng', 'jpg', 'jpeg', 'gif', 'webp']);
function previewKind(format: string | null, name: string): PreviewKind {
  const f = (format || name.split('.').pop() || '').toLowerCase();
  if (PREVIEW_IMG.has(f)) return 'image';
  if (PREVIEW_VID.has(f)) return 'video';
  if (f === 'pdf') return 'pdf';
  return 'none';
}
function mediaPreviewHtml(p: Preview | undefined, size: 'lg' | 'sm'): string {
  if (!p) return '';
  const cls = `valid-preview valid-preview--${size} is-${p.kind}`;
  if (p.kind === 'image' && p.url)
    return `<figure class="${cls}"><img src="${escape(p.url)}" alt="${escape(t('Preview of {name}', { name: p.name }))}" decoding="async"></figure>`;
  if (p.kind === 'video' && p.url)
    return `<figure class="${cls}"><video src="${escape(p.url)}#t=0.1" preload="metadata" playsinline muted${size === 'lg' ? ' controls' : ''}></video></figure>`;
  if (p.kind === 'pdf' && p.url && size === 'lg')
    return `<figure class="${cls}"><embed src="${escape(p.url)}#toolbar=0&view=FitH" type="application/pdf"></figure>`;
  // Not inline-previewable at this size — a quiet labelled placeholder (large only).
  if (size === 'lg')
    return `<figure class="${cls} is-placeholder"><span class="valid-preview-ic" aria-hidden="true">${svgIcon('image')}</span><figcaption>${t('No inline preview for {format}', { format: escape((p.format || t('this format')).toUpperCase()) })}</figcaption></figure>`;
  return '';
}

function renderReportBody(fileName: string, report: VerifyReport, meta: FileMetadata | undefined, preview: Preview | undefined, fileIndex: number, watermark?: Watermark, mine?: LocalExportMatch, seal?: SealVerifyResult): string {
  const { state, sub, identity } = resolveState(report);
  const claim: Partial<Claim> = report.claim ?? {};
  const signer: Partial<Signer> = report.signer ?? {};
  const env: Record<string, string | number | boolean> & { inputs?: Record<string, string> } = report.environment ?? {};
  const signedAt = claim.actions?.find((a) => a.when)?.when;
  const generator = claim.generatorInfo?.name
    ? `${claim.generatorInfo!.name}${claim.generatorInfo!.version ? ' ' + claim.generatorInfo!.version : ''}`
    : claim.claimGenerator;
  // AI declaration (credential or bare metadata) + the extra scorecard pips it
  // and the steganalysis reads imply — see deriveAi/aiMarkPip/stegoPips.
  const { origin: aiOrigin, makerHint } = deriveAi(report, meta);
  const pips = extraPips(aiOrigin, makerHint, preview?.kind === 'video', meta);
  // SEAL is a byte-level signal computed alongside C2PA (see sealPip): its pip
  // rides with the other watermark/provenance pips in the hero scorecard.
  const sp = sealPip(seal);
  if (sp) pips.push(sp);
  // Who signed: the device credential's OIDC email when present, else the
  // organisation / common name from a CA signer's certificate (Google, Adobe,
  // Microsoft… carry no SAN email). Only shown when the chain reached a pinned
  // anchor (identity set) — an org name alone is never proof.
  const signerWho = identity ? (identity.email || signer.organization || signer.commonName) : null;
  const identityLine = (identity && signerWho) ? `
          <p class="valid-identity-line">${report.trusted
    ? t('Signed by <strong>{who}</strong> — identity verified by <strong>{issuer}</strong>', { who: escape(signerWho), issuer: escape(identity!.issuer ?? t('a recognised C2PA root')) })
    : t('Signed by <strong>{who}</strong> — identity was CA-verified; the certificate has since expired', { who: escape(signerWho) })}</p>` : '';
  // "Made from", "what happened" and "what was checked" — distinct boxed panels,
  // paired with the file/facts summary so they share one row wherever the page
  // has the room (see .valid-panels). madeFromBlock is placed ahead of stepsBlock
  // in panelsBlock below so it reads (and, on narrow viewports, stacks) directly
  // above change history.
  // The recreate CTA rides the digest panel only when the claim's own content is
  // trustworthy (made / likely-made with Lolly — the digest IS a Lolly assertion)
  // AND the recorded tool name resolves against this build's tool index.
  const recreate = (report.madeWithLolly || report.likelyMadeWithLolly) ? resolveRecreateTool(env.tool) : undefined;
  const madeFromBlock = report.found && report.claim ? inputsDigestHtml(env.inputs, recreate ? { ...recreate, fileIndex } : undefined) : '';
  const stepsBlock = report.found && report.claim ? stepsHtml(report) : '';
  const checksBlock = checksHtml(report);
  const selfnoteBlock = report.found && report.claim && !report.madeWithLolly ? `
        <p class="valid-selfnote">${identity
    ? t('As recorded in the credential — asserted by its CA-verified signer:')
    : t('As recorded in the credential — self-asserted by whoever signed it:')}</p>` : '';
  const factsBlock = report.found && report.claim ? `
        <dl class="valid-facts">
          ${fact(t('Title'), claim.title, 'tag')}
          ${fact(t('Tool'), env.tool, 'tool')}
          ${fact(t('Produced by'), report.author ? `${report.author.name}${report.author.email ? ` <${report.author.email}>` : ''}` : null, 'user')}
          ${fact(report.delivered ? t('Delivered by') : t('Made with'), generator, report.delivered ? 'package' : 'lollipop')}
          ${fact(t('Signed'), signedAt ? fmtDate(signedAt) : null, 'clock')}
          ${fact(t('Where'), [env.surface, env.engine, env.os].filter(Boolean).join(' · ') || null, 'globe')}
          ${fact(t('Size'), env.dimensions, 'image')}
          ${fact(t('Signer'), signer.commonName, 'seal')}
          ${fact(t('Identity'), identity?.email, 'mail')}
          ${fact(t('Issuer'), identity ? identity.issuer
    : signer.organization ? `${signer.organization} ${signer.selfSigned ? t('(self-signed, on-device)') : t('(unverified — does not chain to a trust anchor)')}` : null, 'building')}
          ${fact(t('Algorithm'), signer.alg, 'cpu')}
          ${fact(t('Certificate valid'), signer.notBefore ? `${fmtDate(signer.notBefore)} → ${fmtDate(signer.notAfter)}` : null, 'calendar')}
          ${fact(t('Manifest'), claim.manifestLabel, 'document')}
        </dl>` : '';
  const summaryBlock = `
      <div class="valid-summary valid-panel">
        <p class="valid-file"><strong>${escape(fileName)}</strong>${report.format ? ` <span class="valid-fmt">${escape(report.format)}</span>` : ''}${report.reason ? ` — ${escape(report.reason)}` : ''}</p>
        ${selfnoteBlock}
        ${factsBlock}
      </div>`;
  // Embedded metadata joins the same flowing panel set (not a separate full-width
  // section below it) so a short card can settle into whatever column has room
  // instead of always trailing after a long change-history/assertion-log panel.
  const metaBlock = renderMetadata(meta, preview, fileIndex);
  const panelsBlock = `<div class="valid-panels">${summaryBlock}${madeFromBlock}${stepsBlock}${checksBlock}${metaBlock}</div>`;
  // The two "key validations" + the signed-by caption shown under the "Made with
  // Lolly" pill — only for the flagship lolly hero; every other good state keeps
  // the single prose sub + identityLine above.
  const signedByCa = identity?.issuer || signer.organization || signer.commonName;
  const lollyValidationsHtml = state === STATE_COPY.lolly ? `
          <div class="valid-hero-vbadges">
            <div class="valid-vbadge"><span class="valid-vbadge-ic" aria-hidden="true">${svgIcon('seal')}</span><span>${t('The credential is intact and records a Lolly export')}</span></div>
            <div class="valid-vbadge"><span class="valid-vbadge-ic" aria-hidden="true">${svgIcon('hash')}</span><span>${t('This file has not changed since it was made')}</span></div>
          </div>
          <p class="valid-hero-signedby">${identity
    ? t('Signed with <strong>{ca}</strong> Certificate Authority.', { ca: escape(signedByCa ?? t('a Certificate Authority')) })
    : t('Signed with an on-device key, not a CA identity.')}</p>` : '';
  // Mirrors lollyValidationsHtml's badge treatment for the broken-credential
  // verdict — three plain facts instead of one sentence to parse.
  const invalidBadgesHtml = state === STATE_COPY.invalid ? `
          <div class="valid-hero-vbadges">
            <div class="valid-vbadge is-fail"><span class="valid-vbadge-ic" aria-hidden="true">${svgIcon('seal')}</span><span>${t('Content Credentials detected')}</span></div>
            <div class="valid-vbadge is-fail"><span class="valid-vbadge-ic" aria-hidden="true">${svgIcon('hash')}</span><span>${t('Bytes no longer match')}</span></div>
            <div class="valid-vbadge is-fail"><span class="valid-vbadge-ic" aria-hidden="true">${svgIcon('pen')}</span><span>${t('Modified after signing')}</span></div>
          </div>` : '';
  // The middle-ground verdict: mixed tones in one badge group, unlike the pure
  // pass (lolly) or pure fail (invalid) groups above — two green facts about
  // the MANIFEST's own content (still trustworthy) and one amber fact about
  // the FILE's current bytes (can't be vouched for).
  const likelyLollyBadgesHtml = state === STATE_COPY.likelyLolly ? `
          <div class="valid-hero-vbadges">
            <div class="valid-vbadge"><span class="valid-vbadge-ic" aria-hidden="true">${svgIcon('seal')}</span><span>${t("The credential's own content checks out")}</span></div>
            <div class="valid-vbadge"><span class="valid-vbadge-ic" aria-hidden="true">${svgIcon('lollipop')}</span><span>${t('It records a Lolly creation')}</span></div>
            <div class="valid-vbadge is-warn"><span class="valid-vbadge-ic" aria-hidden="true">${svgIcon('hash')}</span><span>${t("This file's bytes no longer match")}</span></div>
          </div>` : '';
  const verdictHtml = report.madeWithLolly
    ? `<span class="valid-hero-pill valid-hero-pill--lolly"><span class="valid-lolly-badge" aria-hidden="true">🍭</span>${escape(t(state.title))}</span>`
    : report.likelyMadeWithLolly
      ? `<span class="valid-hero-pill valid-hero-pill--likely-lolly"><span class="valid-lolly-badge" aria-hidden="true">🍭</span>${escape(t(state.title))}</span>`
      : report.trusted
        ? `<span class="valid-hero-pill valid-hero-pill--trusted"><span class="valid-trusted-badge" aria-hidden="true">✓</span>${escape(t(state.title))}</span>`
        : `<span class="valid-hero-verdict">${escape(t(state.title))}</span>`;
  // A file whose intact chain records Lolly steps without being a Lolly creation
  // gets the amber lolly pill BESIDE the main verdict — credit for the Lolly leg
  // without claiming the whole file (see engine partsMadeWithLolly).
  const partsPill = report.partsMadeWithLolly
    ? ` <span class="valid-hero-pill valid-hero-pill--likely-lolly" title="${escape(t('The provenance chain records steps made with Lolly, but the file as it stands was produced by another tool.'))}"><span class="valid-lolly-badge" aria-hidden="true">🍭</span>${t('Parts made with Lolly')}</span>`
    : '';
  return `
    <div class="valid-result ${state.cls}">
      <div class="valid-top">
        ${mediaPreviewHtml(preview, 'lg')}
        <div class="valid-hero">
          <div class="valid-hero-title">
            <span class="valid-hero-icon">${report.madeWithLolly
    ? '<span class="valid-hero-logo" aria-hidden="true"></span>'
    : ICON_SHIELD}</span>
            <h2><span class="valid-hero-filename">${escape(fileName)}</span> ${verdictHtml}${partsPill}</h2>
          </div>
          ${state === STATE_COPY.lolly ? lollyValidationsHtml
    : state === STATE_COPY.likelyLolly ? likelyLollyBadgesHtml
    : state === STATE_COPY.invalid ? invalidBadgesHtml
      : `<p>${sub}</p>${identityLine}`}
        </div>
        ${report.found || watermark?.present || pips.length ? scorecardHtml(report, watermark, pips) : ''}
      </div>
      ${deepScanBlock(fileIndex, report.format, fileName)}
      ${aiFlagHtml(aiOrigin, makerHint)}
      ${mine ? mineNote(mine) : ''}
      ${panelsBlock}
      ${watermarkNote(watermark)}
      ${imprintRescanBlock(fileIndex, report.format, fileName, !!watermark?.present, report.madeWithLolly)}
      ${sealNoteHtml(seal)}
      ${appendedPayloadHtml(meta, fileIndex)}
      ${report.found ? deviceNote(report.format === 'webm' || report.format === 'mkv'
    ? t("<strong>Checked entirely on this device</strong> — the file was not uploaded. WebM has no standardised C2PA container mapping yet, so this credential is Lolly's own Matroska attachment: only Lolly (here and via <code>lolly validate</code>) can read it — external C2PA viewers don't support WebM at all.")
    : identity
      ? t("<strong>Checked entirely on this device</strong> — the file was not uploaded. The signer's identity was verified against the Lolly CA root pinned in this app (the same root <code>lolly validate --trust-anchor</code> uses). Validators that don't pin that root — {link}, or <code>c2patool</code> without <code>--trust_anchors</code> — still show the signer as an unknown source.", { link: '<a href="https://verify.contentauthenticity.org/" target="_blank" rel="noopener">verify.contentauthenticity.org</a>' })
      : t('<strong>Checked entirely on this device</strong> — the file was not uploaded. The same file on {link} reads the same, with the signer shown as an unknown source (there is no CA behind an on-device key — by design).', { link: '<a href="https://verify.contentauthenticity.org/" target="_blank" rel="noopener">verify.contentauthenticity.org</a>' })) : ''}
    </div>`;
}

const MASONRY_BREAKPOINT = '(min-width: 780px)';

// True masonry: each card lands in whichever column is CURRENTLY shortest, not
// wherever a fixed CSS column-count's strictly-sequential fill would put it.
// column-count fills column 1 (in DOM order) up to a computed height before
// spilling into column 2 — so one dominant card (a long change history / input
// record) can tip its ENTIRE column over while a short sibling column sits
// mostly empty, stranding the next cards behind the tall one instead of beside
// it. Greedy shortest-column placement is what actually keeps every card
// visible near the top instead of trailing a long one.
// Cards are tagged with their template order (data-m-idx) the first time this
// runs, since shortest-column placement doesn't preserve a simple document-order
// split — a later re-layout (crossing the column-count breakpoint) needs that
// original order to rebuild from, not whatever order cards ended up in last time.
function layoutMasonry(container: HTMLElement): void {
  if (!container.offsetParent) return; // closed <details> body — re-runs once opened (see wireMasonry)
  const cols = window.matchMedia(MASONRY_BREAKPOINT).matches ? 2 : 1;
  if (container.dataset.masonryCols === String(cols)) return;
  const cards = Array.from(container.querySelectorAll<HTMLElement>('.valid-panel, .valid-meta'));
  if (!cards.length) return;
  cards.forEach((c, i) => { if (c.dataset.mIdx === undefined) c.dataset.mIdx = String(i); });
  cards.sort((a, b) => Number(a.dataset.mIdx) - Number(b.dataset.mIdx));
  container.dataset.masonryCols = String(cols);
  // Never open more columns than there are cards — a lone summary panel (no
  // claim found, so made-from/steps/checks are all empty) should stay full-width
  // rather than sit at half-width beside a dead empty column.
  const activeCols = Math.min(cols, cards.length);
  if (activeCols <= 1) {
    cards.forEach((c) => container.appendChild(c));
    container.querySelectorAll(':scope > .valid-panels-col').forEach((el) => el.remove());
    return;
  }
  const colEls = Array.from({ length: activeCols }, () => {
    const col = document.createElement('div');
    col.className = 'valid-panels-col';
    return col;
  });
  container.replaceChildren(...colEls);
  const heights = new Array(activeCols).fill(0);
  for (const card of cards) {
    let shortest = 0;
    for (let i = 1; i < activeCols; i++) if (heights[i]! < heights[shortest]!) shortest = i;
    colEls[shortest]!.appendChild(card);
    heights[shortest] = colEls[shortest]!.getBoundingClientRect().height;
  }
}

// Wires the column-count breakpoint (re-lays-out every currently-visible
// .valid-panels on crossing it) and, since a batch report's cards start
// collapsed (display:none — nothing to measure), a capture-phase `toggle`
// listener: <details> doesn't bubble that event, but capture still reaches it
// from an ancestor. Also fires for the "Expand all" button, which flips `.open`
// programmatically (that still dispatches toggle).
function wireMasonry(viewEl: HTMLElement, reportEl: HTMLElement): void {
  const relayout = (): void => {
    reportEl.querySelectorAll<HTMLElement>('.valid-panels').forEach(layoutMasonry);
  };
  reportEl.addEventListener('toggle', (e) => {
    const details = e.target as HTMLElement;
    if ((details as HTMLDetailsElement).open) details.querySelectorAll<HTMLElement>('.valid-panels').forEach(layoutMasonry);
  }, true);
  const mq = window.matchMedia(MASONRY_BREAKPOINT);
  mq.addEventListener('change', relayout);
  const prev = (viewEl as HTMLElement & { _cleanup?: () => void })._cleanup;
  (viewEl as HTMLElement & { _cleanup?: () => void })._cleanup = () => {
    prev?.();
    mq.removeEventListener('change', relayout);
  };
}

export async function mountValid(viewEl: HTMLElement, host: HostV1): Promise<void> {
  document.title = 'Verify — Lolly';

  viewEl.innerHTML = `
    <a href="#/" class="tools-home home-full">${t('Tools')}</a>
    <div class="gallery-topright">${langFabHtml()}</div>
    <div class="platform-layout valid-layout">
      <header class="plat-header">
        <h1 class="plat-title">${t('Verify')}</h1>
        <div class="plat-header-text">
          <p class="plat-sub">${t("Check a file's Content Credentials — the signed C2PA manifest Lolly embeds on export. Answers whether it was genuinely made with Lolly, by whom, and where. On-device; nothing is uploaded.")}</p>
        </div>
      </header>

      <div class="valid-drop" data-drop tabindex="0" role="button" aria-label="${escape(t('Choose or drop files to verify'))}">
        <input type="file" multiple accept=".pdf,.pptx,.png,.apng,.jpg,.jpeg,.gif,.svg,.tif,.tiff,.webp,.mp4,.m4v,.mov,.webm,.mkv,application/pdf,${PPTX_MIME},image/png,image/jpeg,image/gif,image/svg+xml,image/tiff,image/webp,video/mp4,video/webm,video/x-matroska" hidden>
        <span class="valid-drop-icon" aria-hidden="true">${ICON_SHIELD}</span>
        <strong>${t('Drop files here')}</strong>
        <span>${t('pdf · png · jpg · gif · svg · tiff · webp · mp4 · webm — check one or several at once')}</span>
      </div>

      <div class="valid-report" data-report hidden></div>
    </div>
  `;
  armViewEnter(viewEl, '.tools-home, .plat-header, .valid-drop');
  attachLangMenu(viewEl.querySelector<HTMLElement>('.lang-fab'), host);

  const drop = viewEl.querySelector<HTMLElement>('[data-drop]')!;
  const input = drop.querySelector<HTMLInputElement>('input[type="file"]')!;
  const reportEl = viewEl.querySelector<HTMLElement>('[data-report]')!;
  wireMasonry(viewEl, reportEl);

  // Verify one file's bytes, returning its C2PA report, its embedded metadata
  // (EXIF/XMP/… — PDF via the shell's pdf bridge, everything else on the engine),
  // or an error message. Kept narrow so both the single- and multi-file paths
  // share the exact engine call. Bytes are read once and reused for both reads.
  async function verifyFile(file: File): Promise<{ report?: VerifyReport; error?: string; meta?: FileMetadata; watermark?: Watermark; mine?: LocalExportMatch; seal?: SealVerifyResult }> {
    try {
      if (file.size > MAX_VERIFY_BYTES) {
        return { error: t('File is too large to verify here (over {n} MB).', { n: Math.round(MAX_VERIFY_BYTES / 1024 / 1024) }) };
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      const report = await verifyC2pa(bytes, VERIFY_OPTS);
      // SEAL runs on the same bytes, on-device. verifySeal parses first and only
      // reaches out for a DNS public-key lookup when a SEAL record is actually
      // present — so a normal (non-SEAL) file triggers zero network I/O. The
      // image itself is never sent; only the domain the record names is looked up.
      const seal = await verifySeal(bytes, resolveSealKey);
      const meta = await readMetadata(bytes);
      let { watermark, lsb } = await pixelChecks(file, report.format) ?? {};
      // A container file (.pptx / PDF) can carry the Imprint inside an embedded
      // raster even though the file itself isn't one Lolly signs directly. Only
      // scan when the top-level pixel check found no mark of its own.
      if (!watermark?.present) {
        const embedded = await containerImprintScan(file, report.format, bytes);
        if (embedded?.present) watermark = embedded;
      }
      // The LSB verdict rides on the metadata object (it's "what the file
      // quietly carries", same as the appended-payload read) — one object
      // through the render pipeline instead of another parallel param.
      if (meta && lsb) {
        meta.lsb = lsb;
        if (lsb.suspicious) {
          meta.fields.push({ label: 'LSB analysis', value: t('pixel pair statistics match LSB steganography'), group: 'technical', sensitive: true });
        }
      }
      const mine = await localExportByHash(bytes);
      return { report, meta, watermark, mine, seal };
    } catch (err) {
      return { error: (err as Error)?.message || String(err) };
    }
  }

  // "You made this here": match the checked bytes back to this device's own export
  // history by SHA-256 (the contentHash recordExport stores at download time). The
  // history is read once per mount; no hashing at all when no entry carries a hash
  // (pre-hash records, insecure contexts). Best-effort — never fails a verify.
  let exportsByHash: Map<string, { href: string; at: number }> | null = null;
  async function localExportByHash(bytes: Uint8Array): Promise<LocalExportMatch | undefined> {
    try {
      if (!exportsByHash) {
        const { listExports, exportReopenHref } = await import('../lib/export-history.ts');
        // listExports is newest-first; reverse so a re-downloaded file's NEWEST
        // record wins the Map (last set for a duplicate hash).
        exportsByHash = new Map((await listExports(24))
          .filter((e) => e.contentHash)
          .reverse()
          .map((e) => [e.contentHash!, { href: exportReopenHref(e), at: e.at }]));
      }
      if (!exportsByHash.size) return undefined;
      const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
      const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
      return exportsByHash.get(hex);
    } catch { return undefined; }
  }

  // Decode a raster file to RGBA once and run every pixel-domain check on it:
  // the engine's Lolly-Imprint detector, plus chi-square LSB steganalysis for
  // PNG (the real-world LSB carrier — a lossy format's decoded LSBs are codec
  // noise, not hidden bits, so the analysis would be meaningless there).
  // NB: no downscale — the Imprint must see native-resolution pixels (a resize
  // shifts the 8×8 grid and erases the mark). Best-effort; anything we can't
  // decode (TIFF, SVG, PDF, video) or that faults returns undefined.
  async function pixelChecks(file: File, format: string | null): Promise<{ watermark?: Watermark; lsb?: FileMetadata['lsb'] } | undefined> {
    const fmt = (format || file.name.split('.').pop() || '').toLowerCase();
    if (!WM_DECODABLE.has(fmt)) return undefined;
    let bmp: ImageBitmap | undefined;
    try {
      bmp = await createImageBitmap(file);
      const w = bmp.width, h = bmp.height;
      if (w < 8 || h < 8) return undefined;
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return undefined;
      ctx.drawImage(bmp, 0, 0);
      const { data } = ctx.getImageData(0, 0, w, h);
      // FAST PATH: a pristine (un-cropped, un-resized) Lolly export detects on this
      // single pass at zero extra cost — the dominant real-world outcome. Only on a
      // MISS do we pay for the crop-recovery offset search (Tier 1: 64 block-phase
      // offsets, NO resample), so an un-resized file stays instant. The resample-
      // heavy scale search (Tier 2) is opt-in per file — never run automatically here.
      const r = detectWatermark(data, { width: w, height: h });
      let present = r.present, score = r.score;
      if (!r.present) {
        const searched = await detectWatermarkSearch(data, { width: w, height: h }, { tier: 1 });
        if (searched.present) {
          present = true; score = searched.score;
          host.log('debug', 'valid: pixel search recovered mark', {
            tier: searched.tier, scale: searched.scale, offsetX: searched.offsetX, offsetY: searched.offsetY,
            hypothesesTried: searched.hypothesesTried, score: +searched.score.toFixed(4),
          });
        }
      }
      const lsb = fmt === 'png' ? analyzeLsb(data, { width: w, height: h }) : undefined;
      return {
        watermark: { present, score },
        lsb: lsb ? { suspicious: lsb.suspicious, score: lsb.score } : undefined,
      };
    } catch {
      return undefined;
    } finally {
      bmp?.close?.();
    }
  }

  // ── Lolly Imprint inside a container file's embedded rasters ─────────────
  // A .pptx or PDF isn't a raster Lolly signs directly, but it can CARRY rasters
  // Lolly rendered (a rasterised slide, a baked CSS fallback) that hold the
  // pixel Imprint. We decode each embedded image at its NATIVE stored resolution
  // (no resize — the mark rides an 8×8 grid a resize would shift) and run the
  // engine detector. Only a POSITIVE hit surfaces (absence is uninformative and
  // must never read as "not made with Lolly"); the unzip/pdf-parse + canvas
  // decode stay shell-side, the enumeration + detection math are engine-pure.
  const CONTAINER_IMG_CAP = 48; // hard bound on images decoded from one container
  const YIELD_EVERY = 6;        // cooperative yield so a big deck doesn't jank the tab

  // Decode encoded image bytes (png/jpeg) to RGBA via a canvas — the same 4-step
  // path pixelChecks uses, but from a byte blob rather than the dropped File.
  async function decodeBytesToRgba(bytes: Uint8Array, mime: string): Promise<{ data: Uint8ClampedArray; width: number; height: number } | undefined> {
    let bmp: ImageBitmap | undefined;
    try {
      bmp = await createImageBitmap(new Blob([bytes as BlobPart], { type: mime }));
      const w = bmp.width, h = bmp.height;
      if (w < 8 || h < 8) return undefined; // too small to carry a mark (detector no-ops anyway)
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return undefined;
      ctx.drawImage(bmp, 0, 0);
      const { data } = ctx.getImageData(0, 0, w, h);
      return { data, width: w, height: h };
    } catch {
      return undefined;
    } finally {
      bmp?.close?.();
    }
  }

  // First embedded image whose pixels clear the Imprint threshold wins — we stop
  // there (presence-only; no count is claimed). Returns the strongest score seen
  // so the caller can log even a near-miss. Never throws.
  async function scanRgbaImages(items: Array<{ bytes: Uint8Array; mime: string }>): Promise<{ present: boolean; score: number; scanned: number }> {
    let best = 0, scanned = 0;
    for (let i = 0; i < items.length; i++) {
      const rgba = await decodeBytesToRgba(items[i]!.bytes, items[i]!.mime);
      if (!rgba) continue;
      scanned++;
      const r = detectWatermark(rgba.data, { width: rgba.width, height: rgba.height });
      if (r.score > best) best = r.score;
      if (r.present) return { present: true, score: r.score, scanned };
      if (scanned % YIELD_EVERY === 0) await new Promise((res) => setTimeout(res, 0));
    }
    return { present: false, score: best, scanned };
  }

  // .pptx → unzip (fflate, shell-side), enumerate ppt/media/*.{png,jpg,jpeg}
  // (engine pptxMediaImages), decode + detect. Best-effort; never throws.
  async function pptxImprintScan(bytes: Uint8Array): Promise<Watermark | undefined> {
    try {
      const parts = await inflatePptx(bytes);
      if (!isPptx(parts)) return undefined;
      const media = pptxMediaImages(parts, CONTAINER_IMG_CAP);
      if (!media.length) {
        // A native-vector deck (text boxes, roundRect shapes, gradient/solid fills)
        // holds no raster in ppt/media at all — so there is nothing an 8×8-block
        // pixel Imprint could ride. This is the EXPECTED shape of an ordinary
        // deck-builder/deck-studio export, not a broken scan: absence stays
        // uninformative and surfaces NOTHING negative. Logged (neutral) so the
        // trail explains why a green deck reads clean.
        host.log('debug', 'valid: pptx has no raster media; Lolly Imprint only rides embedded raster images, not vector slides');
        return undefined;
      }
      const items: Array<{ bytes: Uint8Array; mime: string }> = [];
      for (const m of media) {
        const b = parts[m.path];
        if (b instanceof Uint8Array) items.push({ bytes: b, mime: m.mime });
      }
      const r = await scanRgbaImages(items);
      host.log('debug', 'valid: pptx imprint scan', { media: media.length, scanned: r.scanned, present: r.present, score: +r.score.toFixed(4) });
      // r.present === false here means the deck's rasters are byte-faithful USER
      // uploads (photos, an SVG logo's PNG fallback) — correctly unmarked, not a
      // failed detect. Still surface nothing; never render absence as "clean".
      return r.present ? { present: true, score: r.score, embedded: true } : undefined;
    } catch { return undefined; }
  }

  // PDF → decode the DCTDecode (JPEG) + non-predictor Flate RGB/Gray image
  // XObjects at native resolution (extractPdfImageBytes, pdf-lib), detect.
  // GAP (logged, not faked): jsPDF's own FlateDecode-with-PNG-predictor rasters
  // — what a future imprint-on-embed would write into a PDF — and JPX/CCITT/JBIG2
  // images are NOT decodable by this path yet, so a mark inside one is invisible
  // here. A pure-VECTOR Lolly PDF (QR, lockup) carries no raster XObject at all,
  // so it can hold no pixel Imprint by construction. We surface only real hits
  // and record what we couldn't read, so "no hit" is never shown as "clean".
  async function pdfImprintScan(file: File): Promise<Watermark | undefined> {
    try {
      const { extractPdfImageBytes } = await import('./pdf-import.ts');
      const { images, skipped, skippedFilters } = await extractPdfImageBytes(file, { max: CONTAINER_IMG_CAP });
      if (skipped > 0) {
        host.log('info', 'valid: pdf imprint scan skipped undecodable images', { skipped, filters: skippedFilters });
      }
      if (!images.length) return undefined;
      const r = await scanRgbaImages(images);
      host.log('debug', 'valid: pdf imprint scan', { images: images.length, scanned: r.scanned, present: r.present, score: +r.score.toFixed(4) });
      return r.present ? { present: true, score: r.score, embedded: true } : undefined;
    } catch (err) {
      host.log('warn', 'valid: pdf imprint scan failed', { error: (err as Error)?.message });
      return undefined;
    }
  }

  // Dispatch a container file to its embedded-raster Imprint scan. Only runs when
  // the top-level pixel check found nothing (a raster Lolly signs directly is
  // handled there); a non-container file returns undefined and shows nothing.
  async function containerImprintScan(file: File, format: string | null, bytes: Uint8Array): Promise<Watermark | undefined> {
    if (looksLikePptxFile(file)) return pptxImprintScan(bytes);
    if (format === 'pdf' || /\.pdf$/i.test(file.name)) return pdfImprintScan(file);
    return undefined;
  }

  // ── Deep scan for watermarks (Adobe TrustMark) ──────────────────────────
  // A SEPARATE decode from pixelChecks' — deliberately: pixelChecks always
  // runs (every verify), so keeping it free of anything that would pull in
  // onnxruntime-web is what makes the default /verify path stay instant.
  // This one only runs when the user clicks the button, and imports
  // lib/trustmark.ts lazily right there.
  async function decodeToRgba(file: File): Promise<{ data: Uint8ClampedArray; width: number; height: number } | undefined> {
    let bmp: ImageBitmap | undefined;
    try {
      bmp = await createImageBitmap(file);
      const w = bmp.width, h = bmp.height;
      if (w < 8 || h < 8) return undefined;
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return undefined;
      ctx.drawImage(bmp, 0, 0);
      const { data } = ctx.getImageData(0, 0, w, h);
      return { data, width: w, height: h };
    } catch {
      return undefined;
    } finally {
      bmp?.close?.();
    }
  }

  // Injects a detected deep-scan pip into the report's LIVE hero scorecard —
  // positioned RIGHT AFTER the "Made with Lolly" verdict pip (always the first
  // pip), NOT appended after the eight C2PA checks: a real TrustMark/Content Seal
  // read is a top-line provenance signal and belongs beside the verdict. Multiple
  // hits cluster in call order (marked with data-deepscan-pip so the second lands
  // after the first). If the report had no scorecard at all (a file with no C2PA,
  // no Lolly Imprint and no AI declaration), one is created from scratch. Mutates
  // the live DOM rather than re-rendering, so scroll/open-<details>/masonry are
  // undisturbed. Also mirrored into the collapsed row's mini scorecard.
  function injectDeepScanPip(deepscanEl: HTMLElement, pip: ScorecardItem): void {
    // Tag the pip so a later hit inserts after it, keeping the cluster ordered.
    const tag = (html: string): string => html.replace('<li ', '<li data-deepscan-pip ');
    // Place `html` right after the verdict pip (list.firstElementChild) or after
    // the last already-injected deep-scan pip; fall back to append on an empty list.
    const place = (list: HTMLElement, html: string): void => {
      const injected = list.querySelectorAll<HTMLElement>(':scope > [data-deepscan-pip]');
      const anchor = injected.length ? injected[injected.length - 1]! : list.firstElementChild;
      if (anchor) anchor.insertAdjacentHTML('afterend', html);
      else list.insertAdjacentHTML('beforeend', html);
    };

    const resultCard = deepscanEl.closest<HTMLElement>('.valid-result');
    const scoreList = resultCard?.querySelector<HTMLElement>('.valid-score:not(.valid-score--mini)');
    const pipHtml = tag(scorecardPipHtml(pip, 0));
    if (scoreList) {
      place(scoreList, pipHtml);
    } else {
      deepscanEl.insertAdjacentHTML('beforebegin',
        `<ul class="valid-score" aria-label="${escape(t('Verification checks at a glance'))}">${pipHtml}</ul>`);
    }
    // Mirror into the collapsed row's MINI scorecard (multi-file cards only —
    // single-file reports have no summary), so a hit shows in the summary without
    // expanding. Create the mini list if the summary had none. Same "after the
    // verdict pip" placement as the full scorecard.
    const summary = deepscanEl.closest<HTMLElement>('.valid-item')?.querySelector<HTMLElement>(':scope > .valid-item-summary');
    if (summary) {
      let mini = summary.querySelector<HTMLElement>('.valid-score--mini');
      if (!mini) {
        mini = document.createElement('ul');
        mini.className = 'valid-score valid-score--mini';
        mini.setAttribute('aria-hidden', 'true');
        summary.insertBefore(mini, summary.querySelector('.valid-item-chev'));
      }
      place(mini, tag(miniScorePipHtml(pip)));
    }
  }

  // Passive per-file scan: decode the file's pixels ONCE, run BOTH detectors
  // (Adobe TrustMark + Meta Content Seal) in cacheOnly mode (NEVER downloads —
  // that's the header banner's one-time job), and — ONLY on a positive
  // detection — inject that maker's green/amber pip + note. Absence is never
  // shown as a verdict (per plans/watermark-detectors.md): a negative or
  // not-installed scan stays silent. Runs at most once per file per batch.
  const scannedIndexes = new Set<number>();
  async function scanOne(fileIndex: number): Promise<void> {
    if (scannedIndexes.has(fileIndex)) return;
    const file = activeFiles[fileIndex];
    const block = reportEl.querySelector<HTMLElement>(`[data-deepscan-block="${fileIndex}"]`);
    const resultEl = block?.querySelector<HTMLElement>(`[data-deepscan-result="${fileIndex}"]`);
    if (!file || !block || !resultEl) return;
    scannedIndexes.add(fileIndex);
    try {
      const [pixels, { detectTrustmark }, { detectContentSeal }] = await Promise.all([
        decodeToRgba(file),
        import('../lib/trustmark.ts'),
        import('../lib/contentseal.ts'),
      ]);
      if (!pixels) return;
      const [tm, cs] = await Promise.all([
        detectTrustmark(pixels.data, pixels.width, pixels.height, { cacheOnly: true }),
        detectContentSeal(pixels.data, pixels.width, pixels.height, { cacheOnly: true }),
      ]);
      let shown = false;
      if (tm.status === 'detected') {
        injectDeepScanPip(block, trustmarkPip());
        resultEl.insertAdjacentHTML('beforeend', trustmarkNoteHtml(tm.payloadHex ?? '', tm.schema ?? ''));
        shown = true;
      }
      if (cs.status === 'detected') {
        injectDeepScanPip(block, contentSealPip());
        resultEl.insertAdjacentHTML('beforeend', contentSealNoteHtml(cs.messageHex ?? ''));
        shown = true;
      }
      if (shown) { block.hidden = false; const p = block.closest<HTMLElement>('.valid-panels'); if (p) layoutMasonry(p); }
    } catch (err) {
      // Passive + best-effort: never surface a failure inline (models may just
      // not be cached). scannedIndexes stays set so it isn't retried on a
      // re-expand; the header banner is the path to (re)enable.
      host.log('warn', 'valid: passive deep scan failed', { error: (err as Error)?.message });
    }
  }

  // Scan every decodable raster in the current batch (cacheOnly). Sequential so a
  // large drop doesn't fire N decodes + inferences at once; pips pop in as each
  // completes. Files already scanned (scannedIndexes) are skipped.
  async function scanAllDecodable(): Promise<void> {
    for (let i = 0; i < activeFiles.length; i++) {
      if (isDeepScannable(null, activeFiles[i]!.name)) await scanOne(i);
    }
  }

  // Opt-in Tier-2 "resized Imprint" search (imprintRescanBlock's button). Re-decode
  // the file's pixels ONCE, run the full scale×offset grid, and — only on a hit —
  // inject the standard Lolly-Imprint pip + note in place (injectDeepScanPip, same
  // DOM-mutation path as the deep-scan pips, so scroll/masonry/open-state survive).
  // A miss updates the button quietly; absence never reads as "not made with Lolly".
  async function rescanImprint(btn: HTMLButtonElement): Promise<void> {
    const fileIndex = Number(btn.dataset.imprintRescan);
    const file = activeFiles[fileIndex];
    const block = reportEl.querySelector<HTMLElement>(`[data-imprint-rescan-block="${fileIndex}"]`);
    const resultEl = block?.querySelector<HTMLElement>(`[data-imprint-rescan-result="${fileIndex}"]`);
    if (!file || !block || !resultEl) return;
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = t('Searching the pixels…');
    try {
      const pixels = await decodeToRgba(file);
      if (!pixels) { btn.textContent = t('Couldn’t read this image.'); return; }
      const found = await detectWatermarkSearch(pixels.data, { width: pixels.width, height: pixels.height }, { tier: 2 });
      if (found.present) {
        host.log('debug', 'valid: tier-2 imprint search recovered mark', {
          scale: found.scale, offsetX: found.offsetX, offsetY: found.offsetY,
          hypothesesTried: found.hypothesesTried, score: +found.score.toFixed(4),
        });
        injectDeepScanPip(btn, lollyImprintPip());
        block.outerHTML = watermarkNote({ present: true, score: found.score });
        reportEl.querySelectorAll<HTMLElement>('.valid-panels').forEach(layoutMasonry);
      } else {
        btn.textContent = t('No resized Imprint found');
        resultEl.insertAdjacentHTML('beforeend',
          `<span class="valid-wm-rescan-miss">${t('This image carries no recoverable Lolly Imprint. That doesn’t rule out a Lolly origin — an aggressive downscale erases the Imprint entirely.')}</span>`);
      }
    } catch (err) {
      btn.disabled = false;
      btn.textContent = original;
      host.log('warn', 'valid: tier-2 imprint search failed', { error: (err as Error)?.message });
    }
  }

  /** `bytes` → "12.3 MB", for the download-progress label. Low-bandwidth by
   *  design: one decimal place, no locale-aware NumberFormat machinery. */
  function formatMb(bytes: number): string {
    return `${(bytes / (1000 * 1000)).toFixed(1)} MB`;
  }

  // The header banner's one-time "Enable" — download the detectors ONCE (network
  // allowed) so the whole batch benefits, then scan everything from cache.
  async function enableDeepScan(btn: HTMLButtonElement): Promise<void> {
    const banner = btn.closest<HTMLElement>('[data-deepscan-banner]');
    const msg = banner?.querySelector<HTMLElement>('[data-deepscan-banner-msg]');
    const bar = banner?.querySelector<HTMLElement>('[data-deepscan-progress]');
    const fill = banner?.querySelector<HTMLElement>('[data-deepscan-progress-fill]');
    btn.disabled = true;
    if (msg) msg.textContent = t('Downloading the detector (~90 MB, once)…');
    bar?.removeAttribute('hidden');
    bar?.classList.add('is-indeterminate');

    // Combines BOTH downloads (TrustMark's ~90 MB decoders + Content Seal's
    // usually-absent extractor) into one running bar. `startedX` distinguishes
    // "never fetched" (a 404 that fires before a single onProgress call — the
    // common Content Seal case) from "fetching, size unknown", so a model that
    // simply isn't vendored can't drag the whole bar into indeterminate.
    let loadedTm = 0, totalTm: number | null = null, startedTm = false;
    let loadedCs = 0, totalCs: number | null = null, startedCs = false;
    const render = (): void => {
      if (!bar || !fill) return;
      const loaded = loadedTm + loadedCs;
      const totalKnown = (!startedTm || totalTm != null) && (!startedCs || totalCs != null);
      const total = totalKnown ? (totalTm ?? 0) + (totalCs ?? 0) : null;
      if (total != null && total > 0) {
        bar.classList.remove('is-indeterminate');
        bar.setAttribute('aria-valuemin', '0');
        bar.setAttribute('aria-valuemax', String(total));
        bar.setAttribute('aria-valuenow', String(Math.min(loaded, total)));
        fill.style.width = `${Math.min(100, (loaded / total) * 100)}%`;
        if (msg) msg.textContent = t('Downloading the detector… {loaded} of {total}', { loaded: formatMb(loaded), total: formatMb(total) });
      } else {
        bar.classList.add('is-indeterminate');
        bar.removeAttribute('aria-valuenow');
        bar.removeAttribute('aria-valuemax');
        if (msg) msg.textContent = t('Downloading the detector… {loaded} so far', { loaded: formatMb(loaded) });
      }
    };

    try {
      const [{ prefetchTrustmarkModels }, { prefetchContentSealModel }] = await Promise.all([
        import('../lib/trustmark.ts'),
        import('../lib/contentseal.ts'),
      ]);
      const ok = await prefetchTrustmarkModels({
        onProgress: (p) => { startedTm = true; loadedTm = p.loaded; totalTm = p.total; render(); },
      });
      await prefetchContentSealModel({
        onProgress: (p) => { startedCs = true; loadedCs = p.loaded; totalCs = p.total; render(); },
      }).catch(() => false); // best-effort; usually absent
      if (!ok) {
        if (msg) msg.textContent = t('Couldn’t download the watermark detector. Check your connection and try again.');
        bar?.setAttribute('hidden', '');
        btn.disabled = false;
        return;
      }
      banner?.remove();
      await scanAllDecodable();
    } catch (err) {
      if (msg) msg.textContent = t('Couldn’t enable deep scanning in this browser.');
      bar?.setAttribute('hidden', '');
      btn.disabled = false;
      host.log('warn', 'valid: enable deep scan failed', { error: (err as Error)?.message });
    }
  }

  // After a batch renders: if the detector models are already on-device, scan
  // everything automatically (no decision for the user). If not, show ONE
  // consent banner at the top of the report so a single download serves the whole
  // batch. Never auto-downloads. `hasDecodable` guards against showing the banner
  // for a PDF/SVG/video-only batch that can't be deep-scanned at all.
  async function armDeepScan(hasDecodable: boolean): Promise<void> {
    if (!hasDecodable) return;
    let ready = false;
    try {
      const { trustmarkModelsReady } = await import('../lib/trustmark.ts');
      ready = await trustmarkModelsReady();
    } catch { ready = false; }
    if (ready) { void scanAllDecodable(); return; }
    const decodableCount = activeFiles.filter((f) => isDeepScannable(null, f.name)).length;
    reportEl.insertAdjacentHTML('afterbegin', deepScanBannerHtml(decodableCount));
  }

  // Which section a PDF finding's label belongs in (its findings arrive as flat
  // {label, detail, tone} rows from host.pdf.analyze).
  const pdfGroup = (label: string): MetaGroup => {
    const l = label.toLowerCase();
    if (l === 'created' || l === 'modified' || l.includes('date')) return 'timestamps';
    if (l.includes('produc') || l.includes('created with') || l.includes('creatortool') || l.includes('software')) return 'software';
    if (l.includes('author') || l.includes('creator')) return 'authorship';
    if (l.includes('title') || l.includes('subject') || l.includes('keyword')) return 'description';
    return 'description';
  };

  // PDF is parsed by the shell (pdf-lib, via host.pdf.analyze); every other format
  // is read by the DOM-free engine extractor. Never throws — worst case, undefined.
  async function readMetadata(bytes: Uint8Array): Promise<FileMetadata | undefined> {
    const isPdf = bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
    if (!isPdf) return extractFileMetadata(bytes);
    try {
      const findings = (await host.pdf?.analyze(bytes))?.findings ?? [];
      return {
        format: 'PDF',
        fields: findings.map((f) => ({ label: f.label, value: f.detail, group: pdfGroup(f.label), sensitive: f.tone === 'warn' })),
      };
    } catch { return undefined; }
  }

  // A collapsed report whose credential check failed to even run (unreadable bytes).
  function errorSummary(fileName: string, message: string): string {
    return `<summary class="valid-item-summary">
        <span class="valid-item-badge is-bad">${t('Error')}</span>
        <span class="valid-item-name">${escape(fileName)}</span>
        <span class="valid-item-chev" aria-hidden="true">${ICON_CHEVRON}</span>
      </summary>
      <div class="valid-item-body"><p class="valid-busy">${t('Could not check this file: {message}', { message: escape(message) })}</p></div>`;
  }

  // Object URLs minted for the media previews. Revoked wholesale at the start of
  // the next check so a fresh drop never leaks the previous batch's blobs.
  let previewUrls: string[] = [];
  function makePreview(file: File, report?: VerifyReport): Preview {
    const kind = previewKind(report?.format ?? null, file.name);
    const format = report?.format || (file.name.split('.').pop() || '');
    const url = kind === 'none' ? undefined : URL.createObjectURL(file);
    if (url) previewUrls.push(url);
    return { url, kind, format, name: file.name };
  }

  // The File objects behind the current batch of reports, indexed exactly like the
  // cards/reportBody calls below — so a "download a cleaned copy" click (delegated
  // on reportEl, see wireCleanCopy) can re-read the right file's bytes on demand
  // rather than holding every batch's bytes in memory between renders.
  let activeFiles: File[] = [];
  // Each report's scalar-input digest, same indexing — what a [data-recreate]
  // click (the "Recreate with these settings" CTA) seeds the tool link from.
  let activeDigests: Array<Record<string, string> | undefined> = [];

  async function handle(files: FileList | File[] | null | undefined): Promise<void> {
    const list = files ? [...files] : [];
    if (!list.length) return;
    previewUrls.forEach((u) => URL.revokeObjectURL(u));
    previewUrls = [];
    activeFiles = list;
    activeDigests = [];
    scannedIndexes.clear(); // fresh batch — allow each file to be scanned again
    reportEl.hidden = false;

    // One file reads exactly as before — the full report inline, no collapse chrome.
    if (list.length === 1) {
      const file = list[0]!;
      reportEl.innerHTML = `<div class="valid-reports-list"><p class="valid-busy">${t('Checking {name}…', { name: escape(file.name) })}</p></div>`;
      const { report, error, meta, watermark, mine, seal } = await verifyFile(file);
      activeDigests[0] = report?.environment?.inputs;
      reportEl.querySelector('.valid-reports-list')!.innerHTML = report
        ? renderReportBody(file.name, report, meta, makePreview(file, report), 0, watermark, mine, seal)
        : `<p class="valid-busy">${t('Could not check this file: {message}', { message: escape(error!) })}</p>`;
      const panels = reportEl.querySelector<HTMLElement>('.valid-panels');
      if (panels) layoutMasonry(panels);
      // Audible verdict, as two composable signals: the spooky ghost "hoooo" marks
      // AI-generated content, the bright "signing" chirps mark an intact Lolly make.
      // A file that's BOTH gets the chirps over the ooo; any OTHER AI file gets the
      // ooo alone (no chirps); a non-AI file keeps the usual verdict — chirps if
      // intact, a soft cautionary "uh-oh" if broken, missing, or unreadable.
      if (report?.aiGenerated || meta?.ai) {
        if (report?.madeWithLolly) playSfx('sign');
        playSfx('ghost');
      } else {
        playSfx(report?.state === 'valid' ? 'sign' : 'warn');
      }
      reportEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      // Auto-scan if models are on-device, else offer the one-time header banner.
      if (report) void armDeepScan(isDeepScannable(report.format, file.name));
      return;
    }

    // Several files → a stack of collapsible reports. Default collapsed so the whole
    // batch reads as a column of highlight bars; expand any one for its full report.
    reportEl.innerHTML = `
      <div class="valid-reports-bar">
        <span class="valid-reports-count">${t('{n} files', { n: list.length })}</span>
        <div class="valid-reports-actions">
          <button type="button" class="btn valid-reports-toggle" data-expand>${t('Expand all')}</button>
          <button type="button" class="btn valid-reports-toggle" data-collapse>${t('Collapse all')}</button>
        </div>
      </div>
      <div class="valid-reports-list"></div>`;
    const listEl = reportEl.querySelector<HTMLElement>('.valid-reports-list')!;
    const setAll = (open: boolean): void => listEl.querySelectorAll('details').forEach((d) => { d.open = open; });
    reportEl.querySelector('[data-expand]')!.addEventListener('click', () => setAll(true));
    reportEl.querySelector('[data-collapse]')!.addEventListener('click', () => setAll(false));

    // Place every card up-front in drop order (busy), so the list doesn't reflow as
    // each result lands. Verify sequentially — bounds memory to one file's bytes at a
    // time and fills the cards top-to-bottom as a visible progress cue.
    const cards = list.map((file) => {
      const card = document.createElement('details');
      card.className = 'valid-item is-busy';
      card.innerHTML = `<summary class="valid-item-summary">
          <span class="valid-item-badge is-busy">${t('Checking…')}</span>
          <span class="valid-item-name">${escape(file.name)}</span>
          <span class="valid-item-chev" aria-hidden="true">${ICON_CHEVRON}</span>
        </summary>
        <div class="valid-item-body"><p class="valid-busy">${t('Checking {name}…', { name: escape(file.name) })}</p></div>`;
      listEl.appendChild(card);
      return card;
    });
    reportEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    let allValid = true, anyAi = false, anyLolly = false;
    for (let i = 0; i < list.length; i++) {
      const file = list[i]!, card = cards[i]!;
      const { report, error, meta, watermark, mine, seal } = await verifyFile(file);
      activeDigests[i] = report?.environment?.inputs;
      if (report) {
        card.className = `valid-item is-${stateTone(report)}`;
        card.innerHTML = `<summary class="valid-item-summary">${summaryInner(file.name, report, meta, watermark, seal)}</summary>` +
          `<div class="valid-item-body">${renderReportBody(file.name, report, meta, makePreview(file, report), i, watermark, mine, seal)}</div>`;
      } else {
        card.className = 'valid-item is-bad';
        card.innerHTML = errorSummary(file.name, error!);
      }
      if (report?.state !== 'valid') allValid = false;
      if (report?.aiGenerated || meta?.ai) anyAi = true;
      if (report?.madeWithLolly) anyLolly = true;
    }
    // One summary verdict, mirroring the single-file rule: AI in the batch → the
    // ghost "hoooo", with the "signing" chirps over it ONLY when every file passed
    // and at least one is a Lolly make; a non-AI batch keeps the usual flourish.
    if (anyAi) {
      if (allValid && anyLolly) playSfx('sign');
      playSfx('ghost');
    } else {
      playSfx(allValid ? 'sign' : 'warn');
    }
    // Arm deep scanning for the batch — auto if the models are on-device, else a
    // single header banner so one download serves every file.
    void armDeepScan(list.some((f) => isDeepScannable(null, f.name)));
  }

  // Append "-clean" before the extension: report.pdf → report-clean.pdf.
  const cleanFileName = (name: string): string => {
    const dot = name.lastIndexOf('.');
    return dot > 0 ? `${name.slice(0, dot)}-clean${name.slice(dot)}` : `${name}-clean`;
  };
  const CLEAN_MIME: Record<string, string> = { jpeg: 'image/jpeg', png: 'image/png', svg: 'image/svg+xml' };

  // The quiet "download a cleaned copy" action beside the metadata reveal — same
  // lossless byte surgery as the Hidden Data tool (JPEG/PNG/SVG in-engine,
  // PDF via host.pdf.strip), offered right where a viewer just saw what the file
  // discloses, without sending them off to a separate tool.
  async function downloadCleanCopy(btn: HTMLButtonElement): Promise<void> {
    const file = activeFiles[Number(btn.dataset.cleanCopy)];
    const format = (btn.dataset.cleanFormat || '').toUpperCase();
    if (!file) return;
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = t('Cleaning…');
    try {
      if (file.size > MAX_VERIFY_BYTES) throw new Error('File is too large to clean here.');
      const bytes = new Uint8Array(await file.arrayBuffer());
      let outBytes: Uint8Array, mime: string;
      if (format === 'PDF') {
        if (!host.pdf?.strip) throw new Error('PDF cleaning isn’t available in this app.');
        ({ bytes: outBytes } = await host.pdf.strip(bytes));
        mime = 'application/pdf';
      } else {
        const fmt = format.toLowerCase() as StripFormat;
        outBytes = stripMetadata(bytes, fmt);
        mime = CLEAN_MIME[fmt] || 'application/octet-stream';
      }
      await host.export.file(new Blob([outBytes as BlobPart], { type: mime }), { filename: cleanFileName(file.name) });
      btn.textContent = t('Downloaded ✓');
    } catch (err) {
      btn.textContent = t('Couldn’t clean this file');
      host.log('warn', 'valid: clean-copy failed', { error: (err as Error)?.message });
    } finally {
      setTimeout(() => { btn.disabled = false; btn.textContent = original; }, 2000);
    }
  }
  // Append "-payload" before an extension derived from the sniffed kind:
  // report.jpg → report-payload.zip (for an appended zip), report-payload.bin
  // for anything unrecognised — never a name that invites a double-click.
  const payloadFileName = (name: string, kind: string): string => {
    const dot = name.lastIndexOf('.');
    const base = dot > 0 ? name.slice(0, dot) : name;
    return `${base}-payload.${payloadExt(kind)}`;
  };

  // Re-reads the file fresh and re-runs the same deterministic byte-offset
  // detection (engine/src/file-metadata.ts) rather than threading the offset
  // through dataset attributes — mirrors downloadCleanCopy's re-read-on-demand
  // pattern, and keeps a single source of truth for "where the payload starts".
  async function rereadAppended(fileIndex: number): Promise<{ file: File; bytes: Uint8Array; appended: NonNullable<FileMetadata['appended']> } | undefined> {
    const file = activeFiles[fileIndex];
    if (!file || file.size > MAX_VERIFY_BYTES) return undefined;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const appended = extractFileMetadata(bytes).appended;
    return appended ? { file, bytes, appended } : undefined;
  }

  // Toggles the inline hex/text preview on the appended-payload callout.
  // SECURITY: payloadPreviewHtml only ever escape()s a hex dump or decoded
  // text into this panel — there is no path from the (untrusted) payload
  // bytes to rendered/executed markup.
  async function viewPayload(btn: HTMLButtonElement): Promise<void> {
    const fileIndex = Number(btn.dataset.payloadView);
    const panel = reportEl.querySelector<HTMLElement>(`[data-payload-panel="${fileIndex}"]`);
    if (!panel) return;
    if (!panel.hidden) { panel.hidden = true; btn.textContent = t('View'); return; }
    btn.disabled = true;
    try {
      const found = await rereadAppended(fileIndex);
      panel.innerHTML = found
        ? payloadPreviewHtml(found.bytes.subarray(found.appended.offset), found.appended.kind)
        : `<p class="valid-busy">${t('Could not re-read this payload.')}</p>`;
      panel.hidden = false;
      btn.textContent = t('Hide');
    } catch (err) {
      panel.innerHTML = `<p class="valid-busy">${t('Could not re-read this payload.')}</p>`;
      panel.hidden = false;
      host.log('warn', 'valid: payload view failed', { error: (err as Error)?.message });
    } finally {
      btn.disabled = false;
    }
  }

  // The extraction download — same on-device re-read, sliced from the recorded
  // offset and handed to host.export.file untouched (no parsing, no re-encode).
  async function downloadPayload(btn: HTMLButtonElement): Promise<void> {
    const fileIndex = Number(btn.dataset.payloadDownload);
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = t('Extracting…');
    try {
      const found = await rereadAppended(fileIndex);
      if (!found) throw new Error('No appended payload found.');
      const payload = found.bytes.subarray(found.appended.offset);
      await host.export.file(new Blob([payload as BlobPart], { type: 'application/octet-stream' }), {
        filename: payloadFileName(found.file.name, found.appended.kind),
      });
      btn.textContent = t('Downloaded ✓');
    } catch (err) {
      btn.textContent = t('Couldn’t extract this');
      host.log('warn', 'valid: payload download failed', { error: (err as Error)?.message });
    } finally {
      setTimeout(() => { btn.disabled = false; btn.textContent = original; }, 2000);
    }
  }

  // "Recreate with these settings in <tool>" — turn the credential's scalar-input
  // digest back into a seeded tool link (lib/seed-url.ts — the same URL shape a
  // share of that look produces). The digest stores every value as a display
  // string (engine summarizeInputs): numbers may carry a unit ("12 mm"), booleans
  // are 'true'/'false' — coerce them per the manifest's input types before
  // seeding, or serializeUrlState would mis-encode them (a truthy 'false' string
  // serialises as boolean ON). Failure falls back to the anchor's blank-session href.
  async function recreateFromDigest(a: HTMLAnchorElement): Promise<void> {
    const toolId = a.dataset.recreateTool || '';
    const inputs = activeDigests[Number(a.dataset.recreate)];
    if (!toolId) return;
    try {
      const [{ getTool }, { toolSeedHref }] = await Promise.all([
        import('../bridge/tool-loader.ts'),
        import('../lib/seed-url.ts'),
      ]);
      const { manifest } = await getTool(toolId);
      const typeById = new Map(manifest.inputs.map((inp) => [inp.id, inp.type]));
      const values: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(inputs ?? {})) {
        const type = typeById.get(k);
        if (type === 'number') {
          const n = parseFloat(v);          // drops a trailing unit ("12 mm" → 12)
          if (!Number.isNaN(n)) values[k] = n;
        } else if (type === 'boolean') {
          values[k] = v === 'true';
        } else {
          values[k] = v;
        }
      }
      window.location.hash = await toolSeedHref(toolId, values);
    } catch {
      window.location.hash = `#/tool/${toolId}`;   // seeding failed — open a blank session
    }
  }
  reportEl.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-clean-copy]');
    if (btn) downloadCleanCopy(btn);
    const rec = (e.target as HTMLElement).closest<HTMLAnchorElement>('[data-recreate]');
    if (rec) { e.preventDefault(); void recreateFromDigest(rec); }
    const enable = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-deep-scan-enable]');
    if (enable) void enableDeepScan(enable);
    const rescan = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-imprint-rescan]');
    if (rescan) void rescanImprint(rescan);
    const view = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-payload-view]');
    if (view) void viewPayload(view);
    const dl = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-payload-download]');
    if (dl) void downloadPayload(dl);
  });

  drop.addEventListener('click', () => input.click());
  drop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
  });
  input.addEventListener('change', () => handle(input.files));
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('is-over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('is-over');
    handle(e.dataTransfer?.files);
  });

  // Arrived here from the catalog's "Check credentials" link? Verify that asset straight
  // away, and surface the handoff note (e.g. re-encoded-on-import caveat) above the report.
  const handoff = takePendingVerify();
  if (handoff?.files.length) {
    await handle(handoff.files);
    if (handoff.note) {
      reportEl.querySelector('.valid-reports-list')?.insertAdjacentHTML(
        'afterbegin',
        `<p class="valid-handoff-note">${escape(handoff.note)}</p>`,
      );
    }
  }
}
