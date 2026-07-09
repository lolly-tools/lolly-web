// SPDX-License-Identifier: MPL-2.0
/**
 * Dashboard view (#/d) — the "instrument panel" for the whole platform. It merges
 * what used to be two pages (#/platform and #/capabilities) and pulls read-only
 * glances of your own data (activity + storage) from the Profile — nothing here
 * is removed from Profile; this is a mirror, not a move.
 * The exception is "Your brand" (see brandSection()), which is a real EDITOR:
 * colour, the editable palette, fonts and the brand pack are all set here, in
 * place (lib/brand-editor.ts). Profile keeps its font/share card as a mirror and
 * #/start remains the first-run wizard, but neither is a detour any more.
 *
 * The layout is deliberate: Your brand leads (full-width, never collapsible),
 * then the bento of instrument tiles (activity, storage, palette wheel, type,
 * aspect ratios), then four collapsible PRIMARY sections built by collapse() —
 * THIS DEVICE (full-width; the live machine readout people find genuinely
 * interesting), a two-up row of Colour palette | Catalogue (each half-width),
 * and What Lolly can do (the full capability map, full-width) — then the type /
 * theme / print reference panels. Each primary section folds to its title bar
 * with a soft hydraulic cue (see the toggle listener in mountDashboard).
 * Apart from Your brand (and the theme/sound switches), the rest is a snapshot
 * of what this session currently knows.
 *
 * Data sources (single sources of truth, imported — never duplicated):
 *   brand     → host.assets discovery (USER_TOKENS_ID) — same check Profile used
 *   device    → lib/device-info.ts        (live session snapshot)
 *   activity  → metrics.ts + lib/activity-summary.ts
 *   storage   → navigator.storage + host.state / host.assets measurers
 *   palette   → lib/live-palette.ts (host.tokens, falls back to src/palette.ts) via lib/swatches.ts
 *   catalogue → window.__toolIndex + /catalog/assets/index.json
 *   caps      → lib/capabilities-data.ts
 *   CMYK      → engine/src/color.ts (CMYK_CONDITIONS)
 *   themes    → src/theme.ts (THEMES) · fonts → the LIVE --font-brand/--font-mono
 *               vars (lib/type-demo.ts activeFaces — brand/user fonts included)
 */

import '../styles/parts/platform.css'; // shared dashboard chrome (.plat-* / .cap-*)
import '../styles/parts/dashboard.css'; // this view's layout + signature pieces
import { escape } from '../utils.ts';
import { armViewEnter } from '../view-enter.ts';
import { createRecentStack } from '../lib/recent-stack.ts';
import { renderPaletteWheel, wirePaletteWheel } from '../lib/palette-wheel.ts';
import { renderTypeDemo, wireTypeDemo, activeFaces } from '../lib/type-demo.ts';
import { catalogSummaryBody, hydrateCatalogAssets } from '../lib/catalog-summary.ts';
import type { CatalogTool } from '../lib/catalog-summary.ts';
import type { PaletteEntry } from '../palette.ts';
import { livePalette } from '../lib/live-palette.ts';
import { groupPalette, swatch, isTransparent, cmykText } from '../lib/swatches.ts';
import { THEMES, THEME_LABELS, currentTheme, applyTheme } from '../theme.ts';
import { CMYK_CONDITIONS, DEFAULT_CMYK_CONDITION } from '@lolly/engine';
import { getMetrics } from '../metrics.ts';
import { renderActivity } from '../lib/activity-summary.ts';
import { collectDevice, renderDeviceCards, renderDeviceStat, liveValue, fmtBytes } from '../lib/device-info.ts';
import { playSfx, playThemeSfx } from '../lib/sfx.ts';
import { soundSwitchHtml, wireSoundSwitch } from '../components/sound-toggle.ts';
import { USER_TOKENS_ID } from '../bridge/tokens.ts';
import type { HostV1 } from '../../../../engine/src/bridge/host-v1.ts';
// Type-only — erased at compile time, so this does NOT pull the (lazily
// loaded) brand-editor.ts module into this view's bundle. See wireLivePaletteDraft.
import type { BrandDraftEventDetail } from '../lib/brand-editor.ts';

// Chevron for a collapsible reference panel (rotates 90° when open via CSS).
const COLLAPSE_CHEV = `<svg class="plat-section-chev" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>`;

// A collapsible primary section — the whole card folds to its title bar, reusing the
// reference-panel <details> chrome (.plat-section-summary / .plat-section-body handle
// the chevron rotation + padding). `half` sizes it for the two-up palette/catalogue row.
// Marked data-dash-collapse so the mount wires a soft open/close cue on toggle.
function collapse(o: { id: string; title: string; body: string; desc?: string; flag?: string; open?: boolean; half?: boolean; cls?: string }): string {
  return `
    <details class="plat-section dash-collapse${o.half ? ' dash-collapse--half' : ''}${o.cls ? ' ' + o.cls : ''}" id="${o.id}"${
      o.flag ? ` data-flag="${escape(o.flag)}"` : ''} data-dash-collapse${o.open === false ? '' : ' open'}>
      <summary class="plat-section-summary dash-collapse-summary">
        <h2 class="plat-section-title" id="${o.id}-h">${escape(o.title)}</h2>
        ${COLLAPSE_CHEV}
      </summary>
      <div class="plat-section-body">
        ${o.desc ? `<p class="plat-section-desc dash-collapse-desc">${o.desc}</p>` : ''}
        ${o.body}
      </div>
    </details>`;
}

// Sparkles (lucide) — the "make it yours" mark on the brand-setup link. Inline so
// it inherits currentColor; sized by CSS (see .dash-brand-setup svg).
const SPARKLES_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .962 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.962 0z"/><path d="M20 3v4M22 5h-4M4 17v2M5 18H3"/></svg>`;

// Section heading + optional deep-link anchor. Sections here are NOT collapsible
// (the reference panels at the foot are); the label rides above the content.
function sectionHead(title: string, id: string, desc = ''): string {
  return `<div class="dash-sec-head"><h2 id="${id}" class="dash-sec-title">${escape(title)}</h2>${
    desc ? `<p class="dash-sec-desc">${desc}</p>` : ''
  }</div>`;
}

