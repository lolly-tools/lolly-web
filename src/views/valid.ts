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
import { verifyC2pa, pemToDer } from '@lolly/engine';
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
  actions: Array<{ action: unknown; when: unknown; softwareAgent: unknown }>;
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
  environment?: Record<string, string | number | boolean> | null;
  author?: { name: string; email?: string };
  signer?: Signer;
}

// The pinned Lolly root becomes the trust anchor. While the PEM is the empty
// placeholder we pass NO options, so verification stays byte-identical to the
// anchorless behaviour.
const VERIFY_OPTS: { trustAnchors: Uint8Array[] } | undefined = CA_ROOT_PEM ? { trustAnchors: [pemToDer(CA_ROOT_PEM)] } : undefined;

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
};
const STATUS_WORD = { pass: 'passed', fail: 'failed', warn: 'needs attention', na: 'not applicable' };

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
    title: 'Credential intact — identity verified',
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
interface ScorecardItem { icon: keyof typeof ICONS; label: string; status: keyof typeof STATUS_WORD; }
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
  const lolly = report.madeWithLolly ? 'pass' : na;

  return [
    { icon: 'document', label: 'Manifest found', status: found ? 'pass' : na },
    { icon: 'eye', label: 'Manifest readable', status: readable },
    { icon: 'link', label: 'Assertions bound to the claim', status: assertions },
    { icon: 'pen', label: 'Claim signature valid', status: signature },
    { icon: 'clock', label: 'Certificate within validity', status: validity },
    { icon: 'hash', label: 'File bytes match (hard binding)', status: binding },
    { icon: 'userCheck', label: 'Signer identity (CA-verified)', status: trust },
    { icon: 'sparkle', label: 'Made with Lolly', status: lolly },
  ];
}

function scorecardHtml(report: VerifyReport): string {
  return `<ul class="valid-score" aria-label="Verification checks at a glance">${scorecardModel(report).map((it) =>
    `<li class="valid-score-pip is-${it.status}" aria-label="${escape(it.label)}: ${STATUS_WORD[it.status]}">` +
      `<span class="valid-score-ic" aria-hidden="true">${svgIcon(ICONS[it.icon])}</span>` +
      `<span class="valid-score-label" aria-hidden="true">${escape(it.label)}</span>` +
      `<span class="valid-score-status" aria-hidden="true">${STATUS_WORD[it.status]}</span>` +
    `</li>`).join('')}</ul>`;
}

function checkRow(c: Check): string {
  const cls = c.ok ? 'ok' : isExpectedRow(c) ? 'info' : 'bad';
  const mark = c.ok ? '✓' : isExpectedRow(c) ? 'ℹ' : '✕';
  return `
    <li class="valid-check valid-check--${cls}">
      <span class="valid-check-mark" aria-hidden="true">${mark}</span>
      <span class="valid-check-text"><code>${escape(c.code)}</code><span>${escape(c.explanation)}</span></span>
    </li>`;
}

