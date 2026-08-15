// SPDX-License-Identifier: MPL-2.0
/**
 * sequence-dom tests — the applier that puts a timed composition's LIVE DOM at a time.
 *
 * This module is the one copy of the "which box is on screen at t, and what does its
 * transition compose on top of the authored styles" logic. views/sequence-clock.ts
 * (the preview playhead) and bridge/export.ts renderLive ("Record live", which has to
 * advance the playhead itself while a MediaRecorder films the page) both go through
 * it, so the three things asserted here are the ones a drift would silently break:
 *
 *   • the AUTHORED transform survives — a box the user rotated stays rotated while an
 *     entrance animation plays over it (the composition bug this module exists for);
 *   • `seq-off` toggles on the half-open window boundaries, not a frame either side;
 *   • restore() leaves the DOM exactly as it was found, attribute string included.
 *
 * The pure readers (readTiming/isActiveAt/transitionAt/compose*) and applyTimeToElements
 * are already covered against jsdom in views/sequence-clock.test.ts, which imports them
 * through the clock's re-export — that suite is the parity check that the move did not
 * change behaviour, so it is not duplicated here.
 *
 * NOT covered (browser-only, stated plainly): the actual live capture. renderLive needs
 * getDisplayMedia + MediaRecorder + a compositor, so "the recorded webm contains motion"
 * can only be verified by exporting from a real browser. What is testable headlessly is
 * that the driver advances the DOM over wall-clock time and restores it — below.
 *
 * Run directly:  node --test shells/web/src/bridge/sequence-dom.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!DOCTYPE html><body></body>');
for (const k of ['window', 'document', 'HTMLElement', 'Element', 'Node']) {
  (globalThis as Record<string, unknown>)[k] = (dom.window as unknown as Record<string, unknown>)[k];
}

const {
  applySequenceTime, restoreSequenceTime, createSequenceTime, driveSequenceTime,
  sequenceStageOf, sequenceDurationMs, OFF_CLASS, SHOT_CLASS, BORROW_ATTR,
  releaseShotBorrow,
} = await import('./sequence-dom.ts');

/**
 * A two-clip magnetic row: `a` [0,1000) with a 400ms "rise" in and an AUTHORED rotation,
 * `b` [1000,2000). Mirrors what sequence-studio's hook stamps.
 */
function stage(): HTMLElement {
  const root = dom.window.document.createElement('div');
  root.innerHTML = `
    <div class="artboard" data-sequence data-seq-ms="2000">
      <div class="lolly-box" data-box-id="a" data-t-start="0" data-t-dur="1000"
           data-t-lane="seq" data-t-enter="rise" data-t-enter-ms="400"
           style="left:0px;top:0px;width:100px;height:50px;transform:rotate(-4deg);opacity:0.8"></div>
      <div class="lolly-box" data-box-id="b" data-t-start="1000" data-t-dur="1000"
           data-t-lane="seq" style="left:0px;top:0px;width:100px;height:50px"></div>
    </div>`;
  return root;
}

const box = (root: HTMLElement, id: string): HTMLElement =>
  root.querySelector<HTMLElement>(`[data-box-id="${id}"]`)!;
const off = (el: HTMLElement): boolean => el.classList.contains(OFF_CLASS);
/**
 * Every declaration the applier is allowed to touch, per box.
 *
 * Deliberately NOT innerHTML: writing through CSSStyleDeclaration re-serialises the
 * whole `style` attribute (`a:0px;b:1px` becomes `a: 0px; b: 1px;`), which the module
 * documents as declaration-identical rather than byte-identical. Comparing the parsed
 * declarations is the contract; comparing the string would be testing jsdom's
 * serialiser.
 */
const snapshot = (root: HTMLElement): string => JSON.stringify(
  [...root.querySelectorAll<HTMLElement>('.lolly-box')].map((el) => ({
    cls: [...el.classList].sort(),
    style: (el.getAttribute('style') || '')
      .split(';').map(d => d.replace(/\s+/g, '')).filter(Boolean).sort(),
  })));

test('reads the stage and its declared length off the DOM', () => {
  const root = stage();
  assert.ok(sequenceStageOf(root), 'finds the [data-sequence] artboard below the root');
  assert.equal(sequenceDurationMs(root), 2000);
  assert.equal(sequenceDurationMs(dom.window.document.createElement('div')), 0,
    'an untimed node has no length (and is not a sequence)');
});

