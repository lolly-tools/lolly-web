// SPDX-License-Identifier: MPL-2.0
/**
 * OneDrive send target (plans/129) - the `o365` driver (the lolly-work
 * vocabulary; one driver covers consumer OneDrive AND work/school O365 drives)
 * on the shared provider-auth machinery: Microsoft identity platform,
 * authorization-code + PKCE as a SINGLE-PAGE APPLICATION client. That client
 * type matters twice over: it is what makes the token endpoint answer
 * CORS from a browser, and what allows a public client (no secret) - the
 * redirect URI must be registered under "Single-page application" in the
 * Azure app or the exchange fails, which the setup guide spells out.
 *
 * SCOPES, minimal and named in the UI: Files.ReadWrite.AppFolder (the app's
 * own folder under Apps/, never the whole drive), User.Read (the /profile
 * account label), offline_access (a refresh token - persisted only when the
 * user opts into "stay connected"; Microsoft ROTATES refresh tokens, so every
 * refresh re-saves the new one).
 *
 * UPLOADS: files up to 4 MB go straight to Graph
 * (PUT /me/drive/special/approot:/name:/content); larger media goes through an
 * UPLOAD SESSION - Graph hands back a pre-authenticated uploadUrl (NO
 * Authorization header on the chunk PUTs, per Graph's contract) on a
 * Microsoft-owned upload host. Those hosts are in the deploy CSP; a
 * self-hosted deploy that trims them keeps small files working and gets an
 * honest error for large ones.
 */

import { t } from '../i18n.ts';
import { isTauriShell } from './instance-choice.ts';
import { codeGrant, refreshGrant, type TokenSet } from './provider-auth.ts';
import {
  getConnection, saveConnection, removeConnection,
  cachedToken, cacheToken, dropToken,
} from './provider-connections.ts';
import type { SendTarget } from './send-target.ts';

const KIND = 'o365';
const AUTHORIZE_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';
const TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const SCOPES = 'Files.ReadWrite.AppFolder User.Read offline_access';

/** Graph accepts simple PUTs up to 4 MB; anything larger needs a session. */
export const GRAPH_SIMPLE_UPLOAD_MAX = 4 * 1024 * 1024;
/** Session chunk size - Graph requires a multiple of 320 KiB; 12 of them. */
export const GRAPH_CHUNK_BYTES = 320 * 1024 * 12;

let clientIdOverride: string | null = null;

/** Runtime override (an instance config or a test); null restores the env value. */
export function setOneDriveClientId(id: string | null): void { clientIdOverride = id; }

export function oneDriveClientId(): string {
  if (clientIdOverride !== null) return clientIdOverride;
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  return env?.VITE_MS_CLIENT_ID || '';
}

export function oneDriveAvailable(): boolean { return !!oneDriveClientId(); }

// ── Auth ──────────────────────────────────────────────────────────────────────

const grantCfg = () => ({
  authorizeUrl: AUTHORIZE_URL,
  tokenUrl: TOKEN_URL,
  clientId: oneDriveClientId(),
  scopes: SCOPES,
  windowName: 'lolly-onedrive-auth',
});

function remember(set: TokenSet): void {
  cacheToken(KIND, set.accessToken, set.expiresAt);
}

/** A valid access token: cache → refresh (stored connection) → interactive.
 *  Microsoft rotates refresh tokens, so a successful refresh RE-SAVES. */
async function token(fetchFn: typeof fetch = fetch): Promise<string> {
  const held = cachedToken(KIND);
  if (held) return held;
  const conn = await getConnection(KIND);
  if (conn?.refreshToken) {
    try {
      const set = await refreshGrant({ tokenUrl: TOKEN_URL, clientId: oneDriveClientId(), scopes: SCOPES }, conn.refreshToken, fetchFn);
      remember(set);
      if (set.refreshToken && set.refreshToken !== conn.refreshToken) {
        await saveConnection({ ...conn, refreshToken: set.refreshToken });
      }
      return set.accessToken;
    } catch { /* refresh revoked/expired - fall through to interactive */ }
  }
  const set = await codeGrant(grantCfg(), fetchFn);
  remember(set);
  if (conn) await saveConnection({ ...conn, ...(conn.persist && set.refreshToken ? { refreshToken: set.refreshToken } : {}) });
  return set.accessToken;
}

