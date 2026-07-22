// SPDX-License-Identifier: MPL-2.0
/**
 * org/ — the single seam through which a deployment's OPTIONAL control plane
 * talks to this shell.
 *
 * A plain Lolly deployment (e.g. the public lolly.tools) ships no control plane:
 * every endpoint below is absent, `initOrg()` resolves to `null` after one
 * tolerant, time-boxed probe (remembered so later boots skip even that), and the
 * shell behaves byte-identically to a build without this module — no gate, no
 * banner, an empty field-policy registry, nothing.
 *
 * When a deployment DOES provide an org-config endpoint, this module is the only
 * place that knows about it. It:
 *   1. probes `GET /api/auth/config` (dormant on 404 / error / non-JSON),
 *   2. resolves the session (`GET /api/auth/session`),
 *   3. gates the app behind sign-in when the deployment is in `gated` mode and
 *      the visitor is not a member,
 *   4. for a member, loads `GET /api/v1/org-config` (ETag-cached) and applies its
 *      profile field policy through the generic src/lib/field-policy.ts registry,
 *      then surfaces any unread inbox messages as a single banner.
 *
 * All traffic goes through instanceFetch/instancePath (src/lib/instance.ts) so a
 * shell pointed at a remote instance consults THAT instance's control plane, and
 * the X-Lolly-Client header rides along for same-origin/native requests.
 *
 * Comments here describe a generic "deployment" / "instance" capability, never a
 * specific product: the control plane is a separate, optional server product, and
 * this shell only ever speaks its documented contract.
 */

import { instanceFetch, instancePath, getInstanceBase } from '../lib/instance.ts';
import { setFieldPolicies } from '../lib/field-policy.ts';
import type { FieldPolicy } from '../lib/field-policy.ts';
import { setToolInputPolicies, clearInputPolicies } from '../lib/input-policy.ts';
import type { InputPolicy } from '../lib/input-policy.ts';
import { registerShareSection } from '../lib/share-sections.ts';
import { setExportPolicy } from '../lib/export-policy.ts';
import { registerApprovalOpener } from '../lib/approval-request.ts';
import { registerSessionSource } from '../lib/session-source.ts';
import { createInstanceSessionSource } from './session-source.ts';
import { t } from '../i18n.ts';
import { escape } from '../utils.ts';

// ── Contract types (the server product's documented shapes) ───────────────────

export interface AuthConfig {
  mode: 'open' | 'gated' | 'per-tool';
  provider: 'oidc' | 'dev' | null;
  loginPath: string | null;
}

export interface OrgUser {
  sub: string;
  email?: string;
  groups?: string[];
  role?: string;
}

export type Session =
  | { kind: 'member'; user: OrgUser }
  | { kind: 'guest'; guest: Record<string, unknown> };

/** One field's policy as the control plane declares it (mapped to a generic
 *  FieldPolicy before it reaches the registry — no product terms leak out). */
export interface ProfileFieldSpec {
  mode: 'editable' | 'locked' | 'hidden';
  source?: 'idp';
  value?: unknown;
}

/** One input's access rule inside a tool policy (control-plane shape). */
export interface InputAccessSpec {
  level: 'locked' | 'choice';
  value?: unknown;
  allow?: string[];
}

/** One tool's policy as the control plane declares it (mapped to generic
 *  InputPolicy entries before they reach the registry). */
export interface ToolPolicySpec {
  /** Per-input access rules (locked / choice). */
  inputs?: Array<{ id: string; access?: InputAccessSpec }>;
  /** Input ids this caller must not see at all. */
  hidden?: string[];
  /** The approval chain bound to this tool's outputs when the instance requires
   *  approval for them (absent = not gated). Mapped onto the generic export-policy
   *  seam so the tool view can offer "Request approval" in place of download. */
  approvalChain?: string;
}

export interface OrgConfig {
  instance: { name: string };
  session?: Session;
  profilePolicy?: Record<string, ProfileFieldSpec>;
  tools?: Record<string, ToolPolicySpec>;
  /** Capability flags the caller has on this instance (e.g. 'link.create'). */
  can?: Record<string, boolean>;
  telemetry?: { level?: string; attribution?: unknown; consented?: boolean };
  inboxUnread?: number;
  policyVersion?: string | number;
}

