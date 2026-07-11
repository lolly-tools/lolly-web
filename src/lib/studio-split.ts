// SPDX-License-Identifier: MPL-2.0
/**
 * Studio split pane — the Colour tab's draggable divider between the main
 * column and the sticky palette side pane (≥1100px; below that the divider is
 * display:none, so it can't be dragged or focused, and the side content just
 * follows in flow). Cloned from the tool view's sidebar drag (views/tool.ts):
 * pointer capture, a CSS width var, snap-collapse, localStorage persist — plus
 * keyboard support, since this handle is a focusable `role="separator"`.
 *
 * `el` is the split grid itself (`.be-tab--split`); this writes `--be-side-w`
 * onto it and toggles `.is-collapsed`. It must never set z-index/transform/
 * contain on the side pane — the swatch popover (.be-editor) positions against
 * `.be` and has to keep beating the sticky action row (the fixed-popover
 * containing-block trap).
 */

const STORE_KEY = 'brandStudioPaneW';
const SIDE_MIN = 220;      // narrowest useful pane
const SNAP_COLLAPSE = 180; // dragging under this snaps the pane closed
const SIDE_DEFAULT = 400;
const KEY_STEP = 24;

export function mountStudioSplit(el: HTMLElement): () => void {
  const divider = el.querySelector<HTMLElement>('[data-be-split-divider]');
  if (!divider) return () => {};

  const maxW = (): number => Math.round(el.getBoundingClientRect().width * 0.6);
  const clamp = (w: number): number => Math.max(SIDE_MIN, Math.min(w, maxW()));

  // 0 persisted = collapsed (same convention as the tool sidebar's width key).
  // A MISSING key must not read as that sentinel — Number(null) is 0, which
  // would boot every fresh profile collapsed — so absent maps to NaN; anything
  // unusable falls back to the default open width.
  const raw = localStorage.getItem(STORE_KEY);
  const saved = raw == null ? NaN : Number(raw);
  let width = Number.isFinite(saved) && saved >= SIDE_MIN ? saved : SIDE_DEFAULT;
  let collapsed = saved === 0;

  const apply = (save = true): void => {
    el.classList.toggle('is-collapsed', collapsed);
    el.style.setProperty('--be-side-w', `${width}px`);
    divider.setAttribute('aria-valuemin', String(SIDE_MIN));
    divider.setAttribute('aria-valuemax', String(maxW()));
    divider.setAttribute('aria-valuenow', String(collapsed ? 0 : width));
    if (save) localStorage.setItem(STORE_KEY, String(collapsed ? 0 : width));
  };
  apply(false);

  // ── Drag (pointer capture, live width, snap-collapse; persist on release) ──
  let dragging = false;
  const onDown = (e: PointerEvent): void => {
    dragging = true;
    divider.classList.add('is-dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    divider.setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  const onMove = (e: PointerEvent): void => {
    if (!dragging) return;
    const rect = el.getBoundingClientRect();
    const raw = rect.right - e.clientX; // pointer → the side pane's would-be width
    if (raw < SNAP_COLLAPSE) collapsed = true;
    else { collapsed = false; width = Math.max(SIDE_MIN, Math.min(raw, rect.width * 0.6)); }
    apply(false);
  };
  const onUp = (): void => {
    if (!dragging) return;
    dragging = false;
    divider.classList.remove('is-dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    apply(); // commit + persist
  };

  // ── Keyboard (Left grows the pane — the separator moves left) ─────────────
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'ArrowLeft') { collapsed = false; width = clamp(width + KEY_STEP); }
    else if (e.key === 'ArrowRight') { if (!collapsed) width = clamp(width - KEY_STEP); }
    else if (e.key === 'Home') { collapsed = false; width = maxW(); }
    else if (e.key === 'End') { collapsed = false; width = SIDE_MIN; }
    else if (e.key === 'Enter') collapsed = !collapsed;
    else return;
    e.preventDefault();
    apply();
  };

  divider.addEventListener('pointerdown', onDown);
  divider.addEventListener('pointermove', onMove);
  divider.addEventListener('pointerup', onUp);
  divider.addEventListener('pointercancel', onUp);
  divider.addEventListener('keydown', onKey);

  return () => {
    divider.removeEventListener('pointerdown', onDown);
    divider.removeEventListener('pointermove', onMove);
    divider.removeEventListener('pointerup', onUp);
    divider.removeEventListener('pointercancel', onUp);
    divider.removeEventListener('keydown', onKey);
    if (dragging) { document.body.style.cursor = ''; document.body.style.userSelect = ''; }
  };
}
