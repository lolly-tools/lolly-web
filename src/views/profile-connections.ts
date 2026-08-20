// SPDX-License-Identifier: MPL-2.0
/**
 * The /profile "Connected services" section (plans/129): where an individual
 * connects their OWN providers - and where the custody choice lives. Every
 * send is client → provider directly; what this section manages is only what
 * is remembered ON THIS DEVICE:
 *
 *   - OAuth providers (Dropbox, OneDrive): Connect runs the popup grant; the
 *     "stay connected on this device" checkbox decides whether the refresh
 *     token is stored at rest (lib/provider-connections.ts - excluded from
 *     portable backups, wiped by Disconnect and by Clear-all). Unchecked =
 *     session-only, tokenless at rest.
 *   - Google Drive keeps its deliberate session-only stance (implicit grant,
 *     no refresh token exists): the row says it signs in at send time.
 *   - Credential providers (S3 bucket, Nextcloud/WebDAV): the user's own
 *     endpoint + keys, entered here, stored device-local, testable in place.
 *
 * OAuth rows appear only when their client id is configured on this deploy
 * (the dormant rule); the credential rows always exist - they need nobody's
 * app registration.
 */

import { t } from '../i18n.ts';
import { escape } from '../utils.ts';
import { driveAvailable } from '../lib/google-drive.ts';
import { dropboxAvailable, connectDropbox, disconnectDropbox } from '../lib/dropbox-send.ts';
import { oneDriveAvailable, connectOneDrive, disconnectOneDrive } from '../lib/onedrive-send.ts';
import { connectS3, disconnectS3, testS3, type S3Config } from '../lib/s3-send.ts';
import { connectWebdav, disconnectWebdav, testWebdav, type WebdavConfig } from '../lib/nextcloud-send.ts';
import { listConnections, type ProviderConnection } from '../lib/provider-connections.ts';

const OAUTH_ROWS: Array<{
  kind: string;
  label: () => string;
  scopesNote: () => string;
  available: () => boolean;
  connect: (persist: boolean) => Promise<string>;
  disconnect: () => Promise<void>;
}> = [
  {
    kind: 'dropbox',
    label: () => t('Dropbox'),
    scopesNote: () => t('Can only see the Lolly app folder in your Dropbox.'),
    available: dropboxAvailable,
    connect: connectDropbox,
    disconnect: disconnectDropbox,
  },
  {
    kind: 'o365',
    label: () => t('OneDrive'),
    scopesNote: () => t('Can only see the Lolly app folder in your OneDrive.'),
    available: oneDriveAvailable,
    connect: connectOneDrive,
    disconnect: disconnectOneDrive,
  },
];

const field = (name: string, label: string, value = '', type: 'text' | 'password' = 'text', placeholder = ''): string => `
  <label class="pconn-field"><span>${escape(label)}</span>
    <input class="field-input" type="${type}" data-field="${escape(name)}" value="${escape(value)}"${placeholder ? ` placeholder="${escape(placeholder)}"` : ''} autocomplete="off" spellcheck="false">
  </label>`;

function oauthRowHtml(kind: string, label: string, scopesNote: string, conn: ProviderConnection | null): string {
  if (conn) {
    return `
    <div class="store-manage--row pconn-row" data-pconn="${escape(kind)}">
      <span class="store-manage-name">${escape(label)}
        <span class="pconn-account">${escape(conn.account)}</span>
        <span class="pconn-note">${escape(conn.persist ? t('Stays connected on this device') : t('Connected for this session only'))}</span>
      </span>
      <button type="button" class="btn-link-danger" data-pconn-disconnect="${escape(kind)}">${t('Disconnect')}</button>
    </div>`;
  }
  return `
    <div class="store-manage--row pconn-row" data-pconn="${escape(kind)}">
      <span class="store-manage-name">${escape(label)}
        <span class="pconn-note">${escape(scopesNote)}</span>
        <label class="pconn-persist"><input type="checkbox" data-pconn-persist="${escape(kind)}"> ${t('Stay connected on this device')}</label>
      </span>
      <button type="button" class="btn" data-pconn-connect="${escape(kind)}">${t('Connect')}</button>
    </div>`;
}

