// SPDX-License-Identifier: MPL-2.0
/**
 * Presentation-mode conductor (plan 112, M1) - DOM sanity tests under jsdom.
 *
 * Asserts the state-class CONTRACT (pr-active/pr-past/pr-future + pr-next, the hidden
 * window), navigation (keys + go()), the HUD counter, the debounced-URL callback surface,
 * `?s=` deep-link resolution, and - the plan's #1 risk - that the ORIGINAL frame pages are
 * never mutated (the presenter clones), so exit is byte-identical.
 *
 * Run directly:  node --test shells/web/src/views/present-mode.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// jsdom realm BEFORE the module loads - present-mode.ts pulls in i18n/icons/a11y-prefs,
// which read browser globals; a dynamic import after this setup guarantees they exist.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://lolly.tools/' });
const win = dom.window as unknown as Window & typeof globalThis;
globalThis.window = win;
globalThis.document = dom.window.document;
// jsdom has no matchMedia; a benign stub keeps prefersReducedMotion() → false (no reduce).
win.matchMedia = ((q: string) => ({
  matches: false, media: q, onchange: null,
  addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
  dispatchEvent() { return false; },
})) as unknown as typeof win.matchMedia;
// jsdom's HTMLMediaElement.play/pause throw "Not implemented"; record play state instead so
// the conduct tests can read which slide's video is playing.
type Playable = HTMLVideoElement & { __playing?: boolean };
win.HTMLMediaElement.prototype.play = function (this: Playable) { this.__playing = true; return Promise.resolve(); };
win.HTMLMediaElement.prototype.pause = function (this: Playable) { this.__playing = false; };

const { openPresentMode } = await import('./present-mode.ts');

/** Build a fresh source scope with N frame pages (ids slideK, laid out left→right). */
function makeSource(ids: string[]): HTMLElement {
  const src = document.createElement('div');
  src.id = 'tool-content';
  let x = 0;
  for (const id of ids) {
    const page = document.createElement('div');
    page.className = 'lolly-frame-page';
    page.setAttribute('data-pdf-page', '');
    page.setAttribute('data-frame-id', id);
    page.style.cssText = `position:absolute;left:${x}px;top:0px;width:1920px;height:1080px;background:#fff;overflow:hidden;`;
    page.textContent = id;
    src.appendChild(page);
    x += 2000;
  }
  document.body.appendChild(src);
  return src;
}

/** A source whose frames can carry a kiosk `dur` (ms), a `<video>` (optionally opted into
 *  present audio), and/or `data-build` fragment boxes. */
function makeRichSource(
  frames: Array<{ id: string; dur?: number; video?: boolean; audio?: boolean; builds?: number[]; state?: string; notes?: string }>,
): HTMLElement {
  const src = document.createElement('div');
  src.id = 'tool-content';
  let x = 0;
  for (const f of frames) {
    const page = document.createElement('div');
    page.className = 'lolly-frame-page';
    page.setAttribute('data-pdf-page', '');
    page.setAttribute('data-frame-id', f.id);
    if (f.dur != null) page.setAttribute('data-frame-dur', String(f.dur));
    if (f.state != null) page.setAttribute('data-frame-state', f.state);
    if (f.notes != null) page.setAttribute('data-frame-notes', f.notes);
    page.style.cssText = `position:absolute;left:${x}px;top:0px;width:1920px;height:1080px;`;
    if (f.video) {
      const v = document.createElement('video');
      v.setAttribute('data-video-key', `vk-${f.id}`);
      if (f.audio) v.setAttribute('data-present-audio', '1');
      v.muted = true;
      page.appendChild(v);
    }
    for (const b of f.builds ?? []) {
      const box = document.createElement('div');
      box.className = 'lolly-box';
      box.setAttribute('data-box-id', `${f.id}-b${b}`);
      box.setAttribute('data-build', String(b));
      page.appendChild(box);
    }
    src.appendChild(page);
    x += 2000;
  }
  document.body.appendChild(src);
  return src;
}

