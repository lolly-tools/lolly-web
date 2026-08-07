// SPDX-License-Identifier: MPL-2.0
/**
 * Free-floating behaviour for the DESKTOP export panel.
 *
 * By default the panel stays docked bottom-left under the sidebar (the CSS in
 * styles/parts/tool.css owns that). This layers four capabilities on top, without
 * touching the panel's open/close/modality wiring in views/tool.ts:
 *
 *   • drag the header to move it — the first drag lifts it off the dock into a
 *     free-floating `position:fixed` box (this is the "not docked to the sidebar"
 *     case: canvas / chromeless layouts start floated so the panel can be moved
 *     out of the way of the stage);
 *   • eight grips to resize it — the SAME primitive the neurospicy player uses
 *     (lib/panel-grips.ts), so every shapeable panel in the app behaves alike;
 *   • a maximise toggle that grows it to the full height of the screen ("expand to
 *     the top"), keeping its left edge + width;
 *   • a dock button that snaps it back home.
 *
 * The box + mode persist per device (localStorage), like the visualizer panel.
 *
 * Mobile is deliberately untouched: there the panel is a modal bottom sheet with a
 * flick-to-dismiss gesture, and floating would fight it. Every gesture no-ops under
 * 641px and the floating CSS is media-scoped ≥641px, so the class is inert there;
 * on a shrink to mobile we also clear the inline box so the sheet renders normally.
 */
import { panelGripsHtml, wirePanelGrips } from './panel-grips.ts';
import { icon } from './icons.ts';

interface Box { x: number; y: number; w: number; h: number }
type Mode = 'docked' | 'floating' | 'maximized';

const KEY = 'lolly:exportPanelFloat';
const MIN = { w: 300, h: 240 };
const MARGIN = 8;          // keep this far from the viewport edges
const KEEP_VISIBLE = 96;   // never let the panel be dragged fully off-screen

export interface ExportFloatOpts {
  overlay: HTMLElement;      // #export-overlay (the fixed, pointer-events:none wrapper)
  popup: HTMLElement;        // .export-popup
  head: HTMLElement;         // .export-popup-head (drag handle)
  isMobile: () => boolean;   // never float on the mobile bottom sheet
  freeLayout: boolean;       // canvas/chromeless — no sidebar to dock under; start floated
}

