// SPDX-License-Identifier: MPL-2.0
/**
 * /valid's pure verdict/scorecard logic — extracted from valid.ts so it's importable
 * (and testable) without that view's top-level CSS side-effect import, which makes the
 * view itself unloadable outside a bundler. Zero DOM, zero side effects: report/watermark
 * data in, a resolved state or scorecard model out. valid.ts imports all of this back for
 * rendering; nothing here renders anything itself.
 *
 * Local mirror of the engine verifier's report shape (c2pa-verify's C2paReport is not
 * re-exported through the barrel). Structural — the awaited result of verifyC2pa() is
 * assignable to it.
 */

import { t } from '../i18n.ts';
import { escape } from '../utils.ts';
import type { IconName } from '../lib/icons.ts';

export interface Check { code: string; ok: boolean; explanation: string; }
export interface SignerIdentity { email: string | null; issuer: string | undefined; }
export interface Signer {
  commonName: string | undefined;
  organization: string | undefined;
  notBefore: string;
  notAfter: string;
  selfSigned: boolean;
  alg: string;
  identity?: SignerIdentity;
}
export interface Claim {
  title: unknown;
  format: unknown;
  claimGenerator: unknown;
  generatorInfo: Record<string, string | number | boolean> | null;
  instanceId: unknown;
  manifestLabel: string;
  actions: Array<{ action: unknown; when: unknown; softwareAgent: unknown; digitalSourceType?: unknown; description?: unknown }>;
}
export interface VerifyReport {
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
export interface Watermark {
  present: boolean;
  score: number;
  // Set when the mark was found INSIDE a container file's embedded raster
  // (a .pptx slide image, a PDF image XObject) rather than in the dropped file's
  // own pixels — the note/pip wording changes to say so.
  embedded?: boolean;
}

export const STATUS_WORD = { pass: 'passed', fail: 'failed', warn: 'invalid', na: 'n/a' };

export const STATE_COPY = {
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
export function isExpiredOnly(report: VerifyReport): boolean {
  const fails = report.checks.filter((c) => !c.ok && c.code !== 'signingCredential.untrusted');
  return fails.length === 1 && fails[0]!.code === 'signingCredential.expired';
}

// The untrusted marker is the designed posture, not damage — render it as an
// informational row, never as a failure.
export const isExpectedRow = (c: Check): boolean => c.code === 'signingCredential.untrusted';

// Eight canonical C2PA checks for the hero scorecard. The verifier emits a
// variable number of rows (one hashed-URI per assertion, trusted vs untrusted,
// …); this collapses them onto a stable eight so the hero reads as a consistent
// glance, with each pip's state (pass / fail / warn / not-applicable) derived
// from the actual rows — never hard-coded.
export interface ScorecardItem { icon: IconName; label: string; status: keyof typeof STATUS_WORD; hideStatus?: boolean; ash?: boolean; statusWord?: string; }
// A pip's status word: the shared pass/fail vocabulary unless the item carries
// its own (the Lolly Imprint says "detected" — presence, not a graded check).
export const pipStatusWord = (it: ScorecardItem): string => it.statusWord ?? t(STATUS_WORD[it.status]);
export function scorecardModel(report: VerifyReport, watermark?: Watermark, extra: ScorecardItem[] = []): ScorecardItem[] {
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

export interface ResolvedState {
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
export function resolveState(report: VerifyReport): ResolvedState {
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
export function stateTone(report: VerifyReport): 'good' | 'bad' | 'warn' | 'none' {
  const { state } = resolveState(report);
  if (state === STATE_COPY.invalid) return 'bad';
  if (state === STATE_COPY.expired || state === STATE_COPY.likelyLolly) return 'warn';
  if (state === STATE_COPY.none) return 'none';
  return 'good';
}
