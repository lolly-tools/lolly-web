// SPDX-License-Identifier: MPL-2.0
/**
 * Featured row — the gallery's cinematic hero.
 *
 * A slowly-drifting strip of large tiles, one per tool flagged `featured` in its
 * manifest. Each tile is a live demonstration of Lolly's whole idea — *one tool,
 * endless on-brand outputs*: it starts on the tool's committed preview and then
 * cross-fades through a handful of rendered example looks (manifest.featured
 * .variants — different inputs AND themes), each produced by the real engine path
 * (see lib/featured-render.ts) and memoised so later visits are instant.
 *
 * Motion, and its restraint:
 *   - The whole row drifts left at a gentle ~22px/s. It PAUSES the moment a pointer
 *     is over it, focus lands inside it, a touch begins, or the visitor scrolls it
 *     by hand — so it never fights the user — and resumes shortly after.
 *   - Within a tile, the active look cross-fades every ~4.6s with a slow Ken-Burns
 *     drift, so a still tile still breathes.
 *   - `prefers-reduced-motion` turns ALL of that off: no drift, no cross-fade, no
 *     variant rendering. The strip stays a plain, manually-scrollable row of tiles.
 *
 * The tile art is object-fit:contain over a themed backdrop (never cropped — a
 * cropped logo or badge is worse than a letterboxed one), and every tile is a real
 * link to its tool, so the whole feature degrades to "a scrollable row of links".
 */

import { escape } from '../utils.ts';
import { renderFeaturedVariant, displayFormatOf } from '../lib/featured-render.ts';
import { toolSeedHref } from '../lib/seed-url.ts';
import { playSfx } from '../lib/sfx.ts';
import { currentTheme } from '../theme.ts';
import { icon } from '../lib/icons.ts';
import type { HostV1 } from '../../../../engine/src/bridge/host-v1.ts';
import type { PreviewsAPI } from '../bridge/previews.ts';

export interface FeaturedVariant {
  label?: string;
  /**
   * Which UI theme this look suits — set on looks that render ink on a TRANSPARENT
   * background (e.g. a reverse/white logo). 'dark' looks are shown on dark/SUSE themes,
   * 'light' looks on the light theme; a clashing look would be near-invisible on the
   * tile, so it's filtered out. Omit for looks that bake their own background (any theme).
   */
  theme?: 'light' | 'dark';
  values: Record<string, unknown>;
}
export interface FeaturedManifest {
  blurb?: string;
  order?: number;
  /** DEPRECATED alias for the top-level `examples` field — see resolveExamples(). */
  variants?: FeaturedVariant[];
}
/** The slice of a catalog index entry the featured row reads. */
export interface FeaturedEntry {
  id: string;
  name: string;
  preview?: string;
  /** The tool's inlined icon SVG — shown as the tile's fallback art when no preview/
   *  variant has loaded (and revealed if one errors), hidden once real art is ready. */
  icon?: string;
  formats?: readonly string[];
  status?: string;
  isNew?: boolean;
  /**
   * Where the tile links. Defaults to the tool route `#/tool/<id>`. Callers reusing the
   * strip for non-tool tiles (e.g. the Projects view's saved-session previews) set the
   * resume URL here so a middle-click / no-JS open still lands in the right place.
   */
  href?: string;
  /** Example looks (manifest.examples) — the canonical source; see resolveExamples(). */
  examples?: FeaturedVariant[];
  featured: FeaturedManifest;
}

/**
 * The example looks a tile cross-fades / scrolls through. The canonical field is the
 * top-level `examples`; `featured.variants` is the pre-`examples` alias kept working for
 * tools authored before it. `examples` wins when both are present. Shared by the featured
 * row and the gallery tile's preview strip so they never diverge on which looks a tool has.
 */
export function resolveExamples(src: { examples?: FeaturedVariant[]; featured?: FeaturedManifest } | undefined | null): FeaturedVariant[] {
  return src?.examples ?? src?.featured?.variants ?? [];
}

type FeaturedHost = HostV1 & { previews?: PreviewsAPI };

export interface FeaturedRowHandle {
  /** Pause/resume all motion (the gallery hides the row during search/filter). */
  setVisible(visible: boolean): void;
  /** Switch between the Gallery strip and the Cover Flow player-select. */
  setViewMode(mode: FeaturedViewMode): void;
  /** Tear down timers, the drift loop, listeners and the pending render queue. */
  destroy(): void;
}

const FADE_INTERVAL_MS = 4600;    // dwell on each look before cross-fading
const DRIFT_PX_PER_SEC = 22;      // "slowly" — a calm, readable drift speed
const RESUME_DELAY_MS = 900;      // after a manual scroll settles, ease back into drift
const WHEEL_TO_VELOCITY = 14;     // px/s of spin added per unit of horizontal wheel delta
const MAX_VELOCITY = 3200;        // px/s cap so a wild flick or wheel can't teleport the strip
const INERTIA_FRICTION = 0.94;    // velocity decay per ~16.7ms frame (≈1s coast to rest)
const INERTIA_MIN_V = 6;          // px/s; below this the coast stops and ambient drift may resume
const SHUFFLE_TRAVEL_PX = 9;      // how far a manually-flipped example nudges vertically ("off the deck")
const SHUFFLE_MS = 260;           // brief — roughly the .is-shifting cross-fade pace

// Lucide "arrow-right" — the Open affordance glyph.
const ARROW = icon('arrowRight', { size: 15, strokeWidth: 2.2 });

// Lucide "circle-help" — the optional "(?)" glyph beside a strip's pull label (opts.labelHref).
// Path data lives in lib/icons.ts as 'help' — deduped against footer-nav.ts's identical glyph
// (component-audit rec 5; help-tip.ts's own copy is a separate agent's territory, see followups).
const HELP_ICON = icon('help', { size: 12, strokeWidth: 2.4 });

// Kebab "more actions" glyph — the optional per-tile ⋯ menu button (opts.tileMenu). The
// consumer (e.g. Projects' Uncategorised ribbon) delegates the button's click to its own menu.
const MENU_DOTS = icon('menuDots', { size: 18, filled: true });

const ric = (cb: () => void): number =>
  (typeof requestIdleCallback === 'function'
    ? requestIdleCallback(cb, { timeout: 3000 })
    : setTimeout(cb, 60)) as unknown as number;
const cancelRic = (id: number): void =>
  (typeof cancelIdleCallback === 'function' ? cancelIdleCallback(id) : clearTimeout(id));

/** In featured `order` (ascending); entries without one keep catalog order, last. */
function byFeaturedOrder(a: FeaturedEntry, b: FeaturedEntry): number {
  const ao = a.featured.order ?? Infinity;
  const bo = b.featured.order ?? Infinity;
  return ao - bo;
}