/** What initOrg resolves with when a control plane is present. `null` (dormant)
 *  means no control plane — see initOrg. */
export interface OrgState {
  auth: AuthConfig;
  session: Session | null;
  config: OrgConfig | null;
  /** True when a sign-in gate has been rendered IN PLACE OF the app; boot must
   *  stop (no view is mounted). */
  gate: boolean;
}

// ── Module state (per session) ────────────────────────────────────────────────

let session: Session | null = null;
let orgConfigState: OrgConfig | null = null;
/** Last org-config ETag, for the conditional request (module-state cache). */
let orgConfigEtag: string | null = null;
const listeners = new Set<(config: OrgConfig | null) => void>();
/** Unregister for the Share-dialog "On this instance" section, so a re-init doesn't
 *  stack a second builder onto the generic share-sections registry. */
let unregisterShareSection: (() => void) | null = null;
/** Unregister for the approval-request opener, so a re-init replaces rather than
 *  leaks the previous registration. */
let unregisterApprovalOpener: (() => void) | null = null;
let unregisterSessionSource: (() => void) | null = null;

/** Short probe budget — a hung network must never delay boot by more than this. */
const PROBE_TIMEOUT_MS = 1500;
/** localStorage negative-cache TTL (per instance base). Optional acceleration
 *  only: it lets a known-dormant origin skip even the one probe on later boots,
 *  and self-heals — if a deployment later gains a control plane, it is seen once
 *  the cached negative expires. Never on the critical path for correctness. */
const ABSENT_TTL_MS = 6 * 60 * 60 * 1000; // 6h
const absentKey = (): string => `lolly:org-absent:${getInstanceBase() || 'same-origin'}`;

// ── Accessors + subscription (the tiny surface other code may consult) ────────

/** The active org-config, or null when dormant / not a member. */
export function orgConfig(): OrgConfig | null {
  return orgConfigState;
}

/** The resolved session, or null (dormant, or a 401/no-session control plane). */
export function orgSession(): Session | null {
  return session;
}

/**
 * The instance-admin console href when the current member's role is admin/owner,
 * else null. A one-function seam a view can consult to show an "Instance console"
 * affordance without importing any of the control-plane machinery above.
 */
export function orgAdminHref(): string | null {
  const role = session?.kind === 'member' ? session.user.role : undefined;
  return role === 'admin' || role === 'owner' ? '/admin' : null;
}

