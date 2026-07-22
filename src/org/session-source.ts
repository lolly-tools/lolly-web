// SPDX-License-Identifier: MPL-2.0
/**
 * The control-plane's SessionSource — a thin adapter over the instance's
 * projects/sessions API, registered into the generic lib/session-source.ts seam
 * by org/index.ts when a control plane is present. Pure data: fetch + shape, no
 * engine, no DOM. Everything goes through instanceFetch/instancePath, so a remote
 * instance base works exactly as the same-origin one.
 *
 * Maps the server contract (plans/08 §6b) onto the seam's neutral types. A failed
 * request degrades to an empty list / null rather than throwing into the view.
 */
import { instanceFetch, instancePath } from '../lib/instance.ts';
import type {
  SessionSource, TeamProjectRef, TeamSessionRef, TeamSessionData,
} from '../lib/session-source.ts';

async function getJson<T>(path: string): Promise<T | null> {
  try {
    const res = await instanceFetch(instancePath(path));
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** Build the source. `label` is the already-localised instance name for the heading. */
export function createInstanceSessionSource(label: string): SessionSource {
  return {
    label,
    async listProjects(): Promise<TeamProjectRef[]> {
      const data = await getJson<{ projects?: TeamProjectRef[] }>('/api/v1/projects');
      return (data?.projects ?? []).map((p) => ({
        id: p.id, name: p.name, sessionCount: p.sessionCount, updatedAt: p.updatedAt,
      }));
    },
    async listSessions(projectId: string): Promise<TeamSessionRef[]> {
      const data = await getJson<{ sessions?: TeamSessionRef[] }>(`/api/v1/projects/${encodeURIComponent(projectId)}/sessions`);
      return (data?.sessions ?? []).map((s) => ({
        id: s.id, toolId: s.toolId, label: s.label, updatedAt: s.updatedAt, updatedBy: s.updatedBy,
      }));
    },
    async fetchSession(sessionId: string): Promise<TeamSessionData | null> {
      const s = await getJson<{ toolId?: string; toolVersion?: string; inputs?: Record<string, unknown>; meta?: Record<string, unknown> }>(
        `/api/v1/sessions/${encodeURIComponent(sessionId)}`,
      );
      if (!s?.toolId || !s.inputs) return null;
      return { toolId: s.toolId, toolVersion: s.toolVersion, inputs: s.inputs, meta: s.meta };
    },
  };
}