/** The clone's build boxes with a given `data-build` value. */
function buildBoxes(cloneIndex: number, value: number): HTMLElement[] {
  return [...document.body.querySelectorAll<HTMLElement>(
    `.pr-stage .pr-page[data-pr-index="${cloneIndex}"] [data-build="${value}"]`,
  )];
}
const shown = (els: HTMLElement[]) => els.every((e) => e.classList.contains('pr-shown'));

/** The <video> inside the clone at a given walk index (in the stage, not the source). */
function cloneVideo(i: number): Playable | null {
  return document.body.querySelector<Playable>(`.pr-stage .pr-page[data-pr-index="${i}"] video`);
}
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function stageEl(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('.pr-stage');
}
function clones(): HTMLElement[] {
  return [...document.body.querySelectorAll<HTMLElement>('.pr-stage .pr-page')];
}
function cleanup(): void {
  for (const s of document.body.querySelectorAll('.pr-stage')) s.remove();
  for (const s of document.body.querySelectorAll('#tool-content')) s.remove();
}

test('opens a stage of cloned pages; originals are NOT mutated', () => {
  const src = makeSource(['slide1', 'slide2', 'slide3']);
  const originalCss = [...src.querySelectorAll<HTMLElement>('.lolly-frame-page')].map((p) => p.style.cssText);
  const ctl = openPresentMode({ source: src });
  assert.ok(ctl, 'a controller is returned when frames exist');
  assert.ok(stageEl(), 'a .pr-stage is appended to the body');
  assert.equal(clones().length, 3, 'three page clones');
  // Originals: no presenter classes, no touched inline styles, still in the source.
  const origs = [...src.querySelectorAll<HTMLElement>('.lolly-frame-page')];
  assert.equal(origs.length, 3, 'originals still under the source');
  origs.forEach((p, i) => {
    assert.equal(p.style.cssText, originalCss[i], `original ${i} inline style untouched`);
    assert.ok(!p.className.includes('pr-'), `original ${i} carries no presenter class`);
    assert.equal(p.hasAttribute('hidden'), false, `original ${i} not hidden`);
  });
  ctl!.close();
  cleanup();
});

test('initial render: state-class contract + hidden window + HUD counter', () => {
  const src = makeSource(['slide1', 'slide2', 'slide3']);
  const addr: Array<{ id: string; i: number }> = [];
  const ctl = openPresentMode({ source: src, onAddress: (id, i) => addr.push({ id, i }) })!;
  const c = clones();
  // active = 0 → present; 1 → future+next (live); 2 → future, hidden (|2−0| > 1).
  assert.ok(c[0]!.classList.contains('pr-active'), 'slide1 active');
  assert.ok(c[1]!.classList.contains('pr-future'), 'slide2 future');
  assert.ok(c[1]!.classList.contains('pr-next'), 'slide2 is the next neighbour');
  assert.equal(c[1]!.hasAttribute('hidden'), false, 'the ±1 neighbour stays live');
  assert.ok(c[2]!.classList.contains('pr-future'), 'slide3 future');
  assert.equal(c[2]!.hasAttribute('hidden'), true, 'slide3 is beyond the live window → unloaded');
  // HUD counter.
  const counter = stageEl()!.querySelector('.pr-counter')!;
  assert.equal(counter.textContent, '1 / 3');
  // onAddress fired for the opening slide (reorder-proof id).
  assert.deepEqual(addr.at(-1), { id: 'slide1', i: 0 });
  assert.equal(ctl.frameId, 'slide1');
  ctl.close();
  cleanup();
});

