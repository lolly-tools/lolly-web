// SPDX-License-Identifier: MPL-2.0
/**
 * Neurospicy toast dock — a small music player pinned bottom-right that follows
 * you across every view while Neurospicy Mode is on. It's appended to <body>
 * (outside the view container) so view swaps never tear it down. Two dismissals:
 *   - minimize (–): collapse to a compact pill; music keeps playing; click to expand.
 *   - close (×): turn the mode off (stops the music); re-enable from the Sound settings.
 *
 * Built once and shown/hidden via a class, so its collapsed state + audio survive.
 * The Sound-settings popover now carries only the enable switch; this dock is the
 * actual player. Reuses the music-player component for its body.
 */
import {
  musicPlayerBodyHtml, wireMusicPlayerBody, refreshMusicPlayer,
} from './music-player.ts';
import { getNeurospicy, setNeurospicyEnabled, stopNeurospicy, type NeurospicyHost } from '../lib/neurospicy.ts';
import { flagEnabledSync } from '../feature-flags.ts';
import { icon } from '../lib/icons.ts';

const DOCK_ID = 'neuro-dock';
const COLLAPSE_KEY = 'lolly:neuroDockCollapsed';

// Path data lives in lib/icons.ts as 'neuroBeat' — deduped against sound-toggle.ts's
// identical NEURO_ICON glyph (component-audit rec 5).
const NOTE = icon('neuroBeat', { size: 18 });
const MIN = icon('minus', { size: 16, strokeWidth: 2.4 });
const X = icon('close', { size: 16, strokeWidth: 2.4 });

const reducedMotion = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

const STYLE_ID = 'lolly-neuro-dock-styles';
const CSS = `
/* Sits ABOVE the fixed bottom cluster (search bar + footer nav, ~5.5rem) so it
   never covers the footer's "Valid" / info-site links; z above those bars too. */
.neuro-dock { position: fixed; right: 16px; bottom: calc(6rem + env(safe-area-inset-bottom, 0px)); z-index: 9002; width: 300px; max-width: calc(100vw - 32px);
  display: flex; flex-direction: column; border:0; border-radius: calc(var(--radius) + 4px);
  background: hsla(var(--card) / .7); color: hsl(var(--foreground));     backdrop-filter: blur(5px);box-shadow: 0 12px 40px rgb(0 0 0 / .35);
  transition: transform .2s cubic-bezier(.2,.7,.3,1), opacity .2s ease; }
.neuro-dock.is-hidden { display: none; }
/* Entrance: springs up from the corner with a slight overshoot when the mode is switched on. */
@keyframes neuro-dock-in { from { transform: translateY(28px) scale(.9); opacity: 0; } to { transform: none; opacity: 1; } }
.neuro-dock.is-entering { animation: neuro-dock-in .36s cubic-bezier(.6,.2,.1,1.2); transform-origin: bottom right; }
.neuro-dock-head { display: flex; align-items: center; gap: 8px; padding: 9px 10px 9px 12px; cursor: default; }
.neuro-dock-grip { display: inline-flex; color: hsl(var(--primary)); }
.neuro-dock-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; font-size: .85rem; }
.neuro-dock-btn { flex: 0 0 auto; width: 26px; height: 26px; border: none; border-radius: 50%; background: transparent; color: hsl(var(--muted-foreground)); cursor: pointer; display: inline-flex; align-items: center; justify-content: center; transition: background .12s ease, color .12s ease; }
.neuro-dock-btn:hover { background: hsl(var(--muted)); color: hsl(var(--foreground)); }
.neuro-dock-btn:focus-visible { outline: 2px solid hsl(var(--primary)); outline-offset: 2px; }
.neuro-dock-body { padding: 12px; }
/* The SomaFM attribution + support link now lives in the Internet Radio group's
   info tooltip inside the player (music-player.ts), not a footer line here. */
/* collapsed → a compact pill: only the head shows, and it becomes the expand target */
.neuro-dock[data-collapsed="true"] { width: auto; }
.neuro-dock[data-collapsed="true"] .neuro-dock-head { border-bottom: none; cursor: pointer; }
.neuro-dock[data-collapsed="true"] .neuro-dock-body { display: none; }
.neuro-dock[data-collapsed="true"] [data-dock-close] { display: none; }
@media (prefers-reduced-motion: reduce) { .neuro-dock { transition: none; } .neuro-dock.is-entering { animation: none; } }
@media (max-width: 520px) {
  .neuro-dock { right: 8px; left: 8px; width: auto; bottom: calc(6rem + env(safe-area-inset-bottom, 0px)); }
  /* On phones a collapsed pill just eats the screen — hide it entirely; the "Show player"
     button in the Sound/filter menu brings it back. */
  .neuro-dock[data-collapsed="true"] { display: none; }
}`;