async function graph(path: string, init: RequestInit = {}, fetchFn: typeof fetch = fetch): Promise<Response> {
  const doFetch = async (tok: string) => fetchFn(`${GRAPH}${path}`, {
    ...init,
    headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${tok}` },
  });
  let res = await doFetch(await token(fetchFn));
  if (res.status === 401) {
    dropToken(KIND);
    res = await doFetch(await token(fetchFn));
  }
  return res;
}

// ── /profile connection surface ───────────────────────────────────────────────

export async function connectOneDrive(persist: boolean, fetchFn: typeof fetch = fetch): Promise<string> {
  const set = await codeGrant(grantCfg(), fetchFn);
  remember(set);
  const res = await graph('/me', {}, fetchFn);
  if (!res.ok) throw new Error(t('Could not read the Microsoft account ({status})', { status: res.status }));
  const me = await res.json() as { mail?: string; userPrincipalName?: string; displayName?: string };
  const account = me.mail || me.userPrincipalName || me.displayName || t('Microsoft account');
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

/** Microsoft has no simple public revocation endpoint for this shape - the
 *  local wipe is the action; the account's own security page lists the grant. */
export async function disconnectOneDrive(): Promise<void> {
  await removeConnection(KIND);
}

// ── Upload ────────────────────────────────────────────────────────────────────

/** The Content-Range chunks an upload session PUTs. Pure, for its test. */
export function uploadChunkRanges(total: number, chunk = GRAPH_CHUNK_BYTES): Array<{ start: number; end: number; range: string }> {
  const out: Array<{ start: number; end: number; range: string }> = [];
  for (let start = 0; start < total; start += chunk) {
    const end = Math.min(start + chunk, total);
    out.push({ start, end, range: `bytes ${start}-${end - 1}/${total}` });
  }
  return out;
}

interface DriveItem { id?: string; webUrl?: string; name?: string }

async function uploadSmall(bytes: Uint8Array, name: string, mime: string, fetchFn: typeof fetch): Promise<DriveItem> {
  const res = await graph(`/me/drive/special/approot:/${encodeURIComponent(name)}:/content`, {
    method: 'PUT',
    headers: { 'Content-Type': mime || 'application/octet-stream' },
    body: bytes as unknown as BodyInit,
  }, fetchFn);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(t('OneDrive upload failed ({status})', { status: res.status }) + (text ? `: ${text.slice(0, 160)}` : ''));
  }
  return await res.json() as DriveItem;
}

async function uploadLarge(bytes: Uint8Array, name: string, fetchFn: typeof fetch): Promise<DriveItem> {
  const sess = await graph(`/me/drive/special/approot:/${encodeURIComponent(name)}:/createUploadSession`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'rename', name } }),
  }, fetchFn);
  if (!sess.ok) throw new Error(t('OneDrive upload failed ({status})', { status: sess.status }));
  const { uploadUrl } = await sess.json() as { uploadUrl?: string };
  if (!uploadUrl) throw new Error(t('OneDrive upload failed ({status})', { status: 500 }));
  let last: Response | null = null;
  for (const { start, end, range } of uploadChunkRanges(bytes.byteLength)) {
    // The session URL is PRE-AUTHENTICATED - no Authorization header, per Graph.
    last = await fetchFn(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Range': range, 'Content-Type': 'application/octet-stream' },
      body: bytes.subarray(start, end) as unknown as BodyInit,
    });
    if (!last.ok) {
      const text = await last.text().catch(() => '');
      throw new Error(t('OneDrive upload failed ({status})', { status: last.status }) + (text ? `: ${text.slice(0, 160)}` : ''));
    }
  }
  return (await last?.json().catch(() => ({}))) as DriveItem;
}

// ── The SendTarget ────────────────────────────────────────────────────────────

export function oneDriveSendTarget(): SendTarget {
  return {
    kind: KIND,
    label: t('OneDrive'),
    // No formats list: every export format Lolly makes is welcome.
    available: () => oneDriveAvailable() && !isTauriShell(),
    hint: t('Uploads this file to the Lolly app folder in your OneDrive. Lolly can only see that folder, and whether your sign-in is remembered on this device is your choice in Profile.'),
    send: async ({ bytes, name, format, mime }) => {
      const filename = name.toLowerCase().endsWith(`.${format}`) ? name : `${name}.${format}`;
      const item = bytes.byteLength <= GRAPH_SIMPLE_UPLOAD_MAX
        ? await uploadSmall(bytes, filename, mime, fetch)
        : await uploadLarge(bytes, filename, fetch);
      return {
        url: item.webUrl,
        label: item.webUrl ? t('Open in OneDrive') : t('Saved to OneDrive ({name})', { name: item.name ?? filename }),
      };
    },
  };
}
