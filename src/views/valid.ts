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
import { verifyC2pa, pemToDer, c2paTrustAnchors, extractFileMetadata, META_GROUP_ORDER, META_GROUP_LABEL, stripMetadata, isStrippableFormat, detectWatermark } from '@lolly/engine';
import type { FileMetadata, MetaGroup, StripFormat } from '@lolly/engine';
import { WORLD_VIEWBOX, WORLD_LAND_PATH, projectLatLon } from './world-map.ts';
import { CA_ROOT_PEM } from '../ca-root.ts';
import { escape } from '../utils.ts';
import { armViewEnter } from '../view-enter.ts';
import { playSfx } from '../lib/sfx.ts';
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
interface Watermark { present: boolean; score: number; }

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

const ICON_SHIELD = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`;
const ICON_CHEVRON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`;

// Small line icons, wrapped consistently — shared by the hero check scorecard
// and the per-fact <dt> labels. Values are the inner paths of a 24×24 glyph.
const svgIcon = (paths: string): string => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const ICONS = {
  document: '<path d="M14 3v5h5"/><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>',
  eye: '<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/>',
  link: '<path d="M9 15 15 9"/><path d="M11 6l1-1a4 4 0 0 1 6 6l-1 1"/><path d="M13 18l-1 1a4 4 0 0 1-6-6l1-1"/>',
  pen: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3.5 2"/>',
  hash: '<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/>',
  userCheck: '<path d="M14 20v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="8" cy="8" r="4"/><path d="M15 11.5l2.2 2.2 4.3-4.3"/>',
  sparkle: '<path d="M12 3l1.8 5.4L19 10l-5.2 1.6L12 17l-1.8-5.4L5 10l5.2-1.6z"/>',
  lollipop: '<circle cx="9" cy="9" r="7"/><path d="M9 5a4 4 0 0 1 0 8 2 2 0 0 1 0-4"/><path d="m14 14 6 6"/>',
  tag: '<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
  tool: '<path d="M14.7 6.3a4 4 0 0 0-5.2 5.2l-6.1 6.1a1.5 1.5 0 0 0 2.1 2.1l6.1-6.1a4 4 0 0 0 5.2-5.2l-2.4 2.4-2-2z"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.5 2.5 3.8 5.7 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.7-3.8-9S9.5 5.5 12 3z"/>',
  seal: '<circle cx="12" cy="9" r="6"/><path d="M9 14.2 8 22l4-2.5 4 2.5-1-7.8"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  building: '<path d="M4 22V4a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v18"/><path d="M15 9h4a1 1 0 0 1 1 1v12"/><path d="M8 7h2M8 11h2M8 15h2M4 22h16"/>',
  cpu: '<rect x="7" y="7" width="10" height="10" rx="1.5"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>',
  calendar: '<rect x="3" y="4.5" width="18" height="16.5" rx="2"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4"/>',
  package: '<path d="M16.5 9.4 7.5 4.21"/><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
  lock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/><circle cx="12" cy="15.2" r="1.1"/>',
  mapPin: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/>',
  camera: '<path d="M3 8a2 2 0 0 1 2-2h2l1.5-2h7L19 6h0a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><circle cx="12" cy="13" r="3.5"/>',
  // Big central sparkle + two small twinkles — the "auto / AI generated" glyph.
  aiSpark: '<path d="M12 2.5l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.9z"/><path d="M19 15v3.5M17.25 16.75h3.5"/><path d="M5 3.5v3M3.5 5h3"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.8"/><path d="m21 15-4.5-4.5L5 21"/>',
  checklist: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="m3 6 1.3 1.3L6.5 5"/><path d="m3 12 1.3 1.3 2.2-2.3"/><path d="m3 18 1.3 1.3 2.2-2.3"/>',
  // A framed ripple — the "in-pixel imprint" glyph.
  imprint: '<rect x="3" y="3" width="18" height="18" rx="2.5"/><path d="M6.5 13.5c1.8-3 3.6-3 5.5 0s3.7 3 5.5 0"/><path d="M6.5 9.5c1.8-2.4 3.6-2.4 5.5 0s3.7 2.4 5.5 0"/>',
};
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
    sub: 'Nothing to verify — this file carries no C2PA manifest.',
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
interface ScorecardItem { icon: keyof typeof ICONS; label: string; status: keyof typeof STATUS_WORD; hideStatus?: boolean; ash?: boolean; }
function scorecardModel(report: VerifyReport): ScorecardItem[] {
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

  return [
    // Yes/no, not a graded check: "Made with Lolly" (green tick) or a plain
    // "Not made with Lolly" with no status pill — "not applicable" reads wrong here.
    { icon: 'lollipop', label: lollyMade ? 'Made with Lolly' : 'Not made with Lolly', status: lollyMade ? 'pass' : na, hideStatus: !lollyMade },
    { icon: 'document', label: 'Manifest found', status: found ? 'pass' : na },
    { icon: 'eye', label: 'Manifest readable', status: readable },
    { icon: 'link', label: 'Assertions bound to the claim', status: assertions },
    { icon: 'pen', label: 'Claim signature valid', status: signature },
    { icon: 'clock', label: 'Certificate within validity', status: validity },
    { icon: 'hash', label: 'File bytes match (hard binding)', status: binding },
    // "Signer identity" has no CA answer when the file was signed with a
    // self-signed on-device key — so say that plainly (dark-ash card) rather
    // than a bare "not applicable".
    (trust === 'na' && report.signer?.selfSigned
      ? { icon: 'cpu', label: 'Signed with an on-device key', status: na, hideStatus: true, ash: true }
      : { icon: 'userCheck', label: 'Signer identity (CA-verified)', status: trust }),
  ];
}