function credentialRowsHtml(conns: Map<string, ProviderConnection>): string {
  const s3 = conns.get('s3');
  const s3cfg = (s3?.config ?? {}) as Partial<S3Config>;
  const dav = conns.get('webdav');
  const davCfg = (dav?.config ?? {}) as Partial<WebdavConfig>;
  return `
    <details class="pconn-cred" data-pconn="s3"${s3 ? '' : ''}>
      <summary><span class="store-manage-name">${t('S3 bucket')}
        ${s3 ? `<span class="pconn-account">${escape(s3.account)}</span>` : `<span class="pconn-note">${t('Your own AWS S3, MinIO, R2 or any S3-compatible store')}</span>`}
      </span></summary>
      <div class="pconn-form">
        ${field('endpoint', t('Endpoint URL'), s3cfg.endpoint ?? '', 'text', 'https://s3.eu-central-1.amazonaws.com')}
        ${field('region', t('Region'), s3cfg.region ?? '', 'text', 'eu-central-1')}
        ${field('bucket', t('Bucket'), s3cfg.bucket ?? '')}
        ${field('accessKeyId', t('Access key id'), s3cfg.accessKeyId ?? '')}
        ${field('secretAccessKey', t('Secret access key'), s3cfg.secretAccessKey ?? '', 'password')}
        ${field('prefix', t('Key prefix (optional)'), s3cfg.prefix ?? '', 'text', 'lolly/')}
        ${field('publicBaseUrl', t('Public base URL (optional)'), s3cfg.publicBaseUrl ?? '', 'text', 'https://cdn.example.com')}
        <p class="pconn-note">${t('Keys stay on this device, never in backups. The bucket’s CORS config must allow this origin.')}</p>
        <div class="pconn-actions">
          <button type="button" class="btn" data-pconn-save="s3">${t('Save & test')}</button>
          ${s3 ? `<button type="button" class="btn-link-danger" data-pconn-disconnect="s3">${t('Disconnect')}</button>` : ''}
          <span class="pconn-status" data-pconn-status="s3" role="status"></span>
        </div>
      </div>
    </details>
    <details class="pconn-cred" data-pconn="webdav">
      <summary><span class="store-manage-name">${t('Nextcloud / WebDAV')}
        ${dav ? `<span class="pconn-account">${escape(dav.account)}</span>` : `<span class="pconn-note">${t('Your own server, signed in with an app password')}</span>`}
      </span></summary>
      <div class="pconn-form">
        ${field('baseUrl', t('Server URL'), davCfg.baseUrl ?? '', 'text', 'https://cloud.example.org')}
        ${field('username', t('Username'), davCfg.username ?? '')}
        ${field('appPassword', t('App password'), davCfg.appPassword ?? '', 'password')}
        ${field('folder', t('Folder (optional)'), davCfg.folder ?? '', 'text', 'Lolly')}
        <p class="pconn-note">${t('Use a per-app password (Nextcloud: Settings → Security), never your account password. Stays on this device.')}</p>
        <div class="pconn-actions">
          <button type="button" class="btn" data-pconn-save="webdav">${t('Save & test')}</button>
          ${dav ? `<button type="button" class="btn-link-danger" data-pconn-disconnect="webdav">${t('Disconnect')}</button>` : ''}
          <span class="pconn-status" data-pconn-status="webdav" role="status"></span>
        </div>
      </div>
    </details>`;
}