// ── Your brand: the live brand EDITOR (lib/brand-editor.ts) — colour, the
// editable palette, fonts and the shareable brand pack, all in place. This is the
// "adjust" surface: nothing here bounces you to the wizard (colours) or Profile
// (fonts) any more. The #/start wizard stays as the first-run pathway, and
// Profile keeps its own font/share card as a mirror.
//
// Mounted just after first paint (IDB reads: brand discovery, tokens, fonts) and
// never collapsible — this is the one section that must always show. A LOCKED
// build renders a read-only note from inside the editor and wires nothing.
function brandSection(): string {
  return `
    <section class="plat-section dash-section dash-brand" id="dash-brand" aria-label="Your brand" data-flag="brand colour colours palette fonts">
      <div class="dash-sec-head dash-brand-head">
        <div class="dash-brand-head-text">
          <h2 id="dash-brand-h" class="dash-sec-title">Your brand</h2>
          <p class="dash-sec-desc">Your colour, palette and fonts — every tool, page and export follows. Nothing leaves this device.</p>
        </div>
        <a class="dash-brand-setup" href="#/start" title="Open the full-page brand setup">
          ${SPARKLES_ICON}<span>Make it yours</span>
        </a>
      </div>
      <p class="dash-brand-status" id="dash-brand-status">Loading…</p>
      <div class="dash-brand-editor" data-brand-editor-mount><p class="cat-empty">Loading your brand…</p></div>
    </section>`;
}

// ── Palette: the compact "ink ribbon" ──────────────────────────────────────
// Every colour as one thin bar, grouped by family; hover/focus drives a single
// mono readout (the instrument), click copies the hex. No value is lost — the
// full name/hex/CMYK grid is one click away under "All values".
function inkBar(c: PaletteEntry): string {
  const trans = isTransparent(c.hex);
  const measured = Array.isArray(c.cmyk);
  const hex = trans ? 'transparent' : c.hex;
  const cmyk = trans ? 'no ink' : cmykText(c.cmyk);
  return `<button type="button" class="dash-ink${trans ? ' is-transparent' : ''}${measured ? ' is-measured' : ''}"${
    trans ? '' : ` style="--ink:${escape(c.hex)}"`
  } data-copy="${escape(hex)}" data-name="${escape(c.label)}" data-hex="${escape(hex)}" data-cmyk="${escape(cmyk)}"${
    measured ? ' data-measured="1"' : ''
  } aria-label="${escape(c.label)} — ${escape(hex)}${measured ? ', exact CMYK ink' : ''} (click to copy)" title="${escape(c.label)} · ${escape(hex)}"></button>`;
}

function inkGroup(label: string, cols: readonly PaletteEntry[], count = false): string {
  return `
    <div class="dash-ink-group">
      <span class="dash-ink-group-label">${escape(label)}${count ? `<span class="dash-ink-group-n">${cols.length}</span>` : ''}</span>
      <div class="dash-ink-row">${cols.map(inkBar).join('')}</div>
    </div>`;
}

// Split from paletteSection so the live-draft sync below (wireLivePaletteDraft)
// can rebuild just the description + ribbon + full-values grid — the same
// markup collapse() wraps in the <details> chrome — without touching that
// chrome's open/closed state.
function paletteBody(palette: readonly PaletteEntry[]): { desc: string; body: string } {
  const { brand, spectrum, ramps } = groupPalette(palette);
  const measuredCount = palette.filter((c) => Array.isArray(c.cmyk)).length;

  const ribbon = `
    <div class="dash-ribbon" data-ribbon>
      ${inkGroup('Brand', brand)}
      ${spectrum.length ? inkGroup('Spectrum', spectrum, true) : ''}
      ${ramps.map(([fam, cols]) => inkGroup(fam, cols, true)).join('')}
    </div>
    <div class="dash-readout" data-readout aria-live="polite">
      <span class="dash-readout-swatch" data-ro-swatch aria-hidden="true"></span>
      <span class="dash-readout-name" data-ro-name>Hover or focus a colour</span>
      <code class="dash-readout-hex" data-ro-hex></code>
      <span class="dash-readout-cmyk" data-ro-cmyk></span>
    </div>`;

  // Full values, disclosed on demand — the classic grouped swatch grid so no
  // hex / CMYK figure is ever hidden, only tucked away.
  const fullGrid = `
    <details class="dash-values">
      <summary class="dash-values-summary">All values<span class="dash-values-n">${palette.length}</span>${COLLAPSE_CHEV}</summary>
      <div class="dash-values-body">
        <div class="plat-legend">
          <span class="plat-legend-item"><span class="plat-chip-flag is-static">CMYK</span> exact ink substitution</span>
          <span class="plat-legend-item"><span class="plat-swatch-cmyk is-generic">RGB→CMYK (generic)</span> generic conversion at export</span>
        </div>
        <h3 class="plat-ramp-title">Brand colours</h3>
        <div class="plat-swatch-grid">${brand.map(swatch).join('')}</div>
        ${spectrum.length ? `<h3 class="plat-ramp-title">Spectrum <span class="plat-ramp-count">${spectrum.length}</span></h3>
        <p class="plat-ramp-note">Secondary palette for infographics, charts &amp; data viz — it expands the colour wheel but does <strong>not</strong> replace brand colours.</p>
        <div class="plat-swatch-grid">${spectrum.map(swatch).join('')}</div>` : ''}
        ${ramps.map(([fam, cols]) => `<h3 class="plat-ramp-title">${escape(fam)} <span class="plat-ramp-count">${cols.length}</span></h3>
        <div class="plat-swatch-grid">${cols.map(swatch).join('')}</div>`).join('')}
      </div>
    </details>`;

  return {
    desc: `Shown in every colour picker. <strong>${measuredCount} of ${palette.length}</strong> carry measured CMYK ink values, substituted directly into CMYK PDF exports — the tick on a bar marks one.`,
    body: `${ribbon}${fullGrid}`,
  };
}

function paletteSection(palette: readonly PaletteEntry[]): string {
  const { desc, body } = paletteBody(palette);
  return collapse({ id: 'dash-palette', flag: 'color colour colours', title: 'Colour palette', desc, body, half: true });
}

// Copy-to-clipboard for ink bars AND the full-values swatch chips, scoped to
// whatever subtree just got (re)painted — the initial mount (the whole view)
// and the live-draft palette resync (just its replaced body) both call this.
function wireCopyButtons(root: ParentNode): void {
  root.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard?.writeText(btn.dataset.copy!);
        btn.classList.add('is-copied');
        setTimeout(() => btn.classList.remove('is-copied'), 900);
      } catch {
        /* clipboard blocked — no-op */
      }
    });
  });
}

