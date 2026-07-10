// SPDX-License-Identifier: MPL-2.0
/**
 * Brand studio tabs — the three studio panels that don't touch the colour
 * pipeline: non-colour token editors (Tokens tab), gradient tokens (Colour
 * tab's optional extra) and catalogue uploads (Catalogue tab). Split out of
 * brand-editor.ts so the editor stays the colour/typography/logo core; each
 * mount gets the same narrow context — the live doc (a GETTER, because the
 * Colour tab reassigns the doc on re-derive/import), the persist funnel and
 * its tab's notify — and returns { render, teardown } so the editor can
 * repaint after a doc swap and unhook on unmount.
 *
 * Pure doc surgery lives in token-studio.ts; storage in upload-dropzone.ts /
 * the picker's storeUserUpload. Nothing here writes outside those funnels.
 */

import type { HostV1 } from '../../../../engine/src/bridge/host-v1.ts';
import { colorToHex } from '@lolly/engine';
import {
  listStudioTokens, addStudioToken, setStudioTokenValue, deleteStudioToken,
  defaultValueFor, gradientCss, formatStudioValue,
} from './token-studio.ts';
import type { StudioKind, StudioToken, GradientStop } from './token-studio.ts';
import { mountUploadDropzone } from './upload-dropzone.ts';
import type { PickerHost } from '../views/picker.ts';
import { confirmDialog } from '../components/confirm-dialog.ts';
import { escape } from '../utils.ts';
import { announce } from '../a11y.ts';
import { playSfx } from './sfx.ts';

export interface StudioTabCtx {
  host: HostV1;
  doc: () => Record<string, unknown>;
  persist: (immediate?: boolean) => void;
  notify: () => void;
}

export interface StudioPanelHandle { render: () => void; teardown: () => void }

// ── Tokens panel ──────────────────────────────────────────────────────────────

/** The kinds the Tokens tab offers (gradient lives on the Colour tab instead —
 *  it's a colour primitive, and colour work shouldn't leave that tab). */
const TOKEN_KINDS: ReadonlyArray<{ id: StudioKind; label: string }> = [
  { id: 'spacing', label: 'Spacing' },
  { id: 'sizing', label: 'Sizing' },
  { id: 'stroke', label: 'Stroke width' },
  { id: 'opacity', label: 'Opacity' },
  { id: 'rotation', label: 'Rotation' },
  { id: 'number', label: 'Number' },
  { id: 'shadow', label: 'Shadow' },
];
const KIND_LABEL = new Map(TOKEN_KINDS.map(k => [k.id, k.label]));

const pathAttr = (t: StudioToken): string => escape(t.path.join('␟')); // ␟ — never in a slug
const pathFrom = (attr: string): string[] => attr.split('␟');

/** One token row's value editor, per kind. Every control carries the row's
 *  JSON path so one delegated listener serves them all. */
function tokenValueEditor(t: StudioToken): string {
  const p = pathAttr(t);
  switch (t.kind) {
    case 'opacity': {
      const v = typeof t.raw === 'number' ? t.raw : 1;
      return `<input type="range" class="be-tok-range" min="0" max="1" step="0.01" value="${v}" data-tok-input="opacity" data-tok-path="${p}" aria-label="${escape(t.name)} opacity">
        <output class="be-tok-out" data-tok-out>${escape(formatStudioValue(t))}</output>`;
    }
    case 'rotation':
    case 'number': {
      const v = typeof t.raw === 'number' ? t.raw : 0;
      return `<input type="number" class="be-tok-num" value="${v}" step="${t.kind === 'rotation' ? 15 : 'any'}" data-tok-input="${t.kind}" data-tok-path="${p}" aria-label="${escape(t.name)} value">${t.kind === 'rotation' ? '<span class="be-tok-unit">°</span>' : ''}`;
    }
    case 'shadow': {
      const raw = (t.raw ?? {}) as Record<string, unknown>;
      const f = (k: string): string => escape(String(raw[k] ?? (k === 'color' ? '#00000040' : '0px')));
      return `<span class="be-tok-shadow-chip" style="box-shadow:${escape(formatStudioValue(t))}" aria-hidden="true"></span>
        ${(['offsetX', 'offsetY', 'blur', 'spread'] as const).map(k =>
          `<label class="be-tok-shadow-in"><span>${k === 'offsetX' ? 'x' : k === 'offsetY' ? 'y' : k}</span><input type="text" value="${f(k)}" data-tok-input="shadow" data-tok-field="${k}" data-tok-path="${p}" size="5" aria-label="${escape(t.name)} ${k}"></label>`).join('')}
        <input type="color" class="be-tok-shadow-col" value="${escape((colorToHex(String(raw.color ?? '')) ?? '#000000').slice(0, 7))}" data-tok-input="shadow" data-tok-field="color" data-tok-path="${p}" aria-label="${escape(t.name)} colour">`;
    }
    default: // the dimension kinds: spacing / sizing / stroke
      return `<input type="text" class="be-tok-dim" value="${escape(String(t.raw ?? ''))}" data-tok-input="dimension" data-tok-path="${p}" size="7" inputmode="decimal" aria-label="${escape(t.name)} value" placeholder="8px">`;
  }
}

