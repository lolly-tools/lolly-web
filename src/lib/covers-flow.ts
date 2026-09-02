// SPDX-License-Identifier: MPL-2.0
/**
 * The landing's Cover Flow (plans/177 beat 2) - ONE source for both surfaces.
 * docs/build.ts bundles this file with esbuild into the static /info page's
 * inline covers script, and lib/docs-landing.ts imports it for the in-app
 * reader at #/docs/index. Zero imports on purpose: the static bundle has to
 * stay tiny and cannot reach the app's modules.
 *
 * The motion model is the app gallery's own (components/featured-row.ts): the
 * strip is a real horizontal scroller whose scrollLeft is the single source of
 * truth, and each cover's transform is a pure function of its LAYOUT offset
 * from the viewport centre - offsetLeft/offsetWidth are transform-independent,
 * so there is no feedback loop. One rAF loop owns scrollLeft in three states:
 *   1. dragging  - the pointer sets it (mouse, pen and touch alike; the strip
 *                  is touch-action: pan-y in fan mode so vertical stays with
 *                  the page);
 *   2. coasting  - a flick release or a horizontal wheel spin decays with
 *                  friction ("wheel physics");
 *   3. settling  - ease onto the chosen cover (a dot, an arrow, a key, the
 *                  autoplay, a side click) or, with none chosen, the nearest.
 * CSS scroll-snap is OFF in fan mode. A snap area is the TRANSFORMED border
 * box, so native snap chased the tuck every frame and fought both the settle
 * and the drag (the 2026-09-02 "buggy sideways scroll and drag"). Under 720px
 * the strip stays the plain scroll-snap filmstrip and this module only keeps
 * the fan off.
 *
 * Markup contract (docs/build.ts, covers.json): #coversRoot > #coversStrip >
 * a.cover-card[href] with .cover-cap b (the name); .covers-nav with
 * [data-covers=prev|next] + .covers-dots; .covers-open-btn[data-tpl] whose
 * first child span takes the label. Cards are pointer-events:none in the fan
 * (a z-translated plane is not hit-testable - featured-row.ts's finding), so
 * the ONE clickable control is the Open button outside the 3-D context, and
 * a press on a side cover is mapped by geometry to centre it.
 */

const CF_MAX_ANGLE = 50;        // deg a fully side-on cover rotates
const CF_TUCK = 0.52;           // fraction of a cover width each neighbour pulls in
const CF_MIN_SCALE = 0.72;      // scale of the side covers
const WHEEL_TO_VELOCITY = 14;   // px/s of spin per unit of horizontal wheel delta
const MAX_VELOCITY = 3200;      // px/s cap so a wild flick cannot teleport the strip
const INERTIA_FRICTION = 0.94;  // velocity decay per ~16.7 ms frame
const INERTIA_MIN_V = 6;        // px/s; below this the coast is over
const EASE_PER_SEC = 12;        // settle ease rate (time-based)
const DRAG_SLOP = 8;            // px a press may travel and still count as a click
const REST_MS = 900;            // a cover must rest centred this long before Open appears
const HOLD_MS = 12000;          // autoplay pause after any hand input
const AUTOPLAY_MS = 4500;

interface Geom { el: HTMLElement; center: number; w: number; vc: number }