// Best-effort: keep the "Colour palette" ink-bar section tracking the brand
// editor's live Colour-panel draft (primary drag, a neutral/secondary ramp
// pick, "Use this colour") — even before it's saved. Listens for the editor's
// BRAND_DRAFT_EVENT (passed in, not imported, so this view never statically
// pulls in the lazily-loaded brand-editor.ts module) and repaints only
// #dash-palette's body, leaving its open/closed state and every other section
// untouched. A no-op (never wired) when the editor doesn't mount, and a no-op
// per event when the section isn't on the page.
function wireLivePaletteDraft(viewEl: HTMLElement, eventName: string): () => void {
  const bodyEl = viewEl.querySelector<HTMLElement>('#dash-palette .plat-section-body');
  if (!bodyEl) return () => {};
  const onDraft = (e: Event): void => {
    if (!viewEl.isConnected) return;
    const palette = (e as CustomEvent<BrandDraftEventDetail>).detail?.palette;
    if (!palette?.length) return;
    const { desc, body } = paletteBody(palette);
    bodyEl.innerHTML = `<p class="plat-section-desc dash-collapse-desc">${desc}</p>${body}`;
    wireReadout(viewEl);
    wireCopyButtons(bodyEl);
  };
  document.addEventListener(eventName, onDraft);
  return () => document.removeEventListener(eventName, onDraft);
}

// ── Capabilities: grouped; each card POPS its detail open in a dialog ────────
// A card is a button that opens the shared dialog with its feature list, rather than an
// inline <details> that reflows the whole section as it expands. The detail markup rides
// in a sibling <template> (inert until cloned into the popup on click).
function capCard(card: { icon: string; title: string; features: Array<{ name: string; desc: string }> }): string {
  // The modal detail (full feature list) rides in an inert <template>.
  const feats = `<dl class="cap-feat dash-cap-feat">${
    card.features.map((f) => `<div><dt>${escape(f.name)}</dt><dd>${f.desc}</dd></div>`).join('')
  }</dl>`;
  // A tiny SUSE-Mono sneak of the subheadings you'll see in the modal.
  const peek = `<ul class="dash-cap-peek" aria-hidden="true">${
    card.features.map((f) => `<li>${escape(f.name)}</li>`).join('')
  }</ul>`;
  return `
    <div class="dash-cap-item">
      <button type="button" class="dash-cap-card" data-cap-open aria-haspopup="dialog"
              aria-label="${escape(card.title)} — ${card.features.length} detail${card.features.length === 1 ? '' : 's'}">
        <span class="dash-cap-card-top">
          <span class="dash-cap-icon" aria-hidden="true">${card.icon}</span>
          <span class="dash-cap-title">${escape(card.title)}</span>
        </span>
        ${peek}
        <span class="dash-cap-foot">
          <span class="dash-cap-n">${card.features.length}</span>
          <span class="dash-cap-more" aria-hidden="true">View →</span>
        </span>
      </button>
      <template class="dash-cap-detail">${feats}</template>
    </div>`;
}

async function capabilitiesSection(): Promise<string> {
  const { CAPABILITY_SECTIONS } = await import('../lib/capabilities-data.ts');
  // Each group is its own collapsible accordion panel — the section desc stays
  // visible in the summary as a table-of-contents, and the card grid expands below.
  // The first (Experiences) opens by default; the rest are folded so the whole map
  // is scannable at a glance. data-dash-collapse wires the shared fold sound cue.
  const groups = CAPABILITY_SECTIONS.map((s, idx) => `
    <details class="dash-cap-group" id="${s.id}" data-flag="${escape(s.flag)}" data-dash-collapse${idx === 0 ? ' open' : ''}>
      <summary class="dash-cap-group-head">
        <span class="dash-cap-group-icon" aria-hidden="true">${s.icon}</span>
        <div class="dash-cap-group-text">
          <h3 class="dash-cap-group-title">${escape(s.title)}</h3>
          <p class="dash-cap-group-desc">${escape(s.desc)}</p>
        </div>
        ${COLLAPSE_CHEV}
      </summary>
      <div class="dash-cap-grid">${s.cards.map(capCard).join('')}</div>
    </details>`).join('');
  const modal = `
      <dialog class="dash-cap-modal" data-cap-modal>
        <div class="dash-cap-modal-card">
          <header class="dash-cap-modal-head">
            <span class="dash-cap-modal-icon" data-cap-modal-icon aria-hidden="true"></span>
            <h3 class="dash-cap-modal-title" data-cap-modal-title></h3>
            <button type="button" class="dash-cap-modal-close" data-cap-modal-close aria-label="Close">✕</button>
          </header>
          <div class="dash-cap-modal-body" data-cap-modal-body></div>
        </div>
      </dialog>`;
  return collapse({
    id: 'dash-caps',
    title: 'What Lolly can do',
    desc: 'The full feature set — what it makes, where it runs, how it is used. Pick any card to pop its detail open.',
    body: `${groups}${modal}`,
  });
}

// ── Reference panels (collapsible) ──────────────────────────────────────────
function refPanel(flag: string, defaultOpen: boolean, id: string, title: string, body: string): string {
  return `
    <details class="plat-section dash-ref" id="${id}" data-flag="${escape(flag)}"${defaultOpen ? ' open' : ''}>
      <summary class="plat-section-summary"><h2 class="plat-section-title">${escape(title)}</h2>${COLLAPSE_CHEV}</summary>
      <div class="plat-section-body">${body}</div>
    </details>`;
}

// Interactive theme picker — each preview is a real button that applies the theme
// app-wide (instant) and persists it to the profile. The active one is flagged.
// `data-theme` still rides each preview so tokens.css renders its dots in that theme's
// own colours; `data-theme-set` is the click target (kept distinct — see wireThemes).
function themesBody(): string {
  const active = currentTheme();
  return `
    <p class="plat-section-desc">Switch the whole app’s theme — applied instantly and remembered on this device.</p>
    <div class="plat-theme-grid dash-theme-pick" data-theme-pick>
      ${THEMES.map((t) => `
        <button type="button" class="plat-theme dash-theme-opt${t === active ? ' is-active' : ''}" data-theme-set="${escape(t)}" data-theme="${escape(t)}" aria-pressed="${t === active ? 'true' : 'false'}">
          <div class="plat-theme-name">${escape(THEME_LABELS[t])}${t === 'light' ? '<span class="plat-pill">default</span>' : ''}</div>
          <div class="plat-theme-dots">
            <span style="background:hsl(var(--primary))" title="primary"></span>
            <span style="background:hsl(var(--card))" title="card"></span>
            <span style="background:hsl(var(--accent))" title="accent"></span>
            <span style="background:hsl(var(--muted))" title="muted"></span>
            <span style="background:hsl(var(--foreground))" title="foreground"></span>
          </div>
          <div class="plat-theme-sample">Aa</div>
        </button>`).join('')}
    </div>`;
}

