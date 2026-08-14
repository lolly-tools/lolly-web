// SPDX-License-Identifier: MPL-2.0
// present-mode.ts — the presentation-mode conductor (plan 112, M1).
//
// Turns a design frame document into a fullscreen, click-advanced DECK. The
// deck MODEL and every index/direction/state-class decision live in the pure, DOM-free
// present-math.ts; this file is the DOM half: it reads the rendered `.lolly-frame-page`
// nodes, builds a fixed full-viewport stage, drives transitions through a state-class
// contract, and handles keyboard / tap / overview / fullscreen / URL sync.
//
// WHY CLONES, NOT THE LIVE NODES. The plan sketched normalising the live frame pages in
// place (the sequence-dom record-and-restore contract). Two facts pushed this to a
// safer shape: (1) the design canvas sits under the free-canvas CAMERA transform,
// so a `position:fixed` page presented in place resolves against that transformed
// ancestor, not the viewport (the containing-block trap this codebase already fights in
// float panels). (2) Restore fidelity is the plan's #1 risk — a leaked transform means a
// wrong export later. Cloning the pages into a body-level stage means the ORIGINAL
// canvas DOM is never touched, so restore is not a discipline to get right — it is
// automatic (remove the stage; the editor underneath is byte-identical). Media/interactive
// continuity is preserved the same way the timeline preserves it: video-mount keys resume
// off `data-video-key`, which survives the clone. M2 layers real media conduct on top.

import {
  buildDeck,
  resolveAddress,
  navDir,
  frameStates,
  walkNext,
  walkPrev,
  stackStep,
  clampIndex,
  matchMorphBoxes,
  type Deck,
  type FrameSpec,
  type MorphBox,
  type NavDir,
} from './present-math.ts';
import { t } from '../i18n.ts';
import { icon } from '../lib/icons.ts';
import { prefersReducedMotion } from '../lib/a11y-prefs.ts';
import { mountLottiePlayers, destroyLottiePlayers, lottiePlayerFor } from './lottie-mount.ts';
import { mountAnimSvgPlayers } from './anim-svg-mount.ts';

/** How long the HUD stays visible after the last pointer/key wake (viz-overlay's 2600). */
const IDLE_MS = 2600;
/** replaceState no more than once per second (reveal's MAX_REPLACE_STATE_FREQUENCY;
 *  Safari throttles it). The conductor fires onAddress freely; the caller debounces. */

export interface OpenPresentOptions {
  /** The tool canvas scope that holds the rendered `.lolly-frame-page` nodes (#tool-content). */
  source: HTMLElement;
  /** The `?s=` address to open on (position, frame id, or `h.f`); null → the first slide. */
  initial?: string | null;
  /** `?loop` — wrap at the ends (signage). */
  loop?: boolean;
  /** Deck-level slide transition (M5). `morph` FLIPs matching boxes between slides; the
   *  default `slide`/`fade` use the CSS state-class transition. */
  transition?: 'slide' | 'fade' | 'morph';
  /** Called on every active-slide OR build-step change with the reorder-proof frame id
   *  and the current build threshold (0 = none). The caller debounces this into
   *  `history.replaceState` as `s=<id>` or `s=<id>.<build>`, keeping the URL a live deep link. */
  onAddress?: (frameId: string, index: number, build: number) => void;
  /** Called once when the presenter is fully torn down (URL cleanup, editor resume). */
  onClose?: () => void;
  /** Where to mount the stage. Defaults to document.body (an un-transformed root, so the
   *  fixed stage fills the true viewport). */
  container?: HTMLElement;
}

export interface PresentController {
  /** Tear down: exit fullscreen, remove the stage, restore the page, fire onClose. Idempotent. */
  close(): void;
  /** Navigate to an `s=` address (position / id / `h.f`). No-op if it resolves to nothing. */
  go(address: string): void;
  /** The active frame's id, or null before the first render. */
  readonly frameId: string | null;
  /** Whether the overview (all-frames map) is showing. */
  readonly overview: boolean;
}

/** Parse an authored pixel value off an inline style (`left:120px` → 120). */
function px(el: HTMLElement, prop: 'left' | 'top' | 'width' | 'height'): number {
  const v = parseFloat(el.style.getPropertyValue(prop));
  return Number.isFinite(v) ? v : 0;
}

/** Read the rendered frame pages into the pure model's FrameSpec shape. Order is DOM
 *  order — the hook already emits pages sorted (order asc, tie x asc), so document order
 *  IS presentation order; geometry comes off the inline pageStyle the hook wrote. */
function readFrames(source: HTMLElement): { specs: FrameSpec[]; pages: HTMLElement[] } {
  const pages = [...source.querySelectorAll<HTMLElement>('.lolly-frame-page')];
  const specs = pages.map((page, i): FrameSpec => {
    const d = Number(page.getAttribute('data-frame-dur')); // kiosk dwell, ms (hook-stamped)
    return {
      id: page.getAttribute('data-frame-id') || String(i),
      order: i,
      x: px(page, 'left'),
      y: px(page, 'top'),
      w: px(page, 'width') || 1,
      h: px(page, 'height') || 1,
      dur: Number.isFinite(d) && d > 0 ? d : null,
    };
  });
  return { specs, pages };
}