/** Read a shadow row's five fields back into the DTCG shadow value. The colour
 *  comes from the STORED value unless the colour input itself drove the commit —
 *  `<input type=color>` only speaks #rrggbb, so echoing it back on every edit
 *  would strip an authored alpha ('#00000040') or oklch() the moment the blur
 *  is touched. */
function shadowFromRow(row: HTMLElement, changedField: string | undefined, currentRaw: unknown): Record<string, string> {
  const val = (k: string): string => row.querySelector<HTMLInputElement>(`[data-tok-field="${k}"]`)?.value.trim() ?? '0px';
  const storedColor = isRecObj(currentRaw) && typeof currentRaw.color === 'string' ? currentRaw.color : val('color');
  return {
    color: changedField === 'color' ? val('color') : storedColor,
    offsetX: val('offsetX'), offsetY: val('offsetY'), blur: val('blur'), spread: val('spread'),
  };
}
const isRecObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function mountTokensPanel(mount: HTMLElement, ctx: StudioTabCtx): StudioPanelHandle {
  mount.innerHTML = `
    <div class="be-panel-head"><h3 class="be-panel-title">More tokens</h3>
      <p class="be-panel-sub">The rest of the system — spacing, sizing, stroke widths, opacity, rotation, plain numbers and shadows. Tools that read tokens follow these the way they follow your colours.</p></div>
    <div class="be-tok-list" data-tok-list></div>
    <form class="be-tok-add" data-tok-add>
      <select class="be-tok-add-kind" data-tok-add-kind aria-label="Token type">
        ${TOKEN_KINDS.map(k => `<option value="${k.id}">${escape(k.label)}</option>`).join('')}
      </select>
      <input type="text" class="be-tok-add-name" data-tok-add-name placeholder="Name it — Gutter, Card shadow…" autocomplete="off" spellcheck="false" aria-label="Token name">
      <button type="submit" class="be-btn">+ Add token</button>
    </form>
    <p class="be-err" data-tok-err hidden></p>`;

  const list = mount.querySelector<HTMLElement>('[data-tok-list]')!;
  const err = mount.querySelector<HTMLElement>('[data-tok-err]');
  const showErr = (m: string): void => { if (err) { err.textContent = m; err.hidden = !m; } if (m) announce(m, { assertive: true }); };

  const render = (): void => {
    const all = listStudioTokens(ctx.doc()).filter(t => t.kind !== 'gradient');
    if (!all.length) {
      list.innerHTML = '<p class="be-tok-empty">No extra tokens yet — most brands start with a spacing unit and a card shadow.</p>';
      return;
    }
    const byKind = new Map<StudioKind, StudioToken[]>();
    for (const t of all) (byKind.get(t.kind) ?? byKind.set(t.kind, []).get(t.kind)!).push(t);
    list.innerHTML = [...byKind.entries()].map(([kind, items]) => `
      <div class="be-tok-group">
        <div class="be-tok-group-head"><span class="be-tok-group-label">${escape(KIND_LABEL.get(kind) ?? kind)}</span><span class="be-tok-group-n">${items.length}</span></div>
        ${items.map(t => `
          <div class="be-tok-row" data-tok-row data-tok-path="${pathAttr(t)}">
            <span class="be-tok-name" title="${escape(t.key)}">${escape(t.name)}</span>
            <span class="be-tok-editor">${tokenValueEditor(t)}</span>
            <button type="button" class="be-tok-del" data-tok-del="${pathAttr(t)}" aria-label="Delete ${escape(t.name)}">&#x2715;</button>
          </div>`).join('')}
      </div>`).join('');
  };
  render();

  // One delegated commit for every editor control. Range/number commit on
  // input (they're cheap + atomic); text dimensions commit on change so a
  // half-typed "1.5re" never lands.
  const commit = (el: HTMLInputElement): void => {
    const path = pathFrom(el.dataset.tokPath ?? '');
    const kind = el.dataset.tokInput;
    // A cleared number field reports '' — Number('') is 0, which would persist
    // a value the user never typed. Wait for real input (or a blur revert).
    if ((kind === 'rotation' || kind === 'number' || kind === 'opacity') && el.value.trim() === '') return;
    let ok = false;
    if (kind === 'shadow') {
      const row = el.closest<HTMLElement>('[data-tok-row]');
      const cur = listStudioTokens(ctx.doc()).find(x => x.path.join('␟') === path.join('␟'));
      if (row) ok = setStudioTokenValue(ctx.doc(), path, shadowFromRow(row, el.dataset.tokField, cur?.raw));
      if (ok) {
        const chip = el.closest<HTMLElement>('[data-tok-row]')?.querySelector<HTMLElement>('.be-tok-shadow-chip');
        const t = listStudioTokens(ctx.doc()).find(x => x.path.join('␟') === path.join('␟'));
        if (chip && t) chip.style.boxShadow = formatStudioValue(t);
      }
    } else if (kind === 'opacity') {
      ok = setStudioTokenValue(ctx.doc(), path, Number(el.value));
      const out = el.parentElement?.querySelector<HTMLElement>('[data-tok-out]');
      if (out) out.textContent = String(Number(el.value));
    } else if (kind === 'rotation' || kind === 'number') {
      ok = setStudioTokenValue(ctx.doc(), path, Number(el.value));
    } else {
      ok = setStudioTokenValue(ctx.doc(), path, el.value);
    }
    if (!ok) { showErr(`Couldn't read that value — ${kind === 'dimension' ? 'use a CSS length like 8px or 0.5rem' : 'check it and try again'}.`); return; }
    showErr('');
    ctx.persist();
    ctx.notify();
  };
  list.addEventListener('input', (e) => {
    const el = e.target as HTMLInputElement;
    if (el.dataset.tokInput === 'opacity' || el.dataset.tokInput === 'rotation' || el.dataset.tokInput === 'number') commit(el);
  });
  list.addEventListener('change', (e) => {
    const el = e.target as HTMLInputElement;
    if (el.dataset.tokInput === 'dimension' || el.dataset.tokInput === 'shadow') commit(el);
  });
  list.addEventListener('click', async (e) => {
    const del = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-tok-del]'); if (!del) return;
    const path = pathFrom(del.dataset.tokDel ?? '');
    const t = listStudioTokens(ctx.doc()).find(x => x.path.join('␟') === path.join('␟'));
    const ok = await confirmDialog({ title: `Delete ${t?.name ?? 'this token'}?`, message: 'Anything reading it falls back to its own default.', confirmLabel: 'Delete' });
    if (!ok) return;
    if (deleteStudioToken(ctx.doc(), path)) { render(); ctx.persist(true); ctx.notify(); }
  });
  mount.querySelector<HTMLFormElement>('[data-tok-add]')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const kindSel = mount.querySelector<HTMLSelectElement>('[data-tok-add-kind]');
    const nameInput = mount.querySelector<HTMLInputElement>('[data-tok-add-name]');
    const kind = (kindSel?.value ?? 'spacing') as StudioKind;
    const name = nameInput?.value.trim() ?? '';
    if (!name) { showErr('Name the token first.'); nameInput?.focus(); return; }
    const path = addStudioToken(ctx.doc(), kind, name, defaultValueFor(kind));
    if (!path) { showErr("Couldn't add that token."); return; }
    showErr('');
    if (nameInput) nameInput.value = '';
    render(); ctx.persist(true); ctx.notify(); playSfx('click');
    announce(`${name} added`);
    // Land focus on the fresh row's first control so the value is one keystroke away.
    list.querySelector<HTMLElement>(`[data-tok-row][data-tok-path="${pathAttr({ path } as StudioToken)}"] input`)?.focus();
  });

  return { render, teardown: () => {} };
}