// A compact "type facts" strip for the Type-in-motion tile — the fonts IN FORCE,
// resolved from the live --font-brand / --font-mono vars (platform defaults, the
// brand's font tokens, or a user-installed primary — whatever is actually set),
// with each row rendered in its own face. "Manage fonts" points at the profile's
// Brand fonts panel, where fonts are added and the primary is chosen.
function typeFacts(): string {
  const { brand, mono } = activeFaces();
  const rootStyle = getComputedStyle(document.documentElement);
  const rows = [
    { face: brand, role: 'Brand · UI & body', cssVar: '--font-brand' },
    { face: mono, role: 'Mono · code & data', cssVar: '--font-mono' },
  ];
  return `
    <ul class="dash-type-facts">
      ${rows.map(({ face, role, cssVar }) => `
        <li>
          <span class="dash-type-fam" style="font-family:var(${cssVar})">${escape(face.label)}</span>
          <span class="dash-type-meta">${escape(role)} · wght ${face.axis.min}–${face.axis.max}</span>
          <code class="dash-type-src">${escape(`${cssVar}: ${rootStyle.getPropertyValue(cssVar).trim()}`)}</code>
        </li>`).join('')}
      <li class="dash-type-manage"><a href="#/profile">Manage fonts →</a></li>
    </ul>`;
}

function printBody(): string {
  return `
    <p class="plat-section-desc">Press conditions a CMYK PDF can declare in its <code>OutputIntent</code>. Selected per-export via the <code>colorProfile</code> option; raster &amp; on-screen output stays sRGB.</p>
    <table class="plat-table">
      <thead><tr><th>Profile key</th><th>Identifier</th><th>Condition</th></tr></thead>
      <tbody>
        ${Object.entries(CMYK_CONDITIONS).map(([key, c]) => `
          <tr${key === DEFAULT_CMYK_CONDITION ? ' class="is-default"' : ''}>
            <td><code>${escape(key)}</code>${key === DEFAULT_CMYK_CONDITION ? '<span class="plat-pill">default</span>' : ''}</td>
            <td>${escape(c.identifier)}</td>
            <td>${escape(c.info)}</td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}

// ── Storage glance (read-only mirror of the Profile meter) ──────────────────
type DashHost = HostV1 & {
  state: HostV1['state'] & { sizes?: () => Promise<Record<string, number>> };
  assets: HostV1['assets'] & {
    _blobCacheSize?: () => Promise<number>;
    _userAssetsSize?: () => Promise<number>;
  };
  previews?: { size?: () => Promise<number>; list?: () => Promise<Array<{ thumb?: { length?: number } }>> };
};

interface StorageSlice { label: string; bytes: number; key: string; }
interface StorageGlance {
  slices: StorageSlice[];
  other: number;
  total: number;
  usage: number | null;
  quota: number | null;
  sessions: number;
}

async function measureStorage(host: DashHost): Promise<StorageGlance> {
  const estP = navigator.storage?.estimate ? navigator.storage.estimate().catch(() => null) : Promise.resolve(null);
  const [estimate, sessionSizes, sessionList, imagesBytes, cacheBytes, previewBytes] = await Promise.all([
    estP,
    host.state.sizes?.().catch(() => ({} as Record<string, number>)) ?? Promise.resolve({} as Record<string, number>),
    host.state.list().catch(() => [] as Array<unknown>),
    host.assets._userAssetsSize?.().catch(() => 0) ?? Promise.resolve(0),
    host.assets._blobCacheSize?.().catch(() => 0) ?? Promise.resolve(0),
    host.previews?.size?.().catch(() => 0) ?? Promise.resolve(0),
  ]);
  const sessBytes = Object.values(sessionSizes).reduce((s, n) => s + (n || 0), 0);
  const slices: StorageSlice[] = [
    { label: 'Saved sessions', bytes: sessBytes, key: 'sessions' },
    { label: 'My images', bytes: imagesBytes, key: 'images' },
    { label: 'Asset cache', bytes: cacheBytes, key: 'cache' },
    { label: 'Tool previews', bytes: previewBytes, key: 'previews' },
  ].filter((s) => s.bytes > 0);
  const measured = slices.reduce((s, x) => s + x.bytes, 0);
  const hasEstimate = !!(estimate && estimate.usage != null);
  const usage = hasEstimate ? estimate!.usage! : null;
  const quota = (estimate && estimate.quota) || null;
  const overshoot = hasEstimate && measured > usage!;
  const other = hasEstimate && !overshoot ? Math.max(0, usage! - measured) : 0;
  const total = hasEstimate ? Math.max(usage!, measured) : measured;
  return { slices, other, total, usage, quota, sessions: sessionList.length };
}

function fmtPct(usage: number, quota: number | null): string {
  if (!quota) return '';
  const p = (usage / quota) * 100;
  return p < 0.1 ? '<0.1%' : p < 10 ? `${p.toFixed(1)}%` : `${Math.round(p)}%`;
}

// A rounded-cap stroke-ring: the used fraction of the device budget, drawn as an arc so
// even a near-empty disk shows a small nub. Used amount + total sit in the hub.
function storeDonut(usedBytes: number, quotaBytes: number): string {
  const R = 52, C = 2 * Math.PI * R;
  const frac = quotaBytes > 0 ? Math.min(1, usedBytes / quotaBytes) : 0;
  const arc = frac > 0 ? Math.max(frac * C, 4) : 0;   // a visible minimum when anything's used
  const pct = quotaBytes > 0 ? (usedBytes / quotaBytes) * 100 : 0;
  const pctLabel = pct <= 0 ? '0%' : pct < 0.1 ? '<0.1%' : pct < 10 ? `${pct.toFixed(1)}%` : `${Math.round(pct)}%`;
  return `
    <div class="dash-store-donut" role="img" aria-label="${escape(fmtBytes(usedBytes))} used of ${escape(fmtBytes(quotaBytes))} (${pctLabel})">
      <svg viewBox="0 0 120 120" aria-hidden="true">
        <circle class="dash-donut-track" cx="60" cy="60" r="${R}" fill="none" stroke-width="11"></circle>
        <circle class="dash-donut-arc" cx="60" cy="60" r="${R}" fill="none" stroke-width="11" stroke-linecap="round"
          stroke-dasharray="${arc.toFixed(1)} ${(C - arc).toFixed(1)}" transform="rotate(-90 60 60)"></circle>
      </svg>
      <div class="dash-store-donut-c">
        <strong>${escape(fmtBytes(usedBytes))}</strong>
        <span>of ${escape(fmtBytes(quotaBytes))}</span>
        <em>${pctLabel} used</em>
      </div>
    </div>`;
}