function tileMarkup(entry: FeaturedEntry, eager = false, menu = false): string {
  const label = `${entry.isNew ? 'New — ' : ''}Open ${entry.name}${entry.featured.blurb ? ` — ${entry.featured.blurb}` : ''}`;
  // The committed preview is the instant first frame; rendered variants are appended
  // as layers as they arrive. A tool whose preview is missing (dev, before
  // `npm run previews`) simply starts on the themed backdrop until its first variant.
  // The FIRST tile is the above-the-fold LCP element, so it loads eagerly at high
  // priority — `loading="lazy"` on the hero delays LCP (the browser defers the very
  // image LCP measures). Off-screen tiles (index > 0) keep lazy.
  const loadAttrs = eager ? 'loading="eager" fetchpriority="high"' : 'loading="lazy"';
  const base = entry.preview
    ? `<img class="ftile-img is-active" data-base src="${escape(entry.preview)}" alt="" aria-hidden="true" draggable="false" ${loadAttrs}>`
    : '';
  // The tool's own icon is the always-present fallback: it shows until a real preview/
  // variant decodes (so a missing or slow image is never a blank/broken box), and it's
  // hidden the instant art is ready (`.ftile.has-art` — a transparent preview would
  // otherwise let the icon show through behind it). '' when the tool has no icon.
  const iconFill = entry.icon ? `<span class="ftile-iconfill" aria-hidden="true">${entry.icon}</span>` : '';
  const href = entry.href ?? `#/tool/${entry.id}`;
  // `data-basehref` is the tool's default route — the fallback the tile's href reverts to
  // while the committed placeholder is showing (a rendered look then points href at its own
  // seeded URL, so opening the tile lands in the look you're watching; see refreshLinkHref).
  return `
    <li class="ftile" data-tool="${escape(entry.id)}">
      <a class="ftile-link" href="${escape(href)}" data-basehref="${escape(href)}" aria-label="${escape(label)}" draggable="false">
        <span class="ftile-stage" aria-hidden="true">
          ${iconFill}
          ${base}
          ${entry.isNew ? '<span class="ftile-badge">New</span>' : ''}
          <span class="ftile-open">Open ${ARROW}</span>
        </span>
        <span class="ftile-meta">
          <span class="ftile-name">${escape(entry.name)}</span>
          ${entry.featured.blurb ? `<span class="ftile-blurb">${escape(entry.featured.blurb)}</span>` : ''}
        </span>
        <span class="ftile-dots" aria-hidden="true"></span>
      </a>
      ${menu ? `<button type="button" class="ftile-menu" aria-label="Actions for ${escape(entry.name)}" title="Actions">${MENU_DOTS}</button>` : ''}
    </li>`;
}

/**
 * Mount the featured row into `mount` (its innerHTML is replaced). Returns a handle
 * whose destroy() must be called before re-mounting or navigating away.
 */
export type FeaturedViewMode = 'gallery' | 'coverflow';

