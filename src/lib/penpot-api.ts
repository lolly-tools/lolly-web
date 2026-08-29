// SPDX-License-Identifier: MPL-2.0
/**
 * penpot-api - a small pure client for the three Penpot RPC commands Lolly
 * uses (plans/173): list the user's projects, create a file in one, upload a
 * finished render into that file's media library.
 *
 * The default base is NOT Penpot itself but the app-origin pass-through at
 * /api/penpot/rpc/<command>: Penpot's RPC answers cross-origin preflights with
 * a 401 and no Access-Control-Allow-Origin header, so a browser can never call
 * it directly - the proxy forwards the Authorization header and body verbatim
 * and stores nothing. Auth is a Personal Access Token sent as
 * `Authorization: Token <PAT>` on every call.
 *
 * Deliberately narrow: results are typed down to the id/name fields the
 * callers read, commands POST JSON except the multipart media upload, and
 * there are no retries - a failure surfaces as one thrown Error with the
 * status in it. Everything injectable (base, fetch) so tests run headless.
 */

export interface PenpotProject { id: string; name: string }
export interface PenpotFile { id: string; name: string }
export interface PenpotMedia { id: string; name: string }

export interface PenpotClientOpts {
  /** RPC base URL; defaults to the app-origin proxy. */
  base?: string;
  /** The user's Personal Access Token, forwarded as `Token <PAT>`. */
  token: string;
  /** Injectable fetch for tests / alternate shells. */
  fetchImpl?: typeof fetch;
}

export interface PenpotClient {
  listProjects(): Promise<PenpotProject[]>;
  createFile(name: string, projectId: string): Promise<PenpotFile>;
  uploadMedia(fileId: string, name: string, blob: Blob): Promise<PenpotMedia>;
}

export const PENPOT_PROXY_BASE = '/api/penpot/rpc';

export function makePenpotClient({ base = PENPOT_PROXY_BASE, token, fetchImpl }: PenpotClientOpts): PenpotClient {
  const fetchFn = fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const root = base.replace(/\/+$/, '');

  const call = async (command: string, init: RequestInit): Promise<unknown> => {
    const res = await fetchFn(`${root}/${command}`, {
      ...init,
      method: 'POST',
      headers: {
        Authorization: `Token ${token}`,
        // Penpot answers Transit by default; asking for plain JSON keeps the
        // narrow parse below honest.
        Accept: 'application/json',
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) throw new Error(`Penpot ${command} failed (${res.status})`);
    return await res.json();
  };

  const json = (command: string, body: unknown): Promise<unknown> =>
    call(command, {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  return {
    async listProjects() {
      const raw = await json('get-all-projects', {});
      if (!Array.isArray(raw)) throw new Error('Penpot get-all-projects returned an unexpected shape');
      return raw
        .filter((p): p is { id: string; name: string } =>
          !!p && typeof (p as { id?: unknown }).id === 'string' && typeof (p as { name?: unknown }).name === 'string')
        .map((p) => ({ id: p.id, name: p.name }));
    },

    async createFile(name, projectId) {
      const raw = await json('create-file', { name, projectId }) as { id?: unknown; name?: unknown };
      if (typeof raw?.id !== 'string') throw new Error('Penpot create-file returned no file id');
      return { id: raw.id, name: typeof raw.name === 'string' ? raw.name : name };
    },

    async uploadMedia(fileId, name, blob) {
      // Proven multipart shape (plans/173): a fresh client-side uuid, the
      // target file, is-local=false (a library asset, reusable on any board).
      const form = new FormData();
      form.append('id', crypto.randomUUID());
      form.append('file-id', fileId);
      form.append('name', name);
      form.append('is-local', 'false');
      form.append('content', blob, name);
      const raw = await call('upload-file-media-object', { body: form }) as { id?: unknown; name?: unknown };
      if (typeof raw?.id !== 'string') throw new Error('Penpot upload returned no media id');
      return { id: raw.id, name: typeof raw.name === 'string' ? raw.name : name };
    },
  };
}