function renderStorageGlance(m: StorageGlance): string {
  const segs = [...m.slices];
  if (m.other > 0) segs.push({ label: 'Other app data', bytes: m.other, key: 'other' });
  const denom = m.total || 1;
  const bar = segs.map((s) => `<span class="dash-store-seg dash-store-seg--${s.key}" style="flex:${Math.max(0.5, (s.bytes / denom) * 100)}" title="${escape(s.label)} — ${escape(fmtBytes(s.bytes))}"></span>`).join('');
  const legend = segs.map((s) => `<span class="dash-store-key"><span class="dash-store-dot dash-store-seg--${s.key}"></span>${escape(s.label)}<strong>${escape(fmtBytes(s.bytes))}</strong></span>`).join('');
  // The ring headlines used-vs-budget when the browser reports a quota; otherwise a plain
  // measured line (some browsers withhold an estimate).
  const hero = m.usage != null && m.quota
    ? storeDonut(m.total, m.quota)
    : `<p class="dash-store-headline"><strong>${escape(fmtBytes(m.total))}</strong> measured on this device</p>`;
  return `
    ${hero}
    <div class="dash-store-bar" role="img" aria-label="Storage composition: ${escape(segs.map((s) => `${s.label} ${fmtBytes(s.bytes)}`).join(', '))}">${bar || '<span class="dash-store-seg dash-store-seg--other" style="flex:1"></span>'}</div>
    <div class="dash-store-legend">${legend}</div>
    <p class="dash-store-note">A read-only view — manage or clear it in your <a href="#/profile?focus=storage-section">Profile</a>. Nothing is uploaded.</p>`;
}

// ────────────────────────────────────────────────────────────────────────────

