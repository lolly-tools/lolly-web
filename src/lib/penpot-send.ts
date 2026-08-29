// SPDX-License-Identifier: MPL-2.0
/**
 * Penpot send target (plans/173) - the `penpot` driver: finished image renders
 * land in the media library of a Penpot file inside a project the user picked
 * at connect time, ready to drag onto any board.
 *
 * Custody follows the Mastodon shape exactly: the Personal Access Token is the
 * connection (Penpot PATs are long-lived, no refresh grant), so session-only
 * custody keeps it in the memory token cache and the record tokenless at rest;
 * "stay connected on this device" writes it into the config. Never in backups,
 * wiped by Disconnect - and there is no revoke RPC we can call, so Disconnect
 * is the local wipe plus the user deleting the PAT in Penpot settings.
 *
 * Transport honesty: every call goes through lolly.tools's app-origin
 * pass-through (/api/penpot/rpc) because Penpot's API refuses cross-origin
 * browser calls - the proxy forwards the token and bytes, stores nothing.
 * The account label is the instance host, not a username: Penpot's
 * get-profile sits behind a bot challenge, so we never call it.
 */

import { t } from '../i18n.ts';
import { makePenpotClient, type PenpotProject } from './penpot-api.ts';
import {
  cacheToken, cachedToken, getConnection, hasConnection, removeConnection, saveConnection,
} from './provider-connections.ts';
import type { SendTarget } from './send-target.ts';

const KIND = 'penpot';
/** The instance the proxy fronts - shown on the /profile row for honesty. */
export const PENPOT_HOST = 'design.penpot.app';
/** The file all sends land in, created on first send in the chosen project. */
const DEFAULT_FILE_NAME = 'From Lolly';

/** The connect probe: list projects with the pasted PAT. Doubles as the
 *  destination-picker source - a PAT that can't list projects can't upload. */
export async function testPenpot(token: string, fetchImpl?: typeof fetch): Promise<{ ok: boolean; note: string; projects?: PenpotProject[] }> {
  try {
    const projects = await makePenpotClient({ token, fetchImpl }).listProjects();
    if (projects.length === 0) return { ok: false, note: t('That token works but sees no projects - create one in Penpot first') };
    return { ok: true, note: t('Found {n} projects - pick a destination', { n: projects.length }), projects };
  } catch (e) {
    return { ok: false, note: String((e as Error).message) };
  }
}

export async function connectPenpot(persist: boolean, token: string, project: PenpotProject): Promise<void> {
  // The PAT is the connection: memory cache always, at rest only by choice.
  cacheToken(KIND, token, Date.now() + 365 * 24 * 3600 * 1000);
  await saveConnection({
    kind: KIND,
    account: `${PENPOT_HOST} · ${project.name}`,
    persist,
    config: {
      projectId: project.id,
      projectName: project.name,
      ...(persist ? { token } : {}),
    },
    connectedAt: new Date().toISOString(),
  });
}

export async function disconnectPenpot(): Promise<void> {
  // No revoke RPC exists for PATs - the local wipe is the whole gesture; the
  // token itself is revoked in Penpot's own settings.
  await removeConnection(KIND);
}

async function penpotAuth(): Promise<{ token: string; projectId: string; projectName: string; fileId?: string }> {
  const conn = await getConnection(KIND);
  const projectId = conn?.config?.projectId;
  if (!projectId) throw new Error(t('Connect Penpot in Profile first'));
  const token = cachedToken(KIND) ?? conn?.config?.token;
  if (!token) throw new Error(t('Your Penpot session ended - connect again in Profile'));
  return { token, projectId, projectName: conn?.config?.projectName ?? '', fileId: conn?.config?.fileId };
}

/** Remember the created file on the connection, under its existing custody
 *  choice - a session-only record keeps it in memory, a persisted one at rest. */
async function rememberFileId(fileId: string): Promise<void> {
  const conn = await getConnection(KIND);
  if (!conn) return;
  await saveConnection({ ...conn, config: { ...conn.config, fileId } });
}

export function penpotSendTarget(): SendTarget {
  return {
    kind: KIND,
    label: t('Penpot'),
    // What Penpot's media library accepts: bitmap images + SVG.
    formats: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'],
    available: () => hasConnection(KIND),
    hint: t('Adds this render to a Penpot file in your chosen project. It travels through lolly.tools’s pass-through because Penpot’s API refuses direct browser calls - your token is forwarded, never stored server-side.'),
    send: async ({ bytes, name, mime }) => {
      const { token, projectId, projectName, fileId } = await penpotAuth();
      const client = makePenpotClient({ token });
      let target = fileId;
      if (!target) {
        // First send: one file to hold everything Lolly ever sends here.
        const file = await client.createFile(DEFAULT_FILE_NAME, projectId).catch((e: Error) => {
          if (/\(401\)/.test(e.message)) throw new Error(t('Penpot rejected the token - connect again in Profile'));
          throw e;
        });
        target = file.id;
        await rememberFileId(target);
      }
      const blob = new Blob([bytes as BlobPart], { type: mime || 'application/octet-stream' });
      try {
        await client.uploadMedia(target, name, blob);
      } catch (e) {
        if (/\(401\)/.test((e as Error).message)) throw new Error(t('Penpot rejected the token - connect again in Profile'));
        throw e;
      }
      return {
        label: projectName
          ? t('Added to “From Lolly” in {project} on Penpot', { project: projectName })
          : t('Added to “From Lolly” on Penpot'),
      };
    },
  };
}
