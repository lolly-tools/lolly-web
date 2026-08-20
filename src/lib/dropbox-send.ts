// SPDX-License-Identifier: MPL-2.0
/**
 * Dropbox send target (plans/129) - the `dropbox` driver on the shared
 * provider-auth machinery: authorization-code + PKCE (public client, no
 * secret), refresh tokens when the user opts into "stay connected", uploads
 * into the app's OWN FOLDER only.
 *
 * SCOPES, minimal and named in the UI: files.content.write (put the file),
 * files.content.read (mint the short-lived "Open" link via get_temporary_link
 * - no public share is ever created), account_info.read (the /profile row's
 * account label). The Dropbox app registration must be "App folder" access
 * type, so the token can only ever see Apps/<app-name>/.
 *
 * DORMANT without a client id (VITE_DROPBOX_CLIENT_ID, or an instance's
 * runtime override) - the gdrive precedent: no id, no button, byte-identical.
 *
 * GOTCHA the test pins: the Dropbox-API-Arg header must be ASCII - a filename
 * with any non-ASCII character must be \uXXXX-escaped into the JSON header or
 * the request is refused at the HTTP layer.
 */

import { t } from '../i18n.ts';
import { isTauriShell } from './instance-choice.ts';
import { codeGrant, refreshGrant, type TokenSet } from './provider-auth.ts';
import {
  getConnection, saveConnection, removeConnection,
  cachedToken, cacheToken, dropToken,
} from './provider-connections.ts';
import type { SendTarget } from './send-target.ts';

const KIND = 'dropbox';
const AUTHORIZE_URL = 'https://www.dropbox.com/oauth2/authorize';
const TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';
const API = 'https://api.dropboxapi.com/2';
const CONTENT = 'https://content.dropboxapi.com/2';
const SCOPES = 'files.content.write files.content.read account_info.read';

let clientIdOverride: string | null = null;

/** Runtime override (an instance config or a test); null restores the env value. */
export function setDropboxClientId(id: string | null): void { clientIdOverride = id; }

export function dropboxClientId(): string {
  if (clientIdOverride !== null) return clientIdOverride;
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  return env?.VITE_DROPBOX_CLIENT_ID || '';
}

export function dropboxAvailable(): boolean { return !!dropboxClientId(); }

// ── Auth ──────────────────────────────────────────────────────────────────────

const grantCfg = () => ({
  authorizeUrl: AUTHORIZE_URL,
  tokenUrl: TOKEN_URL,
  clientId: dropboxClientId(),
  scopes: SCOPES,
  // offline = a refresh token comes back; whether it PERSISTS is the user's
  // custody choice, decided in connect() below.
  extraAuthParams: { token_access_type: 'offline' },
  windowName: 'lolly-dropbox-auth',
});

function remember(set: TokenSet): void {
  cacheToken(KIND, set.accessToken, set.expiresAt);
}

/** A valid access token: cache → refresh (stored connection) → interactive. */
async function token(fetchFn: typeof fetch = fetch): Promise<string> {
  const held = cachedToken(KIND);
  if (held) return held;
  const conn = await getConnection(KIND);
  if (conn?.refreshToken) {
    try {
      const set = await refreshGrant({ tokenUrl: TOKEN_URL, clientId: dropboxClientId() }, conn.refreshToken, fetchFn);
      remember(set);
      if (set.refreshToken && set.refreshToken !== conn.refreshToken) {
        await saveConnection({ ...conn, refreshToken: set.refreshToken });
      }
      return set.accessToken;
    } catch { /* refresh revoked/expired - fall through to interactive */ }
  }
  const set = await codeGrant(grantCfg(), fetchFn);
  remember(set);
  // A send-time sign-in without a /profile connection stays session-only.
  if (conn) await saveConnection({ ...conn, ...(conn.persist && set.refreshToken ? { refreshToken: set.refreshToken } : {}) });
  return set.accessToken;
}

