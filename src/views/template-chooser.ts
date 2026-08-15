// SPDX-License-Identifier: MPL-2.0
/**
 * "New from template" chooser — a host-owned modal shown ONLY on a blank fresh
 * open of a tool that declares `templates[]` (see views/tool.ts's mount flow).
 *
 * Why this is a host concern, not a tool concern: a tool declares its starting
 * points (manifest `templates[]`); the shell owns the on-ramp UX, exactly like
 * the asset picker. The chooser never appears on a resume (`?slot`), a URL-seeded
 * / parameterised open, an in-process direct seed (the drop/PSD route), or a
 * `?template=<id>` launch — those all carry their own intent.
 *
 * It resolves the input-value seed for the fresh session: a chosen template's
 * `values`, or `{}` for the always-first "Blank canvas" tile (and for Escape /
 * backdrop / close — closing the chooser proceeds to the tool's own default
 * composition, which is what a blank open has always done). It never rejects.
 *
 * THE MOUNT DOES NOT WAIT FOR THIS. views/tool.ts starts the chooser and carries
 * straight on to `createRuntime`, so the tool paints and becomes interactive
 * underneath while the modal sits on top; the pick is applied afterwards as an
 * `applyPatch` seed. That is why nothing here may assume it owns the main thread —
 * see `whenIdle()` and the preview drain below. It also means the caller can navigate
 * away before a tile is picked, with nothing else holding a reference to this modal —
 * `ChooserOpts.onOpen` hands back a force-close for exactly that (see views/tool.ts's
 * `_cleanup`, which calls it so a torn-down view never leaves this floating on top of
 * whatever loads next).
 *
 * House UI rules honoured: Escape closes; focus is trapped and lands in the
 * search field; tiles are rounded with a neutral border (no accent-coloured
 * border, no dashed border — dashed is reserved for drop areas); strings are
 * English-only (this is a pre-i18n on-ramp).
 */

import '../styles/template-chooser.css'; // async CSS chunk (lazy view — not on the landing)
import { escapeHtml } from '../lib/html.ts';
import { trapFocus, type FocusTrap } from '../lib/focus-trap.ts';
import { icon } from '../lib/icons.ts';
import type { InputValue } from '../../../../engine/src/inputs.ts';
import type { HostV1 } from '@lolly-tools/core/host-v1';

/**
 * A parsed template entry. Its metadata (id/name/category/description/thumb) is what
 * the synced index carries and the chooser renders the grid from; `values` is the heavy
 * input seed, which now lives in an EXTERNAL per-template file (tools/<id>/templates/
 * <tid>.json) and is FETCHED ON DEMAND (preview render + select). For a metadata-only
 * entry `values` is `{}` — fetchTemplateValues() supplies the real seed lazily.
 */
export interface TemplateVariant {
  id: string;
  name: string;
  description?: string;
  category?: string;
  thumb?: string;
  values: Record<string, InputValue>;
}

/**
 * Fetch one template's full input seed from its external file
 * (tools/<toolId>/templates/<tid>.json) through the instance base / profile view — the
 * same static namespace the card-preview paths use. Returns the `values` map, or `null`
 * on any failure (network, missing file, malformed JSON, non-object `values`) so a
 * caller falls through to a blank/default open rather than throwing. The heavy seed is
 * never packed into a URL — this fetch is the on-demand path for both the chooser select
 * and the reserved `?template=<id>` launcher.
 */
export async function fetchTemplateValues(toolId: string, tid: string): Promise<Record<string, InputValue> | null> {
  try {
    const { instanceFetch, instancePath } = await import('../lib/instance.ts');
    const resp = await instanceFetch(instancePath(`/tools/${encodeURIComponent(toolId)}/templates/${encodeURIComponent(tid)}.json`));
    if (!resp.ok) return null;
    const data = await resp.json() as { values?: unknown };
    const v = data?.values;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, InputValue>) : null;
  } catch {
    return null;
  }
}

/**
 * Narrow a manifest's `templates` (typed `unknown[]` on the SDK Manifest) into
 * the variants this chooser can render. Entries missing the required `id` /
 * `name` / object `values` are dropped rather than throwing — a malformed
 * template must never break a tool's fresh open.
 */