test('seq-off follows the HALF-OPEN window, on both boundaries', () => {
  const root = stage();
  const a = box(root, 'a'), b = box(root, 'b');

  applySequenceTime(root, 0);
  assert.equal(off(a), false, 'a is on at its own start');
  assert.equal(off(b), true, 'b has not begun');

  applySequenceTime(root, 999);
  assert.equal(off(a), false, 'a is still on one ms before its end');
  assert.equal(off(b), true);

  // The frame at exactly start+dur belongs to the NEXT clip — this is what makes a
  // gapless row cut cleanly instead of flashing both clips for one frame.
  applySequenceTime(root, 1000);
  assert.equal(off(a), true, 'a is off at exactly start+dur');
  assert.equal(off(b), false, 'b is on at exactly its start');

  applySequenceTime(root, 2000);
  assert.equal(off(b), true, 'past the end nothing is on screen');
  restoreSequenceTime(root);
});

// ── the thumbnail shot's borrow ─────────────────────────────────────────────
//
// lib/clip-thumbs.ts photographs an off-playhead box by lifting `seq-off` and parking the
// box 200vw away for up to 1.5s. The applier is the authority on visibility for that whole
// window, not just after the shot settles: scrubbing onto a parked box used to leave the
// LIVE scene off the viewport (a black stage) until the shot popped it back.

/** Exactly what borrowVisibility does to a box it is about to photograph. */
function borrow(el: HTMLElement, token = 't1'): void {
  el.classList.remove(OFF_CLASS);
  el.classList.add(SHOT_CLASS);
  el.setAttribute(BORROW_ATTR, token);
}

test('making a borrowed box ACTIVE revokes the lease and un-parks it', () => {
  const root = stage();
  const a = box(root, 'a');

  applySequenceTime(root, 1500);                 // a is off screen: photographable
  assert.equal(off(a), true);
  borrow(a);

  applySequenceTime(root, 200);                  // the user scrubs onto a, mid-shot
  assert.equal(off(a), false, 'the live scene is not hidden');
  assert.equal(a.classList.contains(SHOT_CLASS), false,
    'and not parked 200vw off the viewport either — this was the black stage');
  assert.equal(a.hasAttribute(BORROW_ATTR), false, 'the lease is revoked, so the restore stands down');
  restoreSequenceTime(root);
});

test('an INACTIVE box keeps what the shot borrowed — re-hiding it would photograph the blank', () => {
  const root = stage();
  const a = box(root, 'a');

  applySequenceTime(root, 1500);
  borrow(a);
  applySequenceTime(root, 1600);                 // another tick while a is still off screen
  assert.equal(off(a), false, 'the shot still owns the class it borrowed');
  assert.equal(a.classList.contains(SHOT_CLASS), true, 'and is still parked, so nothing shows');
  assert.equal(a.getAttribute(BORROW_ATTR), 't1', 'lease intact: the restore will re-hide it');
  restoreSequenceTime(root);
});

test('restore takes the lease with it, so a late restore cannot re-hide anything', () => {
  const root = stage();
  const a = box(root, 'a');
  applySequenceTime(root, 1500);
  borrow(a);
  restoreSequenceTime(root);
  assert.equal(a.hasAttribute(BORROW_ATTR), false);
  assert.equal(a.classList.contains(SHOT_CLASS), false);
});

test('releaseShotBorrow un-parks the BOX when the borrow was taken on a descendant', () => {
  const root = stage();
  const a = box(root, 'a');
  const kid = dom.window.document.createElement('div');
  a.appendChild(kid);
  a.classList.add(SHOT_CLASS);
  kid.setAttribute(BORROW_ATTR, 't9');

  releaseShotBorrow(kid);
  assert.equal(a.classList.contains(SHOT_CLASS), false, 'the park is on the box, the lease on the child');
  assert.equal(kid.hasAttribute(BORROW_ATTR), false);
  // Nothing borrowed, nothing to do — and no throw on a box that was never parked.
  releaseShotBorrow(box(root, 'b'));
});

