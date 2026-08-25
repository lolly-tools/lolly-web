// SPDX-License-Identifier: MPL-2.0
/**
 * Edge docking - a right-edge (inline-end) full-height column the export settings
 * panel and the Neurospicy player can be dragged into, so they stay put and out of
 * the content while you work instead of floating over the preview and inputs.
 *
 * The content is NUDGED, never overlapped: this module owns one custom property,
 * `--dock-w` on <html>, and the shell's `#view` + the fixed chrome reserve that much
 * inline-end space (styles/parts/*.css thread `var(--dock-w, 0px)`). The tool stage
 * re-fits on its own - it is inside #view and watched by a ResizeObserver
 * (views/tool.ts) - so shrinking #view reflows everything with no poke from here.
 *
 * DESKTOP ONLY. Below the shell's 640px mobile breakpoint the whole feature is inert:
 * no column, no `--dock-w`, no listeners doing work, so mobile (web and the Tauri
 * mobile shell, which is the same code under 640px) cannot be touched by a feature
 * that does not run there. Crossing below the breakpoint with panels docked undocks
 * them back to their float boxes.
 *
 * Additive when idle: with nothing docked there is no column element, no attribute
 * and no custom property, so the app is byte-identical to today (`var(--dock-w, 0px)`
 * resolves to 0px when the property is unset). This module only ever moves chrome
 * panels; it never reads or writes their persisted float boxes, and never reaches
 * inside the tool canvas or the export stages.
 *
 * Geometry (column width, the two-panel split, collapsed) persists here under
 * `lolly:edge-dock`; WHICH panels are docked is owned by each panel, which re-requests
 * docking from its own restore path.
 */

const STORE_KEY = 'lolly:edge-dock';
const MOBILE_MQ = '(max-width: 640px)';   // the shell's canonical breakpoint (mobile-sheet.ts etc.)

// px. RAIL = collapsed rail width; MIN/MAX bound the resizable column; MIN_SLOT keeps
// each stacked panel usable; BAND = the inline-end drop-zone depth a drag must reach.
const RAIL_W = 48;
const MIN_W = 280;
const DEFAULT_W = 340;
const MIN_SLOT_H = 120;
const DROP_BAND = 52;

// Column order is fixed: the player on top, the export panel below it, so the split
// means "player height fraction". Both can be docked at once; one docks full-height.
type PanelId = 'neuro' | 'export';
const ORDER: readonly PanelId[] = ['neuro', 'export'];

interface Occupant {
  el: HTMLElement;
  home: { parent: Node; next: Node | null };
  onRelease?: () => void;
  onCollapse?: (collapsed: boolean) => void;
  /** Trusted SVG markup (icon()) + label for the collapsed rail's per-panel button. */
  icon?: string;
  label?: string;
}

export interface DockHooks {
  onRelease?: () => void;
  onCollapse?: (collapsed: boolean) => void;
  icon?: string;
  label?: string;
}

interface DockGeom { width?: number; split?: number; collapsed?: boolean }

const occupants = new Map<PanelId, Occupant>();
let geom: DockGeom = load();
let col: HTMLElement | null = null;
let body: HTMLElement | null = null;
let preview: HTMLElement | null = null;
let resizeBound = false;

function load(): DockGeom {
  try { return { ...(JSON.parse(localStorage.getItem(STORE_KEY) || '{}') as DockGeom) }; }
  catch { return {}; }
}
function save(): void {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(geom)); } catch { /* best-effort */ }
}

/** Desktop resolution? Docking never exists below the mobile breakpoint. */
export function edgeDockAvailable(): boolean {
  return typeof matchMedia === 'function' && !matchMedia(MOBILE_MQ).matches;
}

function isRTL(): boolean {
  if (document.documentElement.dir === 'rtl' || document.dir === 'rtl') return true;
  // Fallback for direction set via CSS rather than the attribute (browser only).
  return typeof window !== 'undefined' && typeof window.getComputedStyle === 'function'
    && window.getComputedStyle(document.documentElement).direction === 'rtl';
}

