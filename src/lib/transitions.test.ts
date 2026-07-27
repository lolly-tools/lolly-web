// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TRANSITIONS, TRANSITION_KINDS, DEFAULT_TRANSITION,
  isTransitionKind, transitionLabel,
  easeOutCubic, easeOutBack, recTransition,
} from './transitions.ts';

const W = 320, H = 180;
const near = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) <= eps;

test('every kind settles to identity at p = 1', () => {
  for (const kind of TRANSITION_KINDS) {
    const t = recTransition(kind, 1, W, H);
    assert.ok(near(t.dx, 0), `${kind} dx=${t.dx}`);
    assert.ok(near(t.dy, 0), `${kind} dy=${t.dy}`);
    assert.ok(near(t.sc, 1), `${kind} sc=${t.sc}`);
    assert.ok(near(t.alpha, 1), `${kind} alpha=${t.alpha}`);
    assert.ok(near(t.rot, 0), `${kind} rot=${t.rot}`);
  }
});

test('every kind returns finite numbers across the whole ramp', () => {
  for (const kind of TRANSITION_KINDS) {
    for (const p of [0, 0.1, 0.25, 0.4, 0.5, 0.6, 0.75, 0.9, 1]) {
      const t = recTransition(kind, p, W, H);
      for (const [k, v] of Object.entries(t)) {
        assert.ok(Number.isFinite(v), `${kind} @${p} ${k}=${v}`);
      }
      assert.ok(t.alpha >= 0 && t.alpha <= 1, `${kind} @${p} alpha out of range: ${t.alpha}`);
      assert.ok(t.sc > 0, `${kind} @${p} non-positive scale: ${t.sc}`);
    }
  }
});

test('at p = 0 every animated kind is fully transparent, and none is a hard cut', () => {
  for (const kind of TRANSITION_KINDS) {
    const t = recTransition(kind, 0, W, H);
    if (kind === 'none') {
      assert.deepEqual(t, { dx: 0, dy: 0, sc: 1, alpha: 1, rot: 0 });
    } else {
      assert.equal(t.alpha, 0, `${kind} should start invisible`);
    }
  }
});

test('p is clamped to [0,1] — out-of-range progress never overshoots', () => {
  for (const kind of TRANSITION_KINDS) {
    assert.deepEqual(recTransition(kind, -5, W, H), recTransition(kind, 0, W, H), kind);
    assert.deepEqual(recTransition(kind, 12, W, H), recTransition(kind, 1, W, H), kind);
  }
});

test('slide distances scale with the object own size', () => {
  const small = recTransition('slide-left', 0, 100, 100);
  const big = recTransition('slide-left', 0, 1000, 100);
  assert.ok(big.dx > small.dx);
  // rise/drop take their distance from the HEIGHT, slides from the WIDTH.
  assert.equal(recTransition('rise', 0, 100, 200).dy, recTransition('rise', 0, 9999, 200).dy);
});

test('an unknown kind is a safe no-op fade, never a throw', () => {
  const t0 = recTransition('does-not-exist', 0, W, H);
  assert.deepEqual(t0, { dx: 0, dy: 0, sc: 1, alpha: 0, rot: 0 });
  const t1 = recTransition('does-not-exist', 1, W, H);
  assert.deepEqual(t1, { dx: 0, dy: 0, sc: 1, alpha: 1, rot: 0 });
  // Prototype keys reaching the compositor as a "kind" must behave the same way.
  for (const k of ['constructor', 'toString', 'valueOf', '__proto__', 'hasOwnProperty']) {
    assert.deepEqual(recTransition(k, 1, W, H), t1, k);
  }
});

test('isTransitionKind accepts every registry key', () => {
  for (const kind of TRANSITION_KINDS) assert.equal(isTransitionKind(kind), true, kind);
  assert.equal(isTransitionKind(DEFAULT_TRANSITION), true);
});

