// SPDX-License-Identifier: MPL-2.0
/**
 * Send to Google Drive - the individual, fully client-side path that lands a
 * Lolly export in the user's own Drive with the one thing Google's web
 * uploader refuses to set: the stored mimeType.
 *
 * Why this exists (measured in a live Drive, 2026-08-18): Drive re-types every
 * web upload SERVER-side from its own extension table. A normal `.emf` upload,
 * a `.wmf` rename and even a synthetic drop whose File carried
 * `type: application/x-msmetafile` all land as a generic blob with no
 * "Open with Google Drawings" route. Only Drive API metadata sets the stored
 * type - which is also why the classic Apps Script fix works. So the EMF →
 * Google Drawings → Slides journey needs exactly one authenticated
 * `files.create`, and nothing less.
 *
 * Privacy posture, deliberately minimal:
 *   - Scope is `drive.file`: Lolly can see and touch ONLY files it created,
 *     never the rest of the Drive.
 *   - The OAuth token lives in memory for the session and is never persisted.
 *   - No Google script is loaded. The flow is a plain popup to
 *     accounts.google.com (a top-level navigation, outside our CSP) returning
 *     to the same-origin static page public/oauth-return.html, which
 *     postMessages the token fragment back and closes. The shell keeps zero
 *     third-party JS. If Google ever retires the implicit `response_type=token`
 *     grant for web clients, the swap point is requestToken() below (the GIS
 *     token client would replace it, at the cost of loading their script).
 *   - The only fetch target is https://www.googleapis.com (connect-src).
 *
 * The feature is DORMANT unless a Google OAuth client id is configured
 * (VITE_GOOGLE_CLIENT_ID at build time, or setDriveClientId at runtime): no
 * client id, no UI, no requests - a plain build stays byte-identical in
 * behaviour. The client id is public by design (implicit/public OAuth flows
 * have no secret); each deploy origin must be registered on the client with
 * redirect URI `<origin>/oauth-return.html`.
 *
 * Surfaced through the PROVIDER-AGNOSTIC send-target seam (lib/send-target.ts):
 * this module is the `gdrive` driver, and googleDriveSendTarget() is what
 * send-targets-builtin.ts registers. Sibling providers (dropbox, o365, … -
 * the lolly-work provider vocabulary) follow the same shape: their own OAuth
 * + upload here-alike module, one registered SendTarget each.
 */

import type { SendTarget } from './send-target.ts';
import { isTauriShell } from './instance-choice.ts';
import { t } from '../i18n.ts';

export interface DriveUploadResult {
  id: string;
  mimeType: string;
  webViewLink?: string;
}

export interface DriveSendOutcome {
  file: DriveUploadResult;
  /** True when Drive converted the upload into a native Google Drawing. */
  converted: boolean;
}

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,mimeType,webViewLink';
const METAFILE_MIME = 'application/x-msmetafile';
const DRAWING_MIME = 'application/vnd.google-apps.drawing';

let clientIdOverride: string | null = null;

/** Runtime override (an instance config or a test); null restores the env value. */
export function setDriveClientId(id: string | null): void { clientIdOverride = id; }

export function driveClientId(): string {
  if (clientIdOverride !== null) return clientIdOverride;
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  return env?.VITE_GOOGLE_CLIENT_ID || '';
}

/** Whether the Send-to-Drive affordance should exist at all. */
export function driveAvailable(): boolean { return !!driveClientId(); }

// ─── OAuth (implicit token grant via popup + same-origin return page) ────────

/** The auth URL for the popup. Pure, for tests. */
export function buildAuthUrl(clientId: string, state: string, redirectUri: string): string {
  const p = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'token',
    scope: SCOPE,
    state,
    // A fresh grant each time the token expired keeps the session tokenless at
    // rest; include_granted_scopes keeps re-consent to a single click.
    include_granted_scopes: 'true',
    prompt: 'select_account',
  });
  return `${AUTH_URL}?${p}`;
}

/** Parse the return page's `#access_token=…` fragment. Pure, for tests.
 *  Throws on an OAuth error, a state mismatch, or a missing token. */
