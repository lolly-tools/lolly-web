// SPDX-License-Identifier: MPL-2.0
/** Rulers and persistent authoring guides for the Design canvas. */

import { t } from '../i18n.ts';

export interface DesignGuideSet {
  /** Vertical guides, in document/CSS pixels from the canvas origin. */
  x: number[];
  /** Horizontal guides, in document/CSS pixels from the canvas origin. */
  y: number[];
}

export interface DesignGuidesOptions {
  stageEl: HTMLElement;
  canvasEl: HTMLElement;
  read(): unknown;
  commit(value: string): void;
  initiallyVisible?: boolean;
}

export interface DesignGuidesHandle {
  el: HTMLElement;
  isVisible(): boolean;
  setVisible(visible: boolean): void;
  toggle(): void;
  clear(): void;
  hasGuides(): boolean;
  /** Re-read the model and repaint after undo, zoom, pan, resize or locale change. */
  sync(): void;
  /** Positions consumed by the canvas smart-snap path. */
  snapTargets(): DesignGuideSet;
  destroy(): void;
}

const NS = 'http://www.w3.org/2000/svg';
const RULER = 22;
const MIN_TICK_PX = 9;

function finiteSorted(values: unknown): number[] {
  if (!Array.isArray(values)) return [];
  return [
    ...new Set(
      values
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value))
        .map((value) => Math.round(value * 100) / 100)
    ),
  ].sort((a, b) => a - b);
}

/** Parse both the compact v1 wire form and the old/debug JSON shape defensively. */
export function parseDesignGuides(value: unknown): DesignGuideSet {
  if (value && typeof value === 'object') {
    const row = value as Partial<DesignGuideSet>;
    return { x: finiteSorted(row.x), y: finiteSorted(row.y) };
  }
  const source = String(value ?? '').trim();
  if (!source) return { x: [], y: [] };
  if (source.startsWith('{')) {
    try {
      return parseDesignGuides(JSON.parse(source));
    } catch {
      return { x: [], y: [] };
    }
  }
  const result: DesignGuideSet = { x: [], y: [] };
  for (const part of source.replace(/^1\|/, '').split(';')) {
    const [axis, raw = ''] = part.split('=', 2);
    if (axis === 'x' || axis === 'y') result[axis] = finiteSorted(raw ? raw.split(',') : []);
  }
  return result;
}

/** Compact enough to remain friendly in Design's continuously-synchronised URL. */
export function serializeDesignGuides(guides: DesignGuideSet): string {
  const n = (value: number): string => String(Math.round(value * 100) / 100);
  const x = finiteSorted(guides.x).map(n).join(',');
  const y = finiteSorted(guides.y).map(n).join(',');
  return x || y ? `1|x=${x};y=${y}` : '';
}

/** A 1/2/5 ruler interval whose minor ticks never become visual noise. */
export function rulerStep(scale: number, minScreenPx = MIN_TICK_PX): number {
  const wanted = minScreenPx / Math.max(0.0001, Math.abs(scale));
  const power = 10 ** Math.floor(Math.log10(wanted));
  for (const multiple of [1, 2, 5, 10]) {
    const step = multiple * power;
    if (step >= wanted) return step;
  }
  return 10 * power;
}

function svgEl<K extends keyof SVGElementTagNameMap>(name: K): SVGElementTagNameMap[K] {
  return document.createElementNS(NS, name);
}