function ensureStyles(): void {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

function isCollapsed(): boolean {
  try { return localStorage.getItem(COLLAPSE_KEY) === '1'; } catch { return false; }
}
function setCollapsedPref(v: boolean): void {
  try { localStorage.setItem(COLLAPSE_KEY, v ? '1' : '0'); } catch { /* best-effort */ }
}

let dock: HTMLElement | null = null;

function build(host: NeurospicyHost): HTMLElement {
  ensureStyles();
  const el = document.createElement('section');
  el.id = DOCK_ID;
  el.className = 'neuro-dock is-hidden';
  el.dataset.collapsed = String(isCollapsed());
  el.setAttribute('aria-label', 'Neurospicy music player');
  el.innerHTML = `
    <header class="neuro-dock-head" data-dock-head>
      <span class="neuro-dock-grip">${NOTE}</span>
      <span class="neuro-dock-title">Neurospicy</span>
      <button type="button" class="neuro-dock-btn" data-dock-min aria-label="Minimize player">${MIN}</button>
      <button type="button" class="neuro-dock-btn" data-dock-close aria-label="Close player">${X}</button>
    </header>
    <div class="neuro-dock-body">${musicPlayerBodyHtml()}</div>`;
  document.body.appendChild(el);
  wireMusicPlayerBody(el, host);

  const setCollapsed = (v: boolean): void => {
    el.dataset.collapsed = String(v);
    setCollapsedPref(v);
    el.querySelector<HTMLButtonElement>('[data-dock-min]')?.setAttribute('aria-label', v ? 'Expand player' : 'Minimize player');
    if (!v) refreshMusicPlayer(el);
  };
  el.querySelector<HTMLButtonElement>('[data-dock-min]')?.addEventListener('click', (e) => {
    e.stopPropagation();
    setCollapsed(el.dataset.collapsed !== 'true');
  });
  // While collapsed, clicking the head expands.
  el.querySelector<HTMLElement>('[data-dock-head]')?.addEventListener('click', (e) => {
    if (el.dataset.collapsed === 'true' && !(e.target as Element).closest('[data-dock-min]')) setCollapsed(false);
  });
  el.querySelector<HTMLButtonElement>('[data-dock-close]')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    stopNeurospicy();                          // stop immediately — don't rely solely on play()'s enabled-guard
    await setNeurospicyEnabled(host, false);    // close = leave the mode
    hideNeuroDock();
  });
  // Escape minimizes an expanded dock — but only when focus is actually inside it,
  // so Esc dismissing some other overlay doesn't also collapse the player.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && el.dataset.collapsed !== 'true' && !el.classList.contains('is-hidden') && el.contains(document.activeElement)) setCollapsed(true);
  });
  // When audio actually starts (notably the boot autoplay-resume gesture, where the
  // analyser doesn't exist until then), (re)start the level meter.
  document.addEventListener('lolly:neuro-playing', () => { if (dock && !dock.classList.contains('is-hidden')) refreshMusicPlayer(dock); });
  return el;
}

/** Show the dock. When `animateIn` (i.e. the mode was just switched on), spring it
 *  up from the corner and pop a confetti burst there to point the eye at it. */
export function showNeuroDock(host: NeurospicyHost, animateIn = false): void {
  if (typeof document === 'undefined') return;
  const first = !dock;
  dock ??= build(host);
  const wasHidden = dock.classList.contains('is-hidden');
  dock.classList.remove('is-hidden');
  refreshMusicPlayer(dock);
  if (animateIn && (wasHidden || first) && !reducedMotion) {
    dock.classList.remove('is-entering');
    void dock.offsetWidth; // reflow so the animation restarts on a repeat enable
    dock.classList.add('is-entering');
    dock.addEventListener('animationend', () => dock?.classList.remove('is-entering'), { once: true });
    // Confetti from the player's corner so the eye is drawn to where it appeared.
    const r = dock.getBoundingClientRect();
    void import('../lib/particles.ts').then((m) =>
      m.celebrateBurst(r.left + r.width / 2, r.top + r.height / 2,
        host as unknown as import('../lib/particles.ts').ChipPairsHost));
  }
}

/** Hide the dock without destroying it (audio + collapse state persist). */
export function hideNeuroDock(): void {
  dock?.classList.add('is-hidden');
}

/** Is the dock collapsed? (On mobile, collapsed = hidden — see the "Show player" button.) */
export function isNeuroDockCollapsed(): boolean {
  return isCollapsed();
}

/** Re-show + expand the dock — the "Show player" action for a mobile-hidden collapsed dock. */
export function reopenNeuroDock(host: NeurospicyHost): void {
  setCollapsedPref(false);
  showNeuroDock(host);
  if (dock) {
    dock.dataset.collapsed = 'false';
    dock.querySelector<HTMLButtonElement>('[data-dock-min]')?.setAttribute('aria-label', 'Minimize player');
    refreshMusicPlayer(dock);
  }
}

/** Show or hide the dock to match state: visible only when the feature flag is on
 *  AND the mode is enabled. Call at boot and whenever the mode is toggled. */
export function syncNeuroDock(host: NeurospicyHost, animateIn = false): void {
  if (flagEnabledSync('neurospicy') && getNeurospicy().enabled) showNeuroDock(host, animateIn);
  else hideNeuroDock();
}