test('ArrowRight advances; classes + counter + address follow', () => {
  const src = makeSource(['slide1', 'slide2', 'slide3']);
  const addr: string[] = [];
  const ctl = openPresentMode({ source: src, onAddress: (id) => addr.push(id) })!;
  document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowRight' }));
  const c = clones();
  assert.ok(c[1]!.classList.contains('pr-active'), 'slide2 now active');
  assert.ok(c[0]!.classList.contains('pr-past'), 'slide1 now past');
  assert.equal(stageEl()!.dataset.navDir, 'right', 'travel direction recorded on the root');
  assert.equal(stageEl()!.querySelector('.pr-counter')!.textContent, '2 / 3');
  assert.equal(ctl.frameId, 'slide2');
  assert.equal(addr.at(-1), 'slide2', 'address callback got the new frame id');
  // ArrowLeft goes back.
  document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowLeft' }));
  assert.ok(clones()[0]!.classList.contains('pr-active'), 'back to slide1');
  assert.equal(stageEl()!.dataset.navDir, 'left');
  ctl.close();
  cleanup();
});

test('does not advance past the end without loop; wraps with loop', () => {
  const src = makeSource(['a', 'b']);
  const noLoop = openPresentMode({ source: src })!;
  noLoop.go('2'); // to the last
  document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowRight' }));
  assert.equal(noLoop.frameId, 'b', 'clamped at the end');
  noLoop.close(); cleanup();

  const src2 = makeSource(['a', 'b']);
  const looped = openPresentMode({ source: src2, loop: true })!;
  looped.go('2');
  document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowRight' }));
  assert.equal(looped.frameId, 'a', 'wraps to the first with loop');
  looped.close(); cleanup();
});

test('?s= deep-links: numeric position and frame id', () => {
  const byPos = openPresentMode({ source: makeSource(['x', 'y', 'z']), initial: '2' })!;
  assert.equal(byPos.frameId, 'y', 's=2 opens the second slide');
  byPos.close(); cleanup();

  const byId = openPresentMode({ source: makeSource(['x', 'y', 'z']), initial: 'z' })!;
  assert.equal(byId.frameId, 'z', 's=z opens that frame by id');
  byId.close(); cleanup();

  const junk = openPresentMode({ source: makeSource(['x', 'y']), initial: 'nope' })!;
  assert.equal(junk.frameId, 'x', 'an unresolvable address falls back to the first');
  junk.close(); cleanup();
});

test('overview toggles a class and reveals every page; O key + Escape peel it', () => {
  const src = makeSource(['a', 'b', 'c']);
  const ctl = openPresentMode({ source: src })!;
  document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'o' }));
  assert.ok(ctl.overview, 'O enters overview');
  assert.ok(stageEl()!.classList.contains('pr-overview'));
  // Every page is revealed in the map (none hidden).
  assert.ok(clones().every((c) => !c.hasAttribute('hidden')), 'no page unloaded in overview');
  // Escape peels overview back to the deck (not exit).
  document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape' }));
  assert.equal(ctl.overview, false, 'Escape leaves overview first');
  assert.ok(stageEl(), 'still presenting after peeling overview');
  ctl.close(); cleanup();
});

test('close() removes the stage, restores page scroll, and fires onClose exactly once', () => {
  const src = makeSource(['a', 'b']);
  document.documentElement.style.overflow = ''; // resting state
  let closes = 0;
  const ctl = openPresentMode({ source: src, onClose: () => closes++ })!;
  assert.equal(document.documentElement.style.overflow, 'hidden', 'scroll locked while presenting');
  ctl.close();
  assert.equal(stageEl(), null, 'stage removed on close');
  assert.equal(document.documentElement.style.overflow, '', 'page scroll restored');
  assert.equal(ctl.frameId, null, 'controller reports closed');
  ctl.close(); // idempotent
  assert.equal(closes, 1, 'onClose fired exactly once');
  cleanup();
});

test('Escape exits the deck when not in overview and browser fullscreen is not held', () => {
  const src = makeSource(['a', 'b']);
  let closed = false;
  const ctl = openPresentMode({ source: src, onClose: () => { closed = true; } })!;
  document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape' }));
  assert.ok(closed, 'Escape exits presentation from the deck');
  assert.equal(stageEl(), null);
  cleanup();
});

// ── M2: media conduct + kiosk ──────────────────────────────────────────────────────