export function wireExportPanelFloat(opts: ExportFloatOpts): () => void {
  const { popup, head, isMobile, freeLayout } = opts;
  let mode: Mode = 'docked';
  let box: Box | null = null;        // current floating box (viewport px)
  let restoreBox: Box | null = null; // box to return to when un-maximising

  // ── persistence ──────────────────────────────────────────────────────────
  const save = (): void => {
    try { localStorage.setItem(KEY, JSON.stringify({ mode, box })); } catch { /* private mode */ }
  };
  const loadSaved = (): { mode: Mode; box: Box | null } | null => {
    try {
      const r = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (r && (r.mode === 'docked' || r.mode === 'floating' || r.mode === 'maximized')) return r;
    } catch { /* corrupt */ }
    return null;
  };

  // ── geometry ─────────────────────────────────────────────────────────────
  const vw = (): number => window.innerWidth;
  const vh = (): number => window.innerHeight;
  const clamp = (b: Box): Box => {
    const w = Math.min(Math.max(MIN.w, b.w), vw() - MARGIN * 2);
    const h = Math.min(Math.max(MIN.h, b.h), vh() - MARGIN * 2);
    // Keep at least KEEP_VISIBLE px of the panel on screen in each axis.
    const x = Math.min(Math.max(KEEP_VISIBLE - w, b.x), vw() - KEEP_VISIBLE);
    const y = Math.min(Math.max(MARGIN, b.y), vh() - KEEP_VISIBLE);
    return { x, y, w, h };
  };
  // Pull the box FULLY inside the viewport. Used when the viewport itself changes
  // (resize) or on (re)open — a panel left hanging off an edge there reads as broken,
  // and the user can't always drag it back. Distinct from clamp(), which is lenient
  // by design so a user CAN tuck the panel to a KEEP_VISIBLE sliver while dragging.
  const clampFully = (b: Box): Box => {
    const w = Math.min(Math.max(MIN.w, b.w), vw() - MARGIN * 2);
    const h = Math.min(Math.max(MIN.h, b.h), vh() - MARGIN * 2);
    const x = Math.min(Math.max(MARGIN, b.x), vw() - MARGIN - w);
    const y = Math.min(Math.max(MARGIN, b.y), vh() - MARGIN - h);
    return { x, y, w, h };
  };
  const currentRect = (): Box => {
    const r = popup.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  };
  const applyBox = (b: Box): void => {
    popup.style.left = `${Math.round(b.x)}px`;
    popup.style.top = `${Math.round(b.y)}px`;
    popup.style.width = `${Math.round(b.w)}px`;
    popup.style.height = `${Math.round(b.h)}px`;
  };
  const clearInline = (): void => {
    popup.style.left = popup.style.top = popup.style.width = popup.style.height = '';
  };

  // ── mode transitions ─────────────────────────────────────────────────────
  const render = (): void => {
    popup.classList.toggle('is-floating', mode !== 'docked');
    popup.classList.toggle('is-maximized', mode === 'maximized');
    dockBtn.hidden = mode === 'docked';
    maxBtn.setAttribute('aria-pressed', mode === 'maximized' ? 'true' : 'false');
    maxBtn.setAttribute('aria-label', mode === 'maximized' ? 'Restore panel size' : 'Expand to full height');
    if (mode === 'docked' || isMobile()) { clearInline(); return; }
    if (box) applyBox(box);
  };
  const enterFloating = (from?: Box): void => {
    if (mode !== 'docked') return;
    mode = 'floating';
    box = clamp(from ?? currentRect());
    render(); save();
  };
  const dock = (): void => {
    mode = 'docked'; box = null; restoreBox = null;
    render(); save();
  };
  const toggleMax = (): void => {
    if (isMobile()) return;
    if (mode === 'maximized') {
      box = restoreBox ? clamp(restoreBox) : clamp({ ...currentRect() });
      mode = 'floating'; restoreBox = null;
    } else {
      const base = box ?? currentRect();
      restoreBox = { ...base };
      mode = 'maximized';
      // "Expand to the top of the screen": keep the left edge + width, take the full
      // height between the margins.
      box = clamp({ x: base.x, y: MARGIN, w: base.w, h: vh() - MARGIN * 2 });
    }
    render(); save();
  };

  // ── header: tool buttons + drag ──────────────────────────────────────────
  const mkBtn = (cls: string, glyph: string, label: string): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `export-popup-tool ${cls}`;
    b.innerHTML = glyph;   // glyph is a constant icon() string — no interpolation (R10)
    b.setAttribute('aria-label', label);
    b.title = label;
    return b;
  };
  const maxBtn = mkBtn('export-popup-max', icon('arrowsV'), 'Expand to full height');
  const dockBtn = mkBtn('export-popup-dock', icon('dock'), 'Dock to the side');
  dockBtn.hidden = true;
  // Group the tool buttons with the existing close button on the right of the head.
  const closeBtn = head.querySelector<HTMLElement>('.export-popup-close');
  const tools = document.createElement('span');
  tools.className = 'export-popup-tools';
  tools.append(maxBtn, dockBtn);
  if (closeBtn) head.insertBefore(tools, closeBtn), tools.append(closeBtn);
  else head.append(tools);
  maxBtn.addEventListener('click', toggleMax);
  dockBtn.addEventListener('click', dock);

  // Drag the header to move; the first drag off the dock floats the panel.
  let drag: { px: number; py: number; b: Box; id: number } | null = null;
  const onHeadDown = (e: PointerEvent): void => {
    if (isMobile() || e.button !== 0) return;
    if ((e.target as HTMLElement).closest('button')) return;   // let the head's buttons click
    if (mode === 'docked') enterFloating();
    if (mode === 'maximized') toggleMax();                     // dragging a maximised panel restores it first
    drag = { px: e.clientX, py: e.clientY, b: { ...(box ?? currentRect()) }, id: e.pointerId };
    try { head.setPointerCapture(e.pointerId); } catch { /* stray pointer id */ }
    popup.classList.add('is-dragging');
    e.preventDefault();
  };
  const onHeadMove = (e: PointerEvent): void => {
    if (!drag) return;
    box = clamp({ ...drag.b, x: drag.b.x + (e.clientX - drag.px), y: drag.b.y + (e.clientY - drag.py) });
    applyBox(box);
  };
  const onHeadUp = (e: PointerEvent): void => {
    if (!drag) return;
    try { if (head.hasPointerCapture(drag.id)) head.releasePointerCapture(drag.id); } catch { /* already released */ }
    drag = null;
    popup.classList.remove('is-dragging');
    save();
  };
  head.addEventListener('pointerdown', onHeadDown);
  head.addEventListener('pointermove', onHeadMove);
  head.addEventListener('pointerup', onHeadUp);
  head.addEventListener('pointercancel', onHeadUp);

  // ── resize grips (only meaningful once floating) ─────────────────────────
  popup.insertAdjacentHTML('beforeend', panelGripsHtml());
  const gripsOff = wirePanelGrips(popup, {
    read: () => { if (mode === 'docked') enterFloating(); return box ?? currentRect(); },
    apply: (b) => { box = b; applyBox(b); },
    clamp,
    min: MIN,
    locked: () => isMobile(),
    onEnd: () => { if (mode === 'maximized') mode = 'floating'; save(); },
  });

  // ── window resize + breakpoint changes ───────────────────────────────────
  const onResize = (): void => {
    if (mode === 'docked' || isMobile()) { clearInline(); return; }
    // A viewport change must never strand the panel off-screen: pull it FULLY back in
    // (clampFully), not merely to the lenient drag sliver.
    if (mode === 'maximized') box = clampFully({ x: (box ?? currentRect()).x, y: MARGIN, w: (box ?? currentRect()).w, h: vh() - MARGIN * 2 });
    else if (box) box = clampFully(box);
    render();
  };
  window.addEventListener('resize', onResize);

  // ── init: restore saved state, or start floated in a free layout ─────────
  const saved = loadSaved();
  if (saved && saved.mode !== 'docked' && saved.box) {
    // Reopen fully on-screen — the saved box may be from a larger window/monitor.
    mode = saved.mode; box = clampFully(saved.box); render();
  } else if (freeLayout && !saved) {
    // No sidebar to dock under → open floated, bottom-left over the stage.
    const w = Math.min(380, vw() - MARGIN * 2);
    const h = Math.min(Math.round(vh() * 0.66), vh() - MARGIN * 2);
    mode = 'floating'; box = clamp({ x: MARGIN, y: vh() - h - MARGIN, w, h }); render();
  }

  return () => {
    gripsOff();
    head.removeEventListener('pointerdown', onHeadDown);
    head.removeEventListener('pointermove', onHeadMove);
    head.removeEventListener('pointerup', onHeadUp);
    head.removeEventListener('pointercancel', onHeadUp);
    window.removeEventListener('resize', onResize);
  };
}