/** Subscribe to org-config changes; returns an unsubscribe fn. */
export function subscribeOrg(fn: (config: OrgConfig | null) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(): void {
  for (const fn of listeners) {
    try { fn(orgConfigState); } catch (e) { console.error(e); }
  }
}

// ── Network helpers (all tolerant; a control-plane hiccup never throws to boot) ─

/** A time-boxed instanceFetch that never rejects — resolves null on any failure
 *  (network error, abort, thrown). */
async function safeFetch(path: string, init?: RequestInit, timeoutMs?: number): Promise<Response | null> {
  const ctrl = timeoutMs ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    return await instanceFetch(instancePath(path), ctrl ? { ...init, signal: ctrl.signal } : init);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Parse a JSON body only when the response looks like real JSON — a 200 that is
 *  actually an SPA-fallback HTML page (a misrouted /api on a static host) is
 *  rejected, so it can never be mistaken for a control-plane reply. */
async function jsonBody<T>(res: Response | null): Promise<T | null> {
  if (!res || !res.ok) return null;
  const ct = res.headers.get('content-type') || '';
  if (!/\bjson\b/i.test(ct)) return null;
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

function isAuthConfig(v: unknown): v is AuthConfig {
  return !!v && typeof v === 'object'
    && ['open', 'gated', 'per-tool'].includes((v as AuthConfig).mode);
}

/** Probe for a control plane. Returns its auth config, or null (dormant). */
async function probeAuthConfig(): Promise<AuthConfig | null> {
  const cfg = await jsonBody<AuthConfig>(await safeFetch('/api/auth/config', undefined, PROBE_TIMEOUT_MS));
  return isAuthConfig(cfg) ? cfg : null;
}

async function fetchSession(): Promise<Session | null> {
  const res = await safeFetch('/api/auth/session');
  if (!res || res.status === 401) return null; // 401 ⇒ no session
  const body = await jsonBody<Session>(res);
  return body && (body.kind === 'member' || body.kind === 'guest') ? body : null;
}

/**
 * Load the member-only org-config with a conditional request. A 304 keeps the
 * cached copy; anything unusable leaves the previous state untouched.
 */
async function fetchOrgConfig(): Promise<OrgConfig | null> {
  const init: RequestInit = orgConfigEtag ? { headers: { 'If-None-Match': orgConfigEtag } } : {};
  const res = await safeFetch('/api/v1/org-config', init);
  if (!res) return orgConfigState;
  if (res.status === 304) return orgConfigState; // unchanged — honour the cache
  const body = await jsonBody<OrgConfig>(res);
  if (!body || typeof body.instance?.name !== 'string') return orgConfigState;
  orgConfigEtag = res.headers.get('etag') || orgConfigEtag;
  return body;
}

// ── Field policy: map the contract's profilePolicy onto the generic registry ──

/**
 * Translate the control-plane profile policy into generic FieldPolicy entries
 * and install them. A locked field gets a localised "Managed by <instance>" note
 * here (the registry itself stays product-neutral). Called with an empty/absent
 * policy too, which clears the registry back to its dormant default.
 */
function applyProfilePolicy(config: OrgConfig | null): void {
  const spec = config?.profilePolicy;
  if (!spec) { setFieldPolicies({}); return; }
  const instanceName = config!.instance?.name || '';
  const managedNote = instanceName
    ? t('Managed by {name}', { name: instanceName })
    : t('Managed by your organisation');
  const out: Record<string, FieldPolicy> = {};
  for (const [field, s] of Object.entries(spec)) {
    if (!s || !['editable', 'locked', 'hidden'].includes(s.mode)) continue;
    out[field] = {
      mode: s.mode,
      note: s.mode === 'locked' ? managedNote : undefined,
      value: s.value,
    };
  }
  setFieldPolicies(out);
}

// ── Export policy: map the contract's capability bits + per-tool chains onto the seam ─

/**
 * Translate the caller's export capability bits and per-tool approval chains into a
 * generic ExportPolicy and install it (see src/lib/export-policy.ts). `export.download`
 * defaults to allowed when the control plane doesn't say otherwise, so an instance that
 * doesn't use this feature stays byte-identical to today; only an explicit `false`
 * withholds download. `export.request` gates whether "Request approval" is offered in
 * its place, and each tool's `approvalChain` binds the chain used for that request.
 * A null config (dormant / non-member) clears the seam back to its dormant default.
 */
function applyExportPolicy(config: OrgConfig | null): void {
  if (!config) { setExportPolicy(undefined); return; }
  const can = config.can ?? {};
  const chains: Record<string, string> = {};
  for (const [toolId, spec] of Object.entries(config.tools ?? {})) {
    if (spec?.approvalChain) chains[toolId] = spec.approvalChain;
  }
  setExportPolicy({
    canDownload: can['export.download'] !== false,
    canRequestApproval: !!can['export.request'],
    chains,
  });
}

// ── Tool input policy: map the contract's per-tool spec onto the generic registry ─

/**
 * Populate the generic src/lib/input-policy.ts registry for one tool from the
 * control plane's per-tool declaration, translating it into neutral InputPolicy
 * entries. A locked/choice input gets the localised "Managed by <instance>" note
 * here (the registry itself stays product-neutral); `hidden` ids win over any
 * access rule for the same input.
 *
 * Always clears the registry first, so this both installs the mounted tool's policy
 * and drops any previous tool's. A dormant no-op when there is no control plane or
 * no declaration for this tool — the sidebar then renders exactly as today. Called
 * by the tool view when a tool mounts.
 */
export function applyOrgToolPolicies(toolId: string): void {
  clearInputPolicies();
  const spec = orgConfigState?.tools?.[toolId];
  if (!spec) return;
  const instanceName = orgConfigState!.instance?.name || '';
  const managedNote = instanceName
    ? t('Managed by {name}', { name: instanceName })
    : t('Managed by your organisation');
  const out: Record<string, InputPolicy> = {};
  for (const inp of spec.inputs ?? []) {
    const access = inp?.access;
    if (!inp?.id || !access) continue;
    if (access.level === 'locked') {
      out[inp.id] = { mode: 'locked', note: managedNote, value: access.value };
    } else if (access.level === 'choice') {
      out[inp.id] = { mode: 'choice', note: managedNote, value: access.value, allow: access.allow };
    }
  }
  // `hidden` (must-not-see) wins over any access rule for the same input.
  for (const id of spec.hidden ?? []) out[id] = { mode: 'hidden' };
  setToolInputPolicies(toolId, out);
}

// ── The sign-in gate (rendered in place of the app for a gated instance) ──────

/** Build the login URL: the deployment's loginPath (instance-prefixed) carrying
 *  returnTo=<the URL the visitor asked for>. */
function loginUrl(loginPath: string): string {
  const returnTo = location.pathname + location.search + location.hash;
  const base = instancePath(loginPath);
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}returnTo=${encodeURIComponent(returnTo)}`;
}

/**
 * Render a minimal sign-in gate into #view, in the shell's visual language. All
 * strings localised; the primary action is a plain link to the login URL, so it
 * behaves like any navigation (open-in-tab, etc.). Returns true when the gate
 * was shown (boot should stop), false when it could not be (no loginPath).
 */
function renderGate(auth: AuthConfig, instanceName?: string): boolean {
  const view = document.getElementById('view');
  if (!view) return false;
  if (!auth.loginPath) return false; // gated but no way in — misconfigured; let boot proceed
  const name = instanceName ? escape(instanceName) : '';
  const heading = name
    ? t('Sign in to {name}', { name })
    : t('Sign in to continue');
  document.title = `${t('Sign in')} — Lolly`;
  view.innerHTML = `
    <section class="org-gate" aria-label="${escape(t('Sign in'))}" style="min-height:70vh;display:flex;align-items:center;justify-content:center;padding:40px 20px">
      <div class="org-gate-card" style="width:100%;max-width:26rem;text-align:center;background:hsl(var(--card));color:hsl(var(--card-foreground));border:1px solid hsl(var(--border));border-radius:var(--radius);padding:2rem 1.75rem;box-shadow:0 26px 60px -30px hsl(var(--foreground) / .35)">
        <h1 style="margin:0 0 .5rem;font-size:1.4rem;font-weight:750;letter-spacing:-.01em">${heading}</h1>
        <p style="margin:0 0 1.5rem;color:hsl(var(--muted-foreground));font-size:.95rem;line-height:1.55">${t('This Lolly instance asks you to sign in before you continue.')}</p>
        <a class="btn btn--primary" href="${escape(loginUrl(auth.loginPath))}" style="display:inline-flex;align-items:center;justify-content:center;min-width:9rem">${t('Sign in')}</a>
      </div>
    </section>`;
  return true;
}

// ── Orchestration ─────────────────────────────────────────────────────────────

/**
 * Initialise the org seam. Resolves:
 *   - `null` — no control plane (dormant): the shell proceeds exactly as today.
 *   - `OrgState` with `gate: true` — a sign-in gate was rendered; STOP boot.
 *   - `OrgState` with `gate: false` — control plane present, proceed to mount the
 *     app; any member profile policy + inbox banner have been applied.
 *
 * Tolerant by construction: any unexpected failure resolves to dormancy so this
 * optional seam can never block or break boot.
 */
export async function initOrg(): Promise<OrgState | null> {
  try {
    // Skip even the probe when this origin was recently seen to have no control
    // plane (module state already covers a single session; this covers reloads).
    if (isRecentlyAbsent()) return null;

    const auth = await probeAuthConfig();
    if (!auth) { rememberAbsent(); return null; }

    session = await fetchSession();
    const isMember = session?.kind === 'member';

    // Gated instance, not a member → sign-in gate instead of the app.
    if (auth.mode === 'gated' && !isMember) {
      const gated = renderGate(auth);
      if (gated) return { auth, session, config: null, gate: true };
      // Could not render a gate (no loginPath) — fall through and let the app mount.
    }

    // Member → load org-config, apply its profile policy, surface the inbox.
    if (isMember) {
      orgConfigState = await fetchOrgConfig();
      applyProfilePolicy(orgConfigState);
      // Populate the generic export-policy seam (download vs. request-approval) from
      // the caller's capability bits + per-tool approval chains, and register the
      // approval-request opener. The opener lazy-imports the dialog only when a member
      // actually requests approval, keeping it out of the boot chunk. Both are
      // dormant-safe: a member whose instance withholds nothing downloads exactly as
      // today, and the opener is only ever reached via the export-policy affordance.
      applyExportPolicy(orgConfigState);
      unregisterApprovalOpener?.();
      unregisterApprovalOpener = registerApprovalOpener((rctx) => {
        import('./approval-dialog.ts')
          .then((m) => m.openApprovalDialog(rctx))
          .catch(() => { /* additive; never break the caller */ });
      });
      // Offer instance-hosted links in the Share dialog. Registered through the
      // generic lib/share-sections.ts seam (so the dialog stays control-plane-
      // unaware), with the heavy builder module lazy-imported only when a member
      // actually opens the dialog. The builder self-gates on the caller's `can`
      // bits, so registering for every member is safe — it renders nothing for a
      // member without link permissions.
      unregisterShareSection?.();
      unregisterShareSection = registerShareSection(async (sctx) => {
        const cfg = orgConfig();
        if (!cfg) return null;
        const { buildInstanceShareSection } = await import('./share-links.ts');
        return buildInstanceShareSection(sctx, cfg);
      });
      // Surface the instance's shared team projects in the Projects view, through
      // the generic lib/session-source.ts seam (so the view stays control-plane-
      // unaware). Pure data — the view owns opening a team session, reusing its own
      // engine URL reconstruction, so no engine/DOM concern leaks in here.
      unregisterSessionSource?.();
      unregisterSessionSource = registerSessionSource(
        createInstanceSessionSource(orgConfigState?.instance?.name || t('your organisation')),
      );
      emit();
      if ((orgConfigState?.inboxUnread ?? 0) > 0) {
        // Lazy — the banner (and its modal dep) stay out of the boot chunk, and
        // load only for the rare member with unread messages.
        import('./banner.ts')
          .then((m) => m.mountOrgBanner())
          .catch(() => { /* banner is additive; never block or break boot */ });
      }
    }

    return { auth, session, config: orgConfigState, gate: false };
  } catch {
    // Absolute backstop: this seam is additive — a bug here must not break boot.
    return null;
  }
}

// ── localStorage negative cache (best-effort; never breaks the dormant path) ──

function isRecentlyAbsent(): boolean {
  try {
    const raw = localStorage.getItem(absentKey());
    if (!raw) return false;
    const at = Number(raw);
    if (Number.isFinite(at) && Date.now() - at < ABSENT_TTL_MS) return true;
    localStorage.removeItem(absentKey());
  } catch { /* storage unavailable — just probe */ }
  return false;
}

function rememberAbsent(): void {
  try { localStorage.setItem(absentKey(), String(Date.now())); } catch { /* ignore */ }
}

/** TEST-ONLY: reset module state between cases. */
export function _resetOrgForTests(): void {
  session = null;
  orgConfigState = null;
  orgConfigEtag = null;
  listeners.clear();
  unregisterShareSection?.();
  unregisterShareSection = null;
  unregisterApprovalOpener?.();
  unregisterApprovalOpener = null;
  unregisterSessionSource?.();
  unregisterSessionSource = null;
  clearInputPolicies();
  setExportPolicy(undefined);
}