export function parseOAuthReturn(hash: string, expectedState: string): { token: string; expiresInS: number } {
  const p = new URLSearchParams(hash.replace(/^#/, ''));
  const err = p.get('error');
  if (err) throw new Error(`Google sign-in failed: ${err}`);
  if (p.get('state') !== expectedState) throw new Error('Google sign-in failed: state mismatch');
  const token = p.get('access_token');
  if (!token) throw new Error('Google sign-in failed: no token returned');
  const expiresInS = Math.max(60, Number(p.get('expires_in')) || 3600);
  return { token, expiresInS };
}

let cached: { token: string; expiresAt: number } | null = null;

/** Drop the in-memory token (a 401 from the API, or a test). */
export function resetDriveToken(): void { cached = null; }

/** Seed the in-memory token so tests can exercise the upload path without the
 *  interactive popup (same spirit as the runtime's exported-mutable HOOK_BUDGET_MS). */
export function seedDriveTokenForTests(token: string, ttlMs = 60_000): void {
  cached = { token, expiresAt: Date.now() + ttlMs };
}

function requestToken(): Promise<string> {
  const clientId = driveClientId();
  if (!clientId) return Promise.reject(new Error('Google Drive is not configured on this build'));
  const state = crypto.getRandomValues(new Uint32Array(4)).join('-');
  const redirectUri = `${location.origin}/oauth-return.html`;
  const popup = window.open(buildAuthUrl(clientId, state, redirectUri), 'lolly-gdrive-auth',
    'popup,width=480,height=640');
  if (!popup) return Promise.reject(new Error('Sign-in popup was blocked - allow popups for this site'));
  return new Promise<string>((resolve, reject) => {
    const done = (fn: () => void) => { cleanup(); fn(); };
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== location.origin) return;
      const data = e.data as { source?: string; hash?: string } | null;
      if (!data || data.source !== 'lolly-oauth') return;
      try {
        const { token, expiresInS } = parseOAuthReturn(data.hash || '', state);
        // Refresh a minute early so an upload never starts on a dying token.
        cached = { token, expiresAt: Date.now() + (expiresInS - 60) * 1000 };
        done(() => resolve(token));
      } catch (err) { done(() => reject(err)); }
    };
    // A closed popup never posts; poll so the caller isn't left hanging.
    const closedPoll = setInterval(() => {
      if (popup.closed) done(() => reject(new Error('Google sign-in was cancelled')));
    }, 500);
    const timeout = setTimeout(() => done(() => reject(new Error('Google sign-in timed out'))), 180_000);
    const cleanup = () => {
      window.removeEventListener('message', onMessage);
      clearInterval(closedPoll);
      clearTimeout(timeout);
      try { if (!popup.closed) popup.close(); } catch { /* cross-origin at half-close */ }
    };
    window.addEventListener('message', onMessage);
  });
}

async function driveToken(): Promise<string> {
  if (cached && cached.expiresAt > Date.now()) return cached.token;
  cached = null;
  return requestToken();
}

// ─── Upload ──────────────────────────────────────────────────────────────────

/** RFC 2387 multipart/related body for uploadType=multipart. Pure, for tests. */
export function buildMultipart(metadata: object, contentType: string, bytes: Uint8Array, boundary: string): Uint8Array {
  const te = new TextEncoder();
  const head = te.encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`);
  const tail = te.encode(`\r\n--${boundary}--\r\n`);
  const out = new Uint8Array(head.length + bytes.length + tail.length);
  out.set(head, 0); out.set(bytes, head.length); out.set(tail, head.length + bytes.length);
  return out;
}

async function driveCreate(metadata: object, contentType: string, bytes: Uint8Array,
                           fetchFn: typeof fetch = fetch): Promise<DriveUploadResult> {
  const boundary = `lolly-${crypto.getRandomValues(new Uint32Array(2)).join('')}`;
  const doPost = async (token: string) => fetchFn(UPLOAD_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body: buildMultipart(metadata, contentType, bytes, boundary) as unknown as BodyInit,
  });
  let res = await doPost(await driveToken());
  if (res.status === 401) {           // expired/revoked mid-session: one fresh grant
    resetDriveToken();
    res = await doPost(await driveToken());
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Drive upload failed (${res.status}): ${body.slice(0, 200)}`);
  }
  return await res.json() as DriveUploadResult;
}

/**
 * Send EMF bytes to Drive so they open in Google Drawings. Tries the straight
 * conversion first - the file lands AS a native Drawing, one copy-paste from
 * Slides. If Drive refuses the import (a metafile its converter can't read),
 * falls back to a plain file typed application/x-msmetafile, which keeps the
 * manual "Open with → Google Drawings" route.
 */
export async function sendEmfToDrive(bytes: Uint8Array, baseName: string,
                                     fetchFn: typeof fetch = fetch): Promise<DriveSendOutcome> {
  const name = baseName.replace(/\.emf$/i, '');
  try {
    const file = await driveCreate({ name, mimeType: DRAWING_MIME }, METAFILE_MIME, bytes, fetchFn);
    if (file.mimeType === DRAWING_MIME) return { file, converted: true };
    return { file, converted: false };
  } catch (e) {
    // Conversion refusals are 4xx with an import error body; auth problems and
    // popup cancellations must NOT silently degrade to the fallback.
    if (!/Drive upload failed \(4\d\d\)/.test(String((e as Error).message))) throw e;
  }
  const file = await driveCreate({ name: `${name}.emf`, mimeType: METAFILE_MIME }, METAFILE_MIME, bytes, fetchFn);
  return { file, converted: false };
}

// ─── The `gdrive` SendTarget (lib/send-target.ts) ────────────────────────────

/** The Google Drive destination the built-ins registration installs. EMF-only
 *  for now - the point of this target is the Drawings/Slides conversion; a
 *  generic any-format Drive upload can widen `formats` later. Not offered in
 *  the Tauri shells: the popup + postMessage return leg needs a browser
 *  window model. */
export function googleDriveSendTarget(): SendTarget {
  return {
    kind: 'gdrive',
    label: t('Google Drive'),
    formats: ['emf'],
    available: () => driveAvailable() && !isTauriShell(),
    actionLabel: () => t('Send to Google Drive'),
    hint: t('Uploads this EMF to your Google Drive as a Google Drawing, ready to copy into Slides. Lolly can only see files it created (drive.file scope), and the sign-in token is kept in memory for this session only.'),
    send: async ({ bytes, name }) => {
      const out = await sendEmfToDrive(bytes, name);
      return {
        url: out.file.webViewLink || `https://drive.google.com/file/d/${encodeURIComponent(out.file.id)}/view`,
        label: out.converted ? t('Open in Google Drawings') : t('Open in Drive, then Open with → Google Drawings'),
      };
    },
  };
}