const STYLE_ID = 'edge-dock-css';
function injectCss(): void {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  // Column is viewport-fixed at the inline-end edge, full height, its own scroll.
  // The slot override forces a floating panel to FLOW inside its slot (it beats the
  // panel's own position:fixed) but deliberately leaves `transform` alone, so the
  // wobble impulse still reads on a docked panel.
  s.textContent = `
.edge-dock {
  position: fixed; inset-block: 0; inset-inline-end: 0; z-index: 9400;
  width: var(--dock-w, ${DEFAULT_W}px);
  display: flex; flex-direction: column;
  background: hsl(var(--background)); 
  box-shadow: -8px 0 24px -18px rgba(0,0,0,.5);
}
.edge-dock-body { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
.edge-dock-slot { min-height: 0; overflow: auto; position: relative; }
.edge-dock-slot--fill { flex: 1 1 auto; }
.edge-dock-slot > * {
  position: static !important; inset: auto !important; margin: 0 !important;
  width: 100% !important; height: 100% !important; max-width: none !important; max-height: none !important;
  /* The dock owns visibility here: the export panel's reveal is scoped to its #tool-layout
     ancestor (tool.css), which stops matching once it is re-parented into this body-level
     slot. transform is deliberately NOT reset, so the wobble impulse still reads. */
  visibility: visible !important; opacity: 1 !important; pointer-events: auto !important;
}
.edge-dock-grip {
  position: absolute; inset-block: 0; inset-inline-start: -3px; width: 8px;
  cursor: col-resize; touch-action: none; z-index: 2;
}
.edge-dock-divider {
  flex: 0 0 auto; height: 8px; cursor: row-resize; touch-action: none;
  background:
    linear-gradient(hsl(var(--border)), hsl(var(--border))) center / 28px 2px no-repeat;
}
.edge-dock-collapse {
  flex: 0 0 auto; height: 28px; border: 0; background: hsl(var(--muted));
  color: hsl(var(--muted-foreground)); cursor: pointer; font: inherit;
}
.edge-dock.is-collapsed .edge-dock-body { display: none; }
.edge-dock-rail { display: none; flex-direction: column; align-items: center; gap: 6px; padding: 6px 0; }
.edge-dock.is-collapsed .edge-dock-rail { display: flex; }
.edge-dock-rail-btn {
  width: 34px; height: 34px; border: 0; border-radius: 8px; cursor: pointer;
  background: transparent; color: hsl(var(--foreground));
  display: inline-flex; align-items: center; justify-content: center;
}
.edge-dock-rail-btn:hover { background: hsl(var(--muted)); }
.edge-dock-rail-btn svg { width: 18px; height: 18px; }
.edge-dock-drop {
  position: fixed; inset-block: 0; inset-inline-end: 0; width: var(--dock-w, ${DEFAULT_W}px);
  z-index: 9399; pointer-events: none;
  background: hsl(var(--primary) / .08);
  outline: 2px dashed hsl(var(--primary) / .5); outline-offset: -6px;
}
@media (prefers-reduced-motion: no-preference) {
  html[data-edge-dock]:not([data-a11y-motion="reduce"]) #view { transition: margin-inline-end .22s ease; }
}`;
  document.head.appendChild(s);
}

function ensureColumn(): void {
  if (col) return;
  injectCss();
  col = document.createElement('aside');
  col.className = 'edge-dock';
  col.setAttribute('aria-label', 'Docked panels');

  const grip = document.createElement('div');
  grip.className = 'edge-dock-grip';
  grip.setAttribute('role', 'separator');
  grip.setAttribute('aria-orientation', 'vertical');
  grip.setAttribute('aria-label', 'Resize docked panels');
  wireWidthGrip(grip);

  const collapse = document.createElement('button');
  collapse.type = 'button';
  collapse.className = 'edge-dock-collapse';
  collapse.addEventListener('click', () => toggleCollapse());

  // The collapsed rail: one icon per docked panel (shown only when collapsed), so the
  // rail reads as "the player + export are here", not a bare bar. Any icon expands.
  const rail = document.createElement('div');
  rail.className = 'edge-dock-rail';

  body = document.createElement('div');
  body.className = 'edge-dock-body';

  col.append(grip, collapse, rail, body);
  document.body.appendChild(col);
  document.documentElement.setAttribute('data-edge-dock', '');
  bindResize();
}

function teardownColumn(): void {
  if (!col) return;
  col.remove();
  col = null; body = null;
  document.documentElement.removeAttribute('data-edge-dock');
  document.documentElement.style.removeProperty('--dock-w');
}