function scorecardHtml(report: VerifyReport): string {
  return `<ul class="valid-score" aria-label="Verification checks at a glance">${scorecardModel(report).map((it, i) =>
    `<li class="valid-score-pip is-${it.status}${it.ash ? ' is-ash' : ''}" style="--i:${i}" aria-label="${escape(it.label)}${it.hideStatus ? '' : `: ${STATUS_WORD[it.status]}`}">` +
      `<span class="valid-score-ic" aria-hidden="true">${svgIcon(ICONS[it.icon])}</span>` +
      `<span class="valid-score-label" aria-hidden="true">${escape(it.label)}</span>` +
      (it.hideStatus ? '' : `<span class="valid-score-status" aria-hidden="true">${STATUS_WORD[it.status]}</span>`) +
    `</li>`).join('')}</ul>`;
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

function fact(label: string, value: unknown, icon: keyof typeof ICONS): string {
  if (value == null || value === '') return '';
  const ic = icon && ICONS[icon] ? `<span class="valid-fact-ic" aria-hidden="true">${svgIcon(ICONS[icon])}</span>` : '';
  return `<div class="valid-fact"><dt>${ic}<span>${escape(label)}</span></dt><dd>${escape(String(value))}</dd></div>`;
}

// The scalar-input digest recorded by the writer's tools.lolly.export assertion
// (env.inputs) — "what this was made from": the colours, sizes, toggles and short
// text the tool rendered with. Boxed as its own panel (matching change-history/
// assertion-log) and placed ABOVE change history so an inspected asset tells its
// "what it's made from" story before its "what happened to it" story. Empty in →
// nothing rendered (so panelsBlock silently drops this column when there's no digest).
function inputsDigestHtml(inputs: Record<string, string> | undefined): string {
  const entries = inputs ? Object.entries(inputs).filter(([, v]) => v != null && v !== '') : [];
  if (!entries.length) return '';
  const isColor = (v: string): boolean => /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v.trim());
  const rows = entries.map(([k, v]) => {
    const sw = isColor(v) ? `<span class="valid-input-swatch" style="background:${escape(v)}" aria-hidden="true"></span>` : '';
    return `<div class="valid-input-row"><dt>${escape(k)}</dt><dd>${sw}<span>${escape(v)}</span></dd></div>`;
  }).join('');
  return `
    <div class="valid-inputs valid-panel">
      <h3>${svgIcon(ICONS.sparkle)}<span>Made from</span></h3>
      <dl class="valid-input-list">${rows}</dl>
    </div>`;
}

