// SPDX-License-Identifier: MPL-2.0
/**
 * celebrateBurst — a one-shot confetti blast of little rounded "chips" flung out across the whole
 * screen from a point. Modelled on the /info hero's click-burst (docs/build.ts): each chip is a
 * baked offscreen sprite (rounded fill + label) that flies out with drag + gravity, then fades on
 * a squared tail so its solid fill stays crisp until it snaps out. Draws onto a transient
 * full-viewport canvas overlay (pointer-events:none, top of the z-stack) that removes itself once
 * every chip is gone — so it's fire-and-forget from wherever a control lives.
 *
 * Used to visually celebrate a moment — e.g. turning ON Neurospicy Mode — from the toggle's spot.
 * Skipped under prefers-reduced-motion: a screen-filling blast is exactly the motion a calm-mode
 * user asked NOT to have (and this control's audience especially).
 */

// Festive SUSE-brand chip colours as [box-fill, ink] pairs — a real mix of the brand's tints and
// shades so the burst reads as confetti, not one colour. Each pair keeps a strong light/dark
// contrast so the label stays legible. Jungle (dark & bright), Pine (deep/mid/light), Persimmon
// (dark & bright), Pine↔Fog both ways for contrast, plus cool Midnight/Waterhole and Mint.
const CHIP_COLORS: ReadonlyArray<readonly [string, string]> = [
  ['#0c322c', '#42d29f'], // dark Jungle → Jungle 5
  ['#30ba78', '#0c322c'], // bright Jungle → Pine ink (lighter jungle chip)
  ['#008878', '#bff1ea'], // mid Pine → Pine 7
  ['#01564a', '#90ebcd'], // deep Pine → Mint
  ['#38d5b4', '#01564a'], // light Pine → deep Pine ink
  ['#8e2810', '#ffb184'], // dark Persimmon → Persimmon 6
  ['#fe7c3f', '#47190d'], // bright Persimmon → darkest Persimmon ink
  ['#bd3314', '#ffd3bd'], // mid Persimmon → light
  ['#0c322c', '#efefef'], // Pine → Fog (contrast)
  ['#efefef', '#0c322c'], // Fog → Pine (a light chip for contrast the other way)
  ['#192072', '#81aefc'], // Midnight → light blue
  ['#2453ff', '#c8dafc'], // Waterhole → pale blue
  ['#0c322c', '#90ebcd'], // Pine → Mint
];
// Plain words only — the SUSE font has no glyphs for symbols like ♪/★, which render as tofu.
const LABELS = ['JUNGLE', 'FOCUS', 'FLOW', 'CALM', 'BEAT', 'RHYTHM', 'DRUM', 'BASS', 'TEMPO', 'SPEED', 'FAST', 'QUICK', 'GENIUS'];

const rand = (a: number, b: number): number => a + Math.random() * (b - a);

let measureCanvas: CanvasRenderingContext2D | null = null;
function measurer(): CanvasRenderingContext2D | null {
  if (!measureCanvas) measureCanvas = document.createElement('canvas').getContext('2d');
  return measureCanvas;
}

function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  c.beginPath();
  c.moveTo(x + r, y); c.lineTo(x + w - r, y); c.arcTo(x + w, y, x + w, y + r, r);
  c.lineTo(x + w, y + h - r); c.arcTo(x + w, y + h, x + w - r, y + h, r);
  c.lineTo(x + r, y + h); c.arcTo(x, y + h, x, y + h - r, r);
  c.lineTo(x, y + r); c.arcTo(x, y, x + r, y, r); c.closePath();
}

interface Chip {
  spr: HTMLCanvasElement; w: number; h: number;
  x: number; y: number; vx: number; vy: number;
  rot: number; vrot: number; alpha: number; life: number;
}

/** Bake one chip (filled rounded box + label) into an offscreen sprite at `dpr`, like /info. */
function makeChipSprite(dpr: number): { spr: HTMLCanvasElement; w: number; h: number } | null {
  const m = measurer();
  if (!m) return null;
  const [fill, ink] = CHIP_COLORS[Math.floor(Math.random() * CHIP_COLORS.length)]!;
  const label = LABELS[Math.floor(Math.random() * LABELS.length)]!;
  const fs = rand(11, 20);
  m.font = `700 ${fs}px SUSE, sans-serif`;
  const tw = m.measureText(label).width;
  const px = fs * 0.7, py = fs * 0.62;
  const w = tw + px * 2, h = fs + py * 2, r = Math.round(fs * 0.42);
  const spr = document.createElement('canvas');
  spr.width = Math.ceil(w * dpr); spr.height = Math.ceil(h * dpr);
  const sx = spr.getContext('2d');
  if (!sx) return null;
  sx.scale(dpr, dpr);
  sx.lineJoin = 'round';
  roundRect(sx, 0, 0, w, h, r);
  sx.fillStyle = fill; sx.fill();
  sx.fillStyle = ink;
  sx.font = `700 ${fs}px SUSE, sans-serif`;
  sx.textAlign = 'center'; sx.textBaseline = 'alphabetic';
  const tm = sx.measureText(label);
  const asc = tm.actualBoundingBoxAscent || fs * 0.7, desc = tm.actualBoundingBoxDescent || 0;
  sx.fillText(label, w / 2, h / 2 + (asc - desc) / 2);
  return { spr, w, h };
}

/**
 * Blast a one-shot confetti burst out from (`x`, `y`) — viewport coordinates — across the whole
 * screen. Fire-and-forget: it paints a transient overlay canvas that cleans itself up.
 */
export function celebrateBurst(x: number, y: number): void {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return; // calm mode — no blast

  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:2147483647';
  canvas.width = Math.round(window.innerWidth * dpr);
  canvas.height = Math.round(window.innerHeight * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const count = Math.floor(rand(52, 72));
  const chips: Chip[] = [];
  for (let i = 0; i < count; i++) {
    const s = makeChipSprite(dpr);
    if (!s) continue;
    const angle = (i / count) * Math.PI * 2 + rand(-0.35, 0.35);
    const spd = rand(9, 26);
    chips.push({
      spr: s.spr, w: s.w, h: s.h, x, y,
      vx: Math.cos(angle) * spd,
      vy: Math.sin(angle) * spd - rand(2, 7), // a little upward bias so it launches like fireworks
      rot: rand(-0.5, 0.5), vrot: rand(-0.03, 0.03),
      alpha: rand(0.85, 1), life: 1,
    });
  }
  if (!chips.length) return;
  document.body.appendChild(canvas);

  let raf = 0;
  const tick = (): void => {
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    for (let i = chips.length - 1; i >= 0; i--) {
      const c = chips[i]!;
      c.vx *= 0.985; c.vy = c.vy * 0.985 + 0.14; // drag + gravity
      c.x += c.vx; c.y += c.vy; c.rot += c.vrot;
      c.life -= 0.006;
      if (c.life <= 0) { chips.splice(i, 1); continue; }
      // Hold full opacity, then snap out over the last ~22% (squared) so the solid fill
      // never goes muddy-translucent while chips overlap.
      const t = c.life / 0.22, fade = t >= 1 ? 1 : t * t;
      ctx.save();
      ctx.translate(c.x, c.y); ctx.rotate(c.rot); ctx.globalAlpha = c.alpha * fade;
      ctx.drawImage(c.spr, -c.w / 2, -c.h / 2, c.w, c.h);
      ctx.restore();
    }
    if (chips.length) { raf = requestAnimationFrame(tick); }
    else { cancelAnimationFrame(raf); canvas.remove(); }
  };
  raf = requestAnimationFrame(tick);
}