export async function mountDashboard(viewEl: HTMLElement, host: HostV1): Promise<void> {
  document.title = 'Dashboard — Lolly';

  // Deep links: `#/d?print`, `#/d?formats`, … force-open a reference panel or a
  // capability group and scroll to it. Read straight off the hash — no router change.
  const params = new URLSearchParams(window.location.hash.split('?')[1] || '');
  const flags = new Set([...params.keys()]);

  const tools = (window as Window & { __toolIndex?: { tools: CatalogTool[] } }).__toolIndex?.tools ?? [];
  const toolCount = tools.length;
  const metrics = getMetrics();

  const capsHtml = await capabilitiesSection();

  // The active brand's palette (SUSE's measured inks, or whichever catalog is
  // mounted) — not the tokenless PALETTE fallback, so this page always shows
  // the profile that's actually running. See lib/live-palette.ts.
  const palette = await livePalette(host);

  // The whole palette on the wheel, each dot labelled with its canonical scale-token name
  // — jungle-6, pine-2, persimmon-5 — not the display label ("Jungle 6"). The tint ramps
  // (jungle-1..8, pine-1..8, …) are what carry those numbered tokens, so they're plotted
  // too, not just the base colours. The palette aliases some hexes (base Persimmon IS
  // persimmon-5, base Jungle IS jungle-4), so dedup by hex: a same-family scale token
  // supersedes its bare base name (persimmon → persimmon-5), while a cross-family alias
  // keeps its distinct brand name (Mint is #90ebcd, which is also pine-6 — it stays "mint").
  // 'transparent' has no hue to plot, so it's skipped.
  const tokenName = (label: string): string => label.toLowerCase().replace(/\s+/g, '-'); // "Jungle 6" → "jungle-6"
  const familyOf = (name: string): string => name.replace(/-\d+$/, '');                  // "jungle-6" → "jungle"
  const isScaleToken = (name: string): boolean => /-\d+$/.test(name);
  const byHex = new Map<string, { hex: string; label: string }>();
  for (const c of palette) {
    if (isTransparent(c.hex)) continue;
    const key = c.hex.toLowerCase();
    const name = tokenName(c.label);
    const prev = byHex.get(key);
    if (!prev) { byHex.set(key, { hex: c.hex, label: name }); continue; }
    // Base colours list first, so a same-family scale token (persimmon-5) arriving after its
    // bare base (persimmon) upgrades it; a cross-family alias (pine-6 vs mint) does not.
    if (isScaleToken(name) && !isScaleToken(prev.label) && familyOf(name) === prev.label) {
      byHex.set(key, { hex: c.hex, label: name });
    }
  }
  const wheelColors = [...byHex.values()];

  viewEl.innerHTML = `
    <a href="#/" class="tools-home home-full">Tools</a>
    <div class="dash-layout">
      <header class="plat-header dash-header">
        <h1 class="plat-title">Dashboard</h1>
        <div class="plat-header-text">
          <p class="plat-sub">One panel for everything defined once and used everywhere — set your brand here, and glance at this device, your activity and the full feature set.</p>
          <div class="plat-stats">
            <span class="plat-stat" data-tool-count${toolCount ? '' : ' hidden'}><strong>${escape(String(toolCount || ''))}</strong>tools</span>
            <span class="plat-stat"><strong>30</strong>export formats</span>
            <span class="plat-stat"><strong>6</strong>surfaces</span>
            <span class="plat-stat" data-asset-stat hidden><strong data-asset-stat-n></strong>brand assets</span>
          </div>
        </div>
      </header>

      ${brandSection()}

      <div class="dash-bento">
        <section class="plat-section dash-section dash-card dash-sound-theme" id="dash-sound-theme" data-flag="sound audio neurospicy focus volume themes theme">
          ${sectionHead('Sound & focus', 'dash-sound-h', 'Interface sounds and Neurospicy focus loops — set them here; the choice follows you across the app.')}
          <div class="dash-sound-mount" data-sound-mount>${soundSwitchHtml()}</div>
          <div class="dash-dev-split dash-sound-theme-split"><span>Theme</span></div>
          ${themesBody()}
        </section>
        <section class="plat-section dash-section dash-card" id="dash-activity" data-flag="activity">
          ${sectionHead('Your activity', 'dash-activity-h', 'Local-only counters — nothing here is recorded remotely.')}
          <div class="dash-activity">${renderActivity(metrics, tools as Array<{ id: string } & Record<string, unknown>>)}</div>
        </section>
        <section class="plat-section dash-section dash-card" id="dash-storage" data-flag="storage">
          ${sectionHead('Storage', 'dash-storage-h', 'What Lolly is keeping on this device.')}
          <div class="dash-store" data-store><p class="cat-empty">measuring…</p></div>
        </section>
        <section class="plat-section dash-section dash-card dash-recent" id="dash-recent" data-flag="recent creations" hidden>
          ${sectionHead('Recent creations', 'dash-recent-h', 'Your latest saved sessions — swipe the stack to browse, tap the top card to reopen.')}
          <div class="dash-recent-mount" data-recent-stack></div>
        </section>
        <section class="plat-section dash-section dash-card dash-recent" id="dash-exports" data-flag="exports downloads latest" hidden>
          ${sectionHead('Latest exports', 'dash-exports-h', 'Files you downloaded — swipe through and tap one to reopen it exactly as it was.')}
          <div class="dash-recent-mount" data-exports-stack></div>
        </section>
        <section class="plat-section dash-section dash-card" id="dash-palette-wheel" data-flag="color colour colours palette wheel">
          ${sectionHead('Palette on the wheel', 'dash-wheel-h', 'Every brand colour plotted by hue and lightness — shade ramps fan out dark-centre to bright-rim. Hover a dot to read it.')}
          ${renderPaletteWheel(wheelColors)}
        </section>
        <section class="plat-section dash-section dash-card dash-typedemo" id="dash-typedemo" data-flag="type typography font motion kinetic">
          ${sectionHead('Type in motion', 'dash-typedemo-h', 'The faces in force — your brand and mono fonts, live. The axes themselves are the animation.')}
          ${renderTypeDemo()}
          ${typeFacts()}
        </section>
      </div>

      ${collapse({
        id: 'dash-device',
        flag: 'device',
        title: 'This device',
        cls: 'dash-device',
        desc: 'A live snapshot of the browser and machine this session runs on. Read on the fly; nothing is stored or sent anywhere.',
        body: `
          <div class="dash-dev-hero" data-dev-hero>
            ${Array.from({ length: 6 }, () => `<div class="dash-dev-stat is-skeleton"></div>`).join('')}
          </div>
          <div class="dash-dev-split"><span>Full readout</span></div>
          <div class="plat-client-grid dash-dev-cards" data-client-grid></div>`,
      })}

      <div class="dash-row dash-row--2">
        ${paletteSection(palette)}
        ${collapse({
          id: 'dash-catalogue',
          flag: 'catalog catalogue',
          title: 'Catalogue',
          desc: 'What ships in this build, synced to clients as data.',
          body: catalogSummaryBody(tools),
          half: true,
        })}
      </div>

      ${capsHtml}

      <div class="dash-ref-grid">
        ${refPanel('print cmyk', false, 'dash-print', 'Print & CMYK', printBody())}
      </div>

      <p class="plat-note dash-foot" role="note">
        <strong>Your brand is live</strong> — colour, palette and fonts above write straight to this device and every tool, page and export follows. The rest of this page is a record of what the platform and this session currently know; your activity and storage are mirrored from your <a href="#/profile">Profile</a>, where you can manage them.
      </p>
    </div>`;

  // Include the read-only foot note in the reveal ladder so it settles with the
  // last section instead of snapping in at full opacity beneath the cascade.
  armViewEnter(viewEl, '.tools-home, .plat-header, .plat-section, .dash-foot');

  // Your brand: a status line (an IDB read via host.assets discovery) plus the
  // live editor, both hydrated just after first paint rather than blocking it.
  // The editor owns colour / palette / fonts / share and persists straight to
  // `user/tokens/brand`; a locked build makes it render its own read-only note.
  void (async () => {
    const statusEl = viewEl.querySelector<HTMLElement>('#dash-brand-status');
    let metaId = '';
    try {
      metaId = (await (host.assets as unknown as {
        _findMetaByType?(t: string): Promise<{ id: string } | null>;
      })._findMetaByType?.('tokens'))?.id ?? '';
    } catch { /* discovery unavailable — show the unbranded pathway */ }
    const locked = await (host.tokens as { isLocked?(): Promise<boolean> } | undefined)?.isLocked?.().catch(() => false) ?? false;
    if (statusEl && viewEl.contains(statusEl)) {
      statusEl.innerHTML = locked
        ? 'This build ships with a fixed brand — every tool, page and export already wears it.'
        : metaId === USER_TOKENS_ID
          ? 'Your brand is installed — every tool, page and export wears it. Adjust it below.'
          : metaId
            ? 'Running the catalogue’s built-in brand. Make it yours below — pick a colour and Lolly derives the rest. It stays on this device.'
            : 'This install is unbranded. Pick one colour and Lolly derives the ramps, themes and every semantic slot — <strong>make it yours</strong>.';
    }

    // Mount the editor. It is the one interactive thing on this page that writes,
    // so its teardown (debounced save timer + document listeners) is chained onto
    // the view's _cleanup. Guarded: a route change mid-await must not mount into
    // a detached node.
    const mount = viewEl.querySelector<HTMLElement>('[data-brand-editor-mount]');
    if (!mount || !viewEl.contains(mount)) return;
    try {
      const { mountBrandEditor, BRAND_DRAFT_EVENT } = await import('../lib/brand-editor.ts');
      if (!viewEl.contains(mount)) return;
      const editor = await mountBrandEditor(mount, host);
      if (!viewEl.contains(mount)) { editor.teardown(); return; }
      // Best-effort: track the editor's live Colour-panel draft in the
      // "Colour palette" ink bar below, even before it's saved.
      const stopPaletteSync = wireLivePaletteDraft(viewEl, BRAND_DRAFT_EVENT);
      const prev = (viewEl as HTMLElement & { _cleanup?: () => void })._cleanup;
      (viewEl as HTMLElement & { _cleanup?: () => void })._cleanup = () => { prev?.(); editor.teardown(); stopPaletteSync(); };
    } catch (err) {
      console.error('Brand editor failed to mount:', err);
      mount.innerHTML = '<p class="cat-empty">The brand editor is unavailable right now.</p>';
    }
  })();

  // Fold cue: a soft hydraulic open/close whenever a primary section (device,
  // palette, catalogue, capabilities) is collapsed or revealed. Capture phase —
  // the <details> `toggle` event does not bubble, so a bubble-phase delegated
  // listener never sees it. Respects the global mute (playSfx no-ops when muted).
  viewEl.addEventListener('toggle', (e) => {
    const d = e.target;
    if (d instanceof HTMLDetailsElement && d.hasAttribute('data-dash-collapse')) {
      playSfx(d.open ? 'hydraulicOpen' : 'hydraulicClose');
    }
  }, true);

  // Deep-link: open + scroll to any panel/group whose flag is in the hash query.
  if (flags.size) applyDeepLink(viewEl, flags);

  // Copy-to-clipboard for ink bars AND the full-values swatch chips.
  wireCopyButtons(viewEl);

  // Palette readout: hover/focus an ink bar → update the mono instrument line.
  wireReadout(viewEl);
  // Signature pieces: the palette wheel's hub readout + the variable-type motion.
  wirePaletteWheel(viewEl);
  // wireTypeDemo returns a teardown (stops its rAF sweep + IntersectionObserver); chain it
  // onto the view's _cleanup so the sweep can't outlive the dashboard after a route change.
  const stopTypeDemo = wireTypeDemo(viewEl);
  {
    const prev = (viewEl as HTMLElement & { _cleanup?: () => void })._cleanup;
    (viewEl as HTMLElement & { _cleanup?: () => void })._cleanup = () => { prev?.(); stopTypeDemo(); };
  }

  // The Sound & focus box drives the real sfx + Neurospicy state (self-contained control).
  wireSoundSwitch(viewEl, host as unknown as Parameters<typeof wireSoundSwitch>[1]);
  // The Theme box applies + persists the app theme live.
  wireThemes(viewEl, host);

  // Capability cards POP their detail into a shared dialog (no inline reflow). Each card
  // clones its sibling <template>; the native <dialog> gives Esc-to-close + backdrop.
  const capModal = viewEl.querySelector<HTMLDialogElement>('[data-cap-modal]');
  if (capModal) {
    const mIcon = capModal.querySelector<HTMLElement>('[data-cap-modal-icon]')!;
    const mTitle = capModal.querySelector<HTMLElement>('[data-cap-modal-title]')!;
    const mBody = capModal.querySelector<HTMLElement>('[data-cap-modal-body]')!;
    const close = () => { if (typeof capModal.close === 'function') capModal.close(); else capModal.removeAttribute('open'); };
    viewEl.querySelectorAll<HTMLButtonElement>('[data-cap-open]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tpl = btn.closest('.dash-cap-item')?.querySelector<HTMLTemplateElement>('template.dash-cap-detail');
        if (!tpl) return;
        mIcon.innerHTML = btn.querySelector('.dash-cap-icon')?.innerHTML ?? '';
        mTitle.textContent = btn.querySelector('.dash-cap-title')?.textContent ?? '';
        mBody.replaceChildren(tpl.content.cloneNode(true));
        if (typeof capModal.showModal === 'function') capModal.showModal(); else capModal.setAttribute('open', '');
      });
    });
    capModal.querySelector('[data-cap-modal-close]')?.addEventListener('click', close);
    capModal.addEventListener('click', (e) => { if (e.target === capModal) close(); }); // backdrop click
  }

  // Build-up: the capability cards start hidden and float in, staggered, when their grid
  // scrolls into view. Opt-in via [data-build] so that WITHOUT this JS (or under
  // reduced-motion) the cards are simply visible — never a blank grid.
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (!reduceMotion && 'IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries, obs) => {
      for (const ent of entries) {
        if (!ent.isIntersecting) continue;
        ent.target.classList.add('is-in');
        obs.unobserve(ent.target);
      }
    }, { threshold: 0.12 });
    viewEl.querySelectorAll<HTMLElement>('.dash-cap-grid').forEach((grid) => {
      grid.dataset.build = '';
      grid.querySelectorAll<HTMLElement>('.dash-cap-item').forEach((item, i) => { item.style.setProperty('--i', String(i)); });
      io.observe(grid);
    });
    // Disconnect on unmount so a superseded dashboard's observer doesn't linger.
    // Composes with wireLive's later _cleanup chain (captures the current hook as prev).
    const prev = (viewEl as HTMLElement & { _cleanup?: () => void })._cleanup;
    (viewEl as HTMLElement & { _cleanup?: () => void })._cleanup = () => { prev?.(); io.disconnect(); };
  }

  // ── Deferred hydration ────────────────────────────────────────────────────
  // Fill the pieces kept off the first-paint path (device probe + a network
  // round-trip for assets + storage measurers). Guarded by a per-mount token so a
  // stale fill from a superseded same-view remount can't wire onto the current one.
  const mountEl = viewEl as HTMLElement & { _dashMount?: number };
  const myMount = (mountEl._dashMount = (mountEl._dashMount || 0) + 1);
  const isCurrent = <T extends Element>(node: T | null): node is T =>
    mountEl._dashMount === myMount && !!node && viewEl.contains(node);

  // Recent creations — reuse the session preview thumbnails the Projects/gallery tiles
  // already cache (host.state.list().thumb); no re-render. Tool sessions only (they
  // reopen cleanly via ?slot=), newest first, into the interactive swipe stack.
  (host.state.list() as Promise<Array<{ slot: string; toolId?: string; label?: string; thumb?: string | null; updatedAt?: string }>>)
    .then((rows) => {
      const recent = rows
        .filter((r) => r.thumb && r.toolId)
        .sort((a, b) => +new Date(b.updatedAt || 0) - +new Date(a.updatedAt || 0))
        .slice(0, 12)
        .map((r) => ({ thumb: r.thumb!, label: r.label || r.toolId!, href: `#/tool/${r.toolId}?slot=${encodeURIComponent(r.slot)}` }));
      const sec = viewEl.querySelector<HTMLElement>('#dash-recent');
      const stackMount = viewEl.querySelector<HTMLElement>('[data-recent-stack]');
      if (isCurrent(stackMount) && sec && recent.length >= 2) {
        createRecentStack(stackMount, recent);
        sec.hidden = false;
      }
    })
    .catch(() => { /* no recent sessions — the section stays hidden */ });

  // Latest exports — the downloads log (export-history.ts), newest first, into its own
  // swipe stack. Distinct from Recent creations: these are files you downloaded, not
  // sessions you saved.
  import('../lib/export-history.ts')
    .then(({ listExports }) => listExports(12))
    .then((exports) => {
      const items = exports
        .filter((e) => e.thumb)
        .map((e) => ({ thumb: e.thumb!, label: e.filename || e.label, href: `#/tool/${e.toolId}${e.query ? '?' + e.query : ''}` }));
      const sec = viewEl.querySelector<HTMLElement>('#dash-exports');
      const stackMount = viewEl.querySelector<HTMLElement>('[data-exports-stack]');
      if (isCurrent(stackMount) && sec && items.length) {
        createRecentStack(stackMount, items);
        sec.hidden = false;
      }
    })
    .catch(() => { /* no exports yet — the section stays hidden */ });

  collectDevice()
    .then((snap) => {
      const hero = viewEl.querySelector<HTMLElement>('[data-dev-hero]');
      const grid = viewEl.querySelector<HTMLElement>('[data-client-grid]');
      if (isCurrent(hero)) {
        hero.innerHTML = snap.headline.map(renderDeviceStat).join('');
        hero.classList.add('plat-hydrated');
      }
      if (isCurrent(grid)) {
        grid.innerHTML = renderDeviceCards(snap.groups);
        grid.classList.add('plat-hydrated');
      }
      // Only wire the live rows if THIS mount is still the current one — a
      // superseded same-view remount whose probe resolves late must not attach a
      // second listener set (and re-chain _cleanup) onto the live mount's nodes.
      if (mountEl._dashMount === myMount) wireLive(viewEl); // [data-live] rows now exist
    })
    .catch(() => { /* device snapshot is best-effort */ });

  measureStorage(host as DashHost)
    .then((m) => {
      const box = viewEl.querySelector<HTMLElement>('[data-store]');
      if (!isCurrent(box)) return;
      box.innerHTML = renderStorageGlance(m);
      box.classList.add('plat-hydrated');
    })
    .catch(() => {
      const box = viewEl.querySelector<HTMLElement>('[data-store]');
      if (isCurrent(box)) box.innerHTML = '<p class="cat-empty">unavailable</p>';
    });

  if (mountEl._dashMount === myMount) {
    hydrateCatalogAssets(viewEl).then(() => {
      // Surface the asset total in the header stat strip too.
      const n = viewEl.querySelector<HTMLElement>('[data-asset-count]')?.textContent;
      const stat = viewEl.querySelector<HTMLElement>('[data-asset-stat]');
      const nEl = viewEl.querySelector<HTMLElement>('[data-asset-stat-n]');
      if (n && stat && nEl && viewEl.contains(stat)) {
        nEl.textContent = n;
        stat.hidden = false;
      }
    });
  }
}