function fact(label: string, value: unknown, icon: keyof typeof ICONS): string {
  if (value == null || value === '') return '';
  const ic = icon && ICONS[icon] ? `<span class="valid-fact-ic" aria-hidden="true">${svgIcon(ICONS[icon])}</span>` : '';
  return `<div class="valid-fact"><dt>${ic}<span>${escape(label)}</span></dt><dd>${escape(String(value))}</dd></div>`;
}

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
  const sub = state === STATE_COPY.lolly && report.trusted
    ? 'The credential is intact and records a Lolly export — the file has not changed since it was made. (Integrity plus the maker’s claim, signed under a CA-verified identity.)'
    : state === STATE_COPY.expired && identity
      ? 'The file still matches exactly what its credential signed — nothing was modified — but the short-lived signing certificate has expired, so the credential no longer validates. Without a trusted timestamp the time of signing cannot be proven.'
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
    `<li class="valid-score-pip is-${it.status}" title="${escape(it.label)}: ${STATUS_WORD[it.status]}"><span class="valid-score-ic">${svgIcon(ICONS[it.icon])}</span></li>`).join('')}</ul>`;
}

// The always-visible summary row of a collapsible report: state badge, filename,
// signer identity (when CA-verified), and the mini scorecard glance.
function summaryInner(fileName: string, report: VerifyReport): string {
  const { state, identity } = resolveState(report);
  return `
    <span class="valid-item-badge is-${stateTone(report)}">${escape(state.title)}</span>
    <span class="valid-item-name">${escape(fileName)}${report.format ? ` <span class="valid-fmt">${escape(report.format)}</span>` : ''}</span>
    ${identity?.email ? `<span class="valid-item-signer" title="Signed by ${escape(identity.email)}">${svgIcon(ICONS.mail)}<span>${escape(identity.email)}</span></span>` : ''}
    ${miniScoreHtml(report)}
    <span class="valid-item-chev" aria-hidden="true">${ICON_CHEVRON}</span>`;
}

function renderReportBody(fileName: string, report: VerifyReport): string {
  const { state, sub, identity } = resolveState(report);
  const claim: Partial<Claim> = report.claim ?? {};
  const signer: Partial<Signer> = report.signer ?? {};
  const env: Record<string, string | number | boolean> = report.environment ?? {};
  const signedAt = claim.actions?.find((a) => a.when)?.when;
  const generator = claim.generatorInfo?.name
    ? `${claim.generatorInfo!.name}${claim.generatorInfo!.version ? ' ' + claim.generatorInfo!.version : ''}`
    : claim.claimGenerator;
  const identityLine = identity?.email ? `
          <p class="valid-identity-line">${report.trusted
    ? `Signed by <strong>${escape(identity!.email)}</strong> — identity verified by ${escape(identity!.issuer)}`
    : `Signed by <strong>${escape(identity!.email)}</strong> — identity was CA-verified; the certificate has since expired`}</p>` : '';
  return `
    <div class="valid-result ${state.cls}">
      <div class="valid-hero">
        <span class="valid-hero-icon">${ICON_SHIELD}</span>
        <div>
          <h2>${escape(state.title)}${report.madeWithLolly ? '<span class="valid-lolly-badge" aria-hidden="true">✦</span>' : report.trusted ? '<span class="valid-trusted-badge" aria-hidden="true">✓</span>' : ''}</h2>
          <p>${escape(sub)}</p>${identityLine}
          ${report.found ? scorecardHtml(report) : ''}
        </div>
      </div>
      <p class="valid-file"><strong>${escape(fileName)}</strong>${report.format ? ` <span class="valid-fmt">${escape(report.format)}</span>` : ''}${report.reason ? ` — ${escape(report.reason)}` : ''}</p>
      ${report.found && report.claim && !report.madeWithLolly ? `
        <p class="valid-selfnote">${identity
    ? 'As recorded in the credential — asserted by its CA-verified signer:'
    : 'As recorded in the credential — self-asserted by whoever signed it:'}</p>` : ''}
      ${report.found && report.claim ? `
        <dl class="valid-facts">
          ${fact('Title', claim.title, 'tag')}
          ${fact('Tool', env.tool, 'tool')}
          ${fact('Produced by', report.author ? `${report.author.name}${report.author.email ? ` <${report.author.email}>` : ''}` : null, 'user')}
          ${fact(report.delivered ? 'Delivered by' : 'Made with', generator, report.delivered ? 'package' : 'sparkle')}
          ${fact('Signed', signedAt ? fmtDate(signedAt) : null, 'clock')}
          ${fact('Where', [env.surface, env.engine, env.os].filter(Boolean).join(' · ') || null, 'globe')}
          ${fact('Signer', signer.commonName, 'seal')}
          ${fact('Identity', identity?.email, 'mail')}
          ${fact('Issuer', identity ? identity.issuer
    : signer.organization ? `${signer.organization}${signer.selfSigned ? ' (self-signed, on-device)' : ''}` : null, 'building')}
          ${fact('Algorithm', signer.alg, 'cpu')}
          ${fact('Certificate valid', signer.notBefore ? `${fmtDate(signer.notBefore)} → ${fmtDate(signer.notAfter)}` : null, 'calendar')}
          ${fact('Manifest', claim.manifestLabel, 'document')}
        </dl>` : ''}
      ${report.checks.length ? `<ul class="valid-checks">${report.checks.map(checkRow).join('')}</ul>` : ''}
      ${report.found ? (report.format === 'webm' || report.format === 'mkv' ? `
        <p class="valid-note">Checked entirely on this device — the file was not uploaded. WebM has no
        standardised C2PA container mapping yet, so this credential is Lolly's own Matroska attachment:
        only Lolly (here and via <code>brand-tool validate</code>) can read it — external C2PA viewers
        don't support WebM at all.</p>` : identity ? `
        <p class="valid-note">Checked entirely on this device — the file was not uploaded. The signer's identity
        was verified against the Lolly CA root pinned in this app (the same root
        <code>brand-tool validate --trust-anchor</code> uses). Validators that don't pin that root —
        <a href="https://verify.contentauthenticity.org/" target="_blank" rel="noopener">verify.contentauthenticity.org</a>,
        or <code>c2patool</code> without <code>--trust_anchors</code> — still show the signer as an unknown source.</p>` : `
        <p class="valid-note">Checked entirely on this device — the file was not uploaded. The same file on
        <a href="https://verify.contentauthenticity.org/" target="_blank" rel="noopener">verify.contentauthenticity.org</a>
        reads the same, with the signer shown as an unknown source (there is no CA behind an on-device key — by design).</p>`) : ''}
    </div>`;
}

export async function mountValid(viewEl: HTMLElement, _host: HostV1): Promise<void> {
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

  // Verify one file's bytes, returning either its report or an error message. Kept
  // narrow so both the single- and multi-file paths share the exact engine call.
  async function verifyFile(file: File): Promise<{ report?: VerifyReport; error?: string }> {
    try {
      return { report: await verifyC2pa(new Uint8Array(await file.arrayBuffer()), VERIFY_OPTS) };
    } catch (err) {
      return { error: (err as Error)?.message || String(err) };
    }
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

  async function handle(files: FileList | File[] | null | undefined): Promise<void> {
    const list = files ? [...files] : [];
    if (!list.length) return;
    reportEl.hidden = false;

    // One file reads exactly as before — the full report inline, no collapse chrome.
    if (list.length === 1) {
      const file = list[0]!;
      reportEl.innerHTML = `<div class="valid-reports-list"><p class="valid-busy">Checking ${escape(file.name)}…</p></div>`;
      const { report, error } = await verifyFile(file);
      reportEl.querySelector('.valid-reports-list')!.innerHTML = report
        ? renderReportBody(file.name, report)
        : `<p class="valid-busy">Could not check this file: ${escape(error!)}</p>`;
      // Audible verdict: a victory "ta-da" when the credential is intact, a soft
      // cautionary "uh-oh" when it's broken, missing, or unreadable.
      playSfx(report?.state === 'valid' ? 'victory' : 'warn');
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

    let allValid = true;
    for (let i = 0; i < list.length; i++) {
      const file = list[i]!, card = cards[i]!;
      const { report, error } = await verifyFile(file);
      if (report) {
        card.className = `valid-item is-${stateTone(report)}`;
        card.innerHTML = `<summary class="valid-item-summary">${summaryInner(file.name, report)}</summary>` +
          `<div class="valid-item-body">${renderReportBody(file.name, report)}</div>`;
      } else {
        card.className = 'valid-item is-bad';
        card.innerHTML = errorSummary(file.name, error!);
      }
      if (report?.state !== 'valid') allValid = false;
    }
    // One summary verdict for the whole batch — victory only if every file passed.
    playSfx(allValid ? 'victory' : 'warn');
  }

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