test('media conduct: only the active slide’s video plays; navigation moves playback', () => {
  const src = makeRichSource([{ id: 'a', video: true }, { id: 'b', video: true }, { id: 'c', video: true }]);
  const ctl = openPresentMode({ source: src })!;
  assert.equal(cloneVideo(0)!.__playing, true, 'active slide video plays');
  assert.equal(cloneVideo(1)!.__playing, false, 'non-active video paused');
  assert.equal(cloneVideo(2)!.__playing, false, 'non-active video paused');
  document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowRight' }));
  assert.equal(cloneVideo(0)!.__playing, false, 'left slide pauses (currentTime preserved → resume on return)');
  assert.equal(cloneVideo(1)!.__playing, true, 'new active plays');
  ctl.close(); cleanup();
});

test('kiosk: a frame with dur auto-advances; the pause button + progress bar appear', async () => {
  const src = makeRichSource([{ id: 'a', dur: 25 }, { id: 'b' }]);
  const ctl = openPresentMode({ source: src })!;
  // Deck has a dwell → pause button + progress bar exist and the bar is armed on slide 1.
  assert.ok(stageEl()!.querySelector('.pr-progress'), 'progress bar present when the deck has durs');
  assert.equal(ctl.frameId, 'a');
  await delay(80);
  assert.equal(ctl.frameId, 'b', 'auto-advanced after the dwell');
  // frame b has no dur and is the last → it stops there (no runaway).
  await delay(60);
  assert.equal(ctl.frameId, 'b', 'stays on the last, un-dwelled slide');
  ctl.close(); cleanup();
});

test('kiosk: k pauses auto-advance (stoppable); it does not advance while paused', async () => {
  const src = makeRichSource([{ id: 'a', dur: 25 }, { id: 'b', dur: 25 }, { id: 'c' }]);
  const ctl = openPresentMode({ source: src })!;
  document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'k' }));
  assert.ok(!stageEl()!.querySelector('.pr-progress')!.classList.contains('pr-progress-on'), 'progress off while paused');
  await delay(80);
  assert.equal(ctl.frameId, 'a', 'did not advance while paused');
  ctl.close(); cleanup();
});

test('blackout: b blacks the deck and pauses media; any key resumes without navigating', () => {
  const src = makeRichSource([{ id: 'a', video: true }, { id: 'b', video: true }]);
  const ctl = openPresentMode({ source: src })!;
  assert.equal(cloneVideo(0)!.__playing, true);
  document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'b' }));
  assert.ok(stageEl()!.classList.contains('pr-blackout'), 'deck goes black');
  assert.equal(cloneVideo(0)!.__playing, false, 'media pauses under blackout');
  // Any key lifts blackout and is spent doing so - it must NOT also advance.
  document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowRight' }));
  assert.equal(stageEl()!.classList.contains('pr-blackout'), false, 'resumed from black');
  assert.equal(ctl.frameId, 'a', 'the resume keystroke did not advance the deck');
  assert.equal(cloneVideo(0)!.__playing, true, 'active media resumes');
  ctl.close(); cleanup();
});

// ── M3: builds (fragments) ───────────────────────────────────────────────────────────

test('builds: fragments start hidden; advance reveals them step-by-step (equal values together)', () => {
  const src = makeRichSource([{ id: 'a', builds: [1, 2, 2, 3] }, { id: 'b' }]);
  const ctl = openPresentMode({ source: src })!;
  // build 0 → nothing revealed.
  assert.ok(!shown(buildBoxes(0, 1)), 'build 1 hidden at start');
  document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowRight' }));
  assert.ok(shown(buildBoxes(0, 1)), 'build 1 revealed');
  assert.ok(!shown(buildBoxes(0, 2)), 'build 2 still hidden');
  document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowRight' }));
  assert.ok(shown(buildBoxes(0, 2)), 'both build-2 boxes reveal together');
  assert.ok(!shown(buildBoxes(0, 3)), 'build 3 still hidden');
  document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowRight' }));
  assert.ok(shown(buildBoxes(0, 3)), 'build 3 revealed');
  assert.equal(ctl.frameId, 'a', 'still on slide a while its builds run');
  // builds exhausted → next advances the slide.
  document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowRight' }));
  assert.equal(ctl.frameId, 'b', 'exhausted builds → next slide');
  ctl.close(); cleanup();
});