// Open + scroll to a deep-linked panel/group. Reference panels AND capability
// groups are <details> now, so force the match open — plus every ancestor <details>
// (a capability group lives inside the outer "What Lolly can do" panel), or the
// linked content would be folded away and the scroll would land on nothing.
function applyDeepLink(viewEl: HTMLElement, flags: Set<string>): void {
  let target: HTMLElement | null = null;
  viewEl.querySelectorAll<HTMLElement>('[data-flag]').forEach((el) => {
    const owns = (el.dataset.flag || '').split(/\s+/).some((f) => flags.has(f));
    if (!owns) return;
    target ||= el;
    if (el.tagName === 'DETAILS') (el as HTMLDetailsElement).open = true;
    for (let anc = el.parentElement?.closest('details') as HTMLDetailsElement | null; anc; anc = anc.parentElement?.closest('details') as HTMLDetailsElement | null) {
      anc.open = true;
    }
  });
  if (target) {
    // Sections above the target (palette wheel, catalogue summary) mount async and keep
    // growing the page for up to ~1.5s after this runs, shoving the target down — a
    // one-shot scroll lands on its pre-expansion spot. Re-land on a short repeating
    // beat while the layout settles so the deep-linked group reliably ends up in view.
    // Each re-land just re-aims at the target (idempotent once it's already at the top).
    const land = (): void => { target!.scrollIntoView({ block: 'start', behavior: 'auto' }); };
    requestAnimationFrame(land);
    let n = 0;
    const again = (): void => { land(); if (++n < 12) setTimeout(again, 130); };
    setTimeout(again, 130);
  }
}