export function parseTemplates(raw: unknown): TemplateVariant[] {
  if (!Array.isArray(raw)) return [];
  const out: TemplateVariant[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const t = item as Record<string, unknown>;
    if (typeof t.id !== 'string' || !t.id) continue;
    if (typeof t.name !== 'string' || !t.name) continue;
    if (seen.has(t.id)) continue; // first wins on a duplicate id
    const values = t.values && typeof t.values === 'object' && !Array.isArray(t.values)
      ? (t.values as Record<string, InputValue>)
      : {};
    seen.add(t.id);
    out.push({
      id: t.id,
      name: t.name,
      description: typeof t.description === 'string' ? t.description : undefined,
      category: typeof t.category === 'string' && t.category ? t.category : undefined,
      thumb: typeof t.thumb === 'string' && t.thumb ? t.thumb : undefined,
      values,
    });
  }
  return out;
}

/** Look up one template's seed by id (for the reserved `?template=<id>` path). */
export function templateValuesById(raw: unknown, id: string): Record<string, InputValue> | null {
  const found = parseTemplates(raw).find(t => t.id === id);
  return found ? found.values : null;
}

// A neutral glyph per template, chosen from the category keyword so a poster reads
// as an image and a carousel as a grid — falls back to a generic layers glyph.
function glyphFor(t: TemplateVariant): Parameters<typeof icon>[0] {
  const hay = `${t.category ?? ''} ${t.name}`.toLowerCase();
  if (/carousel|slides?|deck|grid|gallery/.test(hay)) return 'grid';
  if (/poster|flyer|cover|image|photo|banner/.test(hay)) return 'image';
  if (/story|social|post/.test(hay)) return 'photos';
  if (/card|badge|label/.test(hay)) return 'shapes';
  return 'layers';
}

const BLANK_ID = '__blank__';

/**
 * Resolve at the next idle moment (or after `timeout` ms, whichever comes first).
 *
 * The chooser is no longer awaited by views/tool.ts — the tool mounts UNDERNEATH it —
 * so its tile previews now share the main thread with a live mount (the editor overlay
 * chunk alone is ~500 KB) instead of having it to themselves. Each preview is a real
 * off-screen tool mount + walker export, ~1 s of mostly-synchronous work, so firing
 * them back-to-back would starve exactly the paint the deferral was meant to let
 * through, and would hold a tile click up behind however many renders were still
 * queued. Yielding once before the render chunk is fetched and once between renders
 * costs the previews nothing they can perceive and gives the mount (and the click) the
 * gaps they need. `requestIdleCallback` is absent in jsdom and older Safari — a
 * macrotask is the honest fallback there: still a yield, just not a prioritised one.
 */
function whenIdle(timeout = 1000): Promise<void> {
  return new Promise(resolve => {
    const ric = (globalThis as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    }).requestIdleCallback;
    if (typeof ric === 'function') ric(() => resolve(), { timeout });
    else setTimeout(resolve, 0);
  });
}

interface ChooserOpts {
  toolName: string;
  /** The tool id — needed to fetch each template's external values file. */
  toolId: string;
  templates: TemplateVariant[];
  /**
   * Host bridge — enables the live VISUAL PREVIEW (each tile fetches its values file and
   * live-renders via renderFeaturedVariant). Omit (e.g. offline / no render path) and the
   * chooser shows glyph tiles; select still fetches values.
   */
  host?: HostV1;
  /** The tool's render.formats — the preview renders vector-first at displayFormatOf. */
  formats?: readonly string[];
  /**
   * Called synchronously, once the modal exists, with a function that force-closes it —
   * exactly as if Escape/backdrop/× had been used — and resolves the returned promise
   * with `{}`. views/tool.ts never awaits this chooser (see the header), so nothing else
   * holds a reference to it; a caller that tears its view down while the modal is still
   * open needs this to take the modal with it, or it is left floating over whatever view
   * loads next with a click handler still wired to the torn-down mount. Fires at most
   * once per open; calling the returned function after the chooser has already settled
   * (a pick, Escape, or an earlier call) is a no-op, same as any other post-settle path.
   */
  onOpen?: (close: () => void) => void;
}

/**
 * Open the chooser. Resolves with the seed for the fresh session: a template's
 * `values`, or `{}` for a blank start (also the result of Escape / close /
 * backdrop). Never rejects.
 */