/** Rebuild the body's slots + divider from the current occupants and apply geometry. */
function relayout(): void {
  if (!col || !body) return;
  const present = ORDER.filter(id => occupants.has(id));
  if (!present.length) { teardownColumn(); return; }

  // (Re)mount each occupant's element into its slot, in fixed column order.
  body.textContent = '';
  const slots = new Map<PanelId, HTMLElement>();
  present.forEach((id, i) => {
    if (i > 0) {
      const div = document.createElement('div');
      div.className = 'edge-dock-divider';
      div.setAttribute('role', 'separator');
      div.setAttribute('aria-orientation', 'horizontal');
      wireDivider(div);
      body!.appendChild(div);
    }
    const slot = document.createElement('div');
    slot.className = 'edge-dock-slot';
    slot.dataset.slot = id;
    slot.appendChild(occupants.get(id)!.el);
    body!.appendChild(slot);
    slots.set(id, slot);
  });

  // Heights: with two panels, the top (player) takes `split` of the body and the
  // bottom fills the rest; the split defaults to the player's natural height. With
  // one panel it fills.
  const bottom = present[present.length - 1]!;
  slots.get(bottom)!.classList.add('edge-dock-slot--fill');
  applySplit();

  // Collapsed rail: an icon button per occupant, click expands.
  const rail = col.querySelector<HTMLElement>('.edge-dock-rail');
  if (rail) {
    rail.textContent = '';
    for (const id of present) {
      const occ = occupants.get(id)!;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'edge-dock-rail-btn';
      b.title = occ.label ?? id;
      b.setAttribute('aria-label', `Expand ${occ.label ?? id}`);
      b.innerHTML = occ.icon ?? '';   // trusted icon() markup, like the export panel's tool buttons
      b.addEventListener('click', () => { if (geom.collapsed) toggleCollapse(); });
      rail.appendChild(b);
    }
  }

  applyWidth();
  col.classList.toggle('is-collapsed', !!geom.collapsed);
  const cb = col.querySelector<HTMLElement>('.edge-dock-collapse');
  if (cb) cb.textContent = geom.collapsed ? '⟨' : '⟩';
}

/**
 * Size the two stacked slots from `geom.split`, writing the EXISTING top slot's height
 * directly - never rebuilding the DOM. A divider drag calls this every move, so it must
 * not touch the divider element (relayout() recreates it, which would detach the handle
 * holding pointer capture and kill the drag after one move). No-op unless two are docked.
 */
function applySplit(): void {
  if (!body) return;
  const slots = body.querySelectorAll<HTMLElement>('.edge-dock-slot');
  if (slots.length !== 2) return;
  const top = slots[0]!;
  if (geom.split === undefined) { top.style.flex = ''; top.style.height = ''; return; }
  const bodyH = body.clientHeight || 1;
  const topH = clamp(geom.split * bodyH, MIN_SLOT_H, Math.max(MIN_SLOT_H, bodyH - MIN_SLOT_H));
  top.style.flex = '0 0 auto';
  top.style.height = `${topH}px`;
}

function applyWidth(): void {
  const w = geom.collapsed ? RAIL_W : clamp(geom.width ?? DEFAULT_W, MIN_W, maxWidth());
  document.documentElement.style.setProperty('--dock-w', `${w}px`);
}