test('builds: prev steps back through builds, then backward arrival shows all builds', () => {
  const src = makeRichSource([{ id: 'a', builds: [1, 2] }, { id: 'b' }]);
  const ctl = openPresentMode({ source: src })!;
  // advance through a's builds and onto b.
  for (let i = 0; i < 3; i++) document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowRight' }));
  assert.equal(ctl.frameId, 'b');
  // prev: back to a, arriving with ALL its builds shown.
  document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowLeft' }));
  assert.equal(ctl.frameId, 'a');
  assert.ok(shown(buildBoxes(0, 1)) && shown(buildBoxes(0, 2)), 'backward arrival reveals every build');
  // prev again steps the builds back down.
  document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowLeft' }));
  assert.ok(shown(buildBoxes(0, 1)) && !shown(buildBoxes(0, 2)), 'stepped build 2 back off');
  ctl.close(); cleanup();
});

test('builds: s=h.f deep-links to a build threshold; onAddress emits id.build', () => {
  const addr: Array<[string, number, number]> = [];
  const src = makeRichSource([{ id: 'a', builds: [1, 2, 3] }]);
  const ctl = openPresentMode({ source: src, initial: 'a.2', onAddress: (id, i, b) => addr.push([id, i, b]) })!;
  assert.equal(ctl.frameId, 'a');
  assert.ok(shown(buildBoxes(0, 1)) && shown(buildBoxes(0, 2)), 's=a.2 reveals builds 1–2');
  assert.ok(!shown(buildBoxes(0, 3)), 'build 3 stays hidden at threshold 2');
  assert.deepEqual(addr.at(-1), ['a', 0, 2], 'onAddress carries the build threshold');
  // advancing a build emits id.3.
  document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowRight' }));
  assert.deepEqual(addr.at(-1), ['a', 0, 3]);
  ctl.close(); cleanup();
});

test('audio: only a box opted into present audio unmutes on its active slide', () => {
  const src = makeRichSource([
    { id: 'a', video: true, audio: true },   // opted in
    { id: 'b', video: true },                // not opted in
  ]);
  const ctl = openPresentMode({ source: src })!;
  assert.equal(cloneVideo(0)!.muted, false, 'opted-in active box plays with sound');
  assert.equal(cloneVideo(1)!.muted, true, 'non-active box stays muted');
  document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowRight' }));
  assert.equal(cloneVideo(0)!.muted, true, 'left slide re-mutes');
  assert.equal(cloneVideo(1)!.muted, true, 'the un-opted active box stays muted (no blare)');
  ctl.close(); cleanup();
});

test('frame state: the active frame lifts its tokens onto the stage root; they follow the slide', () => {
  const src = makeRichSource([
    { id: 'a', state: 'dark title' },
    { id: 'b' },
    { id: 'c', state: 'accent' },
  ]);
  const ctl = openPresentMode({ source: src })!;
  const stage = stageEl()!;
  assert.ok(stage.classList.contains('dark') && stage.classList.contains('title'), 'slide a state on the root');
  document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowRight' }));
  assert.ok(!stage.classList.contains('dark') && !stage.classList.contains('title'), 'slide a tokens removed on leave');
  assert.ok(!stage.classList.contains('accent'), 'slide b has no state');
  document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowRight' }));
  assert.ok(stage.classList.contains('accent'), 'slide c state applied');
  ctl.close(); cleanup();
});

