// SPDX-License-Identifier: MPL-2.0
/**
 * The browsable component library (#/components).
 *
 * A dev/design surface, off every hot path (lazy-loaded). It renders the shell's
 * components — a "Primitives" section for the shared layer a multi-wave refactor
 * shipped (buttons.css, chips.css, lib/seg.ts, lib/icons.ts, mountModal,
 * mountZoomHud, mountViewTopbar, swatchTile, setTheme, wireTabs, sessionRow,
 * mountBodyPopover, .section-card, .note/.field-input), then the remaining
 * common-primitive families, then per-view — from the specimen data in
 * components-data.ts (originally generated from the component-audit workflow;
 * hand-maintained since the refactor landed; the written analysis + per-rec
 * shipped status is plans/component-audit.md). Each specimen is shown live where
 * the component is a pure render function, as a static markup sample where it's
 * only CSS, and as a labelled source snippet where it needs the host bridge to run.
 *
 * The page has one nav affordance: a back control that returns you where you came
 * from IF you arrived from inside Lolly (cameFromApp → history.back()), else drops
 * you at the gallery. Nothing here mutates app or brand state.
 *
 * Specimens are styled by the real part sheets, imported below so each looks
 * exactly as it does in situ.
 */

import '../styles/parts/components-lib.css';
// The specimens borrow the app's own stylesheets. The globally-@imported parts
// (components, gallery, topbar, catalog, dialogs, featured, folders, projects,
// saved-list — see styles/app.css) are already present; these view-local sheets
// are not on the landing bundle, so pull them in for the samples that need them.
import '../styles/parts/platform.css';
import '../styles/parts/dashboard.css';
import '../styles/parts/brand-studio.css';
import '../styles/parts/tool.css';
import '../styles/parts/tool-chrome.css';
import '../styles/parts/storage.css';
import '../styles/parts/profile.css';
import '../styles/parts/start.css';
import '../styles/parts/multi-edit.css';
import '../styles/parts/valid.css';
import '../styles/parts/editor.css'; // .stage-nav (the tool canvas's zoom HUD) — for the Zoom HUD live specimen

import { t } from '../i18n.ts';
import { escape } from '../utils.ts';
import { armViewEnter } from '../view-enter.ts';
import type { HostV1 } from '../../../../engine/src/bridge/host-v1.ts';
import { AUDIT_SECTIONS, type Specimen } from './components-data.ts';

import { colorFieldHtml, wireColorField } from '../components/color-field.ts';
import { renderPaletteWheel, wirePaletteWheel } from '../lib/palette-wheel.ts';
import { renderBrandSeal, sealColors } from '../lib/brand-seal.ts';
import { swatch, swatchTile } from '../lib/swatches.ts';
import { genAiPill } from '../lib/genai-pill.ts';
import { lollyBadge } from '../lib/lolly-badge.ts';
import { viewToggle } from '../components/view-toggle.ts';
import { themeSegmentHtml } from '../components/theme-toggle.ts';
import { soundSwitchHtml } from '../components/sound-toggle.ts';
import { helpTip } from '../components/help-tip.ts';
import { footerNav, gallerySearchBox } from '../components/footer-nav.ts';
import { confirmDialog, choiceDialog, noticeDialog, promptDialog } from '../components/confirm-dialog.ts';
import { openShareDialog } from '../components/share-dialog.ts';
import { palettePreviewSvgs } from '../lib/palette-preview.ts';
import { categoryGlyph } from '../lib/category-icons.ts';
import { catalogSummaryBody } from '../lib/catalog-summary.ts';
import { fmtBadge, dimBadge, rowCountBadge, sessionRow, type SessionEntry } from '../folder-tiles.ts';
import { controlHtml } from '../pro/controls.ts';
import { stepsHtml, inputsDigestHtml } from './valid.ts';
import type { PaletteEntry } from '../palette.ts';
import { segHtml } from '../lib/seg.ts';
import { icon, iconNames } from '../lib/icons.ts';
import { mountZoomHud } from '../components/zoom-hud.ts';
import { viewTopbarHtml } from '../components/view-topbar.ts';
import { mountBodyPopover, type BodyPopoverHandle } from '../components/body-popover.ts';