// ── Gradients panel (Colour tab) ──────────────────────────────────────────────

export interface GradientsCtx extends StudioTabCtx {
  primaryHex: () => string;
  paletteHexes: () => string[];
}

const stopHex = (s: GradientStop): string => (colorToHex(s.color) ?? '#888888').slice(0, 7);

export function mountGradientsPanel(mount: HTMLElement, ctx: GradientsCtx): StudioPanelHandle {
  mount.innerHTML = `
    <div class="be-panel-head"><h3 class="be-panel-title">Gradients</h3>
      <p class="be-panel-sub">Optional colour tokens — blends of your palette for backgrounds and accents. Skip these entirely if your brand doesn't do gradients.</p></div>
    <div class="be-grad-list" data-grad-list></div>
    <button type="button" class="be-add" data-grad-add>+ Add gradient</button>
    <p class="be-err" data-grad-err hidden></p>`;

  const list = mount.querySelector<HTMLElement>('[data-grad-list]')!;
  const err = mount.querySelector<HTMLElement>('[data-grad-err]');
  const showErr = (m: string): void => { if (err) { err.textContent = m; err.hidden = !m; } if (m) announce(m, { assertive: true }); };
  const grads = (): StudioToken[] => listStudioTokens(ctx.doc()).filter(t => t.kind === 'gradient');

  const render = (): void => {
    const items = grads();
    list.innerHTML = items.map(t => {
      const stops = Array.isArray(t.raw) ? (t.raw as GradientStop[]) : [];
      const p = pathAttr(t);
      return `
        <div class="be-grad-row" data-grad-row data-grad-path="${p}">
          <span class="be-grad-preview" style="background:${escape(gradientCss(t.raw, t.angle))}" aria-hidden="true"></span>
          <span class="be-grad-meta">
            <span class="be-grad-name">${escape(t.name)}</span>
            <span class="be-grad-stops">
              ${stops.map((s, i) => `<label class="be-grad-stop"><input type="color" value="${stopHex(s)}" data-grad-stop="${i}" data-grad-path="${p}" aria-label="${escape(t.name)} stop ${i + 1}"></label>`).join('')}
              ${stops.length < 5 ? `<button type="button" class="be-grad-addstop" data-grad-addstop="${p}" aria-label="Add a stop to ${escape(t.name)}">+</button>` : ''}
              <label class="be-grad-angle"><input type="number" value="${t.angle ?? 180}" step="15" data-grad-angle data-grad-path="${p}" aria-label="${escape(t.name)} angle">°</label>
            </span>
          </span>
          <button type="button" class="be-tok-del" data-grad-del="${p}" aria-label="Delete ${escape(t.name)}">&#x2715;</button>
        </div>`;
    }).join('');
  };
  render();

  const tokenAt = (attr: string): StudioToken | undefined =>
    grads().find(t => t.path.join('␟') === attr);
  const repaintRow = (attr: string): void => {
    const t = tokenAt(attr);
    const row = list.querySelector<HTMLElement>(`[data-grad-row][data-grad-path="${CSS.escape(attr)}"] .be-grad-preview`);
    if (t && row) row.style.background = gradientCss(t.raw, t.angle);
  };

  list.addEventListener('input', (e) => {
    const el = e.target as HTMLInputElement;
    const attr = el.dataset.gradPath ?? '';
    const t = tokenAt(attr); if (!t) return;
    const stops = Array.isArray(t.raw) ? [...(t.raw as GradientStop[])] : [];
    if (el.dataset.gradStop !== undefined) {
      const i = Number(el.dataset.gradStop);
      if (!stops[i]) return;
      stops[i] = { ...stops[i]!, color: el.value };
      if (!setStudioTokenValue(ctx.doc(), t.path, stops)) return;
    } else if (el.dataset.gradAngle !== undefined) {
      if (el.value.trim() === '') return; // cleared field — Number('') would write 0
      const angle = Number(el.value);
      if (!Number.isFinite(angle)) return;
      if (!setStudioTokenValue(ctx.doc(), t.path, { stops, angle })) return;
    } else return;
    repaintRow(attr);
    ctx.persist();
    ctx.notify();
  });
  list.addEventListener('click', async (e) => {
    const addStop = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-grad-addstop]');
    if (addStop) {
      const t = tokenAt(addStop.dataset.gradAddstop ?? ''); if (!t) return;
      const stops = Array.isArray(t.raw) ? [...(t.raw as GradientStop[])] : [];
      // A new stop lands mid-run in the palette's next unused colour.
      const used = new Set(stops.map(stopHex));
      const next = ctx.paletteHexes().find(h => !used.has(h.toLowerCase().slice(0, 7))) ?? '#888888';
      stops.push({ color: next, position: 0.5 });
      if (setStudioTokenValue(ctx.doc(), t.path, stops)) { render(); ctx.persist(); ctx.notify(); }
      return;
    }
    const del = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-grad-del]'); if (!del) return;
    const t = tokenAt(del.dataset.gradDel ?? '');
    const ok = await confirmDialog({ title: `Delete ${t?.name ?? 'this gradient'}?`, message: 'It’s removed from your brand tokens.', confirmLabel: 'Delete' });
    if (!ok || !t) return;
    if (deleteStudioToken(ctx.doc(), t.path)) { render(); ctx.persist(true); ctx.notify(); }
  });
  mount.querySelector<HTMLButtonElement>('[data-grad-add]')?.addEventListener('click', () => {
    const n = grads().length + 1;
    const pal = ctx.paletteHexes();
    const from = ctx.primaryHex(), to = pal.find(h => h.toLowerCase() !== from.toLowerCase()) ?? '#ffffff';
    const path = addStudioToken(ctx.doc(), 'gradient', `Gradient ${n}`, {
      stops: [{ color: from, position: 0 }, { color: to, position: 1 }], angle: 135,
    });
    if (!path) { showErr("Couldn't add a gradient."); return; }
    showErr('');
    render(); ctx.persist(true); ctx.notify(); playSfx('click');
    announce(`Gradient ${n} added`);
  });

  return { render, teardown: () => {} };
}