test('an enter transition composes with the AUTHORED rotation instead of clobbering it', () => {
  const root = stage();
  const a = box(root, 'a');

  // Mid-transition: 200ms into a 400ms "rise" (it translates AND fades, so both the
  // transform and the opacity have to compose rather than replace).
  applySequenceTime(root, 200);
  const tr = a.style.transform;
  assert.match(tr, /rotate\(-4deg\)/, "the author's own rotation is still in the transform");
  assert.match(tr, /^translate\(/, 'the animation translate goes OUTSIDE the authored transform');
  assert.ok(tr.indexOf('translate(') < tr.indexOf('rotate(-4deg)'),
    'order is translate -> authored -> anim, matching the compositor\'s matrix order');
  // Authored opacity 0.8 × the transition's alpha — never replaced by the alpha alone.
  const mid = parseFloat(a.style.opacity);
  assert.ok(mid > 0 && mid < 0.8, `authored 0.8 is multiplied down mid-transition, got ${a.style.opacity}`);

  // At rest the authored declarations are handed straight back.
  applySequenceTime(root, 600);
  assert.equal(a.style.transform, 'rotate(-4deg)');
  assert.equal(a.style.opacity, '0.8');
  restoreSequenceTime(root);
});

test('restore leaves the DOM exactly as it was found', () => {
  const root = stage();
  const before = snapshot(root);

  applySequenceTime(root, 150);
  applySequenceTime(root, 1200);
  assert.notEqual(snapshot(root), before, 'the applier really did write something');

  restoreSequenceTime(root);
  assert.equal(snapshot(root), before, 'every class and inline property is back');

  // And a second restore is a no-op rather than an error.
  restoreSequenceTime(root);
  assert.equal(snapshot(root), before);
});

test('a session is reusable and its restore is the same guarantee', () => {
  const root = stage();
  const before = snapshot(root);
  const s = createSequenceTime(root);
  assert.equal(s.durationMs(), 2000);
  for (const t of [0, 100, 500, 1000, 1500, 1999]) s.apply(t);
  s.restore();
  assert.equal(snapshot(root), before);
});

// ── the live driver ─────────────────────────────────────────────────────────

/** A fake wall clock + scheduler, so the driver runs deterministically. */
function fakeClock() {
  let t = 0;
  const queue: Array<{ at: number; fn: () => void }> = [];
  return {
    now: () => t,
    schedule: (fn: () => void, ms: number) => {
      const item = { at: t + ms, fn };
      queue.push(item);
      return () => { const i = queue.indexOf(item); if (i >= 0) queue.splice(i, 1); };
    },
    /** Advance to `ms`, running everything due on the way. */
    advance(ms: number) {
      const end = t + ms;
      for (;;) {
        const next = queue.filter(q => q.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        queue.splice(queue.indexOf(next), 1);
        t = next.at;
        next.fn();
      }
      t = end;
    },
    pending: () => queue.length,
  };
}

test('driveSequenceTime advances the playhead over wall-clock time', () => {
  const root = stage();
  const a = box(root, 'a'), b = box(root, 'b');
  const clock = fakeClock();
  const d = driveSequenceTime(root, { durationMs: 2000, fps: 10, now: clock.now, schedule: clock.schedule });

  d.start();
  assert.equal(off(a), false, 'frame 0 is applied synchronously on start — no blank first frame');
  assert.equal(off(b), true);

  clock.advance(1200);
  assert.equal(off(a), true, 'a has ended by t=1200');
  assert.equal(off(b), false, 'b is on screen — the DOM really moved without anyone scrubbing');

  // Past the end the last frame is HELD (a recorder may still be rolling); the loop
  // stops rather than spinning.
  clock.advance(2000);
  assert.equal(clock.pending(), 0, 'the driver stopped scheduling at the end');
  d.stop();
});

test('driveSequenceTime restores the DOM on stop, even mid-clip', () => {
  const root = stage();
  const before = snapshot(root);
  const clock = fakeClock();
  const d = driveSequenceTime(root, { durationMs: 2000, fps: 10, now: clock.now, schedule: clock.schedule });
  d.start();
  clock.advance(700);
  assert.notEqual(snapshot(root), before);

  d.stop();
  assert.equal(snapshot(root), before, 'stop puts every authored declaration back');
  assert.equal(clock.pending(), 0, 'and cancels the pending tick');

  // stop() before start(), and a double stop, are both no-ops.
  const d2 = driveSequenceTime(root, { durationMs: 100, now: clock.now, schedule: clock.schedule });
  d2.stop(); d2.stop();
  assert.equal(snapshot(root), before);
});

// ── authored easing ─────────────────────────────────────────────────────────
//
// The ease is a per-PHASE string on the box (`data-t-enter-ease` / `data-t-exit-ease`)
// that governs the transition's GEOMETRY only. The three properties worth pinning are
// the ones a regression would be invisible in: an unauthored box is byte-identical to
// what it rendered before the control existed, an authored one actually moves, and
// junk falls back rather than throwing mid-frame.

/** The same two-clip row, with an ease of the caller's choosing on `a`'s entrance. */
function easedStage(ease: string | null): HTMLElement {
  const root = stage();
  const a = box(root, 'a');
  if (ease === null) a.removeAttribute('data-t-enter-ease');
  else a.setAttribute('data-t-enter-ease', ease);
  return root;
}

/** `a`'s inline transform 100 ms into its 400 ms rise — a quarter of the way in. */
function riseTransform(ease: string | null): string {
  const root = easedStage(ease);
  applySequenceTime(root, 100);
  const out = box(root, 'a').style.transform;
  restoreSequenceTime(root);
  return out;
}

test('an unauthored ease renders exactly what it rendered before the control existed', () => {
  const bare = riseTransform(null);
  assert.equal(riseTransform(''), bare, 'an empty attribute is the same as no attribute');
  assert.ok(/translate\(/.test(bare), 'the rise is still animating at t=100');
});

test('an authored ease moves the geometry, and a preset agrees with its own bezier', () => {
  const bare = riseTransform(null);
  const linear = riseTransform('linear');
  assert.notEqual(linear, bare, 'linear is not the built-in easeOutCubic');
  // The preset name and the curve it stands for are the same authored value.
  assert.equal(riseTransform('cubic-bezier(0,0,1,1)'), linear);
  assert.notEqual(riseTransform('overshoot'), linear);
});

test('a junk ease falls back to the preset\'s own curve rather than throwing', () => {
  const bare = riseTransform(null);
  for (const junk of ['wobble', 'cubic-bezier(0,0,1)', 'cubic-bezier(2,0,1,1)', 'cubic-bezier(a,b,c,d)', '<script>']) {
    assert.equal(riseTransform(junk), bare, junk);
  }
});

test('the ease reaches the driver too — a live take is eased like the preview', () => {
  const clock = fakeClock();
  const runAt = (ease: string | null): string => {
    const root = easedStage(ease);
    const d = driveSequenceTime(root, { durationMs: 2000, fps: 10, now: clock.now, schedule: clock.schedule });
    d.start();
    clock.advance(100);
    const out = box(root, 'a').style.transform;
    d.stop();
    return out;
  };
  assert.equal(runAt(null), riseTransform(null));
  assert.equal(runAt('linear'), riseTransform('linear'));
});

// ── frames AS scenes: the applier gates [data-pdf-page] frame pages too (plan 92) ──────
// A sequenced Design frame doc has NO `.lolly-box` on the seq lane — its scenes are
// [data-pdf-page] frame pages carrying data-t-start/data-t-dur. The SAME generic
// [data-t-start] applier gates them: the page whose [start,start+dur) holds t stays
// visible, the others get `.seq-off` — a slide at a time. There is no [data-sequence]
// stage in a frames doc, so this also exercises the sequenceStageOf → root fallback.

function framesStage(): HTMLElement {
  const root = dom.window.document.createElement('div');
  root.innerHTML = `
    <div class="lolly-frames">
      <div class="lolly-frame-page" data-pdf-page data-t-start="0" data-t-dur="3000" data-t-lane="seq"
           style="position:absolute;left:0px;top:0px;width:800px;height:600px"></div>
      <div class="lolly-frame-page" data-pdf-page data-t-start="3000" data-t-dur="3000" data-t-lane="seq"
           style="position:absolute;left:1000px;top:0px;width:800px;height:600px"></div>
    </div>`;
  return root;
}
const pageAt = (root: HTMLElement, i: number): HTMLElement =>
  [...root.querySelectorAll<HTMLElement>('[data-pdf-page]')][i]!;

test('applySequenceTime gates frame pages: the inactive page gets seq-off, the active one does not', () => {
  const root = framesStage();
  const a = pageAt(root, 0), b = pageAt(root, 1);

  applySequenceTime(root, 1500);   // inside frame A [0,3000)
  assert.equal(off(a), false, 'frame A is active at t=1.5s');
  assert.equal(off(b), true, 'frame B is hidden (its window starts at 3s)');

  applySequenceTime(root, 4500);   // inside frame B [3000,6000)
  assert.equal(off(a), true, 'frame A is now hidden');
  assert.equal(off(b), false, 'frame B is active at t=4.5s');

  // Half-open boundary: at exactly 3000 the cut belongs to B, not A.
  applySequenceTime(root, 3000);
  assert.equal(off(a), true, 'A ends at its half-open boundary');
  assert.equal(off(b), false, 'B owns the frame at exactly its start');

  restoreSequenceTime(root);
  assert.equal(off(a), false, 'restore lifts seq-off from every page');
  assert.equal(off(b), false);
});

test('an untimed (spatial) frame page is never gated', () => {
  const root = dom.window.document.createElement('div');
  root.innerHTML = `
    <div class="lolly-frames">
      <div class="lolly-frame-page" data-pdf-page style="position:absolute;left:0px;top:0px;width:800px;height:600px"></div>
    </div>`;
  applySequenceTime(root, 5000);
  assert.equal(off(pageAt(root, 0)), false, 'a page with no data-t-start is never selected or hidden');
  restoreSequenceTime(root);
});