export function mountDesignGuides(opts: DesignGuidesOptions): DesignGuidesHandle {
  const { stageEl, canvasEl } = opts;
  let guides = parseDesignGuides(opts.read());
  let visible = opts.initiallyVisible !== false;
  let destroyed = false;

  const root = document.createElement('div');
  root.className = 'fc-authoring-guides';
  root.setAttribute('data-export-hide', '');
  root.setAttribute('data-live-hide', '');
  root.setAttribute('aria-label', t('Rulers and guides'));

  const corner = document.createElement('button');
  corner.type = 'button';
  corner.className = 'fc-ruler-corner';
  corner.setAttribute('aria-label', t('Remove all guides'));
  corner.title = t('Remove all guides');

  const top = document.createElement('div');
  top.className = 'fc-ruler fc-ruler-x';
  top.setAttribute('aria-label', t('Horizontal ruler. Drag down to add a guide.'));
  top.setAttribute('role', 'toolbar');
  const topSvg = svgEl('svg');
  top.appendChild(topSvg);

  const left = document.createElement('div');
  left.className = 'fc-ruler fc-ruler-y';
  left.setAttribute('aria-label', t('Vertical ruler. Drag right to add a guide.'));
  left.setAttribute('role', 'toolbar');
  const leftSvg = svgEl('svg');
  left.appendChild(leftSvg);

  const lines = document.createElement('div');
  lines.className = 'fc-author-guide-lines';
  root.append(corner, top, left, lines);
  stageEl.appendChild(root);

  const stagePoint = (axis: 'x' | 'y', client: number): number => {
    const canvas = canvasEl.getBoundingClientRect();
    const size =
      axis === 'x'
        ? parseFloat(canvasEl.style.width) || canvasEl.offsetWidth || 1
        : parseFloat(canvasEl.style.height) || canvasEl.offsetHeight || 1;
    const scale = (axis === 'x' ? canvas.width : canvas.height) / size || 1;
    return (client - (axis === 'x' ? canvas.left : canvas.top)) / scale;
  };

  const canvasSize = (axis: 'x' | 'y'): number =>
    axis === 'x'
      ? parseFloat(canvasEl.style.width) || canvasEl.offsetWidth || 1
      : parseFloat(canvasEl.style.height) || canvasEl.offsetHeight || 1;

  function commit(next: DesignGuideSet): void {
    guides = { x: finiteSorted(next.x), y: finiteSorted(next.y) };
    opts.commit(serializeDesignGuides(guides));
    paint();
  }

  function remove(axis: 'x' | 'y', index: number): void {
    commit({ ...guides, [axis]: guides[axis].filter((_, i) => i !== index) });
  }

  function lineLabel(axis: 'x' | 'y', value: number): string {
    return axis === 'x'
      ? t('Vertical guide at {n} px', { n: Math.round(value * 100) / 100 })
      : t('Horizontal guide at {n} px', { n: Math.round(value * 100) / 100 });
  }

  let drag: { axis: 'x' | 'y'; index: number | null; pointerId: number; value: number } | null =
    null;

  function updateDrag(event: PointerEvent): void {
    if (!drag) return;
    const next = stagePoint(drag.axis, drag.axis === 'x' ? event.clientX : event.clientY);
    drag.value = event.shiftKey ? Math.round(next / 10) * 10 : Math.round(next);
    paintLines();
  }

  function finishDrag(event: PointerEvent): void {
    if (!drag) return;
    updateDrag(event);
    const { axis, index, value } = drag;
    drag = null;
    root.classList.remove('is-guide-dragging');
    try {
      const target = event.currentTarget as Element;
      if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
    } catch {
      /* capture may already have been lost */
    }
    const next = guides[axis].slice();
    if (index != null) next.splice(index, 1);
    if (value >= 0 && value <= canvasSize(axis)) next.push(value);
    commit({ ...guides, [axis]: next });
  }

  function startDrag(event: PointerEvent, axis: 'x' | 'y', index: number | null): void {
    if (event.button !== 0) return;
    const value =
      index == null
        ? stagePoint(axis, axis === 'x' ? event.clientX : event.clientY)
        : (guides[axis][index] ?? 0);
    drag = { axis, index, pointerId: event.pointerId, value };
    root.classList.add('is-guide-dragging');
    try {
      (event.currentTarget as Element).setPointerCapture(event.pointerId);
    } catch {
      /* jsdom/stray id */
    }
    event.preventDefault();
    event.stopPropagation();
    paintLines();
  }

  function onRulerDown(event: PointerEvent): void {
    startDrag(event, event.currentTarget === top ? 'y' : 'x', null);
  }

  function onLineDown(event: PointerEvent): void {
    const line = (event.target as HTMLElement | null)?.closest<HTMLElement>('.fc-author-guide');
    const axis = line?.dataset.axis;
    const index = Number(line?.dataset.index);
    if ((axis === 'x' || axis === 'y') && Number.isInteger(index)) startDrag(event, axis, index);
  }

  function onLineDblClick(event: MouseEvent): void {
    const line = (event.target as HTMLElement | null)?.closest<HTMLElement>('.fc-author-guide');
    const axis = line?.dataset.axis;
    const index = Number(line?.dataset.index);
    if ((axis === 'x' || axis === 'y') && Number.isInteger(index)) remove(axis, index);
  }

  function onLineKey(event: KeyboardEvent): void {
    const line = (event.target as HTMLElement | null)?.closest<HTMLElement>('.fc-author-guide');
    const axis = line?.dataset.axis;
    const index = Number(line?.dataset.index);
    if ((axis !== 'x' && axis !== 'y') || !Number.isInteger(index)) return;
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      remove(axis, index);
      return;
    }
    const negative = axis === 'x' ? event.key === 'ArrowLeft' : event.key === 'ArrowUp';
    const positive = axis === 'x' ? event.key === 'ArrowRight' : event.key === 'ArrowDown';
    if (!negative && !positive) return;
    event.preventDefault();
    const step = event.shiftKey ? 10 : 1;
    const next = guides[axis].slice();
    next[index] = Math.max(0, Math.min(canvasSize(axis), next[index]! + (negative ? -step : step)));
    commit({ ...guides, [axis]: next });
  }

  function paintRuler(
    svg: SVGSVGElement,
    axis: 'x' | 'y',
    length: number,
    origin: number,
    scale: number
  ): void {
    svg.replaceChildren();
    svg.setAttribute('viewBox', axis === 'x' ? `0 0 ${length} ${RULER}` : `0 0 ${RULER} ${length}`);
    const step = rulerStep(scale);
    const nativeStart = (0 - origin) / scale;
    const nativeEnd = (length - origin) / scale;
    const first = Math.floor(nativeStart / step) * step;
    for (
      let value = first, guard = 0;
      value <= nativeEnd + step && guard < 2000;
      value += step, guard++
    ) {
      const at = origin + value * scale;
      const sequence = Math.round(value / step);
      const major = sequence % 5 === 0;
      const tick = svgEl('line');
      if (axis === 'x') {
        tick.setAttribute('x1', String(at));
        tick.setAttribute('x2', String(at));
        tick.setAttribute('y1', String(major ? 7 : 13));
        tick.setAttribute('y2', String(RULER));
      } else {
        tick.setAttribute('x1', String(major ? 7 : 13));
        tick.setAttribute('x2', String(RULER));
        tick.setAttribute('y1', String(at));
        tick.setAttribute('y2', String(at));
      }
      svg.appendChild(tick);
      if (!major) continue;
      const label = svgEl('text');
      label.textContent = String(Math.round(value * 100) / 100);
      if (axis === 'x') {
        label.setAttribute('x', String(at + 3));
        label.setAttribute('y', '9');
      } else {
        label.setAttribute('x', '9');
        label.setAttribute('y', String(at - 3));
        label.setAttribute('transform', `rotate(-90 9 ${at - 3})`);
      }
      svg.appendChild(label);
    }
  }

  function chromeTop(stageRect: DOMRect): number {
    const bar = stageEl.querySelector<HTMLElement>('.design-topbar');
    if (!bar) return 0;
    const rect = bar.getBoundingClientRect();
    return Math.max(0, Math.min(stageRect.height - RULER, rect.bottom - stageRect.top));
  }

  function paintLines(): void {
    lines.replaceChildren();
    const stage = stageEl.getBoundingClientRect();
    const canvas = canvasEl.getBoundingClientRect();
    const xScale = canvas.width / canvasSize('x') || 1;
    const yScale = canvas.height / canvasSize('y') || 1;
    const topInset = chromeTop(stage) + RULER;
    const all: Array<{ axis: 'x' | 'y'; value: number; index: number | null; dragging?: boolean }> =
      [
        ...guides.x.map((value, index) => ({ axis: 'x' as const, value, index })),
        ...guides.y.map((value, index) => ({ axis: 'y' as const, value, index })),
      ];
    if (drag) all.push({ axis: drag.axis, value: drag.value, index: drag.index, dragging: true });
    for (const item of all) {
      if (drag && !item.dragging && item.axis === drag.axis && item.index === drag.index) continue;
      const line = document.createElement('button');
      line.type = 'button';
      line.className = `fc-author-guide fc-author-guide-${item.axis}${item.dragging ? ' is-dragging' : ''}`;
      line.dataset.axis = item.axis;
      if (item.index != null) line.dataset.index = String(item.index);
      const at =
        item.axis === 'x'
          ? canvas.left - stage.left + item.value * xScale
          : canvas.top - stage.top + item.value * yScale;
      if (item.axis === 'x') {
        line.style.left = `${at}px`;
        line.style.top = `${topInset}px`;
        line.style.height = `${Math.max(0, stage.height - topInset)}px`;
      } else {
        line.style.left = `${RULER}px`;
        line.style.top = `${at}px`;
        line.style.width = `${Math.max(0, stage.width - RULER)}px`;
      }
      line.setAttribute('aria-label', lineLabel(item.axis, item.value));
      line.title = `${lineLabel(item.axis, item.value)}. ${t('Drag to move. Double-click or press Delete to remove.')}`;
      if (item.dragging) line.tabIndex = -1;
      lines.appendChild(line);
    }
  }

  function paint(): void {
    if (destroyed) return;
    root.hidden = !visible;
    if (!visible) return;
    const stage = stageEl.getBoundingClientRect();
    const canvas = canvasEl.getBoundingClientRect();
    const topInset = chromeTop(stage);
    corner.style.top = `${topInset}px`;
    top.style.top = `${topInset}px`;
    top.style.left = `${RULER}px`;
    top.style.width = `${Math.max(0, stage.width - RULER)}px`;
    left.style.top = `${topInset + RULER}px`;
    left.style.height = `${Math.max(0, stage.height - topInset - RULER)}px`;
    paintRuler(
      topSvg,
      'x',
      Math.max(1, stage.width - RULER),
      canvas.left - stage.left - RULER,
      canvas.width / canvasSize('x') || 1
    );
    paintRuler(
      leftSvg,
      'y',
      Math.max(1, stage.height - topInset - RULER),
      canvas.top - stage.top - topInset - RULER,
      canvas.height / canvasSize('y') || 1
    );
    paintLines();
  }

  top.addEventListener('pointerdown', onRulerDown);
  left.addEventListener('pointerdown', onRulerDown);
  top.addEventListener('pointermove', updateDrag);
  left.addEventListener('pointermove', updateDrag);
  top.addEventListener('pointerup', finishDrag);
  left.addEventListener('pointerup', finishDrag);
  top.addEventListener('pointercancel', finishDrag);
  left.addEventListener('pointercancel', finishDrag);
  lines.addEventListener('pointerdown', onLineDown);
  lines.addEventListener('pointermove', updateDrag);
  lines.addEventListener('pointerup', finishDrag);
  lines.addEventListener('pointercancel', finishDrag);
  lines.addEventListener('dblclick', onLineDblClick);
  lines.addEventListener('keydown', onLineKey);
  corner.addEventListener('click', () => commit({ x: [], y: [] }));

  paint();

  return {
    el: root,
    isVisible: () => visible,
    setVisible(next: boolean): void {
      visible = next;
      paint();
    },
    toggle(): void {
      visible = !visible;
      paint();
    },
    clear(): void {
      commit({ x: [], y: [] });
    },
    hasGuides: () => guides.x.length + guides.y.length > 0,
    sync(): void {
      const next = parseDesignGuides(opts.read());
      if (serializeDesignGuides(next) !== serializeDesignGuides(guides)) guides = next;
      paint();
    },
    snapTargets: () => ({ x: guides.x.slice(), y: guides.y.slice() }),
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      root.remove();
    },
  };
}
