// SPDX-License-Identifier: MPL-2.0
/* Export shutter — a canvas camera-iris that closes over the stage while the
   brief full-res resize during export (the "shake") happens, then opens again.
   Replaces the six CSS flaps that lived inline in views/tool.ts.

   WHY CANVAS. The CSS version faked blades with skewed rotated boxes, which
   cannot produce a real iris: the blades were straight-edged, they could not
   lap each other, and the aperture was a rotating hexagram rather than a
   closing polygon. This paints the actual mechanism — blade k pivots at P with
   |OP| = R, its leading edge an arc of radius rc centred at C rigidly fixed at
   |PC| = d, so the opening's inradius is exactly rc − |OC| and one rotation per
   blade IS the whole animation.

   PERFORMANCE. This runs during export on phones, so every pass here earns its
   place. Three passes from the prototype are deliberately absent rather than
   set to zero — seam hairlines, the throat vignette, and the weave contact
   shadow — see PASSES REMOVED at the bottom of this file. The remaining
   per-frame cost is N blade paints plus `PAIRS` small offscreen composites
   confined to a dirty rect, and one gradient fillRect for the cast shadow.

   Tuned in scratchpad/iris3.html; the constants below are that tool's readout. */

import { playSfx } from './sfx.ts';
import { prefersReducedMotion } from './a11y-prefs.ts';

export interface Shutter {
  /** Close the iris. Resolves once it is fully sealed. */
  close(): Promise<void>;
  /** Open it again. Fire-and-forget. */
  open(): void;
  /** Close then open — for callers that can't await (clipboard writes). */
  play(): void;
  destroy(): void;
}

/* ── the tuned look ──────────────────────────────────────────────────────── */
const BLADES     = 14;
const ARC_RADIUS = 5.30;   // rc, in units of (stage half-diagonal / 1.40)
const DURATION   = 375;    // ms for one direction
const ENTER_AT   = 0.22;   // below this the blades are still off-stage
const LOCK_AT    = 0.97;   // above this they only bury themselves further
const THICKNESS  = 0.01;   // blade edge wall
const REVERSE_LAP = true;
const WEAVE_REACH = 0.53;
const PAIRS       = 5;     // seams that get the woven lap treatment
const KEY_ANGLE   = -78 * Math.PI / 180;
const CONTRAST    = 0.98;
const SPOTLIGHT   = 1.00;
const CAST        = 0.28;
const COVER       = 0.02;
const SPREAD      = 0.13;

const OPEN = 1.46;
const SEAL = 0.02;

/* ── geometry ────────────────────────────────────────────────────────────── */
interface Geom { N: number; R: number; d: number; rc: number; RB: number; tOpen: number; tShut: number }

function geom(N: number, rc: number): Geom {
  const rhoOpen = rc - OPEN, rhoShut = rc + 0.02 + SEAL;
  const R = (rhoOpen + rhoShut) / 2;
  const d = (rhoShut - rhoOpen) / 2 * 1.45;
  const ang = (r: number) =>
    Math.acos(Math.max(-1, Math.min(1, (r * r - R * R - d * d) / (2 * R * d))));
  return { N, R, d, rc, RB: R + rc + 3, tOpen: ang(rhoOpen), tShut: ang(rhoShut) };
}

/* Annular sector about C, spanning the half facing the aperture. Its straight
   side edges sit at |OC| ≥ R−d, always off-stage, so the blades can never leave
   a gap on the canvas — which is what lets this be used as an export cover. */
function bladePath(c: CanvasRenderingContext2D, g: Geom): void {
  c.beginPath();
  c.arc(g.d, 0, g.rc, Math.PI / 2, 3 * Math.PI / 2, false);
  c.arc(g.d, 0, g.RB, 3 * Math.PI / 2, Math.PI / 2, true);
  c.closePath();
}
function bladePath2D(g: Geom): Path2D {
  const p = new Path2D();
  p.arc(g.d, 0, g.rc, Math.PI / 2, 3 * Math.PI / 2, false);
  p.arc(g.d, 0, g.RB, 3 * Math.PI / 2, Math.PI / 2, true);
  p.closePath();
  return p;
}
function bladeAngle(g: Geom, prog: number, _k: number): number {
  const p = Math.max(0, Math.min(1, prog));
  return g.tOpen + (g.tShut - g.tOpen) * p;
}