// A demo palette for the colour specimens (not the live brand).
const DEMO: PaletteEntry[] = [
  { hex: '#30ba78', label: 'Jungle', cmyk: [74, 0, 60, 0], group: 'Brand' },
  { hex: '#0c322c', label: 'Pine', cmyk: [80, 30, 55, 60], group: 'Brand' },
  { hex: '#2453ff', label: 'Klein', cmyk: [86, 68, 0, 0], group: 'Spectrum' },
  { hex: '#fe7c3f', label: 'Persimmon', cmyk: [0, 60, 78, 0], group: 'Spectrum' },
  { hex: '#efefef', label: 'Mist', cmyk: [0, 0, 0, 6], group: 'Neutral' },
  { hex: '#1b1b1b', label: 'Ink', cmyk: [0, 0, 0, 92], group: 'Neutral' },
];

// A live-openable dialog trigger — the honest sample for an imperative component.
function triggerButton(label: string, onClick: () => void): HTMLElement {
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'be-cta'; b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

/** The live renderers, keyed by the `live` tag in components-data.ts. Each returns
 *  an HTML string or a node; a `wire` runs after it's inserted. Only pure/wired
 *  components with a safe render path are here — everything else falls back to a
 *  markup sample or a source snippet. */
const LIVE: Record<string, { render: () => string | HTMLElement; wire?: (stage: HTMLElement) => void }> = {
  colorField: { render: () => colorFieldHtml('cl-color', '#30ba78', { inline: true, modes: true }), wire: (s) => wireColorField(s) },
  wheel: { render: () => `<div style="width:320px;max-width:100%">${renderPaletteWheel(DEMO.map(p => ({ hex: p.hex, label: p.label })))}</div>`, wire: (s) => wirePaletteWheel(s) },
  seal: { render: () => renderBrandSeal(sealColors(DEMO), 128) },
  swatchCard: { render: () => `<div style="display:grid;grid-template-columns:1fr 1fr;gap:.6rem;width:100%">${swatch(DEMO[0]!)}${swatch({ ...DEMO[1]!, spot: { name: 'PANTONE 5535 C' } })}</div>` },
  palettePreview: { render: () => `<div style="width:340px;max-width:100%">${palettePreviewSvgs(['#2453ff', '#30ba78', '#fe7c3f', '#e11d48'])[0]?.svg ?? ''}</div>` },
  genai: { render: () => `${genAiPill('full')} ${genAiPill('partial')} ${genAiPill('full', true)}` },
  lollyBadge: { render: () => `${lollyBadge('sm')} ${lollyBadge('lg')}` },
  viewToggle: { render: () => viewToggle('tools') },
  themeSeg: { render: () => themeSegmentHtml() },
  soundSwitch: { render: () => soundSwitchHtml() },
  footerNav: { render: () => footerNav({ proEnabled: false, searchHtml: gallerySearchBox({ placeholder: t('Search'), ariaLabel: t('Search') }) }) },
  catGlyph: { render: () => `<span style="display:inline-flex;gap:.7rem;align-items:center">${['logos', 'photos', 'swatches', 'fonts'].map(categoryGlyph).join('')}</span>` },
  catSummary: { render: () => catalogSummaryBody([
    { id: 'qr-code', category: 'utility', status: 'official' },
    { id: 'brand-lockup', category: 'designer', status: 'experimental' },
    { id: 'street-map', category: 'utility', status: 'official' },
  ] as never) },
  tileBadges: { render: () => `<span class="tile-badges">${fmtBadge('svg')}${dimBadge(512, 512, 'px')}${rowCountBadge(8)}</span>` },
  dialogTriggers: {
    render: () => {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'display:flex;gap:.5rem;flex-wrap:wrap';
      wrap.append(
        triggerButton(t('Confirm…'), () => { void confirmDialog({ title: t('Delete swatch?'), message: t('This can’t be undone.'), confirmLabel: t('Delete') }); }),
        triggerButton(t('Choose…'), () => { void choiceDialog({ title: t('Export as'), message: t('Pick a format'), choices: [{ id: 'png', label: 'PNG' }, { id: 'svg', label: 'SVG' }] as never }); }),
        triggerButton(t('Notice…'), () => { void noticeDialog({ title: t('Heads up'), message: t('A sample notice.') }); }),
        triggerButton(t('Prompt…'), () => { void promptDialog({ title: t('Name this'), message: t('Give it a name'), placeholder: t('e.g. Jungle') }); }),
      );
      return wrap;
    },
  },
  shareTrigger: { render: () => triggerButton(t('Share…'), () => { openShareDialog({ toolId: 'qr-code', baseParts: ['url=https%3A%2F%2Fsuse.com'], currentFormat: 'png', title: t('Share this tool') }); }) },
  helpTip: {
    render: () => { const h = helpTip(t('Chroma is how vivid a colour is — grey at the centre, vivid at the rim.'), { href: '#/components', text: t('Learn more') }); return `<span class="help-tip-host" style="display:inline-flex;align-items:center;gap:.4rem">${t('Chroma')} ${h.button}${h.pop}</span>`; },
  },
  proControl: { render: () => `<div style="display:flex;gap:.6rem;flex-wrap:wrap;align-items:center">${controlHtml({ type: 'select', options: [{ value: 'a', label: 'Option A' }, { value: 'b', label: 'Option B' }] } as never, 'a' as never, '')}${controlHtml({ type: 'number' } as never, 42 as never, '')}</div>` },
  validSteps: { render: () => stepsHtml({ history: [
    { action: 'c2pa.created', when: '2026-07-01T09:00:00Z', softwareAgent: 'Lolly', digitalSourceType: 'http://cv.iptc.org/newscodes/digitalsourcetype/digitalCreation' },
    { action: 'c2pa.color_adjustments', when: '2026-07-02T11:00:00Z', softwareAgent: 'Adobe Photoshop' },
  ] } as never) },
  validInputs: { render: () => inputsDigestHtml({ Background: '#1a1a2e', Headline: 'Ship it', Size: '1080×1080' }) },

  // ── Primitives-section live renderers (component audit recs 1/5/6/8/11/12) ──
  seg: { render: () => segHtml('cl-stored', [{ id: 'lch', label: 'LCH' }, { id: 'hex', label: 'Hex' }, { id: 'rgb', label: 'RGB' }], 'hex', t('Stored as')) },
  icons: {
    render: () => `<div class="cl-icon-grid">${iconNames.map(name => `<div class="cl-icon-cell">${icon(name, { size: 20 })}<span>${escape(name)}</span></div>`).join('')}</div>`,
  },
  zoomHud: {
    render: () => {
      const wrap = document.createElement('div');
      wrap.className = 'cl-zoomhud-demo';
      const hudEl = document.createElement('div');
      hudEl.className = 'stage-nav';
      wrap.appendChild(hudEl);
      let pct = 100;
      const hud = mountZoomHud(hudEl, {
        ariaLabel: t('Zoom'),
        classes: { btn: 'stage-nav-btn', pct: 'stage-nav-pct', fit: 'stage-nav-fit' },
        onZoom: (dir) => { pct = Math.max(25, Math.min(400, pct + dir * 25)); hud.setReadout(`${pct}%`); hud.setValue(pct); },
        onFit: () => { pct = 100; hud.setReadout(t('Fit')); hud.setValue(pct); },
        initialReadout: '100%',
        min: 25, max: 400,
      });
      return wrap;
    },
  },
  sessionRow: {
    render: () => {
      const entry: SessionEntry = { slot: 'qr-code:171', toolId: 'qr-code', label: t('Launch QR'), thumb: null, updatedAt: '2026-07-09T10:00:00Z' };
      const galleryRow = sessionRow(entry, {
        rowClass: 'saved-row', thumbClass: 'saved-thumb', metaClass: 'saved-label',
        titleTag: 'h4', title: entry.label ?? '', subtitle: t('3 Jul 14:20'),
        openClass: 'saved-resume', openAttrs: 'data-cl-noop', openLabel: t('Resume'),
        deleteAttr: 'data-cl-noop', deleteClass: 'saved-delete', deleteLabel: t('Delete'),
      });
      const profileRow = sessionRow(entry, {
        rowClass: 'store-sess', thumbClass: 'store-sess-thumb', metaClass: 'store-sess-meta', titleClass: 'store-sess-label',
        title: entry.label ?? '', subtitle: t('QR Code · 2d ago'),
        selectClass: 'store-sess-check', selectLabel: t('Select'),
        sizeBytes: 20480,
        deleteAttr: 'data-cl-noop', deleteClass: 'store-sess-del', deleteLabel: t('Delete'),
      });
      return `<ul class="saved-list" style="width:100%;max-width:340px;list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:.5rem">${galleryRow}${profileRow}</ul>`;
    },
  },
  viewTopbar: { render: () => viewTopbarHtml({ active: 'tools', profile: { firstname: 'Alex' } }) },
  swatchTile: {
    render: () => `<div style="display:flex;gap:1.2rem;flex-wrap:wrap;align-items:center">
      <div style="display:flex;gap:.4rem">${DEMO.slice(0, 4).map((p, i) => swatchTile({ label: p.label, hex: p.hex, locked: i === 1 }, { idx: i })).join('')}</div>
      <div style="display:flex;gap:.3rem">${DEMO.slice(0, 4).map((p, i) => swatchTile({ label: p.label, hex: p.hex }, { size: 'sm', idx: i })).join('')}</div>
    </div>`,
  },
  bodyPopover: {
    render: () => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'be-cta'; b.textContent = t('Open menu…');
      let popover: BodyPopoverHandle | null = null;
      b.addEventListener('click', () => {
        popover ??= mountBodyPopover(b, (el) => {
          el.innerHTML = [t('Recolour'), t('Duplicate'), t('Delete')]
            .map(label => `<button type="button" class="cl-popover-demo-item">${escape(label)}</button>`).join('');
          return el.querySelector<HTMLElement>('.cl-popover-demo-item');
        }, { className: 'cl-popover-demo', ariaLabel: t('Demo menu') });
        popover.isOpen() ? popover.close() : popover.open();
      });
      return b;
    },
  },
};