export function openPresentMode(opts: OpenPresentOptions): PresentController | null {
  const { source, loop = false, onAddress, onClose, transition = 'slide' } = opts;
  const container = opts.container ?? document.body;

  // Defensive: clear any stage a prior session leaked (a route change can re-mount the
  // tool without running the presenter's teardown, orphaning a body-level stage).
  for (const s of document.querySelectorAll('.pr-stage')) s.remove();

  const { specs, pages } = readFrames(source);
  if (specs.length === 0) return null; // nothing to present — caller nudges "add frames"

  const deck: Deck = buildDeck(specs);
  const reduced = prefersReducedMotion();

  // ---- Stage DOM (a body-level fixed overlay; never a child of the canvas) ----------
  const stage = document.createElement('div');
  stage.className = 'pr-stage';
  stage.tabIndex = -1;
  stage.setAttribute('role', 'region');
  stage.setAttribute('aria-label', t('Presentation'));
  stage.setAttribute('data-export-hide', ''); // never captured by an export walk
  stage.dataset.prTransition = transition;     // 'slide' | 'fade' | 'morph' (present.css varies on it)
  if (reduced) stage.classList.add('pr-reduced');

  const framesEl = document.createElement('div');
  // `pr-scope` is the shared style-scope class the re-scoped tool CSS targets — carried by
  // the deck AND by slide-preview containers (speaker view), so a preview gets styled too.
  framesEl.className = 'pr-frames pr-scope';
  stage.appendChild(framesEl);

  // Clone each rendered page. Clones are ours to mutate freely; the originals are never
  // touched. Strip the authored absolute placement (present.css centres every page in
  // one co-located stack) and stamp the per-page fit scale + walk index.
  const cloneByIndex: HTMLElement[] = [];
  for (let i = 0; i < pages.length; i++) {
    const src = pages[i]!;
    const clone = src.cloneNode(true) as HTMLElement;
    clone.classList.add('pr-page');
    clone.removeAttribute('data-pdf-page'); // not a page to export; a slide to show
    clone.style.removeProperty('left');
    clone.style.removeProperty('top');
    clone.style.removeProperty('margin');
    // Mark build boxes (M3): a `data-build` child is a fragment revealed on advance —
    // it starts hidden (present.css) and gets `pr-shown` when its step is reached.
    for (const bx of clone.querySelectorAll<HTMLElement>('[data-build]')) bx.classList.add('pr-build');
    // The clone keeps its authored width/height (child boxes are in frame-local coords),
    // so a single scale fits the whole page — letterboxed to its own aspect.
    clone.dataset.prIndex = String(i);
    framesEl.appendChild(clone);
    cloneByIndex[i] = clone;
  }

  // ---- HUD + tap zones (siblings of the frames, so slide content stays clickable) ----
  const tapPrev = el('button', 'pr-tap pr-tap-prev');
  tapPrev.setAttribute('aria-label', t('Previous'));
  const tapNext = el('button', 'pr-tap pr-tap-next');
  tapNext.setAttribute('aria-label', t('Next'));
  stage.append(tapPrev, tapNext);

  // Kiosk auto-advance is only offered when at least one frame declares a dwell (dur).
  const deckHasDurs = specs.some((s) => (s.dur ?? 0) > 0);

  const hud = el('div', 'pr-hud');
  const counter = el('span', 'pr-counter');
  const btnPrev = hudBtn('chevronLeft', t('Previous'));
  const btnNext = hudBtn('chevronRight', t('Next'));
  const btnPause = deckHasDurs ? hudBtn('play', t('Pause')) : null; // icon/label swap in syncPauseBtn
  const btnSpeaker = hudBtn('monitor', t('Speaker view'));
  const btnOverview = hudBtn('grid', t('Overview'));
  const btnExit = hudBtn('close', t('Exit presentation'));
  hud.append(btnPrev, counter, btnNext, ...(btnPause ? [btnPause] : []), btnSpeaker, btnOverview, btnExit);
  stage.appendChild(hud);

  // Kiosk dwell progress — a thin bar that fills over the active frame's dur, then advances.
  const progress = el('div', 'pr-progress');
  const progressFill = el('div', 'pr-progress-fill');
  progress.appendChild(progressFill);
  if (deckHasDurs) stage.appendChild(progress);

  container.appendChild(stage);
  // The tool's styles.css is scoped `#tool-canvas .lolly-box{…}`; clones live in a
  // body-level stage, so copy those box-layout rules re-scoped to `.pr-frames`. Faithful
  // to whatever the tool defines (no drift), and structural only — text/colour ride inline.
  injectToolBoxStyles(stage);

  // ---- State -------------------------------------------------------------------------
  const initAddr = resolveAddress(opts.initial, deck);
  let active = clampIndex(deck, initAddr.position?.index ?? 0);
  let build = 0;           // current build threshold of the active frame (0 = none revealed); set below
  let overview = false;
  let closed = false;
  let blackout = false;    // `b` — a black hold that pauses media + auto-advance
  let autoPaused = false;  // kiosk auto-advance paused by the user (stoppable-on-input)
  let appliedState: string[] = []; // frame `state` tokens currently on the stage root (M4)
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let armTimer: ReturnType<typeof setTimeout> | null = null;
  let advTimer: ReturnType<typeof setTimeout> | null = null;
  let morphTimer: ReturnType<typeof setTimeout> | null = null;
  // Speaker view (the presenter's private panel: current + next slide previews, notes, timer).
  let speaker: HTMLElement | null = null;
  let speakerRefs: {
    nowSlot: HTMLElement; nextSlot: HTMLElement; nextWrap: HTMLElement;
    notes: HTMLElement; timer: HTMLElement; counter: HTMLElement;
  } | null = null;
  let speakerWin: Window | null = null;      // the SECOND WINDOW (null → in-page fallback)
  let speakerDoc: Document = document;        // the document the panel lives in (popup or main)
  let speakerTimer: ReturnType<typeof setInterval> | null = null;
  let speakerStart = 0;
  const ownedFullscreen = { v: false };

  // Lock page scroll while the modal deck is up; record to restore exactly.
  const htmlEl = document.documentElement;
  const prevOverflow = htmlEl.style.overflow;
  htmlEl.style.overflow = 'hidden';

  function frameIdAt(i: number): string {
    return deck.positions[clampIndex(deck, i)]?.id ?? '';
  }

  // Any frame carrying `data-build` fragments? Skip all build work when none (the common case).
  const deckHasBuilds = cloneByIndex.some((c) => c.querySelector('[data-build]'));

  // ---- Builds (M3): fragment reveals within a slide ----------------------------------
  // Distinct build values on a frame, ascending (equal values reveal together — reveal's
  // data-fragment-index). A box with no build is always visible; `build` (the threshold)
  // reveals every box whose value ≤ it.
  function buildStepsOf(index: number): number[] {
    const clone = cloneByIndex[clampIndex(deck, index)];
    if (!clone) return [];
    const set = new Set<number>();
    for (const bx of clone.querySelectorAll('[data-build]')) {
      const v = Number(bx.getAttribute('data-build'));
      if (Number.isFinite(v) && v >= 1) set.add(v);
    }
    return [...set].sort((a, b) => a - b);
  }
  function maxBuildOf(index: number): number {
    const steps = buildStepsOf(index);
    return steps.length ? steps[steps.length - 1]! : 0;
  }
  function applyBuilds(index: number, threshold: number): void {
    const clone = cloneByIndex[clampIndex(deck, index)];
    if (!clone) return;
    const boxes = [...clone.querySelectorAll<HTMLElement>('[data-build]')];
    let maxShown = 0;
    for (const bx of boxes) {
      const v = Number(bx.getAttribute('data-build')) || 0;
      const shown = v <= threshold;
      bx.classList.toggle('pr-shown', shown);
      bx.classList.remove('pr-current');
      if (shown) maxShown = Math.max(maxShown, v);
    }
    // The most-recently-revealed step is `current` (CSS can emphasise it — reveal's shape).
    if (maxShown > 0) for (const bx of boxes) {
      if ((Number(bx.getAttribute('data-build')) || 0) === maxShown) bx.classList.add('pr-current');
    }
  }

  // Fit scale per clone: min(vw/fw, vh/fh), leaving a small margin so a slide never
  // kisses the screen edge. Recomputed on resize.
  function layoutScales(): void {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    for (let i = 0; i < cloneByIndex.length; i++) {
      const clone = cloneByIndex[i]!;
      const fw = specs[i]!.w;
      const fh = specs[i]!.h;
      const fit = Math.min(vw / fw, vh / fh) * 0.94;
      clone.style.setProperty('--pr-scale', String(fit));
      if (overview) setOverviewTransform(i, vw, vh);
    }
  }

  // Overview = the authored arrangement (the deck map) scaled to fit the union bbox into
  // the viewport. Columns read as columns — no commercial player has an audience overview.
  function unionBox() {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of specs) {
      minX = Math.min(minX, s.x); minY = Math.min(minY, s.y);
      maxX = Math.max(maxX, s.x + s.w); maxY = Math.max(maxY, s.y + s.h);
    }
    return { minX, minY, w: maxX - minX || 1, h: maxY - minY || 1 };
  }
  function setOverviewTransform(i: number, vw: number, vh: number): void {
    const box = unionBox();
    const s = specs[i]!;
    const k = Math.min(vw / box.w, vh / box.h) * 0.86;
    // Top-left of this frame in the union box → viewport coordinates. present.css places
    // each page at (--pr-ox,--pr-oy) with transform-origin top-left and scale(k), so the
    // authored arrangement maps 1:1 (columns read as columns).
    const ox = (s.x - box.minX) * k + (vw - box.w * k) / 2;
    const oy = (s.y - box.minY) * k + (vh - box.h * k) / 2;
    const clone = cloneByIndex[i]!;
    clone.style.setProperty('--pr-ox', `${ox}px`);
    clone.style.setProperty('--pr-oy', `${oy}px`);
    clone.style.setProperty('--pr-oscale', String(k));
  }

  // The heart: assign the state-class contract for the whole deck at `active`, in travel
  // direction `dir`. Positional trichotomy from present-math; direction on the root.
  function render(dir: NavDir): void {
    const states = frameStates(deck, active, /* viewDistance */ 1);
    stage.dataset.navDir = dir ?? '';
    for (const st of states) {
      const clone = cloneByIndex[st.index]!;
      clone.classList.toggle('pr-past', st.state === 'past');
      clone.classList.toggle('pr-active', st.state === 'present');
      clone.classList.toggle('pr-future', st.state === 'future');
      clone.classList.toggle('pr-prev', st.isPrev);
      clone.classList.toggle('pr-next', st.isNext);
      clone.classList.toggle('pr-stack', st.isStack);
      // The rendering monopoly: pages beyond the live window unload (a11y.css turns
      // [hidden] into display:none) and leave the a11y tree.
      clone.toggleAttribute('hidden', st.hidden && !overview);
      clone.setAttribute('aria-hidden', st.state === 'present' ? 'false' : 'true');
      clone.tabIndex = st.state === 'present' ? 0 : -1;
      // Builds: the active slide reveals up to `build`; every other slide shows all its
      // fragments (a past slide is complete; a future one arrives complete then resets to 0
      // as it becomes active, so it never flashes empty mid-transition).
      if (deckHasBuilds) applyBuilds(st.index, st.index === active ? build : maxBuildOf(st.index));
    }
    // will-change only on the two pages in flight, dropped after the move settles.
    armWillChange();
    counter.textContent = `${active + 1} / ${deck.count}`;
    conductMedia();     // play the active slide's video, pause the rest
    scheduleAdvance();  // (re)arm the kiosk dwell for the new active frame
    applyFrameState();  // lift the active frame's state tokens onto the stage root
    if (speaker) renderSpeaker(); // keep the presenter panel's current/next previews in step
    onAddress?.(frameIdAt(active), active, build);
  }

  // Per-frame `state` (M4, reveal data-state): the active frame's sanitised tokens become
  // classes on the presenter root, so Custom CSS can theme the whole stage per slide
  // (`.pr-stage.dark …` in present.css, or an author rule). Removed when the frame leaves.
  function applyFrameState(): void {
    for (const cls of appliedState) stage.classList.remove(cls);
    appliedState = [];
    const raw = cloneByIndex[active]?.getAttribute('data-frame-state') ?? '';
    for (const tok of raw.split(/\s+/)) {
      if (/^[a-z0-9-]+$/.test(tok)) { stage.classList.add(tok); appliedState.push(tok); }
    }
  }

  // ---- Media conduct (M2) ------------------------------------------------------------
  // Play the ACTIVE slide's video, pause every other. pause() preserves currentTime, so
  // returning to a slide RESUMES rather than restarts (Andy's decision 7) — no extra state.
  // Audio stays muted: mute:false unmuting is deferred (the field defaults to audible, so
  // honouring it literally would blare a whole deck at once — it needs a clearer signal).
  function conductMedia(): void {
    for (let i = 0; i < cloneByIndex.length; i++) {
      const isActive = i === active && !blackout && !overview;
      for (const v of cloneByIndex[i]!.querySelectorAll<HTMLVideoElement>('video')) {
        if (isActive) {
          // Unmute ONLY a box that explicitly opted into present audio (data-present-audio);
          // entering the presenter is a user gesture, so the unmute is allowed. Everything
          // else stays muted — the deck never blares (plan §8, Andy's opt-in decision).
          v.muted = v.getAttribute('data-present-audio') !== '1';
          const p = v.play?.(); if (p && typeof p.catch === 'function') p.catch(() => {});
        } else {
          try { v.muted = true; v.pause(); } catch { /* jsdom / not-ready — never throw */ }
        }
      }
      // Lottie: play the active slide's players, pause the rest (mounted below, async — a
      // marker with no player yet is simply skipped and picked up on the next conduct).
      for (const marker of cloneByIndex[i]!.querySelectorAll('[data-lottie-src]')) {
        const player = lottiePlayerFor(marker);
        if (!player) continue;
        try { isActive ? player.play() : player.pause(); } catch { /* never throw out of conduct */ }
      }
    }
  }

  // ---- Kiosk auto-advance (M2): dwell on a frame's dur, then advance; stoppable, with a
  // visible progress bar (reveal's autoSlideStoppable — the polish commercial kiosks lack).
  function clearAdvance(): void {
    if (advTimer) { clearTimeout(advTimer); advTimer = null; }
    progress.classList.remove('pr-progress-on');
    progressFill.style.transition = 'none';
    progressFill.style.transform = 'scaleX(0)';
  }
  function scheduleAdvance(): void {
    clearAdvance();
    const durMs = deck.positions[active]?.frame.dur ?? 0;
    const atEnd = active === deck.count - 1 && !loop; // last slide, no wrap → stop (don't spin)
    if (!durMs || durMs <= 0 || autoPaused || blackout || overview || atEnd) return;
    progress.classList.add('pr-progress-on');
    progressFill.style.transition = 'none';
    progressFill.style.transform = 'scaleX(0)';
    void progressFill.offsetWidth; // reflow so the fill animation restarts each slide
    progressFill.style.transition = reduced ? 'none' : `transform ${durMs}ms linear`;
    progressFill.style.transform = 'scaleX(1)';
    advTimer = setTimeout(() => { advTimer = null; next(); }, durMs);
  }
  function syncPauseBtn(): void {
    if (!btnPause) return;
    const label = autoPaused ? t('Resume') : t('Pause');
    btnPause.setAttribute('aria-label', label);
    btnPause.setAttribute('data-tip', label);
    btnPause.innerHTML = icon(autoPaused ? 'play' : 'pause', { size: 22 });
  }
  function togglePause(): void {
    autoPaused = !autoPaused;
    syncPauseBtn();
    scheduleAdvance();
  }

  // ---- Blackout (`b`): a black hold that pauses media + auto-advance; any key resumes.
  function setBlackout(on: boolean): void {
    if (blackout === on) return;
    blackout = on;
    stage.classList.toggle('pr-blackout', on);
    conductMedia();
    scheduleAdvance();
  }

  function armWillChange(): void {
    if (armTimer) clearTimeout(armTimer);
    const dur = reduced ? 0 : 460;
    for (let i = 0; i < cloneByIndex.length; i++) {
      const near = Math.abs(i - active) <= 1;
      cloneByIndex[i]!.style.willChange = near ? 'transform, opacity' : 'auto';
    }
    armTimer = setTimeout(() => {
      for (const c of cloneByIndex) c.style.willChange = 'auto';
    }, dur + 60);
  }

  // ---- Morph (M5): FLIP matching boxes from the leaving slide to the entering one ------
  function boxEl(clone: HTMLElement, id: string): HTMLElement | null {
    const safe = (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(id) : id.replace(/["\\]/g, '\\$&');
    try { return clone.querySelector<HTMLElement>(`.lolly-box[data-box-id="${safe}"]`); } catch { return null; }
  }
  function boxDescriptors(index: number): MorphBox[] {
    const clone = cloneByIndex[clampIndex(deck, index)];
    if (!clone) return [];
    return [...clone.querySelectorAll<HTMLElement>('.lolly-box')].map((b) => {
      const media = b.querySelector<HTMLElement>('video[data-video-key], img[src], [data-lottie-src], [data-anim-src]');
      const imageKey = media?.getAttribute('data-video-key') || media?.getAttribute('src')
        || media?.getAttribute('data-lottie-src') || media?.getAttribute('data-anim-src') || '';
      return {
        id: b.getAttribute('data-box-id') ?? '',
        matchOf: b.getAttribute('data-match'),
        text: b.querySelector('.lolly-box-text')?.textContent ?? '',
        imageKey,
      };
    });
  }
  function morphTo(toIndex: number, dir: NavDir, buildTarget: number): void {
    const fromClone = cloneByIndex[active];
    const pairs = fromClone ? matchMorphBoxes(boxDescriptors(active), boxDescriptors(toIndex)) : [];
    // FIRST — measure the leaving boxes' on-screen rects (that slide is still active).
    const fromRects = new Map<string, DOMRect>();
    if (fromClone) for (const p of pairs) {
      const el = boxEl(fromClone, p.fromId);
      if (el) fromRects.set(p.toId, el.getBoundingClientRect());
    }
    // Switch: `pr-morphing` crossfades the PAGES (both centred) instead of sliding, so only
    // the matched boxes appear to travel.
    stage.classList.add('pr-morphing');
    active = clampIndex(deck, toIndex);
    build = Math.max(0, Math.min(buildTarget, maxBuildOf(active)));
    render(dir);
    // LAST + INVERT + PLAY — animate each entering box from where its partner was.
    const toClone = cloneByIndex[active];
    const pageScale = toClone ? (Number(toClone.style.getPropertyValue('--pr-scale')) || 1) : 1;
    const dur = reduced ? 1 : 520;
    if (toClone) for (const p of pairs) {
      const el = boxEl(toClone, p.toId);
      const from = fromRects.get(p.toId);
      if (!el || !from || !el.getBoundingClientRect) continue;
      const to = el.getBoundingClientRect();
      if (!to.width || !to.height) continue;
      // Screen delta → page-local transform: a box's transform composes with the page's
      // scale(--pr-scale), so a screen translate of `d`px is `d/pageScale` locally; the size
      // ratio is scale-invariant (the page scale cancels).
      const dx = (from.left - to.left) / pageScale;
      const dy = (from.top - to.top) / pageScale;
      el.style.transformOrigin = 'top left';
      el.animate?.(
        [{ transform: `translate(${dx}px,${dy}px) scale(${from.width / to.width},${from.height / to.height})` }, { transform: 'none' }],
        { duration: dur, easing: 'cubic-bezier(0.4,0,0.2,1)', fill: 'backwards' },
      );
    }
    if (morphTimer) clearTimeout(morphTimer);
    morphTimer = setTimeout(() => stage.classList.remove('pr-morphing'), dur + 60);
  }

  // ---- Speaker view (M5) -------------------------------------------------------------
  // A presenter-only panel: a large preview of the CURRENT slide, a small preview of what's
  // NEXT, the active frame's speaker `notes`, an elapsed timer, and its own prev/next. It's
  // the slide-preview primitive (`makeSlidePreview`) put to work — a static, scaled re-clone
  // of a frame that reuses the same `.pr-scope` box styling the deck does.
  //
  // DUAL-SCREEN by default: `S` opens the panel in a SECOND WINDOW (`window.open`), so the
  // deck stays on the projector while the presenter reads notes on their laptop. Same-origin,
  // so no postMessage — we hold the window handle and drive its DOM directly; `render()` calls
  // `renderSpeaker()` and it repaints whichever document the panel lives in. If the popup is
  // blocked (or jsdom, which has no `window.open`), it falls back to an IN-PAGE overlay that
  // covers the deck — a rehearsal/notes aid on a single screen.

  /** A static, non-playing re-clone of frame `index`, scaled to FIT a `boxW`×`boxH` slot
   *  (letterboxed to the frame's own aspect), built in `doc` (the deck's window or the popup). */
  function makeSlidePreview(index: number, boxW: number, boxH: number, doc: Document): HTMLElement {
    const i = clampIndex(deck, index);
    const fw = specs[i]?.w || 1;
    const fh = specs[i]?.h || 1;
    const scale = Math.min(boxW / fw, boxH / fh);
    const wrap = doc.createElement('div');
    wrap.className = 'pr-scope pr-preview';
    wrap.style.width = `${Math.round(fw * scale)}px`;
    wrap.style.height = `${Math.round(fh * scale)}px`;
    const src = cloneByIndex[i];
    if (src) {
      // importNode adopts the clone into `doc` (cross-window for the popup; a plain deep clone
      // in the deck's own document) — so a preview works in either window unchanged.
      const clone = doc.importNode(src, true) as HTMLElement;
      clone.removeAttribute('hidden');
      clone.removeAttribute('id');
      // Drop the deck state/placement classes — a preview is a still, top-left, scaled page;
      // the build classes (pr-build/pr-shown) are KEPT so a fragment slide reads as authored.
      clone.classList.remove('pr-page', 'pr-active', 'pr-past', 'pr-future', 'pr-prev', 'pr-next', 'pr-stack');
      clone.style.position = 'absolute';
      clone.style.left = '0';
      clone.style.top = '0';
      clone.style.margin = '0';
      clone.style.transformOrigin = 'top left';
      clone.style.transform = `scale(${scale})`;
      clone.style.opacity = '1';
      clone.style.transition = 'none';
      // A preview never plays: freeze its media so N previews don't spin decoders.
      for (const v of clone.querySelectorAll<HTMLVideoElement>('video')) {
        v.muted = true; v.autoplay = false; v.removeAttribute('autoplay');
        try { v.pause(); } catch { /* not-ready — ignore */ }
      }
      wrap.appendChild(clone);
    }
    return wrap;
  }

  function renderSpeaker(): void {
    if (!speaker || !speakerRefs) return;
    // Fall back to the panel's own window dimensions when a slot hasn't been laid out yet.
    const winW = speakerWin ? speakerWin.innerWidth : window.innerWidth;
    const winH = speakerWin ? speakerWin.innerHeight : window.innerHeight;
    const nowW = Math.max(160, speakerRefs.nowSlot.clientWidth || Math.round(winW * 0.5));
    const nowH = Math.max(120, speakerRefs.nowSlot.clientHeight || Math.round(winH * 0.6));
    speakerRefs.nowSlot.replaceChildren(makeSlidePreview(active, nowW, nowH, speakerDoc));
    // Next: walkNext returns the same index at the last slide when not looping → no next.
    const nx = walkNext(deck, active, { loop });
    const noNext = nx === active && !loop;
    speakerRefs.nextWrap.style.visibility = noNext ? 'hidden' : '';
    if (noNext) {
      speakerRefs.nextSlot.replaceChildren();
    } else {
      const nextW = Math.max(120, speakerRefs.nextSlot.clientWidth || Math.round(winW * 0.22));
      const nextH = Math.max(90, speakerRefs.nextSlot.clientHeight || Math.round(winH * 0.22));
      speakerRefs.nextSlot.replaceChildren(makeSlidePreview(nx, nextW, nextH, speakerDoc));
    }
    const notes = cloneByIndex[active]?.getAttribute('data-frame-notes') ?? '';
    speakerRefs.notes.textContent = notes;
    speakerRefs.notes.style.display = notes ? '' : 'none';
    speakerRefs.counter.textContent = `${active + 1} / ${deck.count}`;
  }

  function fmtClock(ms: number): string {
    const total = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(total / 60);
    return `${String(m).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  }
  function tickSpeaker(): void {
    // The heartbeat also reaps a popup the user closed from its own titlebar.
    if (speakerWin && speakerWin.closed) { closeSpeaker(); return; }
    if (speakerRefs) speakerRefs.timer.textContent = fmtClock(Date.now() - speakerStart);
  }

  /** Build the panel in `doc`, appended to `host`. Elements are created in `doc` so the popup
   *  gets nodes it owns (icon() returns HTML strings, valid in either document). */
  function buildSpeaker(doc: Document, host: HTMLElement): void {
    const mk = (tag: string, cls: string): HTMLElement => { const n = doc.createElement(tag); n.className = cls; return n; };
    const navBtn = (iconName: string, label: string): HTMLButtonElement => {
      const b = doc.createElement('button');
      b.className = 'pr-hud-btn'; b.type = 'button';
      b.setAttribute('aria-label', label); b.setAttribute('data-tip', label);
      b.innerHTML = icon(iconName as Parameters<typeof icon>[0], { size: 22 });
      return b;
    };
    const root = mk('div', 'pr-speaker');
    const now = mk('div', 'pr-sp-now');
    const nowTag = mk('span', 'pr-sp-tag'); nowTag.textContent = t('Current');
    const nowSlot = mk('div', 'pr-sp-slot');
    now.append(nowTag, nowSlot);
    const aside = mk('div', 'pr-sp-aside');
    const timer = mk('div', 'pr-sp-timer'); timer.textContent = '00:00';
    const nextWrap = mk('div', 'pr-sp-nextwrap');
    const nextTag = mk('span', 'pr-sp-tag'); nextTag.textContent = t('Next');
    const nextSlot = mk('div', 'pr-sp-slot pr-sp-slot-next');
    nextWrap.append(nextTag, nextSlot);
    const notes = mk('div', 'pr-sp-notes');
    const controls = mk('div', 'pr-sp-controls');
    const spPrev = navBtn('chevronLeft', t('Previous'));
    const counter = mk('span', 'pr-sp-counter');
    const spNext = navBtn('chevronRight', t('Next'));
    spPrev.addEventListener('click', () => { wake(); prev(); });
    spNext.addEventListener('click', () => { wake(); next(); });
    controls.append(spPrev, counter, spNext);
    aside.append(timer, nextWrap, notes, controls);
    root.append(now, aside);
    host.appendChild(root);
    speaker = root;
    speakerRefs = { nowSlot, nextSlot, nextWrap, notes, timer, counter };
  }

  /** Prepare a blank popup: full-height dark body, the app's same-origin stylesheets copied in
   *  (so present.css `.pr-speaker*` rules apply), plus the re-scoped tool `.lolly-box` CSS. */
  function setupSpeakerWindow(win: Window): void {
    const d = win.document;
    const theme = document.documentElement.getAttribute('data-theme');
    if (theme) d.documentElement.setAttribute('data-theme', theme);
    d.head.replaceChildren();
    d.body.replaceChildren();
    d.title = t('Speaker view'); // AFTER clearing head — the setter re-creates the <title> element
    // Copy the app's own <style>/<link> — skip anything inside the stage (the box CSS we add
    // fresh below, re-scoped) so we don't double it. This brings present.css `.pr-speaker*`.
    for (const node of Array.from(document.querySelectorAll<HTMLElement>('link[rel="stylesheet"], style'))) {
      if (node.closest('.pr-stage')) continue;
      if (node.tagName === 'LINK') {
        const l = d.createElement('link');
        l.rel = 'stylesheet';
        l.href = (node as HTMLLinkElement).href; // resolved absolute URL — safe against about:blank base
        d.head.appendChild(l);
      } else {
        const s = d.createElement('style');
        s.textContent = node.textContent || '';
        d.head.appendChild(s);
      }
    }
    const box = d.createElement('style');
    box.textContent = collectToolBoxCss();
    d.head.appendChild(box);
    // A minimal full-height dark body, appended LAST so it out-ranks the app's own base sheet.
    const base = d.createElement('style');
    base.textContent = 'html,body{margin:0;height:100%;background:#0b0f18;overflow:hidden}';
    d.head.appendChild(base);
  }

  // Keys inside the popup: Esc / S close the panel (not the whole deck); everything else drives
  // the deck through the shared handler, so arrows/space work from either window.
  function onSpeakerKey(e: KeyboardEvent): void {
    if (e.key === 'Escape' || e.key === 's' || e.key === 'S') { e.preventDefault(); closeSpeaker(); return; }
    onKey(e);
  }

  function toggleSpeaker(): void {
    if (speaker || speakerWin) { closeSpeaker(); return; }
    let win: Window | null = null;
    try { win = window.open('', 'lolly-speaker', 'popup=yes,width=1100,height=760'); } catch { win = null; }
    if (win && win.document) {
      speakerWin = win;
      speakerDoc = win.document;
      setupSpeakerWindow(win);
      buildSpeaker(speakerDoc, speakerDoc.body);
      speakerDoc.addEventListener('keydown', onSpeakerKey, true);
      try { win.focus(); } catch { /* focus may be denied — harmless */ }
    } else {
      // Popup blocked / unavailable → in-page overlay that covers the deck.
      speakerWin = null;
      speakerDoc = document;
      buildSpeaker(document, stage);
      stage.classList.add('pr-speaker-on');
    }
    speakerStart = Date.now();
    if (speakerTimer) clearInterval(speakerTimer);
    speakerTimer = setInterval(tickSpeaker, 500);
    tickSpeaker();
    renderSpeaker();
    syncSpeakerBtn();
  }
  function closeSpeaker(): void {
    if (!speaker && !speakerWin) return;
    if (speakerTimer) { clearInterval(speakerTimer); speakerTimer = null; }
    if (speaker) speaker.remove();
    const w = speakerWin;
    speaker = null;
    speakerRefs = null;
    speakerWin = null;
    speakerDoc = document;
    stage.classList.remove('pr-speaker-on');
    if (w) { try { if (!w.closed) w.close(); } catch { /* already gone */ } }
    syncSpeakerBtn();
  }
  function syncSpeakerBtn(): void {
    const on = !!speaker || !!speakerWin;
    btnSpeaker.classList.toggle('pr-hud-btn-on', on);
    btnSpeaker.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  // ---- Navigation --------------------------------------------------------------------
  // Reveal the active slide's remaining builds before leaving it (`build` = threshold).
  function goIndex(idx: number, dir: NavDir, buildTarget = 0): void {
    const clamped = clampIndex(deck, idx);
    if (clamped === active && dir !== null && buildTarget === build) return;
    // Morph is a slide-to-slide FLIP; reduced motion / overview fall through to a plain render.
    if (transition === 'morph' && clamped !== active && !overview && !reduced) {
      morphTo(clamped, dir, buildTarget);
      return;
    }
    active = clamped;
    build = Math.max(0, Math.min(buildTarget, maxBuildOf(active)));
    render(dir);
  }
  // Advance a build within a slide until they're exhausted, then move to the next slide.
  function stepBuild(id: string, active_: number, b: number): void {
    build = b;
    applyBuilds(active_, build);
    onAddress?.(id, active_, build);
  }
  function next(): void {
    if (overview) { setOverview(false); return; }
    const nextStep = buildStepsOf(active).find((v) => v > build);
    if (nextStep != null) { stepBuild(frameIdAt(active), active, nextStep); return; }
    const to = walkNext(deck, active, { loop });
    goIndex(to, navDir(deck.positions[active] ?? null, deck.positions[to] ?? null) ?? 'right', 0);
  }
  function prev(): void {
    if (overview) { setOverview(false); return; }
    if (build > 0) { stepBuild(frameIdAt(active), active, buildStepsOf(active).filter((v) => v < build).pop() ?? 0); return; }
    const to = walkPrev(deck, active, { loop });
    // Backward arrival shows all builds (reveal behaviour).
    goIndex(to, navDir(deck.positions[active] ?? null, deck.positions[to] ?? null) ?? 'left', maxBuildOf(to));
  }
  function stackVert(dir: 'up' | 'down'): void {
    const to = stackStep(deck, active, dir);
    if (to !== active) goIndex(to, dir);
  }
  function go(address: string): void {
    const addr = resolveAddress(address, deck);
    if (!addr.position) return;
    goIndex(addr.position.index, navDir(deck.positions[active] ?? null, addr.position), addr.build ?? 0);
  }

  // ---- Overview ----------------------------------------------------------------------
  function setOverview(on: boolean): void {
    if (overview === on) return;
    overview = on;
    stage.classList.toggle('pr-overview', on);
    if (on && speaker) closeSpeaker(); // two full-screen presenter modes don't co-exist
    if (on) {
      // Everything visible in the map; recompute positions, drop hidden. Media + kiosk
      // dwell pause while the map is up (a wall of playing videos would be chaos).
      for (const c of cloneByIndex) c.removeAttribute('hidden');
      layoutScales();
      conductMedia();
      clearAdvance();
    } else {
      render(null); // re-collapse to the co-located stack at the current active
    }
  }

  // ---- Fullscreen --------------------------------------------------------------------
  function enterFullscreen(): void {
    const req = stage.requestFullscreen?.bind(stage);
    if (req) req().then(() => { ownedFullscreen.v = true; }).catch(() => { /* already fills the viewport */ });
  }

  // ---- Idle-hide chrome (woken by pointer, key, focus) -------------------------------
  function wake(): void {
    stage.classList.remove('pr-idle');
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (!overview) stage.classList.add('pr-idle'); }, IDLE_MS);
  }

  // ---- Input -------------------------------------------------------------------------
  function isTyping(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
  }

  function onKey(e: KeyboardEvent): void {
    if (closed || isTyping(e.target)) return;
    wake();
    // Any key resumes from a blackout hold (reveal's `B`): the screen was black, so the
    // keystroke is spent lifting it, not navigating.
    if (blackout) { setBlackout(false); e.preventDefault(); e.stopPropagation(); return; }
    let handled = true;
    switch (e.key) {
      case 'ArrowRight': case 'PageDown': case ' ': case 'Spacebar':
        overview ? setOverview(false) : next(); break;
      case 'ArrowLeft': case 'PageUp':
        prev(); break;
      case 'ArrowDown':
        overview ? setOverview(false) : stackVert('down'); break;
      case 'ArrowUp':
        stackVert('up'); break;
      case 'Home': goIndex(0, 'left'); break;
      case 'End': goIndex(deck.count - 1, 'right'); break;
      case 'o': case 'O': setOverview(!overview); break;
      case 's': case 'S': toggleSpeaker(); break;
      case 'b': case 'B': setBlackout(true); break;
      case 'k': case 'K': if (deckHasDurs) togglePause(); else handled = false; break;
      case 'f': case 'F': enterFullscreen(); break;
      case 'Escape':
        // Esc peels one layer. When the browser owns fullscreen it consumes Escape
        // itself, so we only ever see it for the overview→deck and deck→exit steps.
        if (document.fullscreenElement) { handled = false; break; }
        if (overview) setOverview(false); else close();
        break;
      default: handled = false;
    }
    if (handled) {
      // Capture-phase + stop: a handled deck key never also reaches the free-canvas
      // editor underneath (arrows must not nudge a selected box while presenting).
      e.preventDefault();
      e.stopPropagation();
    }
  }

  // Overview: clicking a frame dives into it.
  function onFramesClick(e: MouseEvent): void {
    if (!overview) return;
    const page = (e.target as HTMLElement).closest<HTMLElement>('.pr-page');
    if (!page) return;
    const i = Number(page.dataset.prIndex);
    if (Number.isFinite(i)) { setOverview(false); goIndex(i, null); }
  }

  // ---- Wiring ------------------------------------------------------------------------
  const onResize = () => layoutScales();
  tapPrev.addEventListener('click', () => { wake(); prev(); });
  tapNext.addEventListener('click', () => { wake(); next(); });
  btnPrev.addEventListener('click', () => { wake(); prev(); });
  btnNext.addEventListener('click', () => { wake(); next(); });
  btnOverview.addEventListener('click', () => { wake(); setOverview(!overview); });
  btnSpeaker.addEventListener('click', () => { wake(); toggleSpeaker(); });
  btnPause?.addEventListener('click', () => { wake(); togglePause(); });
  btnExit.addEventListener('click', () => close());
  framesEl.addEventListener('click', onFramesClick);
  document.addEventListener('keydown', onKey, true);
  stage.addEventListener('pointermove', wake);
  stage.addEventListener('pointerdown', wake);
  stage.addEventListener('focusin', wake);
  window.addEventListener('resize', onResize);

  // ---- Go ----------------------------------------------------------------------------
  syncPauseBtn();
  build = deckHasBuilds ? Math.max(0, Math.min(initAddr.build ?? 0, maxBuildOf(active))) : 0; // s=h.f deep-link
  layoutScales();
  render(null);
  wake();
  stage.focus({ preventScroll: true });
  enterFullscreen();
  // Hydrate motion content on the clones so it actually plays in present mode: lottie
  // players and animated-SVG markers (video autoplays natively via its markup). Both are
  // async (fetch + inject); re-conduct once mounted so non-active players start paused.
  void Promise.all([
    mountLottiePlayers(framesEl, { isCurrent: () => !closed }),
    mountAnimSvgPlayers(framesEl, { isCurrent: () => !closed }),
  ]).then(() => { if (!closed) conductMedia(); });

  function close(): void {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onResize);
    if (idleTimer) clearTimeout(idleTimer);
    if (armTimer) clearTimeout(armTimer);
    if (advTimer) clearTimeout(advTimer);
    if (morphTimer) clearTimeout(morphTimer);
    closeSpeaker(); // stops the timer AND closes the second window / removes the overlay
    htmlEl.style.overflow = prevOverflow;
    if (ownedFullscreen.v && document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    destroyLottiePlayers(stage); // reap OUR players only — lottie-web's global rAF ticks detached trees otherwise
    stage.remove(); // clones (and their media) die with it; originals are untouched
    onClose?.();
  }

  return {
    close,
    go,
    get frameId() { return closed ? null : frameIdAt(active); },
    get overview() { return overview; },
  };
}

/** Gather the tool canvas's `.lolly-box*` layout rules (scoped `#tool-canvas .lolly-box…`)
 *  re-scoped to `.pr-scope` (carried by the deck AND every slide preview), so cloned boxes
 *  position correctly outside the canvas. Structural rules only — the frame/page rules are
 *  excluded because present.css owns page placement; text and colour are inline on the boxes.
 *  Same-origin sheets only; cross-origin `cssRules` access throws and is skipped. Returned as a
 *  string so it can be injected into the stage AND into the speaker popup's document. */
function collectToolBoxCss(): string {
  let css = '';
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList | null = null;
    try { rules = sheet.cssRules; } catch { continue; } // cross-origin — skip
    if (!rules) continue;
    for (const rule of Array.from(rules)) {
      // @keyframes the shell scoped for the tool's customCss (M4) — copy verbatim; the
      // names are already scoped and the animation-name references below match them.
      if (rule instanceof CSSKeyframesRule) { css += rule.cssText + '\n'; continue; }
      if (!(rule instanceof CSSStyleRule)) continue;
      const sel = rule.selectorText;
      if (!sel || !sel.includes('#tool-canvas')) continue;
      // Skip the frame/page positioning rules — present.css owns page placement, and an
      // unlayered injected copy would out-rank it (position:relative would break centring).
      if (/\.lolly-frames|\.lolly-frame-page/.test(sel)) continue;
      // Everything else: the tool's .lolly-box layout AND the doc-level customCss (both
      // scoped `#tool-canvas …` by the shell), re-scoped onto the present stage.
      css += rule.cssText.split('#tool-canvas').join('.pr-scope') + '\n';
    }
  }
  return css;
}
function injectToolBoxStyles(stage: HTMLElement): void {
  const css = collectToolBoxCss();
  if (css) {
    const styleEl = document.createElement('style');
    styleEl.textContent = css;
    stage.appendChild(styleEl);
  }
}

// ---- tiny DOM helpers ----------------------------------------------------------------
function el(tag: string, className: string): HTMLElement {
  const n = document.createElement(tag);
  n.className = className;
  return n;
}
function hudBtn(iconName: string, label: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'pr-hud-btn';
  b.type = 'button';
  b.setAttribute('aria-label', label);
  b.setAttribute('data-tip', label);
  // icon() returns an inline SVG string; the icon set is camelCase (chevronLeft, …).
  b.innerHTML = icon(iconName as Parameters<typeof icon>[0], { size: 22 });
  return b;
}