function maxWidth(): number {
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1024;
  return Math.max(MIN_W, Math.min(560, Math.floor(vw * 0.5)));
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Dock `el` into the column under `id`. No-op (returns false) below the desktop
 * breakpoint. Remembers where `el` came from so releaseDock puts it back. The caller
 * stops applying its own float box while docked and re-applies it in `onRelease`.
 */
export function requestDock(id: PanelId, el: HTMLElement, hooks: DockHooks = {}): boolean {
  if (!edgeDockAvailable()) return false;
  if (occupants.has(id)) return true;
  ensureColumn();
  occupants.set(id, {
    el,
    home: { parent: el.parentNode!, next: el.nextSibling },
    onRelease: hooks.onRelease,
    onCollapse: hooks.onCollapse,
    icon: hooks.icon,
    label: hooks.label,
  });
  relayout();
  if (geom.collapsed) hooks.onCollapse?.(true);
  save();
  return true;
}

/** Undock `id`: restore its element to where it came from, then relayout (or tear the
 *  column down if it was the last). Fires the occupant's onRelease so it re-floats. */
export function releaseDock(id: PanelId): void {
  const occ = occupants.get(id);
  if (!occ) return;
  occupants.delete(id);
  const { parent, next } = occ.home;
  try { parent.insertBefore(occ.el, next); } catch { document.body.appendChild(occ.el); }
  occ.onRelease?.();
  relayout();
  save();
}

export function isDocked(id: PanelId): boolean { return occupants.has(id); }
export function dockedCount(): number { return occupants.size; }

/** The inline-end space the dock currently reserves, in px (0 when nothing is docked).
 *  For sites that clamp popovers to the viewport and must instead clamp to the content
 *  area (e.g. the timeline, which sits beside a docked column). */
export function edgeDockWidth(): number {
  const v = document.documentElement.style.getPropertyValue('--dock-w');
  return v ? (parseFloat(v) || 0) : 0;
}

/** Is `clientX` within the inline-end drop band? RTL-aware (inline-end is the left). */
export function edgeDockHitTest(clientX: number): boolean {
  if (!edgeDockAvailable()) return false;
  const vw = window.innerWidth;
  return isRTL() ? clientX <= DROP_BAND : clientX >= vw - DROP_BAND;
}

/** Show / hide the drop-zone affordance while a panel drag hovers the edge. */
export function edgeDockPreview(on: boolean): void {
  if (on) {
    if (!edgeDockAvailable()) return;
    if (!preview) {
      injectCss();
      preview = document.createElement('div');
      preview.className = 'edge-dock-drop';
      document.body.appendChild(preview);
    }
  } else if (preview) {
    preview.remove();
    preview = null;
  }
}

// ── Width grip (inline-start edge) - the sidebar/studio-split shape ─────────────
function wireWidthGrip(grip: HTMLElement): void {
  let dragging = false;
  grip.addEventListener('pointerdown', (e: PointerEvent) => {
    if (geom.collapsed || !col) return;
    dragging = true;
    try { grip.setPointerCapture(e.pointerId); } catch { /* stray pointer id */ }
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });
  grip.addEventListener('pointermove', (e: PointerEvent) => {
    if (!dragging || !col) return;
    const r = col.getBoundingClientRect();
    // Column width from the pointer to the column's outer (viewport) edge.
    const w = isRTL() ? e.clientX - r.left : r.right - e.clientX;
    geom.width = clamp(w, MIN_W, maxWidth());
    applyWidth();
  });
  const up = (e: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    try { if (grip.hasPointerCapture(e.pointerId)) grip.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    save();
  };
  grip.addEventListener('pointerup', up);
  grip.addEventListener('pointercancel', up);
}

// ── Divider (between the two stacked panels) - studio-split forked to the Y axis ─
function wireDivider(div: HTMLElement): void {
  let dragging = false;
  div.addEventListener('pointerdown', (e: PointerEvent) => {
    dragging = true;
    try { div.setPointerCapture(e.pointerId); } catch { /* stray pointer id */ }
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });
  div.addEventListener('pointermove', (e: PointerEvent) => {
    if (!dragging || !body) return;
    const r = body.getBoundingClientRect();
    const bodyH = r.height || 1;
    const topH = clamp(e.clientY - r.top, MIN_SLOT_H, Math.max(MIN_SLOT_H, bodyH - MIN_SLOT_H));
    geom.split = topH / bodyH;
    applySplit();   // direct height write - must NOT relayout (that recreates this handle)
  });
  const up = (e: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    try { if (div.hasPointerCapture(e.pointerId)) div.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    save();
  };
  div.addEventListener('pointerup', up);
  div.addEventListener('pointercancel', up);
}

// ── Collapse ───────────────────────────────────────────────────────────────────
function toggleCollapse(): void {
  geom.collapsed = !geom.collapsed;
  applyWidth();
  if (col) col.classList.toggle('is-collapsed', geom.collapsed);
  const cb = col?.querySelector<HTMLElement>('.edge-dock-collapse');
  if (cb) cb.textContent = geom.collapsed ? '⟨' : '⟩';
  for (const occ of occupants.values()) occ.onCollapse?.(!!geom.collapsed);
  save();
}

// ── Breakpoint + viewport guard ─────────────────────────────────────────────────
function bindResize(): void {
  if (resizeBound) return;
  resizeBound = true;
  window.addEventListener('resize', () => {
    // Dropped below the desktop breakpoint: undock everything back to floating.
    if (!edgeDockAvailable()) {
      for (const id of [...occupants.keys()]) releaseDock(id);
      return;
    }
    // Still desktop: re-clamp the width (the viewport may have shrunk) and re-derive
    // the split's px from its fraction.
    if (occupants.size) { applyWidth(); relayout(); }
  });
}