test('morph transition: advances the slide and applies pr-morphing (jsdom has no layout/animation)', () => {
  const src = document.createElement('div');
  src.id = 'tool-content';
  for (const id of ['a', 'b']) {
    const page = document.createElement('div');
    page.className = 'lolly-frame-page';
    page.setAttribute('data-pdf-page', '');
    page.setAttribute('data-frame-id', id);
    page.style.cssText = 'position:absolute;left:0px;top:0px;width:1920px;height:1080px;';
    const box = document.createElement('div');
    box.className = 'lolly-box';
    box.setAttribute('data-box-id', `${id}-t`);
    const txt = document.createElement('div');
    txt.className = 'lolly-box-text';
    txt.textContent = 'Shared'; // identical text → the two boxes morph-match
    box.appendChild(txt);
    page.appendChild(box);
    src.appendChild(page);
  }
  document.body.appendChild(src);
  const ctl = openPresentMode({ source: src, transition: 'morph' })!;
  assert.equal(stageEl()!.dataset.prTransition, 'morph');
  document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowRight' }));
  assert.equal(ctl.frameId, 'b', 'morph advanced the slide');
  assert.ok(stageEl()!.classList.contains('pr-morphing'), 'pr-morphing applied for the crossfade');
  ctl.close(); cleanup();
});

test('returns null (no stage) when the document has no frames', () => {
  const src = document.createElement('div');
  document.body.appendChild(src);
  const ctl = openPresentMode({ source: src });
  assert.equal(ctl, null, 'nothing to present → no controller');
  assert.equal(stageEl(), null, 'and no stage is created');
  cleanup();
});

// ---- Speaker view (M5) --------------------------------------------------------------
const speakerEl = () => document.body.querySelector<HTMLElement>('.pr-stage .pr-speaker');

test('speaker view: `S` toggles the panel; it shows current + next previews and the counter', () => {
  const src = makeRichSource([{ id: 'a', notes: 'open strong' }, { id: 'b' }, { id: 'c' }]);
  const ctl = openPresentMode({ source: src })!;
  assert.equal(speakerEl(), null, 'no panel until opened');
  document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 's' }));
  const sp = speakerEl();
  assert.ok(sp, 'S opens the speaker panel');
  // Two slide previews: the current (a) and the next (b), each a scaled page clone.
  const previews = sp!.querySelectorAll('.pr-preview .lolly-frame-page');
  assert.equal(previews.length, 2, 'current + next previews mounted');
  assert.equal(sp!.querySelector('.pr-sp-counter')!.textContent, '1 / 3', 'counter reads current/total');
  // A preview page is static: it dropped the deck placement/state classes.
  const anyPreview = sp!.querySelector<HTMLElement>('.pr-preview .lolly-frame-page')!;
  assert.ok(!anyPreview.classList.contains('pr-page'), 'preview clone is not a live deck page');
  document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 's' }));
  assert.equal(speakerEl(), null, 'S again closes the panel');
  ctl.close(); cleanup();
});

test('speaker view: shows the ACTIVE frame notes; empty when the frame has none', () => {
  const src = makeRichSource([{ id: 'a', notes: 'say the thing' }, { id: 'b' }]);
  const ctl = openPresentMode({ source: src })!;
  document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 's' }));
  const notes = () => speakerEl()!.querySelector<HTMLElement>('.pr-sp-notes')!;
  assert.equal(notes().textContent, 'say the thing', 'slide a notes shown');
  document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowRight' }));
  assert.equal(notes().textContent, '', 'slide b has no notes → cleared');
  assert.equal(notes().style.display, 'none', 'empty notes are hidden');
  ctl.close(); cleanup();
});

test('speaker view: the last slide has no next preview', () => {
  const src = makeRichSource([{ id: 'a' }, { id: 'b' }]);
  const ctl = openPresentMode({ source: src })!;
  document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'End' }));   // → last slide
  document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 's' }));
  const sp = speakerEl()!;
  assert.equal(sp.querySelector('.pr-sp-slot-next')!.children.length, 0, 'no next preview on the final slide');
  assert.equal(sp.querySelector<HTMLElement>('.pr-sp-nextwrap')!.style.visibility, 'hidden', 'next label hidden');
  ctl.close(); cleanup();
});

test('speaker view: opening the overview closes the speaker panel (mutually exclusive)', () => {
  const src = makeRichSource([{ id: 'a' }, { id: 'b' }]);
  const ctl = openPresentMode({ source: src })!;
  document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 's' }));
  assert.ok(speakerEl(), 'speaker open');
  document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'o' }));
  assert.equal(speakerEl(), null, 'overview closed the speaker panel');
  assert.ok(stageEl()!.classList.contains('pr-overview'), 'overview is on');
  ctl.close(); cleanup();
});

