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

/** A parsed, validated entry from a manifest's `templates[]`. */
export interface TemplateVariant {
  id: string;
  name: string;
  description?: string;
  category?: string;
  thumb?: string;
  values: Record<string, InputValue>;
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

interface ChooserOpts {
  toolName: string;
  templates: TemplateVariant[];
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

    const byId = new Map<string, TemplateVariant>(opts.templates.map(t => [t.id, t]));

    // Group by category, preserving first-seen order; uncategorised templates
    // fall into a "Templates" bucket rendered after the named groups.
    const groupOrder: string[] = [];
    const groups = new Map<string, TemplateVariant[]>();
    for (const t of opts.templates) {
      const key = t.category ?? 'Templates';
      if (!groups.has(key)) { groups.set(key, []); groupOrder.push(key); }
      groups.get(key)!.push(t);
    }

    const tileHtml = (t: TemplateVariant): string => {
      const media = t.thumb
        ? `<img class="tmpl-chooser-tile-thumb" src="${escapeHtml(t.thumb)}" alt="" loading="lazy">`
        : `<span class="tmpl-chooser-tile-icon" aria-hidden="true">${icon(glyphFor(t), { size: 22 })}</span>`;
      const search = `${t.name} ${t.description ?? ''} ${t.category ?? ''}`.toLowerCase();
      return `<button type="button" class="tmpl-chooser-tile" data-template-id="${escapeHtml(t.id)}" data-search="${escapeHtml(search)}">
        ${media}
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

    const groupsHtml = groupOrder.map(key => `
      <section class="tmpl-chooser-group" data-group>
        <h3 class="tmpl-chooser-group-title">${escapeHtml(key)}</h3>
        <div class="tmpl-chooser-grid">${groups.get(key)!.map(tileHtml).join('')}</div>
      </section>`).join('');

    root.innerHTML = `
      <div class="tmpl-chooser-backdrop" aria-hidden="true"></div>
      <div class="tmpl-chooser-panel" role="dialog" aria-modal="true" aria-labelledby="tmpl-chooser-title">
        <header class="tmpl-chooser-header">
          <h2 id="tmpl-chooser-title">Start ${escapeHtml(opts.toolName)}</h2>
          <input type="search" class="tmpl-chooser-search" placeholder="Search templates…" autocomplete="off" spellcheck="false" aria-label="Search templates">
          <button type="button" class="tmpl-chooser-close" aria-label="Close">×</button>
        </header>
        <div class="tmpl-chooser-body">
          <section class="tmpl-chooser-group" data-group>
            <div class="tmpl-chooser-grid">${blankTile}</div>
          </section>
          ${groupsHtml}
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
      const chosen = byId.get(id);
      finish(chosen ? chosen.values : {});
    });

    // Live filter: hide non-matching tiles (Blank always shows) and any group left
    // empty, and surface an empty-state note when nothing but Blank matches.
    searchInput.addEventListener('input', () => {
      const term = searchInput.value.trim().toLowerCase();
      let anyTemplateVisible = false;
      for (const tile of root.querySelectorAll<HTMLElement>('.tmpl-chooser-tile')) {
        if (tile.dataset.templateId === BLANK_ID) continue; // Blank is never filtered out
        const match = !term || (tile.dataset.search ?? '').includes(term);
        tile.hidden = !match;
        if (match) anyTemplateVisible = true;
      }
      for (const group of root.querySelectorAll<HTMLElement>('[data-group]')) {
        const tiles = [...group.querySelectorAll<HTMLElement>('.tmpl-chooser-tile')];
        const isBlankGroup = tiles.some(t => t.dataset.templateId === BLANK_ID);
        group.hidden = !isBlankGroup && tiles.every(t => t.hidden);
      }
      emptyEl.hidden = anyTemplateVisible || !term;
      emptyTermEl.textContent = term;
    });
  });
}
