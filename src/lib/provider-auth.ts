// SPDX-License-Identifier: MPL-2.0
/**
 * provider-auth - the shared OAuth machinery every personal send-target driver
 * rides (plans/129). Extracted from lib/google-drive.ts's popup flow and grown
 * one grant:
 *
 *   - `popupOAuth()` - the popup + BOTH return channels (opener postMessage and
 *     the BroadcastChannel that survives COOP severance - plans/127), the
 *     closed-poll that stands down under cross-origin isolation, the timeout,
 *     the cleanup. Providers differ only in the URL they open and how they
 *     parse what comes back.
 *   - `codeGrant()` / `refreshGrant()` - authorization-code + PKCE for public
 *     clients (Dropbox, Microsoft SPA): S256 challenge, state validation, the
 *     token exchange over CORS. No client secret anywhere, ever.
 *
 * Google's web clients still demand a secret for code exchange, so the gdrive
 * driver keeps its implicit token grant and reuses only popupOAuth from here.
 *
 * PRIVACY: everything is client → provider directly. Tokens live in the
 * caller's custody (lib/provider-connections.ts); nothing here persists.
 */

import { t } from '../i18n.ts';

/** What the return page delivers (public/oauth-return.html): the fragment
 *  (token grants) and the query string (code grants), verbatim. */
export interface OAuthReturn {
  hash: string;
  search: string;
}

/** A minted (or refreshed) token set. `refreshToken` only where the provider
 *  granted one AND the flow asked for offline access. */
export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms; refresh a minute early so a send never starts on a dying token. */
  expiresAt: number;
}

const AUTH_TIMEOUT_MS = 180_000;

/**
 * Open the provider's page in a popup and wait for /oauth-return.html to
 * deliver. Rejects on popup-blocked, timeout, or (outside isolation, where the
 * handle is trustworthy) a closed popup. The caller validates `state`.
 */
export function popupOAuth(url: string, windowName: string): Promise<OAuthReturn> {
  const popup = window.open(url, windowName, 'popup,width=480,height=640');
  if (!popup) return Promise.reject(new Error(t('Sign-in popup was blocked - allow popups for this site')));
  return new Promise<OAuthReturn>((resolve, reject) => {
    const done = (fn: () => void) => { cleanup(); fn(); };
    const accept = (data: { source?: string; hash?: string; search?: string } | null) => {
      if (!data || data.source !== 'lolly-oauth') return;
      done(() => resolve({ hash: data.hash || '', search: data.search || '' }));
    };
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== location.origin) return;
      accept(e.data as { source?: string; hash?: string; search?: string } | null);
    };
    // The isolation-proof channel: under COOP: same-origin the popup's opener
    // handle is severed on the provider's pages, so the return page reaches us
    // over BroadcastChannel instead (same origin, same isolation partition).
    let bc: BroadcastChannel | null = null;
    try {
      bc = new BroadcastChannel('lolly-oauth');
      bc.onmessage = (e) => accept(e.data as { source?: string; hash?: string; search?: string } | null);
    } catch { /* no BroadcastChannel - the opener path covers it */ }
    // A closed popup never posts; poll so the caller isn't left hanging. A
    // SEVERED handle also reads closed under isolation, so there the timeout
    // is the only honest cancel signal and the poll must stay out of it.
    const closedPoll = globalThis.crossOriginIsolated ? null : setInterval(() => {
      if (popup.closed) done(() => reject(new Error(t('Sign-in was cancelled'))));
    }, 500);
    const timeout = setTimeout(() => done(() => reject(new Error(t('Sign-in timed out')))), AUTH_TIMEOUT_MS);
    const cleanup = () => {
      window.removeEventListener('message', onMessage);
      bc?.close();
      if (closedPoll != null) clearInterval(closedPoll);
      clearTimeout(timeout);
      try { if (!popup.closed) popup.close(); } catch { /* cross-origin at half-close */ }
    };
    window.addEventListener('message', onMessage);
  });
}

// ── PKCE (RFC 7636, S256) ─────────────────────────────────────────────────────

const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function randomState(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(16)));
}