// How a specimen is actually shown — not its nature, but what the card displays,
// so the tag never says "live" over a source snippet. Live = rendered by a LIVE
// renderer; sample = static markup; source = a host-bound call shown as code.
type Mode = 'live' | 'sample' | 'source';
function renderMode(s: Specimen): Mode {
  if (s.live && LIVE[s.live]) return 'live';
  if (s.markup) return 'sample';
  return 'source';
}
const MODE_LABEL: Record<Mode, string> = { live: 'live', sample: 'sample', source: 'source' };

// Most live specimens sit on a plain muted field; a few (translucency checks,
// a frosted/backdrop-blur pill) want the checkerboard so what they're actually
// doing over the surface beneath them is visible.
const CHECKERED_LIVE = new Set(['genai', 'lollyBadge', 'tileBadges', 'zoomHud']);

function specimenShell(s: Specimen, idx: number): string {
  const mode = renderMode(s);
  // Colour tools + wide media get more room; everything else fits the auto grid.
  const wide = s.live === 'colorField' || s.live === 'footerNav' || s.live === 'icons' || s.live === 'viewTopbar' || s.live === 'sessionRow';
  const tall = s.live === 'colorField' || s.live === 'wheel' || s.live === 'icons';
  const plain = mode === 'source' || (!!s.live && !CHECKERED_LIVE.has(s.live));
  const cls = ['cl-card', wide ? 'cl-card--wide' : '', tall ? 'cl-card--tall' : ''].filter(Boolean).join(' ');
  const stageCls = ['cl-stage', plain ? 'cl-stage--plain' : ''].filter(Boolean).join(' ');
  const eg = s.eg?.length ? `<div class="cl-eg">${s.eg.map(e => `<span>${escape(e)}</span>`).join('')}</div>` : '';
  const kindTag = `<span class="cl-kind cl-kind--${mode === 'sample' ? 'css' : mode === 'source' ? 'host' : 'live'}">${escape(MODE_LABEL[mode])}</span>`;
  return `<div class="${cls}">
    <div class="${stageCls}" data-cl-stage="${idx}"></div>
    <div class="cl-meta">
      <div class="cl-name">${escape(s.name)} ${kindTag}</div>
      ${s.description ? `<p class="cl-desc">${escape(s.description)}</p>` : ''}
      ${s.defined ? `<p class="cl-src">${escape(s.defined)}</p>` : ''}
      ${eg}
    </div>
  </div>`;
}

