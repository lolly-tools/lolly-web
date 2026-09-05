// SPDX-License-Identifier: MPL-2.0
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import {
  mountDesignGuides,
  parseDesignGuides,
  rulerStep,
  serializeDesignGuides,
} from './design-guides.ts';

const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://lolly.test/' });
for (const key of [
  'window',
  'document',
  'HTMLElement',
  'Element',
  'SVGElement',
  'KeyboardEvent',
  'MouseEvent',
  'Event',
  'Node',
  'localStorage',
]) {
  (globalThis as Record<string, unknown>)[key] = (dom.window as unknown as Record<string, unknown>)[
    key
  ];
}

test('guide wire format is compact, sorted, deduplicated and backwards-compatible', () => {
  assert.deepEqual(parseDesignGuides('1|x=20,10,20;y=5.5'), { x: [10, 20], y: [5.5] });
  assert.deepEqual(parseDesignGuides('{"x":[9],"y":[4,2]}'), { x: [9], y: [2, 4] });
  assert.equal(serializeDesignGuides({ x: [20, 10, 20], y: [5.555] }), '1|x=10,20;y=5.56');
  assert.equal(serializeDesignGuides({ x: [], y: [] }), '');
});

test('ruler ticks keep a usable screen interval at any zoom', () => {
  assert.equal(rulerStep(1), 10);
  assert.equal(rulerStep(0.1), 100);
  assert.equal(rulerStep(4), 5);
  assert.ok(rulerStep(0.025) * 0.025 >= 9);
});

test('dragging from a ruler commits one document guide and the corner clears it', () => {
  document.body.replaceChildren();
  const stage = document.createElement('div');
  const canvas = document.createElement('div');
  canvas.style.width = '1000px';
  canvas.style.height = '800px';
  stage.appendChild(canvas);
  document.body.appendChild(stage);
  Object.defineProperty(stage, 'getBoundingClientRect', {
    value: () => ({
      left: 0,
      top: 0,
      right: 1200,
      bottom: 900,
      width: 1200,
      height: 900,
      x: 0,
      y: 0,
      toJSON() {},
    }),
  });
  Object.defineProperty(canvas, 'getBoundingClientRect', {
    value: () => ({
      left: 100,
      top: 100,
      right: 1100,
      bottom: 900,
      width: 1000,
      height: 800,
      x: 100,
      y: 100,
      toJSON() {},
    }),
  });
  (
    dom.window.Element.prototype as unknown as { setPointerCapture(id: number): void }
  ).setPointerCapture = () => {};
  (
    dom.window.Element.prototype as unknown as { hasPointerCapture(id: number): boolean }
  ).hasPointerCapture = () => false;

  let value = '';
  const commits: string[] = [];
  const handle = mountDesignGuides({
    stageEl: stage,
    canvasEl: canvas,
    read: () => value,
    commit: (next) => {
      value = next;
      commits.push(next);
    },
  });
  const top = handle.el.querySelector<HTMLElement>('.fc-ruler-x')!;
  const pointer = (type: string, x: number, y: number): void => {
    const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, { button: 0, pointerId: 7, clientX: x, clientY: y, shiftKey: false });
    top.dispatchEvent(event);
  };
  pointer('pointerdown', 300, 100);
  pointer('pointermove', 300, 220);
  pointer('pointerup', 300, 220);

  assert.equal(commits.length, 1, 'one write on pointer release, never one per move');
  assert.deepEqual(handle.snapTargets(), { x: [], y: [120] });
  assert.equal(
    handle.el.querySelector('.fc-author-guide-y')?.getAttribute('aria-label'),
    'Horizontal guide at 120 px'
  );

  (handle.el.querySelector('.fc-ruler-corner') as HTMLButtonElement).click();
  assert.equal(value, '');
  assert.equal(handle.hasGuides(), false);
  handle.destroy();
  assert.equal(handle.el.isConnected, false);
});