// The "checked on this device" footnote, wrapped as a professional callout: a
// lock chip (privacy — nothing left the device) beside the explanatory prose.
const deviceNote = (inner: string): string =>
  `<div class="valid-note">
    <span class="valid-note-ic" aria-hidden="true">${svgIcon(ICONS.lock)}</span>
    <p class="valid-note-body">${inner}</p>
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
    ? 'The credential is intact and records a Lolly export — the file has not changed since it was made. (Integrity plus the maker’s claim, signed under a CA-verified identity.)'
    : state === STATE_COPY.expired && identity
      ? 'The file still matches exactly what its credential signed — nothing was modified — but the short-lived signing certificate has expired, so the credential no longer validates. Without a trusted timestamp the time of signing cannot be proven.'
      : state === STATE_COPY.trusted && thirdPartyRoot
        ? `The file is exactly what its embedded credential signed, and the signing certificate chains to <strong>${escape(identity!.issuer!)}</strong> — a recognised C2PA trust anchor${signerOrg ? `, identifying the signer as <strong>${escape(signerOrg)}</strong>` : ''}. Integrity plus a CA-verified identity; what it records about how it was made is still the signer’s own claim.`
        : state.sub;
  return { state, sub, identity };
}

// A single tone for the collapsed summary's badge / card stripe. good = intact
// (valid / lolly / trusted / delivered), warn = expired-only, bad = broken, none
// = no credential.
function stateTone(report: VerifyReport): 'good' | 'bad' | 'warn' | 'none' {
  const { state } = resolveState(report);
  if (state === STATE_COPY.invalid) return 'bad';
  if (state === STATE_COPY.expired) return 'warn';
  if (state === STATE_COPY.none) return 'none';
  return 'good';
}

// Icon-only mirror of the hero scorecard for the collapsed summary — the "highlights
// showing when collapsed". Same eight pips, same colour = state, label as a tooltip.
function miniScoreHtml(report: VerifyReport): string {
  if (!report.found) return '';
  return `<ul class="valid-score valid-score--mini" aria-hidden="true">${scorecardModel(report).map((it) =>
    `<li class="valid-score-pip is-${it.status}${it.ash ? ' is-ash' : ''}" title="${escape(it.label)}${it.hideStatus ? '' : `: ${STATUS_WORD[it.status]}`}"><span class="valid-score-ic">${svgIcon(ICONS[it.icon])}</span></li>`).join('')}</ul>`;
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

function summaryInner(fileName: string, report: VerifyReport): string {
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
    ? `<span class="valid-item-maker ${maker.lolly ? 'is-lolly' : 'is-other'}" title="${escape(state.title)}">Made with ${escape(maker.names.join(' · '))}</span>`
    : `<span class="valid-item-badge is-${tone}">${escape(state.title)}</span>`;
  return `
    ${lead}
    ${report.aiGenerated ? `<span class="valid-item-ai" title="Content Credential declares AI-generated content">${svgIcon(ICONS.aiSpark)}<span>AI</span></span>` : ''}
    <span class="valid-item-name">${escape(fileName)}${report.format ? ` <span class="valid-fmt">${escape(report.format)}</span>` : ''}</span>
    ${who ? `<span class="valid-item-signer" title="Signed by ${escape(who)}">${svgIcon(ICONS.mail)}<span>${escape(who)}</span></span>` : ''}
    ${miniScoreHtml(report)}
    <span class="valid-item-chev" aria-hidden="true">${ICON_CHEVRON}</span>`;
}

// Which glyph heads each metadata section.
const META_GROUP_ICON: Record<MetaGroup, keyof typeof ICONS> = {
  location: 'mapPin', device: 'cpu', capture: 'camera', software: 'tool',
  authorship: 'user', timestamps: 'calendar', description: 'document', technical: 'hash',
};

// An offline world locator: the photo's GPS fix plotted on an embedded land
// outline (no tile server — the coordinates never leave the device). Rendered
// full-width above the sections when a file records a position.
function renderLocator(lat: number, lon: number): string {
  const { x, y } = projectLatLon(lat, lon);
  return `<svg class="valid-locator" viewBox="${WORLD_VIEWBOX}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="World map with a pin at the recorded location">
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
  const section = (g: MetaGroup, label: string, icon: keyof typeof ICONS, rows: string): string => `
    <section class="valid-meta-group${g === 'description' ? ' valid-meta-group--desc' : ''}">
      <h4>${svgIcon(ICONS[icon])}<span>${escape(label)}</span></h4>
      <dl>${rows}</dl>
    </section>`;
  const row = (f: { label: string; value: string; sensitive?: boolean }): string =>
    `<div class="valid-meta-row${f.sensitive ? ' is-sensitive' : ''}"><dt>${escape(f.label)}</dt><dd>${escape(f.value)}</dd></div>`;
  const locationBlock = meta.gps ? `
    <section class="valid-meta-location">
      <h4>${svgIcon(ICONS.mapPin)}<span>Location</span></h4>
      ${renderLocator(meta.gps.lat, meta.gps.lon)}
      <div class="valid-meta-loc-read">
        ${loc.map((f) => `<span class="valid-meta-loc-item"><span class="k">${escape(f.label)}</span><span class="v">${escape(f.value)}</span></span>`).join('')}
        ${meta.mapUrl ? `<a class="valid-meta-map" href="${escape(meta.mapUrl)}" target="_blank" rel="noopener noreferrer">OpenStreetMap ↗</a>` : ''}
      </div>
    </section>` : '';
  return `
    <section class="valid-meta">
      <div class="valid-meta-head">
        <h3>${svgIcon(ICONS.eye)}<span>Embedded metadata</span></h3>
        <span class="valid-meta-count">${n} field${n > 1 ? 's' : ''}${meta.format ? ` · ${escape(meta.format)}` : ''}</span>
      </div>
      ${mediaPreviewHtml(preview, 'sm')}
      <p class="valid-meta-note">Read on this device from the file's own bytes — the EXIF, XMP and container data it carries wherever it travels.${sensitive ? ' Values that can identify a person, place or device are marked.' : ''} ${isStrippableFormat(meta.format)
    ? `<button type="button" class="valid-clean-link" data-clean-copy="${fileIndex}" data-clean-format="${escape(meta.format)}">Download a cleaned copy</button> or use the <a href="#/tool/strip-data">Hidden Data</a> tool for more control.`
    : `Remove it with the <a href="#/tool/strip-data">Hidden Data</a> tool.`}</p>
      <div class="valid-meta-grid">
        ${locationBlock}
        ${groups.map((x) => section(x.g, META_GROUP_LABEL[x.g], META_GROUP_ICON[x.g], x.items.map(row).join(''))).join('')}
      </div>
    </section>`;
}