const sectionId = (title: string): string => 'cl-' + title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// A `<dialog>` renders in the browser's top layer, which escapes the stage's
// `contain` — a markup sample with a bare <dialog> would cover the whole page.
// Reduce it to an in-flow element (its own classes still style the chrome) so it
// previews as a contained card. Overlays that merely use `position: fixed` are
// already trapped by the stage's containment and need no help.
function neutralizeMarkup(html: string): string {
  return html.replace(/<dialog\b/gi, '<div data-cl-dialog').replace(/<\/dialog>/gi, '</div>');
}

export async function mountComponents(viewEl: HTMLElement, _host: HostV1, cameFromApp: boolean): Promise<void> {
  document.title = 'Components — Lolly';
  viewEl.classList.add('cl-view', 'components-view');

  // A flat, ordered list of every specimen with the section it belongs to — so the
  // stage-fill loop can address each by index without re-walking the tree.
  const flat: Specimen[] = AUDIT_SECTIONS.flatMap(sec => sec.items);
  let n = 0;
  const jump = AUDIT_SECTIONS.map(sec => `<a href="#${sectionId(sec.title)}">${escape(sec.title)}</a>`).join('');

  viewEl.innerHTML = `
    <button type="button" class="tools-home home-full cl-back" data-cl-back>${escape(cameFromApp ? t('Back') : t('Tools'))}</button>
    <header class="cl-head">
      <h1 class="cl-title">${escape(t('Component library'))}</h1>
      <p class="cl-sub">${escape(t('Live samples of the shell’s components — common primitives first, then by view. Full inventory and unification notes: plans/component-audit.md.'))}</p>
      <nav class="cl-jump" aria-label="${escape(t('Jump to section'))}">${jump}</nav>
    </header>

    <section class="cl-recs" aria-label="${escape(t('Still open'))}">
      <h2>${escape(t('Still open'))}</h2>
      <p class="cl-recs-lede">${escape(t('The 2026-07 component audit is executed — the primitives below are what it produced. Per-recommendation history and each deliberate exception: plans/component-audit.md. Not yet done:'))}</p>
      <ul class="cl-open">
        <li>Button-name fragmentation: <code>.pro-btn</code> vs bare <code>.btn</code> vs <code>.save-btn</code>/<code>.render-pill-save</code>/<code>.pro-sess-save</code> — frozen by the buttons.css attrition policy (no new members; a family migrates to <code>.btn</code> only when its view is rewritten wholesale).</li>
        <li>projects.ts's view-options (filter) popover is still hand-rolled — only the context menus moved to <code>mountBodyPopover</code>.</li>
      </ul>
    </section>

    ${AUDIT_SECTIONS.map(sec => `
      <section class="cl-section" id="${sectionId(sec.title)}">
        <div class="cl-section-head">
          <h2>${escape(sec.title)}</h2>
          <span class="cl-section-kind">${sec.group === 'common' ? escape(t('common')) : escape(t('view'))}</span>
        </div>
        ${sec.blurb ? `<p class="cl-sub" style="margin-top:-.5rem">${escape(sec.blurb)}</p>` : ''}
        <div class="cl-grid">
          ${sec.items.map(item => specimenShell(item, n++)).join('')}
        </div>
      </section>`).join('')}
  `;

  // Fill each stage. A live component renders through its LIVE renderer; a markup
  // specimen drops in its sample; a host-bound one shows its source snippet. Any
  // throw shows the error rather than a silent empty box — this is a component
  // surface; failures are the point of looking.
  flat.forEach((item, i) => {
    const stage = viewEl.querySelector<HTMLElement>(`[data-cl-stage="${i}"]`);
    if (!stage) return;
    try {
      if (item.live && LIVE[item.live]) {
        const spec = LIVE[item.live]!;
        const out = spec.render();
        if (typeof out === 'string') stage.innerHTML = out;
        else stage.appendChild(out);
        spec.wire?.(stage);
      } else if (item.markup) {
        stage.innerHTML = neutralizeMarkup(item.markup);
      } else if (item.code) {
        // Needs the host bridge to run — show the call as a source snippet.
        stage.classList.add('cl-stage--plain');
        stage.innerHTML = `<code class="cl-code">${escape(item.code)}</code>`;
      } else {
        stage.innerHTML = `<span class="cl-broken">no sample</span>`;
      }
    } catch (err) {
      stage.innerHTML = `<span class="cl-broken">render failed: ${escape(String((err as Error)?.message ?? err))}</span>`;
    }
  });

  // The one nav affordance. In-app arrival → step back to where you were; a cold
  // deep link (no in-app predecessor) → the gallery.
  viewEl.querySelector<HTMLButtonElement>('[data-cl-back]')?.addEventListener('click', (e) => {
    e.preventDefault();
    if (cameFromApp && window.history.length > 1) window.history.back();
    else window.location.hash = '#/';
  });

  armViewEnter(viewEl, '.tools-home, .cl-head, .cl-recs, .cl-section');
}