/** POST an RPC endpoint with one 401 retry through a fresh token. */
async function rpc(path: string, body: unknown, fetchFn: typeof fetch = fetch): Promise<Record<string, unknown>> {
  const doPost = async (tok: string) => fetchFn(`${API}/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? null),
  });
  let res = await doPost(await token(fetchFn));
  if (res.status === 401) {
    dropToken(KIND);
    res = await doPost(await token(fetchFn));
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(t('Dropbox request failed ({status})', { status: res.status }) + (text ? `: ${text.slice(0, 160)}` : ''));
  }
  return await res.json() as Record<string, unknown>;
}

// ── /profile connection surface ───────────────────────────────────────────────

/** Interactive connect from /profile: grant, identity, custody. */
export async function connectDropbox(persist: boolean, fetchFn: typeof fetch = fetch): Promise<string> {
  const set = await codeGrant(grantCfg(), fetchFn);
  remember(set);
  const who = await rpc('users/get_current_account', null, fetchFn);
  const account = (who.email as string) || ((who.name as { display_name?: string })?.display_name ?? t('Dropbox account'));
  await saveConnection({
    kind: KIND,
    account,
    persist,
    ...(persist && set.refreshToken ? { refreshToken: set.refreshToken } : {}),
    scopes: SCOPES,
    connectedAt: new Date().toISOString(),
  });
  return account;
}

/** Disconnect: best-effort provider-side revocation, then wipe locally. */
export async function disconnectDropbox(fetchFn: typeof fetch = fetch): Promise<void> {
  const held = cachedToken(KIND);
  if (held) {
    try {
      await fetchFn(`${API}/auth/token/revoke`, { method: 'POST', headers: { Authorization: `Bearer ${held}` } });
    } catch { /* revocation is a courtesy; the wipe below is the guarantee */ }
  }
  await removeConnection(KIND);
}

// ── Upload ────────────────────────────────────────────────────────────────────

/** Dropbox-API-Arg must be ASCII: escape every non-ASCII char in the JSON.
 *  Exported for its test. */
export function dropboxApiArg(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (c) =>
    `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

interface DropboxFile { path_display?: string; path_lower?: string; name?: string }

export async function dropboxUpload(bytes: Uint8Array, path: string, fetchFn: typeof fetch = fetch): Promise<DropboxFile> {
  const doPost = async (tok: string) => fetchFn(`${CONTENT}/files/upload`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tok}`,
      'Dropbox-API-Arg': dropboxApiArg({ path, mode: 'add', autorename: true, mute: true }),
      'Content-Type': 'application/octet-stream',
    },
    body: bytes as unknown as BodyInit,
  });
  let res = await doPost(await token(fetchFn));
  if (res.status === 401) {
    dropToken(KIND);
    res = await doPost(await token(fetchFn));
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(t('Dropbox upload failed ({status})', { status: res.status }) + (text ? `: ${text.slice(0, 160)}` : ''));
  }
  return await res.json() as DropboxFile;
}

// ── The SendTarget ────────────────────────────────────────────────────────────

export function dropboxSendTarget(): SendTarget {
  return {
    kind: KIND,
    label: t('Dropbox'),
    // No formats list: every export format Lolly makes is welcome.
    available: () => dropboxAvailable() && !isTauriShell(),
    hint: t('Uploads this file to the Lolly app folder in your Dropbox. Lolly can only see that folder, and whether your sign-in is remembered on this device is your choice in Profile.'),
    send: async ({ bytes, name, format }) => {
      const filename = name.toLowerCase().endsWith(`.${format}`) ? name : `${name}.${format}`;
      const file = await dropboxUpload(bytes, `/${filename}`);
      // A short-lived direct link (4h), never a public share.
      let url: string | undefined;
      try {
        const link = await rpc('files/get_temporary_link', { path: file.path_lower ?? `/${filename}` });
        if (typeof link.link === 'string') url = link.link;
      } catch { /* the upload stands; the label carries the outcome */ }
      return { url, label: t('Saved to Dropbox ({path})', { path: file.path_display ?? `/${filename}` }) };
    },
  };
}