// ── AI-generated flag ───────────────────────────────────────────────────────
// The loudest marker on the page: when a credential declares its pixels came
// from a trained model, we say so in a purple, animated, unmissable banner.
const AI_FLAG_COPY = {
  generated: {
    title: 'AI-generated content',
    sub: 'This file’s Content Credential declares it was generated by AI — produced by a trained algorithmic model, not captured or hand-made.',
  },
  composite: {
    title: 'Contains AI-generated content',
    sub: 'This file’s Content Credential declares AI-generated elements were composited in — part of it was produced by a trained algorithmic model.',
  },
};
function aiFlagHtml(report: VerifyReport): string {
  if (!report.aiGenerated) return '';
  const c = AI_FLAG_COPY[report.aiGenerated.kind];
  return `
    <div class="valid-ai-flag" role="alert">
      <span class="valid-ai-flag-ic" aria-hidden="true">${svgIcon(ICONS.aiSpark)}</span>
      <span class="valid-ai-flag-text">
        <strong>${escape(c.title)}</strong>
        <span>${escape(c.sub)}</span>
      </span>
      <span class="valid-ai-flag-tag" aria-hidden="true">AI</span>
    </div>`;
}

// ── Lolly pixel watermark ─────────────────────────────────────────────────────
// Shown ONLY when the in-pixel mark is found (absence is uninformative — resize
// erases it and non-Lolly rasters never carry it, so "not found" must never read
// as "not made with Lolly"). Deliberately quiet and clearly secondary to the
// C2PA verdict: a durable hint, not a cryptographic guarantee.
function watermarkNote(wm: Watermark | undefined): string {
  if (!wm?.present) return '';
  return `
    <div class="valid-wm" role="note">
      <span class="valid-wm-ic" aria-hidden="true">${svgIcon(ICONS.imprint)}</span>
      <div class="valid-wm-text">
        <strong>Lolly pixel watermark present</strong>
        <span>An imperceptible mark Lolly can embed in the pixels of a raster export. Unlike the Content Credential — which travels in metadata and is lost to a re-save or strip — this rides in the image itself and survives recompression, so it's a durable hint that the image came from Lolly. A supporting signal, not a cryptographic guarantee.</span>
      </div>
    </div>`;
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
const ACTION_ICON: Record<string, keyof typeof ICONS> = {
  'c2pa.created': 'sparkle', 'c2pa.edited': 'pen', 'c2pa.opened': 'eye',
  'c2pa.placed': 'package', 'c2pa.published': 'package', 'c2pa.drawing': 'pen',
  'c2pa.color_adjustments': 'pen', 'c2pa.filtered': 'pen', 'c2pa.cropped': 'pen',
  'c2pa.resized': 'pen', 'c2pa.converted': 'tool', 'c2pa.transcoded': 'tool',
};
// Friendly wording for an action's IPTC DigitalSourceType (the last path segment).
const SOURCE_TYPE_LABEL: Record<string, string> = {
  trainedAlgorithmicMedia: 'Generated by AI',
  compositeWithTrainedAlgorithmicMedia: 'Composited with AI',
  algorithmicMedia: 'Algorithmically generated',
  digitalCreation: 'Created in software',
  digitalCapture: 'Captured by a camera',
  computationalCapture: 'Computational capture',
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

function stepsHtml(report: VerifyReport): string {
  // The full provenance chain (all manifests) when the engine surfaced it, else
  // just the active manifest's own actions.
  const acts = report.history?.length ? report.history : (report.claim?.actions ?? []);
  if (!acts.length) return '';
  const rowData = acts.map((a) => {
    const code = String(a.action ?? '');
    const label = ACTION_LABEL[code] ?? (code.replace(/^c2pa\./, '') || 'Step');
    const icon = ACTION_ICON[code] ?? 'clock';
    const slug = sourceSlug(a);
    const isAi = !!AI_SOURCE_SLUGS[slug];
    const src = SOURCE_TYPE_LABEL[slug];
    // Who did it → a left-side pill. Lolly reads bold green (mark our own edits
    // prominently), an AI-sourced step reads purple, any other maker solid grey.
    const agent = stepAgent(a);
    const agentCls = agent && /lolly/i.test(agent) ? 'lolly' : isAi ? 'ai' : 'other';
    const desc = a.description ? tidyStepDescription(String(a.description), label) : '';
    const meta = [
      desc ? escape(desc) : null,
      a.when ? escape(fmtDate(a.when)) : null,
    ].filter(Boolean).join('<span class="valid-step-dot" aria-hidden="true">·</span>');
    // The source-type note (e.g. "Generated by AI") always gets its own line —
    // it's a distinct claim from the description/timestamp, not more list prose.
    const srcLine = src ? `<span class="valid-step-src">${isAi ? `${svgIcon(ICONS.aiSpark)} ` : ''}${escape(src)}</span>` : '';
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
        <span class="valid-step-agent" title="${r.agent ? escape(r.agent) : 'Unknown source'}">${escape(r.agent ? shortAgent(r.agent) : '—')}</span>
        <div class="valid-step-main">
          <span class="valid-step-label"><span class="valid-step-ic" aria-hidden="true">${svgIcon(ICONS[r.icon])}</span>${escape(r.label)}</span>
          ${r.meta ? `<span class="valid-step-meta">${r.meta}</span>` : ''}
          ${r.srcLine}
        </div>
      </li>`;
  }).join('');
  return `
    <div class="valid-steps valid-panel">
      <h3>${svgIcon(ICONS.clock)}<span>Change history</span></h3>
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
      <h3>${svgIcon(ICONS.checklist)}<span>Assertion log</span></h3>
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
    return `<figure class="${cls}"><img src="${escape(p.url)}" alt="Preview of ${escape(p.name)}" decoding="async"></figure>`;
  if (p.kind === 'video' && p.url)
    return `<figure class="${cls}"><video src="${escape(p.url)}#t=0.1" preload="metadata" playsinline muted${size === 'lg' ? ' controls' : ''}></video></figure>`;
  if (p.kind === 'pdf' && p.url && size === 'lg')
    return `<figure class="${cls}"><embed src="${escape(p.url)}#toolbar=0&view=FitH" type="application/pdf"></figure>`;
  // Not inline-previewable at this size — a quiet labelled placeholder (large only).
  if (size === 'lg')
    return `<figure class="${cls} is-placeholder"><span class="valid-preview-ic" aria-hidden="true">${svgIcon(ICONS.image)}</span><figcaption>No inline preview for ${escape((p.format || 'this format').toUpperCase())}</figcaption></figure>`;
  return '';
}

function renderReportBody(fileName: string, report: VerifyReport, meta: FileMetadata | undefined, preview: Preview | undefined, fileIndex: number, watermark?: Watermark): string {
  const { state, sub, identity } = resolveState(report);
  const claim: Partial<Claim> = report.claim ?? {};
  const signer: Partial<Signer> = report.signer ?? {};
  const env: Record<string, string | number | boolean> & { inputs?: Record<string, string> } = report.environment ?? {};
  const signedAt = claim.actions?.find((a) => a.when)?.when;
  const generator = claim.generatorInfo?.name
    ? `${claim.generatorInfo!.name}${claim.generatorInfo!.version ? ' ' + claim.generatorInfo!.version : ''}`
    : claim.claimGenerator;
  // Who signed: the device credential's OIDC email when present, else the
  // organisation / common name from a CA signer's certificate (Google, Adobe,
  // Microsoft… carry no SAN email). Only shown when the chain reached a pinned
  // anchor (identity set) — an org name alone is never proof.
  const signerWho = identity ? (identity.email || signer.organization || signer.commonName) : null;
  const identityLine = (identity && signerWho) ? `
          <p class="valid-identity-line">${report.trusted
    ? `Signed by <strong>${escape(signerWho)}</strong> — identity verified by <strong>${escape(identity!.issuer ?? 'a recognised C2PA root')}</strong>`
    : `Signed by <strong>${escape(signerWho)}</strong> — identity was CA-verified; the certificate has since expired`}</p>` : '';
  // "Made from", "what happened" and "what was checked" — distinct boxed panels,
  // paired with the file/facts summary so they share one row wherever the page
  // has the room (see .valid-panels). madeFromBlock is placed ahead of stepsBlock
  // in panelsBlock below so it reads (and, on narrow viewports, stacks) directly
  // above change history.
  const madeFromBlock = report.found && report.claim ? inputsDigestHtml(env.inputs) : '';
  const stepsBlock = report.found && report.claim ? stepsHtml(report) : '';
  const checksBlock = checksHtml(report);
  const selfnoteBlock = report.found && report.claim && !report.madeWithLolly ? `
        <p class="valid-selfnote">${identity
    ? 'As recorded in the credential — asserted by its CA-verified signer:'
    : 'As recorded in the credential — self-asserted by whoever signed it:'}</p>` : '';
  const factsBlock = report.found && report.claim ? `
        <dl class="valid-facts">
          ${fact('Title', claim.title, 'tag')}
          ${fact('Tool', env.tool, 'tool')}
          ${fact('Produced by', report.author ? `${report.author.name}${report.author.email ? ` <${report.author.email}>` : ''}` : null, 'user')}
          ${fact(report.delivered ? 'Delivered by' : 'Made with', generator, report.delivered ? 'package' : 'lollipop')}
          ${fact('Signed', signedAt ? fmtDate(signedAt) : null, 'clock')}
          ${fact('Where', [env.surface, env.engine, env.os].filter(Boolean).join(' · ') || null, 'globe')}
          ${fact('Size', env.dimensions, 'image')}
          ${fact('Signer', signer.commonName, 'seal')}
          ${fact('Identity', identity?.email, 'mail')}
          ${fact('Issuer', identity ? identity.issuer
    : signer.organization ? `${signer.organization} ${signer.selfSigned ? '(self-signed, on-device)' : '(unverified — does not chain to a trust anchor)'}` : null, 'building')}
          ${fact('Algorithm', signer.alg, 'cpu')}
          ${fact('Certificate valid', signer.notBefore ? `${fmtDate(signer.notBefore)} → ${fmtDate(signer.notAfter)}` : null, 'calendar')}
          ${fact('Manifest', claim.manifestLabel, 'document')}
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
            <div class="valid-vbadge"><span class="valid-vbadge-ic" aria-hidden="true">${svgIcon(ICONS.seal)}</span><span>The credential is intact and records a Lolly export</span></div>
            <div class="valid-vbadge"><span class="valid-vbadge-ic" aria-hidden="true">${svgIcon(ICONS.hash)}</span><span>This file has not changed since it was made</span></div>
          </div>
          <p class="valid-hero-signedby">${identity
    ? `Signed with <strong>${escape(signedByCa ?? 'a Certificate Authority')}</strong> Certificate Authority.`
    : 'Signed with an on-device key, not a CA identity.'}</p>` : '';
  // Mirrors lollyValidationsHtml's badge treatment for the broken-credential
  // verdict — three plain facts instead of one sentence to parse.
  const invalidBadgesHtml = state === STATE_COPY.invalid ? `
          <div class="valid-hero-vbadges">
            <div class="valid-vbadge is-fail"><span class="valid-vbadge-ic" aria-hidden="true">${svgIcon(ICONS.seal)}</span><span>Content Credentials detected</span></div>
            <div class="valid-vbadge is-fail"><span class="valid-vbadge-ic" aria-hidden="true">${svgIcon(ICONS.hash)}</span><span>Bytes no longer match</span></div>
            <div class="valid-vbadge is-fail"><span class="valid-vbadge-ic" aria-hidden="true">${svgIcon(ICONS.pen)}</span><span>Modified after signing</span></div>
          </div>` : '';
  const verdictHtml = report.madeWithLolly
    ? `<span class="valid-hero-pill valid-hero-pill--lolly"><span class="valid-lolly-badge" aria-hidden="true">🍭</span>${escape(state.title)}</span>`
    : report.trusted
      ? `<span class="valid-hero-pill valid-hero-pill--trusted"><span class="valid-trusted-badge" aria-hidden="true">✓</span>${escape(state.title)}</span>`
      : `<span class="valid-hero-verdict">${escape(state.title)}</span>`;
  return `
    <div class="valid-result ${state.cls}">
      <div class="valid-top">
        ${mediaPreviewHtml(preview, 'lg')}
        <div class="valid-hero">
          <div class="valid-hero-title">
            <span class="valid-hero-icon">${report.madeWithLolly
    ? '<img class="valid-hero-logo" src="/icons/icon-192.png" width="192" height="192" alt="" aria-hidden="true" decoding="async">'
    : ICON_SHIELD}</span>
            <h2><span class="valid-hero-filename">${escape(fileName)}</span> ${verdictHtml}</h2>
          </div>
          ${state === STATE_COPY.lolly ? lollyValidationsHtml
    : state === STATE_COPY.invalid ? invalidBadgesHtml
      : `<p>${sub}</p>${identityLine}`}
        </div>
        ${report.found ? scorecardHtml(report) : ''}
      </div>
      ${aiFlagHtml(report)}
      ${panelsBlock}
      ${watermarkNote(watermark)}
      ${report.found ? deviceNote(report.format === 'webm' || report.format === 'mkv'
    ? `<strong>Checked entirely on this device</strong> — the file was not uploaded. WebM has no
        standardised C2PA container mapping yet, so this credential is Lolly's own Matroska attachment:
        only Lolly (here and via <code>lolly validate</code>) can read it — external C2PA viewers
        don't support WebM at all.`
    : identity
      ? `<strong>Checked entirely on this device</strong> — the file was not uploaded. The signer's identity
        was verified against the Lolly CA root pinned in this app (the same root
        <code>lolly validate --trust-anchor</code> uses). Validators that don't pin that root —
        <a href="https://verify.contentauthenticity.org/" target="_blank" rel="noopener">verify.contentauthenticity.org</a>,
        or <code>c2patool</code> without <code>--trust_anchors</code> — still show the signer as an unknown source.`
      : `<strong>Checked entirely on this device</strong> — the file was not uploaded. The same file on
        <a href="https://verify.contentauthenticity.org/" target="_blank" rel="noopener">verify.contentauthenticity.org</a>
        reads the same, with the signer shown as an unknown source (there is no CA behind an on-device key — by design).`) : ''}
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
    <a href="#/" class="tools-home home-full">Tools</a>
    <div class="platform-layout valid-layout">
      <header class="plat-header">
        <h1 class="plat-title">Verify</h1>
        <div class="plat-header-text">
          <p class="plat-sub">Check a file's Content Credentials — the signed C2PA manifest Lolly embeds on export. Answers whether it was genuinely made with Lolly, by whom, and where. On-device; nothing is uploaded.</p>
        </div>
      </header>

      <div class="valid-drop" data-drop tabindex="0" role="button" aria-label="Choose or drop files to verify">
        <input type="file" multiple accept=".pdf,.png,.apng,.jpg,.jpeg,.gif,.svg,.tif,.tiff,.webp,.mp4,.m4v,.mov,.webm,.mkv,application/pdf,image/png,image/jpeg,image/gif,image/svg+xml,image/tiff,image/webp,video/mp4,video/webm,video/x-matroska" hidden>
        <span class="valid-drop-icon" aria-hidden="true">${ICON_SHIELD}</span>
        <strong>Drop files here</strong>
        <span>pdf · png · jpg · gif · svg · tiff · webp · mp4 · webm — check one or several at once</span>
      </div>

      <div class="valid-report" data-report hidden></div>
    </div>
  `;
  armViewEnter(viewEl, '.tools-home, .plat-header, .valid-drop');

  const drop = viewEl.querySelector<HTMLElement>('[data-drop]')!;
  const input = drop.querySelector<HTMLInputElement>('input[type="file"]')!;
  const reportEl = viewEl.querySelector<HTMLElement>('[data-report]')!;
  wireMasonry(viewEl, reportEl);

  // Verify one file's bytes, returning its C2PA report, its embedded metadata
  // (EXIF/XMP/… — PDF via the shell's pdf bridge, everything else on the engine),
  // or an error message. Kept narrow so both the single- and multi-file paths
  // share the exact engine call. Bytes are read once and reused for both reads.
  async function verifyFile(file: File): Promise<{ report?: VerifyReport; error?: string; meta?: FileMetadata; watermark?: Watermark }> {
    try {
      if (file.size > MAX_VERIFY_BYTES) {
        return { error: `File is too large to verify here (over ${Math.round(MAX_VERIFY_BYTES / 1024 / 1024)} MB).` };
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      const report = await verifyC2pa(bytes, VERIFY_OPTS);
      const meta = await readMetadata(bytes);
      const watermark = await detectPixelWatermark(file, report.format);
      return { report, meta, watermark };
    } catch (err) {
      return { error: (err as Error)?.message || String(err) };
    }
  }

  // Decode a raster file to RGBA and run the engine's pixel-watermark detector.
  // NB: no downscale — detection must see native-resolution pixels (a resize
  // shifts the 8×8 grid and erases the mark). Best-effort; anything we can't
  // decode (TIFF, SVG, PDF, video) or that faults returns undefined.
  const WM_DECODABLE = new Set(['png', 'apng', 'jpg', 'jpeg', 'gif', 'webp']);
  async function detectPixelWatermark(file: File, format: string | null): Promise<Watermark | undefined> {
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
      const r = detectWatermark(data, { width: w, height: h });
      return { present: r.present, score: r.score };
    } catch {
      return undefined;
    } finally {
      bmp?.close?.();
    }
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
        <span class="valid-item-badge is-bad">Error</span>
        <span class="valid-item-name">${escape(fileName)}</span>
        <span class="valid-item-chev" aria-hidden="true">${ICON_CHEVRON}</span>
      </summary>
      <div class="valid-item-body"><p class="valid-busy">Could not check this file: ${escape(message)}</p></div>`;
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

  async function handle(files: FileList | File[] | null | undefined): Promise<void> {
    const list = files ? [...files] : [];
    if (!list.length) return;
    previewUrls.forEach((u) => URL.revokeObjectURL(u));
    previewUrls = [];
    activeFiles = list;
    reportEl.hidden = false;

    // One file reads exactly as before — the full report inline, no collapse chrome.
    if (list.length === 1) {
      const file = list[0]!;
      reportEl.innerHTML = `<div class="valid-reports-list"><p class="valid-busy">Checking ${escape(file.name)}…</p></div>`;
      const { report, error, meta, watermark } = await verifyFile(file);
      reportEl.querySelector('.valid-reports-list')!.innerHTML = report
        ? renderReportBody(file.name, report, meta, makePreview(file, report), 0, watermark)
        : `<p class="valid-busy">Could not check this file: ${escape(error!)}</p>`;
      const panels = reportEl.querySelector<HTMLElement>('.valid-panels');
      if (panels) layoutMasonry(panels);
      // Audible verdict, as two composable signals: the spooky ghost "hoooo" marks
      // AI-generated content, the bright "signing" chirps mark an intact Lolly make.
      // A file that's BOTH gets the chirps over the ooo; any OTHER AI file gets the
      // ooo alone (no chirps); a non-AI file keeps the usual verdict — chirps if
      // intact, a soft cautionary "uh-oh" if broken, missing, or unreadable.
      if (report?.aiGenerated) {
        if (report.madeWithLolly) playSfx('sign');
        playSfx('ghost');
      } else {
        playSfx(report?.state === 'valid' ? 'sign' : 'warn');
      }
      reportEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      return;
    }

    // Several files → a stack of collapsible reports. Default collapsed so the whole
    // batch reads as a column of highlight bars; expand any one for its full report.
    reportEl.innerHTML = `
      <div class="valid-reports-bar">
        <span class="valid-reports-count">${list.length} files</span>
        <div class="valid-reports-actions">
          <button type="button" class="btn valid-reports-toggle" data-expand>Expand all</button>
          <button type="button" class="btn valid-reports-toggle" data-collapse>Collapse all</button>
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
          <span class="valid-item-badge is-busy">Checking…</span>
          <span class="valid-item-name">${escape(file.name)}</span>
          <span class="valid-item-chev" aria-hidden="true">${ICON_CHEVRON}</span>
        </summary>
        <div class="valid-item-body"><p class="valid-busy">Checking ${escape(file.name)}…</p></div>`;
      listEl.appendChild(card);
      return card;
    });
    reportEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    let allValid = true, anyAi = false, anyLolly = false;
    for (let i = 0; i < list.length; i++) {
      const file = list[i]!, card = cards[i]!;
      const { report, error, meta, watermark } = await verifyFile(file);
      if (report) {
        card.className = `valid-item is-${stateTone(report)}`;
        card.innerHTML = `<summary class="valid-item-summary">${summaryInner(file.name, report)}</summary>` +
          `<div class="valid-item-body">${renderReportBody(file.name, report, meta, makePreview(file, report), i, watermark)}</div>`;
      } else {
        card.className = 'valid-item is-bad';
        card.innerHTML = errorSummary(file.name, error!);
      }
      if (report?.state !== 'valid') allValid = false;
      if (report?.aiGenerated) anyAi = true;
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
    btn.textContent = 'Cleaning…';
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
      btn.textContent = 'Downloaded ✓';
    } catch (err) {
      btn.textContent = 'Couldn’t clean this file';
      host.log('warn', 'valid: clean-copy failed', { error: (err as Error)?.message });
    } finally {
      setTimeout(() => { btn.disabled = false; btn.textContent = original; }, 2000);
    }
  }
  reportEl.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-clean-copy]');
    if (btn) downloadCleanCopy(btn);
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
}