export function mountFeaturedRow(
  mount: HTMLElement,
  entriesIn: FeaturedEntry[],
  host: FeaturedHost,
  opts: { viewMode?: FeaturedViewMode; label?: string; ariaLabel?: string; tileDragOut?: boolean; tileMenu?: boolean; labelHref?: string; labelHelp?: string; onActivate?: (id: string) => void } = {},
): FeaturedRowHandle {
  const entries = [...entriesIn].sort(byFeaturedOrder);
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  let coverflow = opts.viewMode === 'coverflow';
  // Drag-out mode (Projects "Uncategorised" ribbon): each tile is a native HTML5 drag
  // source so a loose session can be dragged onto a "Move to" folder. The consumer wires
  // dragstart/dragend (it owns the payload); here we only make the tiles draggable and,
  // below, keep a tile-press from being swallowed by the grab-pan so the drag can start.
  const tileDragOut = opts.tileDragOut === true;
  // Per-tile ⋯ menu button (Projects' Uncategorised ribbon): a visible, touch-friendly handle
  // whose click the consumer delegates to its own actions menu (Move to folder…, Rename, …).
  const tileMenu = opts.tileMenu === true;
  // In-view activation: when the consumer wants a tile press to DO something in place
  // (e.g. open a modal) rather than navigate a route, it passes onActivate. Tiles then
  // hand their id to it instead of following their href — which is what keeps the
  // catalogue favourites strip's "Open" (a same-route #/c?asset=… link) from being
  // swallowed by the router's same-route dedupe. The <a href> is kept as the middle- /
  // ⌘-click "open in new tab" + no-JS deep-link fallback.
  const onActivate = opts.onActivate;

  mount.innerHTML = `
    <section class="featured${reduced ? ' featured--static' : ''}${coverflow ? ' featured--coverflow' : ''}" aria-label="${escape(opts.ariaLabel || opts.label || 'Featured tools')}" aria-roledescription="carousel">
      ${opts.label ? `<span class="featured-label">${escape(opts.label)}${opts.labelHref ? `<a class="featured-label-help" href="${escape(opts.labelHref)}" aria-label="${escape(opts.labelHelp || 'Learn more')}" title="${escape(opts.labelHelp || 'Learn more')}">${HELP_ICON}</a>` : ''}</span>` : ''}
      <div class="featured-viewport">
        <ul class="featured-track">${entries.map((e, i) => tileMarkup(e, i === 0, tileMenu)).join('')}</ul>
      </div>
      <div class="featured-grip" aria-hidden="true"><span class="featured-grip-bar"></span></div>
    </section>`;

  const section = mount.querySelector<HTMLElement>('.featured')!;
  const viewport = mount.querySelector<HTMLElement>('.featured-viewport')!;
  const track = mount.querySelector<HTMLElement>('.featured-track')!;

  // Make the ORIGINAL tile links drag sources; setupLoop's wrap-clones are cloneNode(true)
  // copies made after this, so they inherit draggable (and re-cloning on a view switch
  // keeps it). tileMarkup sets draggable="false" to suppress the native link-drag ghost
  // during a pan — here we deliberately turn it back on.
  if (tileDragOut) track.querySelectorAll<HTMLElement>('.ftile-link').forEach((l) => { l.draggable = true; });

  const ac = new AbortController();
  const { signal } = ac;
  let destroyed = false;
  let visible = true; // the gallery pauses the row while a search / filter is active
  // Scrolled-into-view gate: when the strip is fully scrolled off-screen (user is down in
  // the grid) there's nothing to animate, so we park the whole drift loop + cross-fade
  // rather than write scrollLeft 60×/s off-screen (each write re-fires the scroll listener
  // → normalizeWrap). An IntersectionObserver (set up after startRaf below) flips this;
  // SSR / engines without IntersectionObserver keep it true → always-on, as before.
  let onScreen = true;
  let vizObserver: IntersectionObserver | undefined;

  // ── Cross-fade + Ken Burns: one shared ticker advances every tile's active look ──
  // (a still tile keeps breathing via CSS Ken Burns on .is-active). Skips tiles with
  // fewer than two decoded images, and pauses wholesale while the row is off-screen.
  const isReady = (img: HTMLImageElement): boolean => img.complete && img.naturalWidth > 0;

  // Icon fallback ⇄ real art. Mark a tile `has-art` the instant any preview/variant image
  // decodes — that hides the icon so a transparent image can't reveal it behind the art —
  // and DROP an image that 404s/errors so the icon stands in rather than a broken box.
  // Capture phase (load/error don't bubble); covers the committed base AND the lazily
  // appended variant layers.
  const markArt = (img: HTMLImageElement): void => { if (isReady(img)) img.closest('.ftile')?.classList.add('has-art'); };
  track.querySelectorAll<HTMLImageElement>('.ftile-img').forEach(markArt);   // warm-cache hits
  track.addEventListener('load', (e) => { const t = e.target as HTMLElement | null; if (t?.classList?.contains('ftile-img')) markArt(t as HTMLImageElement); }, { capture: true, signal });
  track.addEventListener('error', (e) => { const t = e.target as HTMLElement | null; if (t?.classList?.contains('ftile-img')) t.remove(); }, { capture: true, signal });

  function syncDots(link: Element, imgs: HTMLImageElement[], activeIdx: number): void {
    const dots = link.querySelector<HTMLElement>('.ftile-dots');
    if (!dots) return;
    if (imgs.length < 2) { dots.innerHTML = ''; return; }
    if (dots.childElementCount !== imgs.length) {
      dots.innerHTML = imgs.map(() => '<span class="ftile-dot"></span>').join('');
    }
    [...dots.children].forEach((d, i) => d.classList.toggle('is-on', i === activeIdx));
  }

  // The looks a stage rotates through: decoded variant layers if any have arrived, else
  // the committed-preview placeholder. So once real variants render, the base drops out
  // of the rotation (it was only the instant first-paint image, and may not suit the
  // current theme anyway).
  function rotationImgs(stage: Element): HTMLImageElement[] {
    const ready = [...stage.querySelectorAll<HTMLImageElement>('.ftile-img')].filter(isReady);
    const variants = ready.filter((i) => i.dataset.base === undefined);
    return variants.length ? variants : ready;
  }

  // Point a tile's <a> at the currently-shown look's seeded URL, so a tap / click / ⌘-click
  // (new tab) / keyboard Enter opens the tool in THAT exact style — the featured row's parity
  // with the gallery carousels' click-to-seed ("you get the config you saw"). Reverts to the
  // tool's default route (`data-basehref`) while the committed placeholder is active or before
  // a look's seed URL has resolved. Each rendered look carries its URL on `data-seedhref` (set
  // in addVariantImage once toolSeedHref resolves).
  function refreshLinkHref(link: Element | null): void {
    if (!(link instanceof HTMLAnchorElement)) return;
    const active = link.querySelector<HTMLImageElement>('.ftile-stage .ftile-img.is-active');
    link.setAttribute('href', active?.dataset.seedhref ?? link.dataset.basehref ?? link.getAttribute('href') ?? '');
  }

  // Cross-fade a stage to the next (dir 1) / previous (dir -1) look. `shuffle` adds the
  // card-shuffle micro-motion — passed on a MANUAL flip, off for the ambient cross-fade.
  function advanceStage(stage: Element, dir = 1, shuffle = false): void {
    const link = stage.parentElement!;
    const all = [...stage.querySelectorAll<HTMLImageElement>('.ftile-img')];
    const imgs = rotationImgs(stage);
    if (!imgs.length) return;
    const cur = imgs.findIndex((i) => i.classList.contains('is-active'));
    // cur === -1 means the active layer is the base placeholder (now out of rotation) —
    // step onto the first variant regardless of direction.
    const nextIdx = imgs.length < 2 || cur === -1
      ? 0
      : ((cur + dir) % imgs.length + imgs.length) % imgs.length;
    all.forEach((i) => i.classList.remove('is-active'));  // also clears a lingering base
    const incoming = imgs[nextIdx]!;
    incoming.classList.add('is-active');
    syncDots(link, imgs, imgs.length < 2 ? -1 : nextIdx);
    refreshLinkHref(link);   // the tile now links to the look it's showing
    if (shuffle && !reduced && nextIdx !== cur) shuffleFlip(incoming, cur >= 0 ? imgs[cur]! : null, dir);
  }

  // Card-shuffle micro-motion on a manual flip: the incoming example rises into place from
  // the direction you're flipping (down→next comes up from below), while the outgoing one
  // recedes the opposite way and a hair smaller — a brief "next card off the deck" beat that
  // makes flipping through looks feel physical. WAAPI so it layers cleanly over the CSS Ken
  // Burns and reverts on its own (no fill) — Ken Burns simply resumes. transform-origin is
  // pinned to the floor so the object stays planted (matching the Ken Burns scale).
  function shuffleFlip(incoming: HTMLImageElement, outgoing: HTMLImageElement | null, dir: number): void {
    if (typeof incoming.animate !== 'function') return;   // WAAPI guard (ancient engines)
    const off = dir >= 0 ? SHUFFLE_TRAVEL_PX : -SHUFFLE_TRAVEL_PX;
    const play = (el: HTMLImageElement, from: string, to: string): void => {
      (el as unknown as { __shuffle?: Animation }).__shuffle?.cancel();   // a fast flurry shouldn't stack
      (el as unknown as { __shuffle?: Animation }).__shuffle = el.animate(
        [{ transform: from, transformOrigin: 'center bottom' },
         { transform: to,   transformOrigin: 'center bottom' }],
        { duration: SHUFFLE_MS, easing: 'cubic-bezier(.22,.7,.28,1)' },
      );
    };
    play(incoming, `translateY(${off}px) scale(.985)`, 'translateY(0) scale(1)');
    if (outgoing) play(outgoing, 'translateY(0) scale(1)', `translateY(${-off}px) scale(.985)`);
  }

  // Shift one tool's examples on BOTH its original tile and its clone, so they stay in sync.
  function shiftTool(toolId: string, dir: number): void {
    track.querySelectorAll(`.ftile[data-tool="${CSS.escape(toolId)}"] .ftile-stage`).forEach((s) => advanceStage(s, dir, true));
  }

  // A manual shift (wheel / vertical gesture) suppresses the auto cross-fade + drift for
  // a beat and speeds the transition (.is-shifting) so hand-flips feel snappy, not slow.
  let shiftClsTimer: ReturnType<typeof setTimeout> | undefined;
  function markManualShift(): void {
    manualUntil = performance.now() + RESUME_DELAY_MS;
    section.classList.add('is-shifting');
    clearTimeout(shiftClsTimer);
    shiftClsTimer = setTimeout(() => section.classList.remove('is-shifting'), 600);
  }

  let fadeTimer: ReturnType<typeof setInterval> | undefined;
  if (!reduced) {
    fadeTimer = setInterval(() => {
      // Pause the auto cross-fade while the pointer is over the strip, a finger is on it,
      // or a hand-shift is in progress — a cross-fade firing mid-swipe animates two
      // drop-shadowed images at once and janks the scroll (mobile especially). `touching`
      // covers the whole swipe; hovering/manualUntil cover the mouse + post-gesture rest.
      if (destroyed || !visible || !onScreen || document.hidden || hovering || touching || performance.now() < manualUntil) return;
      track.querySelectorAll('.ftile-stage').forEach((s) => advanceStage(s));
    }, FADE_INTERVAL_MS);
  }

  // ── Motion model: ambient drift · flick/wheel inertia · pointer drag ─────────
  // The viewport is a native horizontal scroller (swipe / trackpad / keyboard all
  // free). One rAF loop owns scrollLeft with three states, in priority order:
  //   1. dragging   — the pointer sets scrollLeft directly (see pointermove).
  //   2. |velocity| — a flick-release or wheel spin-up coasts and decays ("wheel
  //                   physics": grab-and-throw keeps spinning, then eases to rest).
  //   3. idle       — the slow ambient drift resumes.
  // A cloned second copy of the track keeps the wrap seamless. Cloning + auto motion
  // engage only when the content overflows; under reduced motion the strip is a plain
  // (still grab-draggable) scroller with no drift and no inertia coast.
  let raf = 0;
  let lastTs = 0;
  let looping = false;
  let halfWidth = 0;
  let velocity = 0;   // px/s, for flick / wheel inertia
  let snapTarget: number | null = null;   // coverflow: scrollLeft to ease toward (a chosen cover)

  // Drag state — mouse/pen "grab and shift" (horizontal carousel pan).
  let dragging = false;
  let dragMoved = false;
  let dragPointerId = -1;
  let dragStartX = 0;   // where the press began — the click-vs-drag slop is measured from here
  let lastPointerX = 0;
  let lastMoveTs = 0;
  let pressLink: HTMLAnchorElement | null = null; // the tile link a mouse/pen press landed on
  let suppressNextClick = false;                  // we opened on pointerup; cancel the native click

  // Touch gesture state — horizontal = native carousel scroll; vertical = shift the
  // examples of the touched tile. Direction is decided after a few px, then locked.
  let touchGesture: 'pending' | 'shift' | 'scroll' = 'scroll';
  let touchId = -1;
  let touchStartX = 0;
  let touchStartY = 0;
  let shiftBaseY = 0;
  let touchTool: string | null = null;

  // How much wheel / drag travel steps one example.
  const DRAG_SLOP = 8;      // px a mouse/pen press may travel and still count as a click, not a drag
  const SHIFT_STEP_WHEEL = 60;
  const SHIFT_STEP_TOUCH = 46;
  const GESTURE_SLOP = 8;   // px before a touch commits to shift-vs-scroll

  // The current UI theme decides which transparent-background looks are legible (a
  // reverse/white look on a light tile — or a dark look on a dark tile — would vanish).
  const darkTheme = /^(dark|suse)$/.test(currentTheme());

  // Pause signals for the AMBIENT drift only (drag + inertia are user-driven and
  // ignore these). The drift runs only when ALL are clear.
  let hovering = false;
  let focusWithin = false;
  let touching = false;
  let manualUntil = 0; // timestamp; a hand-scroll / drag suppresses drift briefly

  // Flick cue — a soft paper tick as each tile / cover flips past WHILE the user is scrolling
  // (drag or flick-coast), never during the calm ambient drift. `flickIndex` tracks the item
  // currently at centre so we only tick on a crossing; the play is rate-limited so a fast riffle
  // flutters rather than buzzes.
  const FLICK_MIN_MS = 42;
  let lastFlickTs = 0;
  let flickIndex = -1;
  function flick(): void {
    const now = performance.now();
    if (now - lastFlickTs < FLICK_MIN_MS) return;
    lastFlickTs = now;
    playSfx('flick');
  }

  const clampV = (v: number): number => Math.max(-MAX_VELOCITY, Math.min(MAX_VELOCITY, v));
  const canDrift = (now: number): boolean =>
    looping && !coverflow && !reduced && !destroyed && visible && onScreen && !document.hidden &&
    !hovering && !focusWithin && !touching && now >= manualUntil;

  function normalizeWrap(): void {
    if (!looping || halfWidth <= 0) return;
    // Keep scrollLeft within [0, halfWidth): the second copy is identical, so
    // subtracting one copy's width is visually seamless. Handles drift, inertia
    // coast, and a hand-drag/scroll that runs off either end.
    if (viewport.scrollLeft >= halfWidth) viewport.scrollLeft -= halfWidth;
    else if (viewport.scrollLeft < 0) viewport.scrollLeft += halfWidth;
  }

  // ── Cover Flow ────────────────────────────────────────────────────────────────
  // The scroll position is the single source of truth: each cover's transform is a
  // pure function of its LAYOUT offset from the viewport centre (offsetLeft/offsetWidth
  // are transform-independent, so there's no feedback loop). The centred cover is
  // upright + front (`.is-centred`); its neighbours fan back, rotate, and tuck inward.
  const CF_MAX_ANGLE = 50;   // deg a fully side-on cover rotates
  const CF_TUCK = 0.52;      // fraction of a cover-width each neighbour pulls toward centre
                             // (higher → covers overlap more toward the screen edges, so
                             //  the fan stacks tighter and more covers fit on screen)
  const CF_MIN_SCALE = 0.72; // scale of the side covers

  // A cover's centre + width only change on (re)layout, but layoutCoverflow() runs every
  // frame during a drag/flick. Cache them in setupLoop so the hot loop is WRITE-only: an
  // offsetLeft/offsetWidth read mid-loop would flush a style recalc after each is-centred
  // class toggle (a per-tile-per-frame cost — felt most on mobile). Rebuilt on resize,
  // view-switch, and the post-decode relayout.
  let cfGeom: Array<{ el: HTMLElement; center: number; w: number }> = [];

  function layoutCoverflow(): void {
    if (!coverflow) return;
    const focus = viewport.scrollLeft + viewport.clientWidth / 2;
    let bestI = -1, bestAbs = Infinity, i = 0;             // which cover is centred, for the flick
    for (const g of cfGeom) {
      const d = (g.center - focus) / g.w;                 // signed offset in cover-widths
      if (Math.abs(d) < bestAbs) { bestAbs = Math.abs(d); bestI = i; }
      i++;
      const cd = Math.max(-1.4, Math.min(1.4, d));        // angle/scale saturate near the edge
      // Tuck keeps pulling the FURTHER covers in (own wider clamp), instead of plateauing
      // at cd's ±1.4 like the rotation does — otherwise every cover past the first neighbour
      // sits ~a full width apart and the fan gaps out at the screen edges. With a wider range
      // the net spacing stays a uniform ~(1-CF_TUCK)·width, so the covers stack tight all the
      // way out. (Range caps the transform for far off-screen covers; doesn't affect visible ones.)
      const td = Math.max(-3.2, Math.min(3.2, d));
      const angle = -cd * CF_MAX_ANGLE;
      const scale = 1 - Math.min(Math.abs(d), 1) * (1 - CF_MIN_SCALE);
      const tuck = -td * g.w * CF_TUCK;
      g.el.style.transform = `translateX(${tuck.toFixed(1)}px) rotateY(${angle.toFixed(1)}deg) scale(${scale.toFixed(3)})`;
      g.el.style.zIndex = String(1000 - Math.round(Math.abs(d) * 20));
      g.el.classList.toggle('is-centred', Math.abs(d) < 0.5);
    }
    // Flip past a cover → a flick. (Coverflow has no ambient drift, so every change is the user.)
    if (bestI !== flickIndex) { if (flickIndex !== -1) flick(); flickIndex = bestI; }
  }

  // scrollLeft that centres a given cover (offsetLeft includes the track's centring pad).
  const coverScrollLeft = (el: HTMLElement): number => el.offsetLeft + el.offsetWidth / 2 - viewport.clientWidth / 2;

  function nearestCoverScrollLeft(): number {
    const half = viewport.clientWidth / 2;
    let best = viewport.scrollLeft, bestD = Infinity;
    for (const g of cfGeom) {                              // cached geometry (see layoutCoverflow)
      const target = g.center - half;
      const dist = Math.abs(target - viewport.scrollLeft);
      if (dist < bestD) { bestD = dist; best = target; }
    }
    return best;
  }

  function clearCoverflow(): void {
    track.querySelectorAll<HTMLElement>('.ftile').forEach((el) => {
      el.style.transform = ''; el.style.zIndex = ''; el.classList.remove('is-centred');
    });
    track.style.paddingLeft = ''; track.style.paddingRight = '';
  }

  function tick(ts: number): void {
    if (destroyed) { raf = 0; return; }             // stop rescheduling once torn down
    if (!onScreen) { raf = 0; return; }             // parked off-screen — the observer restarts us
    raf = requestAnimationFrame(tick);
    const dt = lastTs ? ts - lastTs : 0;
    lastTs = ts;
    if (!visible || document.hidden || dt <= 0 || dt > 200) return; // skip huge gaps
    if (dragging) { if (coverflow) layoutCoverflow(); return; }   // (1) pointer owns scrollLeft

    if (coverflow) {
      if (Math.abs(velocity) > INERTIA_MIN_V) {    // coast from a flick/wheel
        viewport.scrollLeft += (velocity * dt) / 1000;
        velocity = clampV(velocity * INERTIA_FRICTION ** (dt / 16.67));
        if (Math.abs(velocity) < INERTIA_MIN_V) velocity = 0;
        layoutCoverflow();
        return;
      }
      // Settle onto a cover: ease toward the chosen (or nearest) one.
      const target = snapTarget ?? nearestCoverScrollLeft();
      const diff = target - viewport.scrollLeft;
      if (Math.abs(diff) < 0.5) { viewport.scrollLeft = target; snapTarget = null; }
      else viewport.scrollLeft += diff * Math.min(1, (dt / 1000) * 12); // time-based ease
      layoutCoverflow();
      return;
    }

    if (Math.abs(velocity) > INERTIA_MIN_V) {      // (2) flick / wheel coast
      viewport.scrollLeft += (velocity * dt) / 1000;
      velocity = clampV(velocity * INERTIA_FRICTION ** (dt / 16.67)); // frame-rate independent
      if (Math.abs(velocity) < INERTIA_MIN_V) velocity = 0;
      normalizeWrap();
      return;
    }
    if (canDrift(ts)) {                            // (3) ambient drift
      viewport.scrollLeft += (DRIFT_PX_PER_SEC * dt) / 1000;
      normalizeWrap();
    }
  }

  function setupLoop(): void {
    // Re-evaluate on resize: (un)clone and (dis)engage drift to match overflow.
    track.querySelectorAll('.ftile--clone').forEach((n) => n.remove());
    looping = false;
    halfWidth = 0;
    // Cover Flow is a finite, snap carousel (no seamless clone loop). Pad the track so
    // the first and last cover can reach the centre, then lay out the fan.
    if (coverflow) {
      section.classList.remove('featured--overflow');
      const tiles = [...track.querySelectorAll<HTMLElement>('.ftile')];
      const pad = Math.max(0, (viewport.clientWidth - (tiles[0]?.offsetWidth ?? 0)) / 2);
      track.style.paddingLeft = track.style.paddingRight = `${pad}px`;
      // Snapshot geometry AFTER padding lands (it shifts every offsetLeft) so the per-frame
      // layout can read from cfGeom instead of the DOM. Tile width/left are otherwise stable
      // here (fixed cover width; no clones in this mode; decoding only changes height).
      cfGeom = tiles.map((el) => ({ el, center: el.offsetLeft + el.offsetWidth / 2, w: el.offsetWidth || 1 }));
      layoutCoverflow();
      return;
    }
    // A tile is ~fixed width; overflow means the single set is wider than the viewport.
    const overflow = track.scrollWidth - viewport.clientWidth > 4;
    if (reduced || !overflow) { section.classList.toggle('featured--overflow', overflow); return; }
    section.classList.add('featured--overflow');
    const originals = [...track.children] as HTMLElement[];
    const clones = originals.map((tile) => {
      const c = tile.cloneNode(true) as HTMLElement;
      c.classList.add('ftile--clone');
      c.setAttribute('aria-hidden', 'true');
      // Clones are decorative duplicates — keep them out of the tab order and off AT.
      if (c.matches('a,button,[tabindex]')) c.setAttribute('tabindex', '-1');
      c.querySelectorAll<HTMLElement>('a,button,[tabindex]').forEach((el) => el.setAttribute('tabindex', '-1'));
      return c;
    });
    clones.forEach((c) => track.appendChild(c));
    // The seamless period is the exact on-screen distance from the first original to
    // its clone — measured from layout, so track padding + the flex gap are all
    // accounted for (a computed width would be off by a gutter and the wrap would jump).
    halfWidth = clones[0]!.offsetLeft - originals[0]!.offsetLeft;
    looping = halfWidth > 0;
  }

  // ── Pause wiring (ambient drift) ─────────────────────────────────────────────
  section.addEventListener('pointerenter', () => { hovering = true; }, { signal });
  section.addEventListener('pointerleave', () => { hovering = false; }, { signal });
  section.addEventListener('focusin', () => { focusWithin = true; }, { signal });
  section.addEventListener('focusout', () => { focusWithin = false; }, { signal });
  viewport.addEventListener('touchstart', () => { touching = true; velocity = 0; }, { signal, passive: true });
  viewport.addEventListener('touchend', () => { touching = false; manualUntil = performance.now() + RESUME_DELAY_MS; }, { signal, passive: true });
  viewport.addEventListener('scroll', () => {
    if (coverflow) { layoutCoverflow(); return; }
    normalizeWrap();
    // Flick as each tile passes centre — but only while the user is driving it (a drag or a
    // flick-coast), never during the calm ambient drift. `flickIndex` tracks position even while
    // drifting so the next user flick doesn't start out of sync.
    if (looping && halfWidth > 0) {
      const stride = halfWidth / Math.max(1, entries.length);
      const idx = Math.round((viewport.scrollLeft + viewport.clientWidth / 2) / stride);
      if (idx !== flickIndex) {
        if (flickIndex !== -1 && (dragging || Math.abs(velocity) > 30)) flick();
        flickIndex = idx;
      }
    }
  }, { signal, passive: true });

  const tileToolAt = (e: Event): string | null =>
    (e.target as Element | null)?.closest?.<HTMLElement>('.ftile')?.dataset.tool ?? null;

  // Open a tile's link the same way its native anchor would (same-origin hash route,
  // or an explicit resume URL). We do this on pointerup for a clean tap rather than
  // trust the native click, which a drifting / re-cloning carousel drops when the
  // mousedown and mouseup resolve to different nodes (and which pointer capture can
  // retarget off the anchor) — the root of "Open sometimes does nothing" on desktop.
  const openLink = (link: HTMLAnchorElement | null): void => {
    // Consumer-driven in-view open (see onActivate): hand the tile's id to the callback
    // rather than navigating its href, so a same-route "Open" isn't lost to route dedupe.
    if (onActivate) {
      const id = link?.closest<HTMLElement>('.ftile')?.dataset.tool;
      if (id) { onActivate(id); return; }
    }
    const href = link?.href || link?.getAttribute('href');
    if (href) window.location.href = href;
  };

  // ── Wheel ─────────────────────────────────────────────────────────────────────
  // Vertical wheel over a tile SHIFTS that tile's examples (quick flip through looks);
  // horizontal wheel (trackpad swipe) spins the carousel with momentum. Non-passive so
  // both can preventDefault. Vertical wheel off a tile is left to scroll the page.
  let wheelTool: string | null = null;
  let wheelAccum = 0;
  viewport.addEventListener('wheel', (e) => {
    if (reduced) return;
    if (coverflow) {                                         // any wheel flicks between covers
      e.preventDefault();
      snapTarget = null;
      const primary = Math.abs(e.deltaX) >= Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      velocity = clampV(velocity + primary * WHEEL_TO_VELOCITY);
      return;
    }
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {           // horizontal → carousel momentum
      manualUntil = performance.now() + RESUME_DELAY_MS;
      e.preventDefault();
      velocity = clampV(velocity + e.deltaX * WHEEL_TO_VELOCITY);
      return;
    }
    const toolId = tileToolAt(e);                            // vertical → shift this tile's looks
    if (!toolId) return;
    e.preventDefault();
    if (toolId !== wheelTool) { wheelTool = toolId; wheelAccum = 0; }
    wheelAccum += e.deltaY;
    while (Math.abs(wheelAccum) >= SHIFT_STEP_WHEEL) {
      const dir = wheelAccum > 0 ? 1 : -1;                   // scroll down → next look
      shiftTool(toolId, dir);
      wheelAccum -= dir * SHIFT_STEP_WHEEL;
      markManualShift();
    }
  }, { signal });

  // ── Pointer down — mouse/pen start a horizontal carousel drag; touch defers the
  // decision (horizontal scroll vs vertical example-shift) to the first move. Either
  // way the grab lights up the backdrop (see .is-grabbing). ──
  viewport.addEventListener('pointerdown', (e) => {
    // A press on the ⋯ menu button is neither a pan nor a tile open — leave it to the button's
    // own click (delegated to the consumer's actions menu), whatever the view mode / device.
    if ((e.target as Element | null)?.closest?.('.ftile-menu')) return;
    // Drag-out mode: a mouse/pen press ON a tile is a click-to-open or the start of a
    // native drag-to-folder — never a pan grab. Yield to the browser (no preventDefault /
    // pointer capture / dragging state) so HTML5 drag can begin; panning stays available
    // via the wheel/trackpad, the mobile grip, and the ambient drift. (Touch has no native
    // DnD, so it keeps the normal scroll/shift gesture handling below.)
    if (tileDragOut && e.pointerType !== 'touch' && e.button === 0 && (e.target as Element | null)?.closest?.('.ftile-link')) return;
    velocity = 0;                                            // a grab cancels any coast
    snapTarget = null;
    dragMoved = false;                                       // fresh press — never inherit a prior drag's "moved"
    suppressNextClick = false;                               // fresh press — never inherit a stale suppress flag
    dragStartX = e.clientX;                                  // anchor for the click-vs-drag slop test
    pressLink = (e.target as Element | null)?.closest?.<HTMLAnchorElement>('.ftile-link') ?? null;
    section.classList.add('is-grabbing');
    // Gallery touch defers to a scroll-vs-shift decision; Cover Flow touch (and all
    // mouse/pen) go straight to a horizontal drag.
    if (e.pointerType === 'touch' && !coverflow) {
      touchGesture = 'pending';
      touchId = e.pointerId;
      touchStartX = e.clientX;
      touchStartY = e.clientY;
      touchTool = tileToolAt(e);
      return;
    }
    if (e.pointerType !== 'touch' && e.button !== 0 && e.button !== 1) return; // left- or middle-drag pans (mouse/pen), like the canvas
    dragging = true;
    dragPointerId = e.pointerId;
    lastPointerX = e.clientX;
    lastMoveTs = performance.now();
    try { viewport.setPointerCapture(e.pointerId); } catch { /* capture is best-effort */ }
    // Stop the browser turning the drag into a text selection / native image-drag.
    e.preventDefault();
  }, { signal });

  // A middle-button press must pan (like the canvas), not engage the browser's middle-click
  // autoscroll. preventDefault() on the pointerdown above doesn't stop it — the autoscroll
  // is a default action of the mousedown on this native scroller — so cancel it here.
  viewport.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); }, { signal });

  viewport.addEventListener('pointermove', (e) => {
    // Gallery touch: decide scroll (horizontal, native) vs shift (vertical, ours).
    if (e.pointerType === 'touch' && !coverflow) {
      if (e.pointerId !== touchId || touchGesture === 'scroll') return;
      if (touchGesture === 'pending') {
        const dx = e.clientX - touchStartX, dy = e.clientY - touchStartY;
        if (Math.max(Math.abs(dx), Math.abs(dy)) <= GESTURE_SLOP) return;
        if (Math.abs(dy) > Math.abs(dx) && touchTool) {
          touchGesture = 'shift';
          dragMoved = true;                                  // a shift is a gesture, not a tap — don't also open the tool
          shiftBaseY = e.clientY;
          try { viewport.setPointerCapture(touchId); } catch { /* best effort */ }
        } else {
          touchGesture = 'scroll';                           // native pan-x handles the carousel
          return;
        }
      }
      // shift mode: each SHIFT_STEP_TOUCH of vertical travel flips one example.
      let dy = e.clientY - shiftBaseY;
      while (Math.abs(dy) >= SHIFT_STEP_TOUCH) {
        const dir = dy < 0 ? 1 : -1;                         // drag up → next look
        if (touchTool) shiftTool(touchTool, dir);
        shiftBaseY += dir === 1 ? -SHIFT_STEP_TOUCH : SHIFT_STEP_TOUCH;
        dy = e.clientY - shiftBaseY;
        markManualShift();
      }
      e.preventDefault();
      return;
    }
    // Mouse/pen: horizontal carousel drag.
    if (!dragging || e.pointerId !== dragPointerId) return;
    const now = performance.now();
    const dx = e.clientX - lastPointerX;
    // Click-vs-drag: it's a drag (which cancels the tile's click) only once the press has
    // travelled past the slop from where it began. A pixel or three of hand-jitter during
    // a plain click must still open the tool. Panning tracks every move regardless.
    if (Math.abs(e.clientX - dragStartX) > DRAG_SLOP) dragMoved = true;
    viewport.scrollLeft -= dx;                               // content follows the pointer
    normalizeWrap();
    const dtm = now - lastMoveTs;
    if (dtm > 0) {
      // -dx: dragging content right (dx>0) DECREASES scrollLeft, so the coast that
      // continues that motion is negative. Exponential-smoothed so a jittery final
      // sample doesn't dominate the throw.
      velocity = clampV(velocity * 0.7 + ((-dx / dtm) * 1000) * 0.3);
    }
    lastPointerX = e.clientX;
    lastMoveTs = now;
    e.preventDefault();
  }, { signal });

  const endDrag = (e: PointerEvent): void => {
    if (e.pointerType === 'touch' && !coverflow) {
      if (e.pointerId !== touchId) return;
      if (touchGesture === 'shift') { try { viewport.releasePointerCapture(touchId); } catch { /* ok */ } }
      touchGesture = 'scroll';
      touchId = -1;
      touchTool = null;
      section.classList.remove('is-grabbing');
      manualUntil = performance.now() + RESUME_DELAY_MS;
      return;
    }
    if (!dragging || (e.pointerId !== undefined && e.pointerId !== dragPointerId)) return;
    dragging = false;
    dragPointerId = -1;
    section.classList.remove('is-grabbing');
    manualUntil = performance.now() + RESUME_DELAY_MS;       // let the coast finish before drift
    // No inertia under reduced motion; and a slow release (pointer already at rest for
    // a beat) should just stop rather than drift on a stale sample. Cover Flow always
    // coasts + snaps, so keep the fling velocity there.
    if (!coverflow && (reduced || performance.now() - lastMoveTs > 80)) velocity = 0;
    // Deterministic open: a clean left tap/click (no drag, no modifier keys) opens the
    // pressed tile right here on release, rather than depending on the native <a> click
    // (which the drifting carousel drops when the press and release land on different
    // nodes → no click fires). Modified / middle clicks fall through to the native
    // anchor so cmd/ctrl/middle-click still open a new tab; keyboard Enter is unaffected.
    // In Cover Flow, only the centred cover opens — a side cover's click centres it (the
    // capture-phase handler below), so leave that to the native click path.
    const plainTap = !dragMoved && e.button === 0 && !(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey);
    const centredOrGallery = !coverflow || (pressLink?.closest('.ftile')?.classList.contains('is-centred') ?? false);
    if (plainTap && pressLink && centredOrGallery) {
      suppressNextClick = true;                              // cancel the native click so we don't double-navigate
      openLink(pressLink);
    }
  };
  viewport.addEventListener('pointerup', endDrag, { signal });
  viewport.addEventListener('pointercancel', endDrag, { signal });
  viewport.addEventListener('click', (e) => {
    // Let a ⋯ menu-button click through untouched — it must reach the consumer's delegated
    // handler, and (in Cover Flow) must NOT be treated as a "centre this side cover" click.
    if ((e.target as Element | null)?.closest?.('.ftile-menu')) return;
    // We already navigated on pointerup (deterministic open) — swallow the native click
    // so the anchor doesn't fire a second, duplicate navigation.
    if (suppressNextClick) { suppressNextClick = false; e.preventDefault(); e.stopPropagation(); dragMoved = false; return; }
    if (dragMoved) { e.preventDefault(); e.stopPropagation(); dragMoved = false; return; }
    // In-view activation (onActivate): a plain, unmodified click that DIDN'T come from a
    // pointerup-open — keyboard Enter on the focused anchor, or any native click we didn't
    // already handle — hands off to onActivate instead of the anchor's href navigation, so
    // keyboard users get the same in-view open (and it isn't lost to route dedupe). Modified
    // / middle clicks fall through so ⌘/ctrl/middle-click still open the deep link in a new
    // tab. In Cover Flow only the centred cover activates; a side cover still centres below.
    if (onActivate && e.button === 0 && !(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)) {
      const link = (e.target as Element | null)?.closest?.<HTMLAnchorElement>('.ftile-link');
      const centredOrGallery = !coverflow || (link?.closest('.ftile')?.classList.contains('is-centred') ?? false);
      if (link && centredOrGallery) { e.preventDefault(); e.stopPropagation(); openLink(link); return; }
    }
    // Cover Flow: clicking a side cover brings it to the centre (select it) rather than
    // opening; only the already-centred cover opens its tool.
    if (coverflow) {
      const tile = (e.target as Element | null)?.closest?.<HTMLElement>('.ftile');
      if (tile && !tile.classList.contains('is-centred')) {
        e.preventDefault(); e.stopPropagation();
        snapTarget = coverScrollLeft(tile);
      }
    }
  }, { signal, capture: true });
  // A middle-drag that actually panned must NOT also open the pressed tile in a new tab; a
  // stationary middle-click still gets its native open-in-new-tab (dragMoved stays false).
  viewport.addEventListener('auxclick', (e) => {
    if (dragMoved) { e.preventDefault(); e.stopPropagation(); dragMoved = false; }
  }, { signal, capture: true });

  // ── Mobile drag handle — a JS-driven page-scroll grip (pointer events, so it works
  // with a finger AND with a mouse at mobile widths). The immersive strip captures
  // vertical gestures, so this pill drags the page 1:1 (finger/cursor up → content up),
  // like the tool editor's sheet grip. ──
  const grip = section.querySelector<HTMLElement>('.featured-grip');
  if (grip) {
    let gripId = -1;
    let gripY = 0;
    grip.addEventListener('pointerdown', (e) => {
      gripId = e.pointerId;
      gripY = e.clientY;
      grip.classList.add('is-dragging');
      try { grip.setPointerCapture(e.pointerId); } catch { /* best effort */ }
      e.preventDefault();
    }, { signal });
    grip.addEventListener('pointermove', (e) => {
      if (e.pointerId !== gripId) return;
      const dy = e.clientY - gripY;
      gripY = e.clientY;
      window.scrollBy(0, -dy);                 // drag up → scroll the page down (content follows)
      e.preventDefault();
    }, { signal });
    const gripEnd = (e: PointerEvent): void => {
      if (e.pointerId !== gripId) return;
      gripId = -1;
      grip.classList.remove('is-dragging');
      try { grip.releasePointerCapture(e.pointerId); } catch { /* ok */ }
    };
    grip.addEventListener('pointerup', gripEnd, { signal });
    grip.addEventListener('pointercancel', gripEnd, { signal });
  }

  // Recompute the loop on resize (debounced to a frame).
  let resizeRaf = 0;
  const onResize = (): void => {
    cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(setupLoop);
  };
  window.addEventListener('resize', onResize, { signal });

  // Initial layout can shift as the committed preview images decode (they change tile
  // heights only, but a late web-font / reflow can nudge widths); establish the loop
  // now and once more after a beat.
  const startRaf = (): void => { if (!raf && !destroyed) raf = requestAnimationFrame(tick); };
  setupLoop();
  const relayout = setTimeout(setupLoop, 600);
  // Gallery needs the loop for drift/inertia (skipped under reduced motion); Cover Flow
  // always needs it for its snap + live transforms.
  if (coverflow || !reduced) startRaf();

  // Resume hook for the progressive-variant queue below — assigned once its jobs exist,
  // called by the vizObserver when the row scrolls back into view. No-op until then.
  let resumeQueue: () => void = () => {};

  // Park all motion while the strip is fully scrolled out of view; resume (slightly early,
  // via the rootMargin) as it comes back. On-screen behaviour is byte-identical — this only
  // stops the loop + cross-fade when there's nothing on screen to animate. Graceful fallback:
  // no IntersectionObserver → onScreen stays true and everything runs as before.
  if (typeof IntersectionObserver === 'function') {
    vizObserver = new IntersectionObserver((entries2) => {
      const nowOn = entries2[entries2.length - 1]!.isIntersecting;
      if (nowOn === onScreen) return;
      onScreen = nowOn;
      if (nowOn) { lastTs = 0; startRaf(); resumeQueue(); }   // reset clock + resume enrichment on re-entry
    }, { rootMargin: '200px' });
    vizObserver.observe(section);
  }

  // ── Progressive variant rendering (skipped under reduced motion) ──────────────
  // Round-robin across tools so every tile gets its first extra look before any gets
  // its second — the row enriches evenly. Serial, on idle, cached; a failure just
  // leaves that tile with fewer looks.
  let ricId = 0;
  if (!reduced) {
    const jobs: Array<{ id: string; formats: readonly string[] | undefined; index: number; values: Record<string, unknown> }> = [];
    const perTool = entries.map((e) => {
      const fmt = displayFormatOf(e.formats);
      return { id: e.id, formats: e.formats, canRender: !!fmt, variants: fmt ? resolveExamples(e) : [] };
    });
    const maxV = perTool.reduce((m, t) => Math.max(m, t.variants.length), 0);
    for (let i = 0; i < maxV; i++) {
      for (const t of perTool) {
        const v = t.variants[i];
        if (!v || !t.canRender) continue;
        // Theme filter: skip a look tagged for the OPPOSITE UI theme — a reverse/white
        // look on a light tile (or a dark look on a dark tile) would be near-invisible.
        // `index: i` keeps the ORIGINAL manifest position so the render cache key is
        // stable whichever looks the theme filters in/out.
        if (v.theme && (v.theme === 'dark') !== darkTheme) continue;
        jobs.push({ id: t.id, formats: t.formats, index: i, values: v.values });
      }
    }

    const addVariantImage = (toolId: string, dataUrl: string, values: Record<string, unknown>): void => {
      // Append to the original tile AND its clone, so both stay in sync as they drift.
      const added: HTMLImageElement[] = [];
      track.querySelectorAll<HTMLElement>(`.ftile[data-tool="${CSS.escape(toolId)}"] .ftile-stage`).forEach((stage) => {
        const img = document.createElement('img');
        img.className = 'ftile-img';
        img.alt = '';
        img.setAttribute('aria-hidden', 'true');
        img.draggable = false;
        img.src = dataUrl; // data URL — decodes synchronously-ish; the ticker rotates it in once ready
        stage.appendChild(img);
        added.push(img);
      });
      // Precompute this look's seeded open URL once (shared by the tile + its wrap-clone) so
      // clicking the tile while this look is on screen opens the tool in this exact style —
      // matching the gallery carousels. advanceStage points the tile's <a> at whichever look
      // is active; if this one is already showing when its URL resolves, refresh it now. A
      // failed build just leaves the default route (toolSeedHref falls back to it).
      void toolSeedHref(toolId, values).then((href) => {
        for (const img of added) {
          img.dataset.seedhref = href;
          if (img.classList.contains('is-active')) refreshLinkHref(img.closest('.ftile-link'));
        }
      });
    };

    // These variants are progressive "extra looks" cross-faded in later — NEVER the LCP
    // element (that's the committed `data-base` preview, already in the DOM). Rendering
    // them eagerly at boot stole CPU + network from the critical first paint: each pulls
    // its example photos through a main-thread canvas, and with all 10 featured tools
    // queued up front that measured gallery LCP 8.3s / TBT 730ms. So the queue is now
    // (a) held until the page's critical load has settled, and (b) parked whenever the
    // row is scrolled off-screen — the vizObserver above resumes it on re-entry.
    let queueArmed = false;
    const pumpQueue = (): void => {
      if (destroyed || !onScreen) return;      // off-screen → park; vizObserver re-pumps on re-entry
      const job = jobs.shift();
      if (!job) return;
      renderFeaturedVariant(host, job.id, job.formats, job.index, job.values)
        .then((thumb) => { if (!destroyed) addVariantImage(job.id, thumb, job.values); })
        .catch((e) => host.log?.('warn', `Featured variant failed for ${job.id}`, { error: String((e as { message?: unknown })?.message ?? e) }))
        .finally(() => { if (!destroyed && onScreen && jobs.length) ricId = ric(pumpQueue); });
    };
    resumeQueue = (): void => { if (queueArmed && !destroyed && onScreen && jobs.length) ricId = ric(pumpQueue); };
    const armQueue = (): void => { if (queueArmed || destroyed || !jobs.length) return; queueArmed = true; ricId = ric(pumpQueue); };
    // Kick off only after the critical load has finished (on a hard load), then on the
    // next idle. Client-side nav back to `/` is already `complete`, so arm on idle directly.
    if (document.readyState === 'complete') ricId = ric(armQueue);
    else window.addEventListener('load', () => ric(armQueue), { once: true, signal });
  }

  return {
    setVisible(v: boolean) {
      visible = v;
      // Re-measure when re-shown: the row may have been laid out (or the window
      // resized) while hidden, so the loop's overflow decision can be stale.
      if (v) setupLoop();
    },
    setViewMode(mode: FeaturedViewMode) {
      const next = mode === 'coverflow';
      if (next === coverflow) return;
      coverflow = next;
      velocity = 0;
      snapTarget = null;
      flickIndex = -1;   // the two modes index differently — don't flick on the switchover
      section.classList.toggle('featured--coverflow', coverflow);
      if (!coverflow) clearCoverflow();      // shed inline transforms + padding before re-cloning
      setupLoop();                           // coverflow → pad + fan; gallery → clone + drift
      startRaf();                            // Cover Flow needs the loop even under reduced motion
    },
    destroy() {
      destroyed = true;
      ac.abort();
      vizObserver?.disconnect();
      cancelAnimationFrame(raf);
      cancelAnimationFrame(resizeRaf);
      clearTimeout(relayout);
      clearTimeout(shiftClsTimer);
      if (fadeTimer) clearInterval(fadeTimer);
      if (ricId) cancelRic(ricId);
    },
  };
}