test('isTransitionKind rejects prototype keys, non-strings and near-misses', () => {
  for (const bad of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString']) {
    assert.equal(isTransitionKind(bad), false, bad);
  }
  for (const bad of [undefined, null, 0, 1, NaN, true, false, {}, [], ['fade'], new String('fade'), Symbol('fade'), () => 'fade']) {
    assert.equal(isTransitionKind(bad), false, String(typeof bad));
  }
  for (const bad of ['', ' fade', 'FADE', 'slide', 'slide_left', 'Fade']) {
    assert.equal(isTransitionKind(bad), false, JSON.stringify(bad));
  }
});

test('the registry is frozen and its keys stay in sync with the kind list', () => {
  assert.ok(Object.isFrozen(TRANSITIONS));
  assert.deepEqual([...TRANSITION_KINDS], Object.keys(TRANSITIONS));
  for (const kind of TRANSITION_KINDS) assert.equal(typeof TRANSITIONS[kind], 'string');
});

test('the wire values the sidebar stores keep their slots', () => {
  // Slot pins, not an exhaustive list: kinds may be APPENDED, never renamed or reordered.
  assert.equal(TRANSITION_KINDS[0], 'fade');
  assert.equal(TRANSITION_KINDS[5], 'slide-left');
  assert.equal(TRANSITION_KINDS[TRANSITION_KINDS.indexOf('slide-left') + 1], 'slide-right');
  assert.equal(DEFAULT_TRANSITION, 'none');
  assert.ok(TRANSITION_KINDS.includes('none'));
});

test('transitionLabel falls back to the raw value for an unknown kind', () => {
  assert.equal(transitionLabel('fade'), 'Fade');
  assert.equal(transitionLabel('none'), 'Cut (no animation)');
  assert.equal(transitionLabel('constructor'), 'constructor');
  assert.equal(transitionLabel(undefined), '');
  assert.equal(transitionLabel(null), '');
});

test('easeOutCubic is monotonic on [0,1] with 0→0 and 1→1', () => {
  assert.equal(easeOutCubic(0), 0);
  assert.equal(easeOutCubic(1), 1);
  let prev = -Infinity;
  for (let i = 0; i <= 200; i++) {
    const v = easeOutCubic(i / 200);
    assert.ok(v > prev, `not increasing at t=${i / 200}`);
    assert.ok(v >= 0 && v <= 1, `out of range at t=${i / 200}: ${v}`);
    prev = v;
  }
});

test('easeOutBack pins its endpoints and overshoots exactly once', () => {
  assert.ok(near(easeOutBack(0), 0, 1e-12));
  assert.equal(easeOutBack(1), 1);
  // It is deliberately NOT monotonic: it rises past 1, then settles back — that
  // overshoot is what makes `pop` pop. Assert the shape rather than monotonicity.
  let peak = -Infinity, peakAt = 0;
  for (let i = 0; i <= 1000; i++) {
    const t = i / 1000;
    const v = easeOutBack(t);
    if (v > peak) { peak = v; peakAt = t; }
  }
  assert.ok(peak > 1, `expected an overshoot, peak=${peak}`);
  assert.ok(peakAt > 0.4 && peakAt < 0.8, `overshoot should sit mid-ramp, at ${peakAt}`);
  // Monotonic up to the peak, monotonic down after it — one hump, no ringing.
  let prev = -Infinity;
  for (let t = 0; t <= peakAt; t += 0.005) { const v = easeOutBack(t); assert.ok(v > prev); prev = v; }
  prev = Infinity;
  for (let t = peakAt + 0.005; t <= 1; t += 0.005) { const v = easeOutBack(t); assert.ok(v < prev); prev = v; }
});

test('only pop and zoom-out ever exceed their resting scale', () => {
  const overshoots = TRANSITION_KINDS.filter((kind) => {
    for (let i = 0; i <= 100; i++) if (recTransition(kind, i / 100, W, H).sc > 1.0000001) return true;
    return false;
  });
  assert.deepEqual(overshoots.sort(), ['pop', 'zoom-out']);
});