const CONIC = typeof CanvasRenderingContext2D.prototype.createConicGradient === 'function';

/* Shading that FOLLOWS THE BLADE: built about C, so iso-lines are concentric
   with the leading edge (radial) or sweep along it (conic). A linear gradient
   cuts across the curve and is what makes blades read flat. */
function conicShade(
  c: CanvasRenderingContext2D, x: number, y: number, peak: number,
  f: (cos: number) => string, steps = 22,
): CanvasGradient {
  const gr = c.createConicGradient(peak, x, y);
  for (let i = 0; i <= steps; i++) gr.addColorStop(i / steps, f(Math.cos(i / steps * 2 * Math.PI)));
  return gr;
}

/* ── the renderer ────────────────────────────────────────────────────────── */

function drawIris(
  ctx: CanvasRenderingContext2D, ov: HTMLCanvasElement, octx: CanvasRenderingContext2D,
  W: number, H: number, prog: number, face: string, ink: string,
): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, H);
  if (prog <= 0) return;

  const N = BLADES, g = geom(N, ARC_RADIUS);
  const S = Math.hypot(W, H) / 2 / 1.40;
  const cx = W / 2, cy = H / 2;
  const K = CONTRAST;

  let c = ctx;   // redirected at the offscreen during the lap passes

  const setT = (k: number): number => {
    const t = bladeAngle(g, prog, k);
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.translate(cx, cy); c.scale(S, S);
    c.rotate(k * 2 * Math.PI / N); c.translate(g.R, 0); c.rotate(t);
    return t;
  };
  const lambert = (k: number, t: number): number => {
    const psi = Math.atan2(g.d * Math.sin(t), g.R + g.d * Math.cos(t));
    return 0.5 + 0.5 * Math.cos(k * 2 * Math.PI / N + psi + Math.PI - KEY_ANGLE);
  };

  /* The thickness wall is swept as nested annuli sharing an inner edge — nested,
     not disjoint, because disjoint bands meet on SUB−1 antialiased boundaries
     and leave a diagonal moiré across every blade.

     SUB scales with the wall's PIXEL width instead of being a fixed 34. At this
     thickness the wall is only a few px, so 34 steps painted the same handful of
     pixels 34 times — 476 fills per frame at 14 blades, for no visible gain. */
  const wallPx = THICKNESS * S;
  const SUB = Math.max(4, Math.min(34, Math.round(wallPx / 1.5)));

  function paintBlade(k: number, t: number): void {
    const alpha = k * 2 * Math.PI / N + t;
    const lam = lambert(k, t);
    const peakFace = KEY_ANGLE - alpha;
    const peakWall = KEY_ANGLE - Math.PI - alpha;

    // Base face. A fixed separation from the card keeps blades reading as solid
    // material at any contrast; without it they vanish into the card and only
    // the thickness bands survive, which reads as ribbons.
    bladePath(c, g);
    c.fillStyle = `hsl(${face})`;
    c.fill();
    bladePath(c, g);
    const sep = 0.10 + (lam - 0.5) * K * 0.30;
    c.fillStyle = `hsl(${ink} / ${Math.max(0.02, sep).toFixed(4)})`;
    c.fill();

    // Directional light along the arc — the main dimensional cue.
    if (CONIC) {
      bladePath(c, g);
      c.fillStyle = conicShade(c, g.d, 0, peakFace, v =>
        v >= 0 ? `hsl(0 0% 100% / ${(v * v * K * 0.30).toFixed(4)})`
               : `hsl(0 0% 0% / ${(v * v * K * 0.34).toFixed(4)})`);
      c.fill();
    }

    // Bevel concentric with the leading edge.
    bladePath(c, g);
    const bev = c.createRadialGradient(g.d, 0, g.rc, g.d, 0, g.rc + 1.35);
    bev.addColorStop(0,    `hsl(0 0% 100% / ${(0.22 * K + 0.05).toFixed(4)})`);
    bev.addColorStop(0.06, `hsl(0 0% 100% / ${(0.07 * K).toFixed(4)})`);
    bev.addColorStop(0.22, 'rgba(0,0,0,0)');
    bev.addColorStop(1,    `rgba(0,0,0,${(0.34 * K + 0.04).toFixed(4)})`);
    c.fillStyle = bev;
    c.fill();

    // Thickness wall. Canvas can't multiply two gradients in one fill, but it
    // can multiply a gradient by globalAlpha — so build the conic once, then
    // sweep nested annuli varying only alpha.
    if (THICKNESS > 0 && CONIC) {
      c.fillStyle = conicShade(c, g.d, 0, peakWall, v =>
        v >= 0 ? `hsl(0 0% 100% / ${(v * (0.30 * K + 0.07)).toFixed(4)})`
               : `hsl(0 0% 0% / ${(-v * (0.42 * K + 0.14)).toFixed(4)})`);
      const a = 1 - Math.pow(0.12, 1 / SUB);
      for (let i = 1; i <= SUB; i++) {
        c.globalAlpha = a;
        c.beginPath();
        c.arc(g.d, 0, g.rc, Math.PI / 2, 3 * Math.PI / 2, false);
        c.arc(g.d, 0, g.rc + THICKNESS * Math.pow(i / SUB, 1.7), 3 * Math.PI / 2, Math.PI / 2, true);
        c.closePath();
        c.fill();
      }
      c.globalAlpha = 1;
    }
  }

  // ── pass 1: bodies, back to front. Whichever is drawn LAST sits on top.
  const order = REVERSE_LAP ? Array.from({ length: N }, (_, i) => i)
                            : Array.from({ length: N }, (_, i) => N - 1 - i);
  for (const k of order) paintBlade(k, setT(k));

  /* ── pass 2: close the cycle ──────────────────────────────────────────────
     Painter order is a stack; a real iris is a cycle, so exactly one lap is
     inverted — the bottom blade must sit over the top one. Repainting it across
     the WHOLE overlap is wrong: these blades are half-plane-sized, so any point
     covered by three of them is a genuine Penrose contradiction and fixing it
     globally just moves the error. So fix it where the eye checks — the rim —
     and fade out before reaching a third blade.

     Pairs beyond the first are not correctness, they are coverage: each pair
     also repaints its seam with the lap shading, and only the seams it touches
     get it, so the count walks the treatment further around the rim. */
  const half = Math.PI / N;
  const pairs = Math.max(1, Math.min(PAIRS, N - 1));

  for (let j = 0; j < pairs; j++) {
    const under = (N - 1 - j + N) % N;
    const over  = (under + 1) % N;
    if (under === over) break;

    const tb  = bladeAngle(g, prog, under);
    const rho = Math.hypot(g.R + g.d * Math.cos(tb), g.d * Math.sin(tb));
    const h2  = g.rc * g.rc - Math.pow(rho * Math.sin(half), 2);
    if (h2 <= 0) continue;

    const q = Math.abs(rho * Math.cos(half) - Math.sqrt(h2));
    const open = Math.max(0, Math.min(1, (g.rc - rho) / OPEN));
    // Later pairs sit further out so they don't stack in one ring — but this
    // SATURATES; unbounded growth made far pairs read as a different-sized lap
    // instead of continuing the same seam round the rim.
    const step = j <= 2 ? 1 + j * 0.55 : 2.10 + 0.55 * (1 - Math.exp(-(j - 2) / 1.5));
    const rIn  = (q + 0.10 + 0.60 * (1 - open)) * WEAVE_REACH * step;
    const rOut = rIn * 2.6;

    /* Dirty rect. The lap is confined to a disc of radius rOut about the centre,
       so clearing and copying back the whole canvas — five times a frame, at
       DPR 2 — was pure waste. Bounding it is the single biggest saving here. */
    const rpx = rOut * S + 2;
    const bx = Math.max(0, Math.floor(cx - rpx)), by = Math.max(0, Math.floor(cy - rpx));
    const bw = Math.min(W, Math.ceil(cx + rpx)) - bx, bh = Math.min(H, Math.ceil(cy + rpx)) - by;
    if (bw <= 0 || bh <= 0) continue;

    if (ov.width !== W || ov.height !== H) { ov.width = W; ov.height = H; }
    octx.setTransform(1, 0, 0, 1, 0, 0);
    octx.clearRect(bx, by, bw, bh);
    octx.globalCompositeOperation = 'source-over';

    c = octx;
    c.save();
    setT(over); bladePath(c, g); c.clip();
    paintBlade(under, setT(under));
    c.restore();

    /* Clipping to `over`'s BODY is only safe while `over` is the blade actually
       visible there — true at the top of the stack, false below it. So erase
       whatever is painted after `over`, and the patch stays confined to where
       `over` is genuinely on show, whichever pair it belongs to. */
    const oi = order.indexOf(over);
    if (oi >= 0 && oi < N - 1) {
      const above = new Path2D(), bp = bladePath2D(g);
      for (let i = oi + 1; i < N; i++) {
        const kk = order[i];
        if (kk === undefined || kk === under) continue;
        const tt = bladeAngle(g, prog, kk);
        above.addPath(bp, new DOMMatrix().translate(cx, cy).scale(S)
          .rotate(kk * 360 / N).translate(g.R, 0).rotate(tt * 180 / Math.PI));
      }
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.globalCompositeOperation = 'destination-out';
      c.fill(above);
      c.globalCompositeOperation = 'source-over';
    }

    /* Mask from the APERTURE CENTRE, not the seam crossing. Fading isotropically
       out of a crossing dissolves the repaint in every direction and reads as a
       stain; a ring about the centre stays hard where blades actually weave. The
       long eased tail matters — a short one leaves a circular edge the eye reads
       as a blade boundary, which is worse than the seam it fixes. */
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.translate(cx, cy); c.scale(S, S);
    c.globalCompositeOperation = 'destination-in';
    const m = c.createRadialGradient(0, 0, 0, 0, 0, rOut);
    const knee = Math.min(0.9, rIn / rOut);
    m.addColorStop(0, 'rgba(0,0,0,1)');
    m.addColorStop(knee, 'rgba(0,0,0,1)');
    for (let i = 1; i <= 6; i++) {
      const u = i / 7;
      m.addColorStop(knee + (1 - knee) * u, `rgba(0,0,0,${Math.pow(1 - u, 2.4).toFixed(4)})`);
    }
    m.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = m;
    c.fillRect(-rOut, -rOut, rOut * 2, rOut * 2);
    c.globalCompositeOperation = 'source-over';

    c = ctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.drawImage(ov, bx, by, bw, bh, bx, by, bw, bh);
  }

  /* ── pass 3: screen-space ambience. 'source-atop' confines this to pixels the
     blades already painted — a plain fillRect would tint the aperture opening
     too, i.e. wash over the user's artwork, the one thing a shutter must never
     touch. */
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-atop';
  const D = Math.hypot(W, H);
  const lx = cx + Math.cos(KEY_ANGLE) * W * 0.34, ly = cy + Math.sin(KEY_ANGLE) * H * 0.34;
  const spot = ctx.createRadialGradient(lx, ly, 0, lx, ly, D * 0.62);
  spot.addColorStop(0,    `rgba(255,255,255,${(0.20 * SPOTLIGHT).toFixed(3)})`);
  spot.addColorStop(0.45, `rgba(255,255,255,${(0.06 * SPOTLIGHT).toFixed(3)})`);
  spot.addColorStop(1,    `rgba(0,0,0,${(0.26 * SPOTLIGHT).toFixed(3)})`);
  ctx.fillStyle = spot;
  ctx.fillRect(0, 0, W, H);

  if (COVER > 0) {
    const dx = Math.cos(KEY_ANGLE + Math.PI), dy = Math.sin(KEY_ANGLE + Math.PI);
    const ox = cx + dx * D * 0.60, oy = cy + dy * D * 0.60;
    const cov = ctx.createRadialGradient(ox, oy, D * 0.30, ox, oy, D * 0.86);
    cov.addColorStop(0,    `rgba(0,0,0,${(0.42 * COVER).toFixed(3)})`);
    cov.addColorStop(0.55, `rgba(0,0,0,${(0.30 * COVER).toFixed(3)})`);
    cov.addColorStop(1,    'rgba(0,0,0,0)');
    ctx.fillStyle = cov;
    ctx.fillRect(0, 0, W, H);
  }
  ctx.globalCompositeOperation = 'source-over';

  /* ── pass 4: cast shadow ──────────────────────────────────────────────────
     'destination-over' paints only where the canvas is still transparent —
     exactly the aperture — so this lands on the artwork showing through and
     never on the blades.

     A radial gradient, NOT a drop shadow. createRadialGradient takes two
     circles: the inner is transparent, the outer opaque, and offsetting the
     inner one against the key makes the falloff directional without a second
     pass. The gradient IS the softness, so nothing needs blurring — this
     replaced two Path2D unions of all N blades fill()ed through full-canvas
     blur()s, which was the most expensive thing in the frame by a wide margin. */
  const trav = Math.max(0, Math.min(1, (prog - ENTER_AT) / Math.max(0.01, LOCK_AT - ENTER_AT)));
  const ramp = trav * trav * (3 - 2 * trav);
  if (CAST > 0 && ramp > 0.01) {
    const t0 = bladeAngle(g, prog, 0);
    const openPx = Math.max(D * 0.02,
      (g.rc - Math.hypot(g.R + g.d * Math.cos(t0), g.d * Math.sin(t0))) * S);
    const rOut = openPx * 1.06;
    const rIn  = rOut * (1 - Math.min(0.92, 0.22 + 0.70 * SPREAD));
    // Clamped inside the outer circle: past that the gradient degenerates into a
    // cone with a hard edge across the aperture, which reads as a crease.
    const off = Math.min((rOut - rIn) * 0.55 * ramp, rOut * 0.98 - rIn);
    const a = CAST * ramp;
    const sh = ctx.createRadialGradient(
      cx + Math.cos(KEY_ANGLE + Math.PI) * off, cy + Math.sin(KEY_ANGLE + Math.PI) * off, rIn,
      cx, cy, rOut);
    sh.addColorStop(0,    'rgba(0,0,0,0)');
    sh.addColorStop(0.45, `rgba(0,0,0,${(0.20 * a).toFixed(3)})`);
    sh.addColorStop(0.80, `rgba(0,0,0,${(0.55 * a).toFixed(3)})`);
    sh.addColorStop(1,    `rgba(0,0,0,${(0.85 * a).toFixed(3)})`);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'destination-over';
    ctx.fillStyle = sh;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }
}