// Palette readout instrument — one shared mono line driven by whichever ink bar
// is hovered or focused. Delegated so it survives nothing (static markup) and
// costs one listener pair.
function wireReadout(viewEl: HTMLElement): void {
  const ribbon = viewEl.querySelector<HTMLElement>('[data-ribbon]');
  const readout = viewEl.querySelector<HTMLElement>('[data-readout]');
  if (!ribbon || !readout) return;
  const sw = readout.querySelector<HTMLElement>('[data-ro-swatch]');
  const name = readout.querySelector<HTMLElement>('[data-ro-name]');
  const hex = readout.querySelector<HTMLElement>('[data-ro-hex]');
  const cmyk = readout.querySelector<HTMLElement>('[data-ro-cmyk]');
  const show = (el: Element | null) => {
    const btn = (el as Element | null)?.closest<HTMLElement>('.dash-ink');
    if (!btn) return;
    const trans = btn.classList.contains('is-transparent');
    if (sw) {
      sw.style.background = trans ? '' : btn.style.getPropertyValue('--ink');
      sw.classList.toggle('is-transparent', trans);
    }
    if (name) name.textContent = btn.dataset.name || '';
    if (hex) hex.textContent = btn.dataset.hex || '';
    if (cmyk) {
      cmyk.textContent = btn.dataset.cmyk || '';
      cmyk.classList.toggle('is-measured', btn.dataset.measured === '1');
    }
    readout.classList.add('is-active');
  };
  ribbon.addEventListener('pointerover', (e) => show(e.target as Element));
  ribbon.addEventListener('focusin', (e) => show(e.target as Element));
}

// Theme picker — each preview button applies the theme app-wide immediately (applyTheme
// mirrors to localStorage + updates the PWA chrome colour) and persists it to the profile
// (canonical). The active preview is flagged; a soft theme cue plays on switch.
function wireThemes(viewEl: HTMLElement, host: HostV1): void {
  const pick = viewEl.querySelector<HTMLElement>('[data-theme-pick]');
  if (!pick) return;
  pick.querySelectorAll<HTMLButtonElement>('[data-theme-set]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const next = btn.dataset.themeSet;
      if (!next || next === currentTheme()) return;
      applyTheme(next);
      playThemeSfx(next);
      // Reflect the new active state across the picker.
      pick.querySelectorAll<HTMLButtonElement>('[data-theme-set]').forEach((b) => {
        const on = b.dataset.themeSet === next;
        b.classList.toggle('is-active', on);
        b.setAttribute('aria-pressed', String(on));
      });
      try {
        // `set` is a web-shell extension (WebProfileAPI), not on the engine's read-only
        // ProfileAPI — reach it via a narrow cast, and feature-detect for other shells.
        const profileApi = host.profile as (typeof host.profile) & { set?: (p: unknown) => Promise<void> };
        const profile = await host.profile.get();
        await profileApi.set?.({ ...profile, theme: next });
      } catch { /* preference save is best-effort */ }
    });
  });
}

// Keep the live device rows (viewport, orientation) current while mounted. The
// device panel is never collapsed here, so listeners run for the view's life and
// are torn down via viewEl._cleanup. rAF-coalesced so a resize drag updates once
// per frame.
function wireLive(viewEl: HTMLElement): void {
  const liveEls = [...viewEl.querySelectorAll<HTMLElement>('[data-live]')];
  if (!liveEls.length) return;
  let raf = 0;
  const refresh = () => {
    raf = 0;
    for (const el of liveEls) el.textContent = liveValue(el.dataset.live!);
  };
  const schedule = () => { if (!raf) raf = requestAnimationFrame(refresh); };
  const orientation = screen.orientation;
  window.addEventListener('resize', schedule);
  orientation?.addEventListener?.('change', schedule);
  const prev = (viewEl as HTMLElement & { _cleanup?: () => void })._cleanup;
  (viewEl as HTMLElement & { _cleanup?: () => void })._cleanup = () => {
    prev?.();
    cancelAnimationFrame(raf);
    window.removeEventListener('resize', schedule);
    orientation?.removeEventListener?.('change', schedule);
  };
}