test('speaker view: closing the presenter does not leak a running timer or panel', () => {
  const src = makeRichSource([{ id: 'a', notes: 'x' }, { id: 'b' }]);
  const ctl = openPresentMode({ source: src })!;
  document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 's' }));
  assert.ok(speakerEl(), 'speaker open');
  ctl.close();
  assert.equal(document.body.querySelector('.pr-stage'), null, 'stage (and its speaker panel) gone');
  cleanup();
});

test('speaker view: opens a SECOND WINDOW when window.open succeeds (deck stays uncovered)', () => {
  const src = makeRichSource([{ id: 'a', notes: 'hello there' }, { id: 'b' }]);
  // A same-realm stand-in popup: createHTMLDocument shares this JSDOM realm, so importNode
  // (cross-document, same realm) works and the real window branch runs.
  const popupDoc = document.implementation.createHTMLDocument('spk');
  const fakeWin = {
    document: popupDoc, closed: false, innerWidth: 1100, innerHeight: 760,
    focus() {}, close() { (this as { closed: boolean }).closed = true; },
    addEventListener() {}, removeEventListener() {},
  } as unknown as Window;
  const realOpen = win.open;
  win.open = (() => fakeWin) as typeof win.open;
  try {
    const ctl = openPresentMode({ source: src })!;
    document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 's' }));
    // The panel lives in the POPUP; the main stage is NOT covered by an overlay.
    assert.equal(document.body.querySelector('.pr-stage .pr-speaker'), null, 'main deck not covered in window mode');
    const sp = popupDoc.querySelector('.pr-speaker');
    assert.ok(sp, 'panel built in the second window');
    // The window title survives the head-clear (set AFTER replaceChildren, not before).
    assert.equal(popupDoc.title, 'Speaker view', 'popup window is titled');
    assert.equal(sp!.querySelectorAll('.pr-preview .lolly-frame-page').length, 2, 'current + next previews in the popup');
    assert.equal(sp!.querySelector('.pr-sp-notes')!.textContent, 'hello there', 'notes rendered in the popup');
    // Advancing from the MAIN window repaints the popup.
    document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowRight' }));
    assert.equal(popupDoc.querySelector('.pr-sp-counter')!.textContent, '2 / 2', 'popup counter tracks the deck');
    // Closing the presenter closes the popup.
    ctl.close();
    assert.equal(fakeWin.closed, true, 'second window closed on exit');
  } finally {
    win.open = realOpen;
    cleanup();
  }
});

test('speaker view: a popup closed from its own titlebar is reaped (button resets)', () => {
  const src = makeRichSource([{ id: 'a' }, { id: 'b' }]);
  const popupDoc = document.implementation.createHTMLDocument('spk');
  const fakeWin = {
    document: popupDoc, closed: false, innerWidth: 1100, innerHeight: 760,
    focus() {}, close() { (this as { closed: boolean }).closed = true; },
    addEventListener() {}, removeEventListener() {},
  } as unknown as Window;
  const realOpen = win.open;
  win.open = (() => fakeWin) as typeof win.open;
  try {
    const ctl = openPresentMode({ source: src })!;
    const btn = stageEl()!.querySelector<HTMLElement>('.pr-hud-btn[aria-label="Speaker view"]')!;
    document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 's' }));
    assert.equal(btn.getAttribute('aria-pressed'), 'true', 'button reflects the open window');
    // The user closes the popup from its titlebar; the next toggle sees a dead handle and
    // tears the state down cleanly (the 500ms heartbeat would do the same unattended).
    (fakeWin as unknown as { closed: boolean }).closed = true;
    document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 's' }));  // toggle → closeSpeaker → reset
    assert.equal(btn.getAttribute('aria-pressed'), 'false', 'button reset after the window died');
    ctl.close();
  } finally {
    win.open = realOpen;
    cleanup();
  }
});