/* ── controller ──────────────────────────────────────────────────────────── */

/* Progress runs 0…1, but the shutter only DOES anything between ENTER_AT (the
   blades reach the frame) and LOCK_AT (they lock together). Below and above
   that it spends the budget on motion the eye can't see, so the eased curve is
   mapped onto that span and the whole duration goes to visible travel. */
const bez = (p: number, a: number, b: number, cc: number, d: number): number => {
  let x = p;
  for (let i = 0; i < 6; i++) {
    const s = 1 - x;
    const bx = 3 * s * s * x * a + 3 * s * x * x * cc + x * x * x;
    x -= (bx - p) / Math.max(1e-4, 3 * s * s * a + 6 * s * x * (cc - a) + 3 * x * x * (1 - cc));
    x = Math.max(0, Math.min(1, x));
  }
  const s = 1 - x;
  return 3 * s * s * x * b + 3 * s * x * x * d + x * x * x;
};

export function createShutter(stage: HTMLElement | null): Shutter {
  if (!stage) {
    return { close: () => Promise.resolve(), open: () => {}, play: () => {}, destroy: () => {} };
  }

  const root = document.createElement('div');
  root.className = 'export-shutter';
  root.setAttribute('aria-hidden', 'true');
  const cv = document.createElement('canvas');
  cv.className = 'export-shutter__iris';
  const flash = document.createElement('div');
  flash.className = 'export-shutter__flash';
  root.append(cv, flash);
  stage.appendChild(root);

  const ctx = cv.getContext('2d');
  const ov = document.createElement('canvas');
  const octx = ov.getContext('2d');

  let raf = 0;
  let cur = ENTER_AT;
  let destroyed = false;

  // Motion only — the iris still opens and closes, it just jumps to the sealed
  // state instead of tweening. Nothing here touches the export itself: the
  // shutter paints on its own overlay canvas, never on the tool canvas, so the
  // exported bytes are the same either way.
  const reduced = prefersReducedMotion;
  const fullscreen = (): boolean => window.matchMedia('(max-width: 640px)').matches;

  function paint(prog: number): void {
    if (!ctx || !octx || destroyed) return;
    const r = cv.getBoundingClientRect();
    /* DPR is capped at 2 on desktop and 1.5 on phones. The iris is a transient
       cover, never inspected at rest, and the fill rate — not the geometry — is
       what costs on a phone. */
    const dpr = Math.min(window.devicePixelRatio || 1, fullscreen() ? 1.5 : 2);
    const W = Math.max(1, Math.round(r.width * dpr)), H = Math.max(1, Math.round(r.height * dpr));
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    const cs = getComputedStyle(document.documentElement);
    drawIris(ctx, ov, octx, W, H, prog,
      cs.getPropertyValue('--secondary').trim(), cs.getPropertyValue('--foreground').trim());
  }

  function animate(to: number): Promise<void> {
    cancelAnimationFrame(raf);
    const target = ENTER_AT + (LOCK_AT - ENTER_AT) * to;
    if (reduced()) { cur = target; paint(cur); return Promise.resolve(); }
    const from = cur, t0 = performance.now();
    return new Promise<void>(resolve => {
      const stepFn = (now: number): void => {
        if (destroyed) { resolve(); return; }
        const p = Math.min(1, (now - t0) / DURATION);
        cur = from + (target - from) * bez(p, 0.33, 0.86, 0.31, 1);
        paint(cur);
        if (p < 1) raf = requestAnimationFrame(stepFn);
        else resolve();
      };
      raf = requestAnimationFrame(stepFn);
    });
  }

  // Removing the class alone does not reset a running CSS animation — force a
  // reflow between remove and add so a rapid second export still flashes.
  function fireFlash(): void {
    if (reduced()) return;
    flash.classList.remove('is-on');
    void flash.offsetWidth;
    flash.classList.add('is-on');
  }

  async function close(): Promise<void> {
    if (destroyed) return;
    /* Mobile: lift the shutter out of the stage so it covers the WHOLE screen —
       over the sidebar sheet and export controls — while the system download or
       share sheet appears. (An ancestor's backdrop-filter is a fixed-positioning
       containing block, so moving to <body> is what actually reaches the
       viewport.) Desktop keeps it scoped to the stage. */
    if (fullscreen()) {
      document.body.appendChild(root);
      root.classList.add('export-shutter--fullscreen');
    }
    root.classList.add('is-active');
    cur = ENTER_AT;
    paint(cur);
    playSfx('shutter');            // the ka-chunk, synced to the iris closing
    await animate(1);
    fireFlash();                   // sealed — pop the primary
  }

  function open(): void {
    if (destroyed) return;
    void animate(0).then(() => {
      if (destroyed) return;
      root.classList.remove('is-active');
      flash.classList.remove('is-on');
      if (root.classList.contains('export-shutter--fullscreen')) {
        root.classList.remove('export-shutter--fullscreen');
        stage!.appendChild(root);
      }
    });
  }

  return {
    close,
    open,
    play(): void { void close().then(open); },
    destroy(): void { destroyed = true; cancelAnimationFrame(raf); root.remove(); },
  };
}

/* ── PASSES REMOVED (deliberate, for frame budget) ────────────────────────────
   The prototype has three more passes. All three are absent here rather than
   present-and-zeroed, so they cost nothing in code size either:

   · Seam hairlines + seam continuity. Both alphas are multiplied by the seam
     WEIGHT, which the tuned look sets to 0 — so the continuity value of 0.72 was
     already painting nothing. Restoring continuity means restoring seam weight
     too, or it stays invisible. Cost: 2N strokes per frame.
   · Throat vignette. Tuned to 0. Cost: one full-canvas gradient fill.
   · Weave contact shadow. Tuned to 0. The most expensive of the three by far —
     a canvas blur() plus a full-canvas composite PER PAIR, so five blurs a
     frame at this pair count. See scratchpad/iris3.html "the woven cue".

   Also note `metal` and `flat` render identically in the prototype — only
   `spectrum` branches — so the tuned "Metal" finish is the plain face path
   reproduced here. Spectrum's hues come from an even walk around the colour
   wheel and are NOT brand colours; it is not implemented here. */