/** A fresh verifier (43-128 chars) and its S256 challenge. */
export async function makePkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48))); // 64 chars
  const challenge = await pkceChallenge(verifier);
  return { verifier, challenge };
}

/** S256: base64url(SHA-256(ascii(verifier))). Exported for its test vector. */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return b64url(new Uint8Array(digest));
}

// ── Authorization-code grant for public clients ───────────────────────────────

export interface CodeGrantConfig {
  /** e.g. https://www.dropbox.com/oauth2/authorize */
  authorizeUrl: string;
  /** e.g. https://api.dropboxapi.com/oauth2/token - must answer CORS. */
  tokenUrl: string;
  clientId: string;
  /** Space-separated provider scopes. */
  scopes: string;
  /** Extra authorize-URL params (e.g. Dropbox token_access_type=offline). */
  extraAuthParams?: Record<string, string>;
  windowName?: string;
}

/** The return page - the SAME registered redirect the token grant uses. */
export const oauthRedirectUri = (): string => `${location.origin}/oauth-return.html`;

/** Map one token-endpoint JSON response to a TokenSet. Exported for tests. */
export function tokenSetFrom(json: Record<string, unknown>): TokenSet {
  const accessToken = typeof json.access_token === 'string' ? json.access_token : '';
  if (!accessToken) throw new Error(t('Sign-in failed: the provider returned no token'));
  const expiresInS = Math.max(60, Number(json.expires_in) || 3600);
  return {
    accessToken,
    ...(typeof json.refresh_token === 'string' && json.refresh_token ? { refreshToken: json.refresh_token } : {}),
    expiresAt: Date.now() + (expiresInS - 60) * 1000,
  };
}

/** Parse and validate a code-grant return. Exported for tests. */
export function parseCodeReturn(search: string, expectedState: string): string {
  const p = new URLSearchParams(search.replace(/^\?/, ''));
  const err = p.get('error');
  if (err) throw new Error(t('Sign-in failed: {reason}', { reason: p.get('error_description') || err }));
  if (p.get('state') !== expectedState) throw new Error(t('Sign-in failed: state mismatch'));
  const code = p.get('code');
  if (!code) throw new Error(t('Sign-in failed: the provider returned no code'));
  return code;
}

/** The full interactive code+PKCE flow: popup → code → token exchange. */
export async function codeGrant(cfg: CodeGrantConfig, fetchFn: typeof fetch = fetch): Promise<TokenSet> {
  const state = randomState();
  const { verifier, challenge } = await makePkce();
  const redirectUri = oauthRedirectUri();
  const url = `${cfg.authorizeUrl}?${new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: cfg.scopes,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ...cfg.extraAuthParams,
  })}`;
  const ret = await popupOAuth(url, cfg.windowName ?? 'lolly-oauth');
  const code = parseCodeReturn(ret.search, state);
  const res = await fetchFn(cfg.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: cfg.clientId,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      ...(cfg.scopes && cfg.tokenUrl.includes('microsoftonline') ? { scope: cfg.scopes } : {}),
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(t('Sign-in failed ({status})', { status: res.status }) + (body ? `: ${body.slice(0, 160)}` : ''));
  }
  return tokenSetFrom(await res.json() as Record<string, unknown>);
}

/** Exchange a refresh token for a fresh set. Providers may ROTATE the refresh
 *  token (Microsoft does) - the caller must store the returned one. */
export async function refreshGrant(
  cfg: { tokenUrl: string; clientId: string; scopes?: string },
  refreshToken: string,
  fetchFn: typeof fetch = fetch,
): Promise<TokenSet> {
  const res = await fetchFn(cfg.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: cfg.clientId,
      ...(cfg.scopes && cfg.tokenUrl.includes('microsoftonline') ? { scope: cfg.scopes } : {}),
    }),
  });
  if (!res.ok) throw new Error(t('Your connection has expired - connect again'));
  const set = tokenSetFrom(await res.json() as Record<string, unknown>);
  // A provider that does not rotate keeps the old refresh token working.
  return { refreshToken, ...set };
}