/** Fill the section body and wire it. Re-renders itself after every change. */
export async function mountConnectionsBody(body: HTMLElement): Promise<void> {
  const conns = new Map((await listConnections()).map((c) => [c.kind, c]));
  const oauthRows = OAUTH_ROWS.filter((r) => r.available())
    .map((r) => oauthRowHtml(r.kind, r.label(), r.scopesNote(), conns.get(r.kind) ?? null)).join('');
  const gdriveRow = driveAvailable()
    ? `<div class="store-manage--row pconn-row" data-pconn="gdrive">
        <span class="store-manage-name">${t('Google Drive')}
          <span class="pconn-note">${t('Signs in when you send; nothing is remembered between sessions.')}</span>
        </span>
       </div>`
    : '';
  body.innerHTML = `
    <p class="storage-hint-text">${t('Send finished exports straight to your own places. Every send goes from this device to the provider directly - no Lolly server ever holds your files or your sign-ins - and what is remembered on this device is your choice, wiped by Disconnect and never included in backups.')}</p>
    ${gdriveRow}
    ${oauthRows}
    ${credentialRowsHtml(conns)}`;

  const readForm = (kind: string): Record<string, string> => {
    const out: Record<string, string> = {};
    body.querySelectorAll<HTMLInputElement>(`[data-pconn="${CSS.escape(kind)}"] [data-field]`).forEach((el) => {
      out[el.dataset.field!] = el.value.trim();
    });
    return out;
  };
  const status = (kind: string, text: string): void => {
    const el = body.querySelector<HTMLElement>(`[data-pconn-status="${CSS.escape(kind)}"]`);
    if (el) el.textContent = text;
  };

  body.onclick = async (ev) => {
    const el = ev.target as HTMLElement;
    const connectKind = el.closest<HTMLElement>('[data-pconn-connect]')?.dataset.pconnConnect;
    const disconnectKind = el.closest<HTMLElement>('[data-pconn-disconnect]')?.dataset.pconnDisconnect;
    const saveKind = el.closest<HTMLElement>('[data-pconn-save]')?.dataset.pconnSave;
    if (!connectKind && !disconnectKind && !saveKind) return;
    const btn = el.closest<HTMLButtonElement>('button');
    if (btn?.disabled) return;
    if (btn) btn.disabled = true;
    try {
      if (connectKind) {
        const row = OAUTH_ROWS.find((r) => r.kind === connectKind);
        const persist = body.querySelector<HTMLInputElement>(`[data-pconn-persist="${CSS.escape(connectKind)}"]`)?.checked ?? false;
        if (row) await row.connect(persist);
      } else if (disconnectKind) {
        if (disconnectKind === 's3') await disconnectS3();
        else if (disconnectKind === 'webdav') await disconnectWebdav();
        else await OAUTH_ROWS.find((r) => r.kind === disconnectKind)?.disconnect();
      } else if (saveKind === 's3') {
        const f = readForm('s3');
        if (!f.endpoint || !f.bucket || !f.accessKeyId || !f.secretAccessKey) {
          status('s3', t('Endpoint, bucket and both keys are required'));
          return;
        }
        const cfg: S3Config = {
          endpoint: f.endpoint, region: f.region || 'us-east-1', bucket: f.bucket,
          accessKeyId: f.accessKeyId, secretAccessKey: f.secretAccessKey,
          prefix: f.prefix, publicBaseUrl: f.publicBaseUrl,
        };
        status('s3', t('Testing…'));
        const res = await testS3(cfg);
        status('s3', res.note);
        if (!res.ok) return;
        await connectS3(cfg);
      } else if (saveKind === 'webdav') {
        const f = readForm('webdav');
        if (!f.baseUrl || !f.username || !f.appPassword) {
          status('webdav', t('Server URL, username and app password are required'));
          return;
        }
        const cfg: WebdavConfig = { baseUrl: f.baseUrl, username: f.username, appPassword: f.appPassword, folder: f.folder };
        status('webdav', t('Testing…'));
        const res = await testWebdav(cfg);
        status('webdav', res.note);
        if (!res.ok) return;
        await connectWebdav(cfg);
      }
      await mountConnectionsBody(body); // re-render with the new state
    } catch (err) {
      const kind = connectKind ?? disconnectKind ?? saveKind ?? '';
      const msg = String((err as Error)?.message || t('That did not work - try again'));
      status(kind, msg.length <= 140 ? msg : t('That did not work - try again'));
      if (btn) btn.disabled = false;
    }
  };
}
