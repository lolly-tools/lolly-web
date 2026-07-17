// SPDX-License-Identifier: MPL-2.0
/**
 * Shared tool loader for the web shell's render paths.
 *
 * Loading (and caching) a tool definition, plus the small format/exportability
 * helpers, live here — separate from pro/render-export.js — so the embed
 * interceptor (bridge/embed.js) and the off-screen renderer (pro/render-export.js)
 * can both reach them WITHOUT a circular import (render-export ↔ embed).
 */
import { loadTool } from '@lolly/engine';
import type { LoadedTool, ToolManifest } from '../../../../engine/src/loader.ts';
import { currentLang } from '../i18n.ts';
import { instanceFetch, instancePath } from '../lib/instance.ts';

// Loaded tools are cached so selecting the same template across many rows — the
// primary power-user workflow — loads each template only once.
const toolCache = new Map<string, Promise<LoadedTool> | LoadedTool>();

function makeFetchFile(toolId: string): (path: string) => Promise<string> {
  return async (path: string) => {
    const resp = await instanceFetch(instancePath(`/tools/${path}`));
    if (resp.status === 404) throw new Error('tool-not-found');
    const ct = resp.headers.get('content-type') ?? '';
    if (!resp.ok || (ct.includes('text/html') && !path.endsWith('.html'))) {
      throw new Error('tool-not-found');
    }
    return resp.text();
  };
}

/** Load (and cache) a tool definition. Used both to read inputs and to render.
 *  Translates the manifest's name/description/input labels via its i18n/<lang>.json
 *  sidecar when one exists (engine/src/loader.ts's applyManifestI18n) — the active
 *  language never changes mid-session (switchLang reloads the page), so the cache
 *  doesn't need lang in its key. */
export async function getTool(toolId: string): Promise<LoadedTool> {
  if (toolCache.has(toolId)) return toolCache.get(toolId)!;
  const promise = loadTool(toolId, makeFetchFile(toolId), { lang: currentLang() });
  toolCache.set(toolId, promise);
  try {
    const tool = await promise;
    toolCache.set(toolId, tool);
    return tool;
  } catch (e) {
    toolCache.delete(toolId);
    throw e;
  }
}

/**
 * Pick an export format the tool actually supports. `jpg` and `jpeg` are the same
 * format spelled two ways, so a request for one matches a declaration of the other
 * (rather than silently falling through to the first declared format).
 */
export function chooseFormat(manifest: ToolManifest, preferred?: string | null): string {
  const formats = manifest.render?.formats ?? [];
  if (preferred) {
    if (formats.includes(preferred)) return preferred;
    const alt = preferred === 'jpg' ? 'jpeg' : preferred === 'jpeg' ? 'jpg' : null;
    if (alt && formats.includes(alt)) return alt;
  }
  return formats[0] ?? 'png';
}

/** Whether a tool can be exported at all (render-only tools opt out). */
export function isExportable(manifest: ToolManifest): boolean {
  return manifest.render?.export !== false && (manifest.render?.formats?.length ?? 0) > 0;
}