export function mountCoverFlow(root: ParentNode): void {
  const rootFound = root.querySelector<HTMLElement>('#coversRoot');
  const stripFound = root.querySelector<HTMLElement>('#coversStrip');
  if (!rootFound || !stripFound) return;
  const sectionFound = rootFound.closest<HTMLElement>('.covers-section');
  const navFound = rootFound.querySelector<HTMLElement>('.covers-nav');
  const dotsFound = rootFound.querySelector<HTMLElement>('.covers-dots');
  if (!sectionFound || !navFound || !dotsFound) return;
  if (rootFound.dataset.coversMounted) return;   // a second hydrate reuses the first
  rootFound.dataset.coversMounted = '1';
  // Re-bound as plain HTMLElements so the closures below need no null checks.
  const rootEl: HTMLElement = rootFound;
  const strip: HTMLElement = stripFound;
  const section: HTMLElement = sectionFound;
  const nav: HTMLElement = navFound;
  const dots: HTMLElement = dotsFound;
  const openBtn = rootEl.querySelector<HTMLAnchorElement>('.covers-open-btn');
  const cards = [...strip.querySelectorAll<HTMLElement>('.cover-card')];
  if (cards.length < 3) return;

  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  // The animated covers (audiogram, 3D) are muted looping clips; under reduced
  // motion they hold their poster frame instead of playing.
  if (reduced) cards.forEach((el) => { const v = el.querySelector('video'); if (v) { v.removeAttribute('autoplay'); v.pause(); } });
  const wide = matchMedia('(min-width: 720px)');

  let fan = false;
  let geom: Geom[] = [];
  let raf = 0;
  let lastTs = 0;
  let velocity = 0;
  let snapTarget: number | null = null;
  let dragging = false;
  let dragMoved = false;
  let dragPointerId = -1;
  let dragStartX = 0;
  let lastPointerX = 0;
  let lastMoveTs = 0;
  let hold = 0;
  let hov = false;
  let lastCur = -1;
  let restT: ReturnType<typeof setTimeout> | 0 = 0;
  let wheelSettleT: ReturnType<typeof setTimeout> | 0 = 0;

  const dotEls: HTMLButtonElement[] = [];
  if (!dots.childElementCount) {
    cards.forEach((c, i) => {
      const d = document.createElement('button');
      d.type = 'button';
      d.className = 'covers-dot';
      d.setAttribute('role', 'tab');
      d.setAttribute('aria-label', c.querySelector('.cover-cap b')?.textContent ?? String(i + 1));
      d.addEventListener('click', () => go(i));
      dots.appendChild(d);
      dotEls.push(d);
    });
  }

  const clampV = (v: number): number => Math.max(-MAX_VELOCITY, Math.min(MAX_VELOCITY, v));
  const half = (): number => strip.clientWidth / 2;
  const centerOf = (i: number): number => (geom[i]?.center ?? 0) - half();

  /** Snapshot the layout geometry once per (re)layout so the hot loop is write-only. */
  function measure(): void {
    geom = cards.map((el) => {
      const w = el.offsetWidth || 1;
      return { el, w, center: el.offsetLeft + w / 2, vc: el.offsetLeft + w / 2 };
    });
  }

  function curIndex(): number {
    const focus = strip.scrollLeft + half();
    let best = 0;
    let bd = Infinity;
    geom.forEach((g, i) => {
      const d = Math.abs(g.center - focus);
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  }

  function nearestTarget(): number {
    const h = half();
    let best = strip.scrollLeft;
    let bd = Infinity;
    for (const g of geom) {
      const target = g.center - h;
      const dist = Math.abs(target - strip.scrollLeft);
      if (dist < bd) { bd = dist; best = target; }
    }
    return best;
  }

  function showOpen(cur: number): void {
    if (!openBtn) return;
    const card = cards[cur]!;
    openBtn.setAttribute('href', card.getAttribute('href') ?? '#');
    const label = openBtn.firstElementChild;
    if (label) {
      label.textContent = (openBtn.getAttribute('data-tpl') || 'Open {name}')
        .replace('{name}', card.querySelector('.cover-cap b')?.textContent ?? '');
    }
    openBtn.classList.add('is-on');
  }

  function layout(): void {
    if (!fan) return;
    const focus = strip.scrollLeft + half();
    const cur = curIndex();   // decided BEFORE the pass, so exactly one cover is current
    geom.forEach((g, i) => {
      const d = (g.center - focus) / g.w;
      const ad = Math.abs(d);
      const cd = Math.max(-1.4, Math.min(1.4, d));
      // Tuck keeps pulling the further covers in with its own wider clamp, so the
      // fan stacks tight to the screen edge instead of gapping past ±1.4.
      const td = Math.max(-3.2, Math.min(3.2, d));
      const angle = -cd * CF_MAX_ANGLE;
      const scale = 1 - Math.min(ad, 1) * (1 - CF_MIN_SCALE);
      const tuck = -td * g.w * CF_TUCK;
      // Recede each cover by its own protrusion (+ slack) so a rotated neighbour's
      // near half never crosses the centred cover's plane.
      const back = (g.w / 2) * scale * Math.abs(Math.sin((angle * Math.PI) / 180)) + Math.abs(td) * 8 + 2;
      g.el.style.transform = `translateX(${tuck.toFixed(1)}px) translateZ(${(-back).toFixed(1)}px) rotateY(${angle.toFixed(1)}deg) scale(${scale.toFixed(3)})`;
      g.el.style.zIndex = String(1000 - Math.round(ad * 20));
      g.vc = g.center + tuck;
      g.el.classList.toggle('is-cur', i === cur);
      g.el.setAttribute('aria-hidden', i === cur ? 'false' : 'true');
    });
    dotEls.forEach((d, i) => d.setAttribute('aria-current', i === cur ? 'true' : 'false'));
    if (cur !== lastCur) {
      lastCur = cur;
      clearTimeout(restT);
      openBtn?.classList.remove('is-on');
      // Quiet while the fan moves, an invitation once it settles.
      restT = setTimeout(() => showOpen(cur), REST_MS);
    }
  }

  // ── The motion loop ─────────────────────────────────────────────────────
  function loop(): void { if (!raf) raf = requestAnimationFrame(tick); }
  function tick(ts: number): void {
    raf = 0;
    if (!fan || !rootEl.isConnected) { lastTs = 0; return; }
    const dt = lastTs ? Math.min(200, ts - lastTs) : 0;
    lastTs = ts;
    if (dragging) { layout(); loop(); return; }
    if (Math.abs(velocity) > INERTIA_MIN_V) {
      strip.scrollLeft += (velocity * dt) / 1000;
      velocity = clampV(velocity * INERTIA_FRICTION ** (dt / 16.67));
      if (Math.abs(velocity) < INERTIA_MIN_V) velocity = 0;
      layout();
      loop();
      return;
    }
    const target = snapTarget ?? nearestTarget();
    const diff = target - strip.scrollLeft;
    if (Math.abs(diff) < 0.5 || reduced) {
      strip.scrollLeft = target;
      snapTarget = null;
      layout();
      lastTs = 0;
      return;                                   // at rest: the loop stops here
    }
    strip.scrollLeft += diff * Math.min(1, (dt / 1000) * EASE_PER_SEC);
    layout();
    loop();
  }

  function go(i: number): void {
    if (!fan) return;
    i = Math.max(0, Math.min(cards.length - 1, i));
    hold = Date.now() + HOLD_MS;
    velocity = 0;
    snapTarget = centerOf(i);
    loop();
  }

  function enterFan(): void {
    fan = true;
    section.classList.add('covers--fan');
    nav.hidden = false;
    cards.forEach((el) => el.setAttribute('draggable', 'false'));
    measure();
    strip.scrollLeft = centerOf(0);
    layout();
  }
  function exitFan(): void {
    fan = false;
    section.classList.remove('covers--fan', 'covers--dragging');
    nav.hidden = true;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    lastTs = 0;
    velocity = 0;
    snapTarget = null;
    dragging = false;
    clearTimeout(restT);
    lastCur = -1;
    openBtn?.classList.remove('is-on');
    cards.forEach((el) => {
      el.style.transform = '';
      el.style.zIndex = '';
      el.classList.remove('is-cur');
      el.removeAttribute('aria-hidden');
    });
  }
  const sync = (): void => { if (wide.matches) enterFan(); else exitFan(); };
  wide.addEventListener('change', sync);
  sync();

  addEventListener('resize', () => {
    if (!fan) return;
    const cur = curIndex();
    measure();
    strip.scrollLeft = centerOf(cur);
    snapTarget = null;
    layout();
  }, { passive: true });
  // A scroll that slips past the model (Chrome's keyboard scrolling of the
  // scroller under the last click, focus scrolling, a scrollbar) repaints the
  // fan from the new position and, once it stops, settles onto the nearest
  // cover - the native snap this mode gave up would have done that.
  let nativeSettleT: ReturnType<typeof setTimeout> | 0 = 0;
  strip.addEventListener('scroll', () => {
    if (!fan || raf || dragging) return;
    layout();
    clearTimeout(nativeSettleT);
    nativeSettleT = setTimeout(() => { if (!raf && !dragging) { snapTarget = nearestTarget(); loop(); } }, 120);
  }, { passive: true });

  // ── Input ────────────────────────────────────────────────────────────────
  rootEl.querySelector('[data-covers="prev"]')?.addEventListener('click', () => go(curIndex() - 1));
  rootEl.querySelector('[data-covers="next"]')?.addEventListener('click', () => go(curIndex() + 1));
  rootEl.addEventListener('keydown', (e) => {
    if (!fan) return;
    if (e.key === 'ArrowLeft') { go(curIndex() - 1); e.preventDefault(); }
    if (e.key === 'ArrowRight') { go(curIndex() + 1); e.preventDefault(); }
  });

  // Horizontal wheel (trackpad swipe) spins the fan with momentum; a vertical
  // wheel ALWAYS falls through to the page - the strip never captures it.
  strip.addEventListener('wheel', (e) => {
    if (!fan) return;
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
    e.preventDefault();
    hold = Date.now() + HOLD_MS;
    snapTarget = null;
    if (reduced) {
      // No momentum: move with the hand, then snap once it stops.
      strip.scrollLeft += e.deltaX;
      layout();
      clearTimeout(wheelSettleT);
      wheelSettleT = setTimeout(() => { snapTarget = nearestTarget(); loop(); }, 150);
      return;
    }
    velocity = clampV(velocity + e.deltaX * WHEEL_TO_VELOCITY);
    loop();
  }, { passive: false });

  strip.addEventListener('pointerdown', (e) => {
    if (!fan) return;
    if (e.pointerType !== 'touch' && e.button !== 0 && e.button !== 1) return;
    velocity = 0;
    snapTarget = null;
    dragging = true;
    dragMoved = false;
    dragPointerId = e.pointerId;
    dragStartX = e.clientX;
    lastPointerX = e.clientX;
    lastMoveTs = performance.now();
    hold = Date.now() + HOLD_MS;
    section.classList.add('covers--dragging');
    try { strip.setPointerCapture(e.pointerId); } catch { /* best effort */ }
    e.preventDefault();
    loop();
  });
  // A middle press must pan, not engage the browser's autoscroll.
  strip.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
  strip.addEventListener('pointermove', (e) => {
    if (!dragging || e.pointerId !== dragPointerId) return;
    const now = performance.now();
    const dx = e.clientX - lastPointerX;
    if (Math.abs(e.clientX - dragStartX) > DRAG_SLOP) dragMoved = true;
    strip.scrollLeft -= dx;
    const dtm = now - lastMoveTs;
    if (dtm > 0) velocity = clampV(velocity * 0.7 + ((-dx / dtm) * 1000) * 0.3);
    lastPointerX = e.clientX;
    lastMoveTs = now;
    e.preventDefault();
  });
  const endDrag = (e: PointerEvent): void => {
    if (!dragging || e.pointerId !== dragPointerId) return;
    dragging = false;
    dragPointerId = -1;
    section.classList.remove('covers--dragging');
    // Take focus on RELEASE: Chrome's own press handling still moves focus to
    // the body after a cancelled pointerdown, so a focus() there is undone by
    // the time the keys arrive. After the release it sticks, and the region's
    // arrow-key handler owns the strip from here (no scroll jump).
    if (e.pointerType !== 'touch') rootEl.focus({ preventScroll: true });
    // A slow release (the hand already at rest) stops dead; only a real throw coasts.
    if (reduced || performance.now() - lastMoveTs > 80) velocity = 0;
    if (!dragMoved && e.type === 'pointerup' && e.button === 0) {
      // Cards are pointer-events:none, so map the press to a cover by its DRAWN
      // centre (layout centre + this frame's tuck) and centre that cover.
      const x = e.clientX - strip.getBoundingClientRect().left + strip.scrollLeft;
      let bi = -1;
      let bd = Infinity;
      geom.forEach((g, i) => {
        const d = Math.abs(g.vc - x);
        if (d < bd) { bd = d; bi = i; }
      });
      if (bi >= 0 && bi !== curIndex()) { go(bi); return; }
    }
    loop();
  };
  strip.addEventListener('pointerup', endDrag);
  strip.addEventListener('pointercancel', endDrag);

  rootEl.addEventListener('mouseenter', () => { hov = true; });
  rootEl.addEventListener('mouseleave', () => { hov = false; });
  rootEl.addEventListener('focusin', () => { hov = true; });
  rootEl.addEventListener('focusout', () => { hov = false; });

  if (!reduced) {
    const timer = setInterval(() => {
      if (!rootEl.isConnected) { clearInterval(timer); return; }
      if (!fan || hov || dragging || Date.now() < hold || document.hidden || Math.abs(velocity) > INERTIA_MIN_V) return;
      const n = curIndex() + 1;
      snapTarget = centerOf(n >= cards.length ? 0 : n);
      loop();
    }, AUTOPLAY_MS);
  }
}
