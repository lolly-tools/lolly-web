// SPDX-License-Identifier: MPL-2.0
/**
 * User templates - a creative saves the current tool doc as a reusable STARTING POINT for
 * that tool, so it joins the built-in per-tool templates in the "New from template" chooser
 * (and, later, the Projects add-picker: "pick a tool → pick a variation, or the default").
 *
 * A user template is just a saved `values` seed under a tool id - the exact same shape a
 * built-in `tools/<id>/templates/<tid>.json` carries, minus the file. A "variation" is the
 * same record with `variationOf` set to the base template it descends from, so the chooser
 * can group it under its parent. This is the local half of the "make variations → submit to
 * the catalog / share as a .lolly" flow: a saved variation is an ordinary session snapshot,
 * so the existing Share-modal `.lolly` path carries it unchanged.
 *
 * Storage mirrors folders.ts exactly: the records ride the single profile record
 * (`profile.userTemplates`) through the host's Profile get/set, so they sync and persist like
 * everything else on the profile, and a read-modify-write over the WHOLE profile never
 * clobbers sibling fields (folders, headshot, a11y, …). No new storage layer, no core change
 * - the profile record already tolerates extra fields (folders proves it).
 */

export interface UserTemplate {
  id: string;
  /** The tool this template seeds - the chooser/add-picker key. */
  toolId: string;
  name: string;
  /** The saved seed: input values plus the `__`-prefixed export markers, i.e. exactly what
   *  `sessionSnapshot()` returns and what the chooser applies for a built-in template. */
  values: Record<string, unknown>;
  /** When set, this is a VARIATION of that base template id (built-in tid or another user
   *  template id) - the chooser groups it under its parent. Absent → a standalone template. */
  variationOf?: string;
  createdAt: string;
  updatedAt: string;
}

interface UserTemplateProfile {
  userTemplates?: UserTemplate[];
  /** Shared with the host's Profile type so it satisfies this weak slice (mirrors folders). */
  custom?: Record<string, string>;
}

/** The slice of the host bridge the store reads/writes - the profile get/set pair only. */
export interface UserTemplateHost {
  profile: {
    get(): Promise<UserTemplateProfile>;
    set(profile: UserTemplateProfile): Promise<unknown>;
  };
}

function uuid(): string {
  if ((globalThis.crypto as { randomUUID?: unknown } | undefined)?.randomUUID) return crypto.randomUUID();
  return 'ut-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}
const now = (): string => new Date().toISOString();

export interface SaveTemplateInput {
  toolId: string;
  name: string;
  values: Record<string, unknown>;
  variationOf?: string;
}

export function createUserTemplateStore(host: UserTemplateHost) {
  // Read-modify-write over the whole profile object, so sibling fields survive (folders.ts).
  async function mutate<T>(fn: (list: UserTemplate[]) => T): Promise<T> {
    const profile = await host.profile.get();
    const list = (profile.userTemplates ?? []).map(t => ({ ...t }));
    const result = fn(list);
    await host.profile.set({ ...profile, userTemplates: list });
    return result;
  }

  return {
    /** Every user template, or just this tool's when `toolId` is given (newest first). */
    async list(toolId?: string): Promise<UserTemplate[]> {
      const profile = await host.profile.get();
      const all = (profile.userTemplates ?? []).slice();
      const scoped = toolId ? all.filter(t => t.toolId === toolId) : all;
      return scoped.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    },

    async save(input: SaveTemplateInput): Promise<UserTemplate> {
      const name = String(input.name ?? '').trim();
      if (!name) throw new Error('A template name is required.');
      if (!input.toolId) throw new Error('A tool id is required.');
      const tpl: UserTemplate = {
        id: uuid(),
        toolId: input.toolId,
        name,
        values: input.values ?? {},
        ...(input.variationOf ? { variationOf: input.variationOf } : {}),
        createdAt: now(),
        updatedAt: now(),
      };
      await mutate(list => list.push(tpl));
      return tpl;
    },

    async rename(id: string, name: string): Promise<void> {
      const label = String(name ?? '').trim();
      if (!label) throw new Error('A template name is required.');
      await mutate(list => {
        const t = list.find(x => x.id === id);
        if (t) { t.name = label; t.updatedAt = now(); }
      });
    },

    async remove(id: string): Promise<void> {
      await mutate(list => {
        const i = list.findIndex(x => x.id === id);
        if (i >= 0) list.splice(i, 1);
      });
    },
  };
}

export type UserTemplateStore = ReturnType<typeof createUserTemplateStore>;