export function openTemplateChooser(opts: ChooserOpts): Promise<Record<string, InputValue>> {
  return new Promise(resolve => {
    const root = document.createElement('div');
    root.className = 'tmpl-chooser-modal';
    document.body.appendChild(root);
    // The documented contract is "never rejects (close = {})" - make it structurally
    // true: any throw below (markup build, icon lookup, preview wiring) would REJECT
    // this promise and strand the caller's await, leaving the tool stuck on its
    // loading screen with an invisible empty modal (the :empty CSS hides the root).
    // Trade the whole chooser for a blank open instead.
    const settleBlank = (e: unknown): void => {
      try { root.remove(); } catch { /* already gone */ }
      console.warn('template chooser failed - resolving blank', e);
      resolve({});
    };
    try {

    const byId = new Map<string, TemplateVariant>(opts.templates.map(t => [t.id, t]));

    // Memoised values seed per template. An inline entry that already carries a non-empty
    // `values` (the optional inline-fallback shape) is used verbatim; otherwise the seed is
    // fetched once from the external file and cached, so the preview render and a later
    // select share a single fetch. Resolves null on failure → the caller falls back to a
    // blank/default open.
    const valuesById = new Map<string, Promise<Record<string, InputValue> | null>>();
    const getValues = (id: string): Promise<Record<string, InputValue> | null> => {
      const cached = valuesById.get(id);
      if (cached) return cached;
      const inline = byId.get(id)?.values;
      const p = inline && Object.keys(inline).length
        ? Promise.resolve(inline)
        : fetchTemplateValues(opts.toolId, id);
      valuesById.set(id, p);
      return p;
    };

    // Distinct categories (tags), first-seen order — these become the filter chips. Every
    // template lives in ONE grid; a chip narrows it, so there are no per-category sections.
    const cats: string[] = [];
    for (const t of opts.templates) { const c = t.category; if (c && !cats.includes(c)) cats.push(c); }

    const tileHtml = (t: TemplateVariant): string => {
      // The media slot starts as the authored thumb (if any) or a category glyph; when a
      // host + formats are supplied, renderPreviews() swaps in a live-rendered <img>.
      const media = t.thumb
        ? `<img class="tmpl-chooser-tile-thumb" src="${escapeHtml(t.thumb)}" alt="" loading="lazy">`
        : `<span class="tmpl-chooser-tile-icon" aria-hidden="true">${icon(glyphFor(t), { size: 22 })}</span>`;
      const search = `${t.name} ${t.description ?? ''} ${t.category ?? ''}`.toLowerCase();
      return `<button type="button" class="tmpl-chooser-tile" data-template-id="${escapeHtml(t.id)}" data-category="${escapeHtml(t.category ?? '')}" data-search="${escapeHtml(search)}">
        <span class="tmpl-chooser-tile-media">${media}</span>
        <span class="tmpl-chooser-tile-name">${escapeHtml(t.name)}</span>
        ${t.description ? `<span class="tmpl-chooser-tile-desc">${escapeHtml(t.description)}</span>` : ''}
      </button>`;
    };

    // The always-first "Blank canvas" tile sits in its own leading group.
    const blankTile = `<button type="button" class="tmpl-chooser-tile" data-template-id="${BLANK_ID}" data-search="blank canvas empty scratch">
      <span class="tmpl-chooser-tile-icon" aria-hidden="true">${icon('filePlus', { size: 22 })}</span>
      <span class="tmpl-chooser-tile-name">Blank canvas</span>
      <span class="tmpl-chooser-tile-desc">Start from scratch.</span>
    </button>`;

    // Tag filters — "All" plus one chip per category. Only shown when there's more than one
    // category to choose between; a single-category set has nothing to filter.
    const filtersHtml = cats.length > 1 ? `
      <div class="tmpl-chooser-filters" role="group" aria-label="Filter templates by type">
        <button type="button" class="tmpl-chooser-filter is-active" data-filter="" aria-pressed="true">All</button>
        ${cats.map(c => `<button type="button" class="tmpl-chooser-filter" data-filter="${escapeHtml(c)}" aria-pressed="false">${escapeHtml(c)}</button>`).join('')}
      </div>` : '';

    root.innerHTML = `
      <div class="tmpl-chooser-backdrop" aria-hidden="true"></div>
      <div class="tmpl-chooser-panel" role="dialog" aria-modal="true" aria-labelledby="tmpl-chooser-title">
        <header class="tmpl-chooser-header">
          <h2 id="tmpl-chooser-title">Start ${escapeHtml(opts.toolName)}</h2>
          <input type="search" class="tmpl-chooser-search" placeholder="Search templates…" autocomplete="off" spellcheck="false" aria-label="Search templates">
          <button type="button" class="tmpl-chooser-close" aria-label="Close">×</button>
        </header>
        <div class="tmpl-chooser-body">
          ${filtersHtml}
          <div class="tmpl-chooser-grid">${blankTile}${opts.templates.map(tileHtml).join('')}</div>
          <p class="tmpl-chooser-empty" hidden>No templates match “<span data-empty-term></span>”.</p>
        </div>
      </div>
    `;

    const panel = root.querySelector<HTMLElement>('.tmpl-chooser-panel')!;
    const searchInput = root.querySelector<HTMLInputElement>('.tmpl-chooser-search')!;
    const emptyEl = root.querySelector<HTMLElement>('.tmpl-chooser-empty')!;
    const emptyTermEl = root.querySelector<HTMLElement>('[data-empty-term]')!;

    const opener = document.activeElement;
    let trap: FocusTrap | undefined;
    let settled = false;
    const finish = (values: Record<string, InputValue>): void => {
      if (settled) return;
      settled = true;
      trap?.release();
      root.remove();
      if (opener instanceof HTMLElement) opener.focus();
      resolve(values);
    };

    trap = trapFocus(root, { initialFocus: searchInput });
    // Hand the caller a close handle now — the modal is fully built (root is in the
    // document, `finish` closes over it) — so a navigate-away arriving any time from
    // here on has something to call. `finish` is itself idempotent (the `settled`
    // guard above), so this can never double-resolve against a real pick.
    opts.onOpen?.(() => finish({}));

    root.querySelector('.tmpl-chooser-close')?.addEventListener('click', () => finish({}));
    root.querySelector('.tmpl-chooser-backdrop')?.addEventListener('click', () => finish({}));

    panel.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); finish({}); }
    });

    root.querySelector('.tmpl-chooser-body')?.addEventListener('click', e => {
      const tile = (e.target as HTMLElement).closest<HTMLElement>('[data-template-id]');
      if (!tile) return;
      const id = tile.dataset.templateId!;
      if (id === BLANK_ID) { finish({}); return; }
      // Reflect the fetch in the tile so a slow network doesn't read as a dead click.
      tile.setAttribute('aria-busy', 'true');
      // Fetch (or reuse) the template's external values seed, THEN resolve. A null result
      // (unknown id / network failure) falls back to a blank open, exactly like Escape.
      void getValues(id).then(values => finish(values ?? {}));
    });

    // Live filter: the search term AND the active tag chip, over the one grid. Blank always
    // shows; an empty-state note appears only when a real query leaves nothing but Blank.
    let activeFilter = '';
    const applyFilter = (): void => {
      const term = searchInput.value.trim().toLowerCase();
      let anyTemplateVisible = false;
      for (const tile of root.querySelectorAll<HTMLElement>('.tmpl-chooser-tile')) {
        if (tile.dataset.templateId === BLANK_ID) { tile.hidden = false; continue; } // Blank is never filtered
        const matchTerm = !term || (tile.dataset.search ?? '').includes(term);
        const matchTag = !activeFilter || tile.dataset.category === activeFilter;
        const show = matchTerm && matchTag;
        tile.hidden = !show;
        if (show) anyTemplateVisible = true;
      }
      emptyEl.hidden = anyTemplateVisible || (!term && !activeFilter);
      emptyTermEl.textContent = term || activeFilter;
    };
    searchInput.addEventListener('input', applyFilter);
    for (const chip of root.querySelectorAll<HTMLButtonElement>('.tmpl-chooser-filter')) {
      chip.addEventListener('click', () => {
        activeFilter = chip.dataset.filter ?? '';
        for (const c of root.querySelectorAll<HTMLElement>('.tmpl-chooser-filter')) {
          const on = c === chip;
          c.classList.toggle('is-active', on);
          c.setAttribute('aria-pressed', on ? 'true' : 'false');
        }
        applyFilter();
      });
    }

    // ── Live visual previews (fire-and-forget) ──────────────────────────────────
    // Each template tile fetches its external values seed and live-renders a vector-first
    // thumbnail via the SAME off-screen engine path an export takes (renderFeaturedVariant,
    // memoised under `template:<toolId>:<tid>:<fmt>` — a namespace that never collides with
    // the featured/example `featured:` records). Rendered SERIALLY, and each render waits
    // for an idle gap first (whenIdle), so opening the chooser never stampedes the engine
    // and never starves the tool mount running underneath it. A still poster-frame is fine
    // for an animated template (v1). With no host / formats — or an authored `thumb` — the
    // glyph/thumb placeholder stays. Results are memoised in host.previews, so this whole
    // block is a FIRST-open cost: a second open resolves every tile from cache.
    if (opts.host && opts.formats && opts.formats.length && typeof IntersectionObserver !== 'undefined') {
      const host = opts.host;
      const formats = opts.formats;
      const queue: string[] = [];
      const queued = new Set<string>();
      let draining = false;
      const drain = async (): Promise<void> => {
        if (draining) return;
        draining = true;
        try {
          // Yield before the render-engine chunk is even requested: the tool is mounting
          // underneath this modal right now and its own lazy chunks are in flight.
          await whenIdle();
          const { renderFeaturedVariant } = await import('../lib/featured-render.ts');
          while (queue.length && !settled) {
            const id = queue.shift()!;
            const values = await getValues(id).catch(() => null);
            if (!values || settled) continue;
            try {
              const src = await renderFeaturedVariant(
                host as Parameters<typeof renderFeaturedVariant>[0],
                opts.toolId, formats, id, values as Record<string, unknown>, 'template',
              );
              if (settled || !src) continue;
              const media = root.querySelector<HTMLElement>(
                `.tmpl-chooser-tile[data-template-id="${CSS.escape(id)}"] .tmpl-chooser-tile-media`,
              );
              if (media) {
                const img = document.createElement('img');
                img.className = 'tmpl-chooser-tile-thumb';
                img.alt = '';
                img.src = src;
                media.replaceChildren(img);
              }
            } catch { /* leave the glyph placeholder for this tile */ }
            // …and between renders, so a tile click (or the mount) can land in the gap
            // rather than queueing behind every remaining preview.
            if (queue.length && !settled) await whenIdle();
          }
        } finally {
          draining = false;
        }
      };
      const enqueue = (id: string): void => {
        if (queued.has(id) || byId.get(id)?.thumb) return; // authored thumb already shows art
        queued.add(id);
        queue.push(id);
        void drain();
      };

      // Eager: enqueue every renderable template on open so previews render even if the
      // IntersectionObserver never delivers an intersecting entry (a false-negative on the
      // first async callback — panel mid-layout, backgrounded/occluded tab, or a stale
      // bundle — was permanent, since each tile is unobserved on first intersect and the IO
      // callback was the ONLY producer for the queue). There are only a handful of templates,
      // and the serial drain renders one at a time, so this cannot stampede the engine.
      // enqueue() dedups via `queued` and skips authored-thumb tiles, so it can't double-render.
      for (const t of opts.templates) {
        if (t.id !== BLANK_ID) enqueue(t.id);
      }

      // IntersectionObserver stays as an off-screen prioritisation nicety — with the eager
      // loop above it is no longer load-bearing (its enqueue() calls dedup to no-ops against
      // `queued`). Root to the real scroll container (the body panel; see template-chooser.css
      // `.tmpl-chooser-body { overflow-y: auto }`), falling back to the viewport — the modal is
      // a fixed overlay filling it — so a missing body never means a dead observer.
      const bodyEl = root.querySelector('.tmpl-chooser-body');
      const io = new IntersectionObserver((entries, obs) => {
        for (const en of entries) {
          if (!en.isIntersecting) continue;
          obs.unobserve(en.target);
          const id = (en.target as HTMLElement).dataset.templateId;
          if (id && id !== BLANK_ID) enqueue(id);
        }
      }, { root: bodyEl, rootMargin: '200px' });
      for (const tile of root.querySelectorAll<HTMLElement>('.tmpl-chooser-tile')) {
        if (tile.dataset.templateId !== BLANK_ID) io.observe(tile);
      }
    }
    } catch (e) { settleBlank(e); }
  });
}