// ── Catalogue panel ───────────────────────────────────────────────────────────

/** Display buckets, in render order — the same coarse cut the Catalogue view
 *  makes: motion = video, Lottie and animated rasters. */
const CAT_BUCKETS: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'vector', label: 'Vector' },
  { key: 'image', label: 'Images' },
  { key: 'audio', label: 'Audio' },
  { key: 'motion', label: 'Motion' },
];

/** Internal ids (fonts, logos, tokens, the headshot) aren't catalogue uploads. */
const INTERNAL_ID = /^user\/(fonts|logo|tokens|headshot)/;

function bucketOf(ref: { type: string; meta?: Record<string, unknown> }): string | null {
  if (ref.type === 'vector') return 'vector';
  if (ref.type === 'audio') return 'audio';
  if (ref.type === 'video' || ref.type === 'lottie') return 'motion';
  if (ref.type === 'raster') return ref.meta?.animated ? 'motion' : 'image';
  return null;
}

export interface CataloguePanelCtx { host: HostV1; notify: () => void }

export function mountCataloguePanel(mount: HTMLElement, ctx: CataloguePanelCtx): StudioPanelHandle {
  mount.innerHTML = `
    <div class="be-panel-head"><h3 class="be-panel-title">Catalogue</h3>
      <p class="be-panel-sub">The files your brand keeps — drop them here and they land in your <a href="#/c">Catalogue</a>, sorted into its sections, ready for every tool's asset picker.</p></div>
    <div data-be-cat-dropzone></div>
    <div class="be-cat-groups" data-be-cat-groups aria-live="polite"></div>`;

  const groupsEl = mount.querySelector<HTMLElement>('[data-be-cat-groups]')!;
  const pickerHost = ctx.host as PickerHost;

  const render = (): void => { void paint(); };
  const paint = async (): Promise<void> => {
    let refs: Array<{ id: string; type: string; meta?: Record<string, unknown> }> = [];
    try { refs = await pickerHost.assets._listUserAssets(); } catch { /* fresh install — nothing yet */ }
    const uploads = refs.filter(r => !INTERNAL_ID.test(r.id));
    if (!mount.isConnected) return;
    if (!uploads.length) {
      groupsEl.innerHTML = '<p class="be-cat-empty">Nothing yet — everything you add stays on this device.</p>';
      return;
    }
    const byBucket = new Map<string, string[]>();
    for (const r of uploads) {
      const b = bucketOf(r); if (!b) continue;
      const name = String(r.meta?.name ?? r.id.split('/').pop() ?? '');
      (byBucket.get(b) ?? byBucket.set(b, []).get(b)!).push(name);
    }
    groupsEl.innerHTML = CAT_BUCKETS.map(({ key, label }) => {
      const names = byBucket.get(key) ?? [];
      if (!names.length) return '';
      return `<div class="be-cat-group">
          <span class="be-cat-group-label">${escape(label)}<span class="be-cat-group-n">${names.length}</span></span>
          <span class="be-cat-group-names">${names.slice(0, 6).map(n => `<span class="be-cat-name">${escape(n)}</span>`).join('')}${names.length > 6 ? `<span class="be-cat-more">+${names.length - 6} more</span>` : ''}</span>
        </div>`;
    }).join('');
  };
  render();

  const dzMount = mount.querySelector<HTMLElement>('[data-be-cat-dropzone]')!;
  const teardownDz = mountUploadDropzone(dzMount, pickerHost, {
    onAdded: async () => { await paint(); ctx.notify(); },
  });

  return { render, teardown: teardownDz };
}
