// SPDX-License-Identifier: MPL-2.0
/**
 * org/index.ts — the control-plane seam.
 *
 * Covers the three things that MUST hold:
 *   - dormancy: no control plane ⇒ initOrg resolves null fast, the field-policy
 *     registry stays empty, and the negative is remembered (one probe max);
 *   - the gate decision truth table (auth mode × session kind);
 *   - a member's org-config populating the generic field-policy registry + the
 *     admin-console accessor.
 *
 * Network is the global fetch (org routes everything through instanceFetch, which
 * is plain window.fetch for the same-origin relative paths used here). jsdom
 * supplies the DOM the gate renders into; a Map-backed localStorage stub backs the
 * negative cache. No IndexedDB is touched (instancePath is a no-op with no base).
 *
 * Run directly:  node --test shells/web/src/org/index.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM(
  '<!doctype html><html><body><div id="app"><main id="view"><p class="loading">Loading…</p></main></div></body></html>',
  { url: 'https://instance.test/#/tool/qr-code', pretendToBeVisual: true },
);
globalThis.window = dom.window as unknown as typeof globalThis.window;
globalThis.document = dom.window.document;
globalThis.location = dom.window.location as unknown as Location;

// Map-backed localStorage (jsdom's is fine, but an explicit stub is controllable).
const store = new Map<string, string>();
globalThis.localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => store.clear(),
  key: () => null,
  length: 0,
} as unknown as Storage;

// A reassignable fetch router + call log.
type Handler = (url: string, init?: RequestInit) => Response;
let router: Handler = () => new Response('', { status: 404 });
let fetchLog: Array<{ url: string; method: string }> = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  fetchLog.push({ url, method: (init?.method || 'GET').toUpperCase() });
  return router(url, init);
}) as typeof fetch;

const json = (body: unknown, extra: Record<string, string> = {}, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...extra } });

const { initOrg, orgConfig, orgSession, orgAdminHref, applyOrgToolPolicies, _resetOrgForTests } = await import('./index.ts');
const { getFieldPolicy, _clearFieldPoliciesForTests } = await import('../lib/field-policy.ts');
const { getInputPolicy, _clearInputPoliciesForTests } = await import('../lib/input-policy.ts');
const { getExportPolicy, exportAffordance, _clearExportPolicyForTests } = await import('../lib/export-policy.ts');
const { openApprovalRequest, _clearApprovalOpenerForTests } = await import('../lib/approval-request.ts');

function reset(): void {
  _resetOrgForTests();
  _clearFieldPoliciesForTests();
  _clearInputPoliciesForTests();
  _clearExportPolicyForTests();
  _clearApprovalOpenerForTests();
  store.clear();
  fetchLog = [];
  document.getElementById('view')!.innerHTML = '<p class="loading">Loading…</p>';
  router = () => new Response('', { status: 404 });
}

type SessionKind = 'member' | 'guest' | 'none';
function controlPlane(opts: {
  mode: 'open' | 'gated' | 'per-tool';
  session?: SessionKind;
  role?: string;
  orgConfig?: unknown;
}): void {
  router = (url) => {
    if (url.includes('/api/auth/config')) return json({ mode: opts.mode, provider: 'oidc', loginPath: '/login' });
    if (url.includes('/api/auth/session')) {
      if (opts.session === 'member') return json({ kind: 'member', user: { sub: 'u1', email: 'me@corp', groups: [], role: opts.role ?? 'member' } });
      if (opts.session === 'guest') return json({ kind: 'guest', guest: {} });
      return new Response('', { status: 401 });
    }
    if (url.includes('/api/v1/org-config')) return json(opts.orgConfig ?? { instance: { name: 'Acme' }, inboxUnread: 0 });
    return new Response('', { status: 404 });
  };
}

// ── Dormancy ──────────────────────────────────────────────────────────────────

test('dormant: no control plane (404) resolves null and leaves the registry empty', async () => {
  reset();
  const r = await initOrg();
  assert.equal(r, null);
  assert.equal(getFieldPolicy('email'), undefined);
});

test('dormant: a probe network error resolves null (never throws to boot)', async () => {
  reset();
  router = () => { throw new Error('offline'); };
  const r = await initOrg();
  assert.equal(r, null);
});

test('dormant: a 200 HTML page (misrouted /api) is NOT mistaken for a control plane', async () => {
  reset();
  router = (url) => (url.includes('/api/auth/config')
    ? new Response('<!doctype html><html></html>', { status: 200, headers: { 'content-type': 'text/html' } })
    : new Response('', { status: 404 }));
  assert.equal(await initOrg(), null);
});

test('dormant negative is remembered — a later boot skips even the probe', async () => {
  reset();
  await initOrg();
  assert.ok(fetchLog.length >= 1, 'first boot probes once');
  // Simulate a fresh page session (module state reset) but keep localStorage.
  _resetOrgForTests();
  fetchLog = [];
  const r = await initOrg();
  assert.equal(r, null);
  assert.equal(fetchLog.length, 0, 'no probe when the origin is remembered-absent');
});

// ── Gate decision truth table (mode × session) ────────────────────────────────

test('gate decision truth table', async () => {
  const cases: Array<{ mode: 'open' | 'gated' | 'per-tool'; session: SessionKind; gate: boolean }> = [
    { mode: 'open', session: 'member', gate: false },
    { mode: 'open', session: 'guest', gate: false },
    { mode: 'open', session: 'none', gate: false },
    { mode: 'gated', session: 'member', gate: false },
    { mode: 'gated', session: 'guest', gate: true },
    { mode: 'gated', session: 'none', gate: true },
    { mode: 'per-tool', session: 'member', gate: false },
    { mode: 'per-tool', session: 'none', gate: false },
  ];
  for (const c of cases) {
    reset();
    controlPlane({ mode: c.mode, session: c.session });
    const r = await initOrg();
    const label = `${c.mode}/${c.session}`;
    assert.ok(r, `${label}: control plane detected`);
    assert.equal(r!.gate, c.gate, `${label}: gate flag`);
    assert.equal(!!document.querySelector('.org-gate'), c.gate, `${label}: gate card rendered iff gated`);
  }
});

test('gate builds a login link carrying returnTo=<current path>', async () => {
  reset();
  controlPlane({ mode: 'gated', session: 'none' });
  await initOrg();
  const link = document.querySelector<HTMLAnchorElement>('.org-gate a.btn--primary');
  assert.ok(link, 'sign-in link present');
  const href = link!.getAttribute('href')!;
  assert.ok(href.startsWith('/login?returnTo='), href);
  assert.ok(href.includes(encodeURIComponent('/#/tool/qr-code')), 'returnTo preserves the requested path');
});

// ── Member org-config → generic field-policy registry + admin accessor ────────

test('member org-config populates the generic field-policy registry', async () => {
  reset();
  controlPlane({
    mode: 'open',
    session: 'member',
    role: 'admin',
    orgConfig: {
      instance: { name: 'Acme' },
      inboxUnread: 0,
      profilePolicy: {
        email: { mode: 'locked', source: 'idp', value: 'me@corp.example' },
        phone: { mode: 'hidden' },
        city: { mode: 'editable' },
      },
    },
  });
  const r = await initOrg();
  assert.equal(r!.gate, false);
  assert.deepEqual(getFieldPolicy('email'), { mode: 'locked', note: 'Managed by Acme', value: 'me@corp.example' });
  assert.deepEqual(getFieldPolicy('phone'), { mode: 'hidden', note: undefined, value: undefined });
  assert.deepEqual(getFieldPolicy('city'), { mode: 'editable', note: undefined, value: undefined });
  assert.equal(getFieldPolicy('firstname'), undefined, 'undeclared fields keep no policy');
  assert.equal(orgConfig()?.instance.name, 'Acme');
  assert.equal(orgSession()?.kind, 'member');
  assert.equal(orgAdminHref(), '/admin', 'admin role exposes the console href');
});

test('orgAdminHref is null for a non-admin member and when dormant', async () => {
  reset();
  controlPlane({ mode: 'open', session: 'member', role: 'member' });
  await initOrg();
  assert.equal(orgAdminHref(), null);
  reset();
  await initOrg(); // dormant
  assert.equal(orgAdminHref(), null);
});

// ── Member org-config → generic input-policy registry (the sidebar seam) ──────

test('applyOrgToolPolicies maps the per-tool contract onto the input-policy registry', async () => {
  reset();
  controlPlane({
    mode: 'open',
    session: 'member',
    orgConfig: {
      instance: { name: 'Acme' },
      inboxUnread: 0,
      tools: {
        'event-badge': {
          inputs: [
            { id: 'logo', access: { level: 'locked', value: 'acme/logo' } },
            { id: 'accent', access: { level: 'choice', allow: ['#0c322c', '#30ba78'] } },
          ],
          hidden: ['discount'],
        },
      },
    },
  });
  await initOrg();

  // Dormant until a tool mounts and asks for its policy.
  assert.equal(getInputPolicy('event-badge', 'logo'), undefined);
  applyOrgToolPolicies('event-badge');

  assert.deepEqual(getInputPolicy('event-badge', 'logo'), { mode: 'locked', note: 'Managed by Acme', value: 'acme/logo' });
  assert.equal(getInputPolicy('event-badge', 'accent')?.mode, 'choice');
  assert.deepEqual(getInputPolicy('event-badge', 'accent')?.allow, ['#0c322c', '#30ba78']);
  assert.equal(getInputPolicy('event-badge', 'discount')?.mode, 'hidden', 'hidden id wins');
  assert.equal(getInputPolicy('event-badge', 'headline'), undefined, 'unpolicied input untouched');

  // Mounting a tool with no declaration clears the previous tool's policy.
  applyOrgToolPolicies('qr-code');
  assert.equal(getInputPolicy('event-badge', 'logo'), undefined, 'previous tool policy cleared on mount');
});

test('applyOrgToolPolicies is a dormant no-op with no control plane', async () => {
  reset();
  await initOrg(); // dormant
  applyOrgToolPolicies('event-badge');
  assert.equal(getInputPolicy('event-badge', 'logo'), undefined);
});

// ── Member org-config → generic export-policy seam + approval opener ──────────

test('member export capabilities + per-tool approvalChain populate the export-policy seam', async () => {
  reset();
  controlPlane({
    mode: 'open',
    session: 'member',
    orgConfig: {
      instance: { name: 'Acme' },
      inboxUnread: 0,
      can: { 'export.download': false, 'export.request': true },
      tools: {
        'event-badge': { approvalChain: 'brand-signoff' },
        'poster': { approvalChain: 'legal-review' },
        'qr-code': {},
      },
    },
  });
  await initOrg();

  const policy = getExportPolicy();
  assert.ok(policy, 'export policy installed for a member');
  assert.equal(policy!.canDownload, false);
  assert.equal(policy!.canRequestApproval, true);
  assert.equal(policy!.approvalChainFor('event-badge'), 'brand-signoff');
  assert.equal(policy!.approvalChainFor('poster'), 'legal-review');
  assert.equal(policy!.approvalChainFor('qr-code'), undefined, 'a tool without approvalChain is ungated');
  assert.equal(exportAffordance(policy), 'request-approval', 'withheld-but-requestable → the approval CTA');
  // A member registers the approval opener (so the swapped CTA can open the flow).
  assert.equal(openApprovalRequest({ toolId: 'event-badge' }), true, 'opener registered for a member');
});

test('export.download absent defaults to allowed (byte-identical to today)', async () => {
  reset();
  controlPlane({
    mode: 'open',
    session: 'member',
    orgConfig: { instance: { name: 'Acme' }, inboxUnread: 0, can: { 'export.request': true } },
  });
  await initOrg();
  const policy = getExportPolicy();
  assert.equal(policy!.canDownload, true, 'unspecified download stays allowed — only explicit false withholds');
  assert.equal(exportAffordance(policy), 'download');
});

test('export-policy seam + approval opener are dormant with no control plane', async () => {
  reset();
  await initOrg(); // dormant
  assert.equal(getExportPolicy(), undefined);
  assert.equal(exportAffordance(getExportPolicy()), 'download');
  assert.equal(openApprovalRequest({ toolId: 'event-badge' }), false, 'no opener registered when dormant');
});

test('a non-member never fetches member-only org-config, and leaves the registry empty', async () => {
  reset();
  controlPlane({ mode: 'open', session: 'guest' });
  const r = await initOrg();
  assert.equal(r!.gate, false);
  assert.equal(orgConfig(), null);
  assert.equal(getFieldPolicy('email'), undefined);
  assert.ok(!fetchLog.some(c => c.url.includes('/api/v1/org-config')), 'org-config not requested for a guest');
});
