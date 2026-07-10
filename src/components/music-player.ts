// SPDX-License-Identifier: MPL-2.0
/**
 * Music-player body for Neurospicy Mode — now-playing meter, prev/play-pause/next
 * transport, a SEARCHABLE track dropdown (type to filter), and volume. Used both
 * in the Sound-settings popover and (chiefly) in the bottom-right toast dock
 * (neuro-dock.ts) that follows you across views while the mode is on.
 *
 * The level meter reads the analyser on the focus-loop audio graph, so it only
 * reacts to our LOCAL songs (zzfxm/opus); a radio stream plays outside that graph
 * and shows no meter. Self-styling; build with musicPlayerBodyHtml(), wire once in
 * the DOM with wireMusicPlayerBody(), and repaint on external state changes
 * (master mute, mode toggle) with paintMusicPlayer().
 */
import {
  getNeurospicy, setNeurospicyLoop, setNeurospicyVolume, listLoops, isNeurospicyPlaying,
  toggleNeurospicyPlay, cycleNeurospicyLoop,
  getNeurospicyAnalyser, type NeurospicyHost, type NeuroTrack,
} from '../lib/neurospicy.ts';
import { getSfxVolume, setSfxVolume } from '../lib/sfx.ts';
import { escape } from '../utils.ts';

const PLAY = `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M7 4.5a1 1 0 0 1 1.53-.85l12 7.5a1 1 0 0 1 0 1.7l-12 7.5A1 1 0 0 1 7 19.5z"/></svg>`;
const PAUSE = `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><rect x="6.5" y="5" width="4" height="14" rx="1.2"/><rect x="13.5" y="5" width="4" height="14" rx="1.2"/></svg>`;
const PREV = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M6 5h2v14H6zM20 5.5v13a1 1 0 0 1-1.53.85l-9-6.5a1 1 0 0 1 0-1.7l9-6.5A1 1 0 0 1 20 5.5z"/></svg>`;
const NEXT = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M16 5h2v14h-2zM4 5.5v13a1 1 0 0 0 1.53.85l9-6.5a1 1 0 0 0 0-1.7l-9-6.5A1 1 0 0 0 4 5.5z"/></svg>`;
const CARET = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>`;

const STYLE_ID = 'lolly-music-player-styles';
const CSS = `
.neuro-player { display: flex; flex-direction: column; gap: 10px; }
.neuro-meter { width: 100%; height: 24px; display: block; border-radius: var(--radius); background: hsl(var(--muted) / .5); }
.neuro-transport { display: flex; align-items: center; justify-content: center; gap: 16px; }
.neuro-tbtn { width: 30px; height: 30px; border-radius: calc(var(--radius)*2); border: none; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; background: transparent; color: hsl(var(--muted-foreground)); transition: color .15s ease, transform .1s ease; }
.neuro-tbtn:hover { color: hsl(var(--foreground)); }
.neuro-tbtn:active { transform: scale(.9); }
.neuro-tbtn.neuro-play { width: 42px; height: 42px; background: hsl(var(--primary)); color: hsl(var(--primary-foreground)); }
.neuro-tbtn.neuro-play:hover { filter: brightness(1.08); color: hsl(var(--primary-foreground)); }
.neuro-tbtn:focus-visible { outline: 2px solid hsl(var(--primary)); outline-offset: 2px; }
/* searchable track picker */
.neuro-picker { position: relative; }
.neuro-picker-btn { display: flex; align-items: center; gap: 8px; width: 100%; padding: 8px 12px; border: 1px solid hsl(var(--border)); border-radius: var(--radius); background: hsl(var(--card)); color: hsl(var(--foreground)); font-size: .85rem; cursor: pointer; text-align: left; }
.neuro-picker-btn:focus-visible { outline: 2px solid hsl(var(--primary)); outline-offset: 2px; }
.neuro-picker-cur { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.neuro-picker-caret { flex: 0 0 auto; color: hsl(var(--muted-foreground)); transition: transform .15s ease; }
.neuro-picker[data-open="true"] .neuro-picker-caret { transform: rotate(180deg); }
.neuro-chip { flex: 0 0 auto; font-size: .62rem; font-weight: 600; letter-spacing: .02em; text-transform: uppercase; padding: 2px 7px; border-radius: 999px; background: hsl(var(--muted)); color: hsl(var(--muted-foreground)); }
.neuro-picker-panel { position: absolute; left: 0; right: 0; bottom: calc(100% + 6px); z-index: 5; display: flex; flex-direction: column; gap: 6px; padding: 8px; border: 1px solid hsl(var(--border)); border-radius: var(--radius); background: hsl(var(--popover, var(--card))); box-shadow: 0 8px 28px rgb(0 0 0 / .28); }
.neuro-picker-panel[hidden] { display: none; }
.neuro-search { width: 100%; padding: 7px 10px; border: 1px solid hsl(var(--border)); border-radius: var(--radius); background: hsl(var(--background)); color: hsl(var(--foreground)); font-size: .82rem; }
.neuro-search:focus-visible { outline: 2px solid hsl(var(--primary)); outline-offset: 1px; }
/* As tall as fits above the bottom-docked player without clipping the viewport top
   (the panel opens upward): grows with screen height, floored so it always scrolls. */
.neuro-list { list-style: none; margin: 0; padding: 0; max-height: clamp(160px, calc(100vh - 360px), 60vh); overflow-y: auto; display: flex; flex-direction: column; gap: 1px; }
.neuro-cat { list-style: none; }
.neuro-cat[hidden] { display: none; }
.neuro-cat-head { display: flex; align-items: center; gap: 6px; width: 100%; padding: 6px 8px; border: none; background: transparent; color: hsl(var(--muted-foreground)); font-size: .68rem; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; cursor: pointer; border-radius: var(--radius); }
.neuro-cat-head:hover { color: hsl(var(--foreground)); background: hsl(var(--muted) / .5); }
.neuro-cat-head:focus-visible { outline: 2px solid hsl(var(--primary)); outline-offset: -2px; }
.neuro-cat-caret { display: inline-flex; transition: transform .15s ease; }
.neuro-cat.is-collapsed .neuro-cat-caret { transform: rotate(-90deg); }
.neuro-cat-count { margin-left: auto; font-weight: 600; opacity: .6; }
.neuro-cat-tracks { list-style: none; margin: 0 0 4px; padding: 0; display: flex; flex-direction: column; gap: 1px; }
.neuro-cat.is-collapsed .neuro-cat-tracks { display: none; }
.neuro-warn { display: inline-flex; color: hsl(var(--muted-foreground)); cursor: help; }
.neuro-warn svg { width: 13px; height: 13px; }
@media (prefers-reduced-motion: reduce) { .neuro-cat-caret { transition: none; } }
.neuro-track { display: flex; align-items: center; gap: 8px; width: 100%; padding: 7px 10px; border: none; border-radius: var(--radius); background: transparent; color: hsl(var(--foreground)); font-size: .82rem; text-align: left; cursor: pointer; transition: background .12s ease; }
.neuro-track:hover { background: hsl(var(--muted)); }
.neuro-track[aria-current="true"] { background: hsl(var(--primary) / .14); font-weight: 600; }
.neuro-track[hidden] { display: none; }
.neuro-track-dot { flex: 0 0 auto; width: 6px; height: 6px; border-radius: var(--radius); background: hsl(var(--muted-foreground) / .5); }
.neuro-track[aria-current="true"] .neuro-track-dot { background: hsl(var(--primary)); }
.neuro-track-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.neuro-track-mood { flex: 0 0 auto; font-size: .62rem; text-transform: uppercase; letter-spacing: .02em; color: hsl(var(--muted-foreground)); }
.neuro-empty { padding: 8px 10px; font-size: .8rem; color: hsl(var(--muted-foreground)); }
.neuro-vol { display: flex; align-items: center; gap: 9px; font-size: .8rem; color: hsl(var(--muted-foreground)); }
.neuro-vol span { flex: 0 0 3.4em; }
.neuro-vol input[type="range"] { flex: 1; accent-color: hsl(var(--primary)); }
@media (prefers-reduced-motion: reduce) { .neuro-tbtn, .neuro-track, .neuro-picker-caret { transition: none; } }`;

function ensureStyles(): void {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

const WARN = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" x2="12" y1="9" y2="13"/><line x1="12" x2="12.01" y1="17" y2="17"/></svg>`;

// Track-list groups, in display order. Tracks sort alphabetically WITHIN each group.
const CATEGORIES: { key: string; label: string; warn?: string }[] = [
  { key: 'uploads', label: 'Uploads' },
  { key: 'lolly', label: 'Lolly Sings' },
  { key: 'ambient', label: 'Ambient' },
  { key: 'beats', label: 'Beats' },
  { key: 'radio', label: 'Internet Radio', warn: 'Requires an internet connection' },
];

/** Which group a track belongs to. */
function trackCategory(t: NeuroTrack): string {
  if (t.format === 'stream' || t.tags.includes('radio') || t.tags.includes('stream')) return 'radio';
  if (t.id.startsWith('user/')) return 'uploads';       // the user's own uploads
  if (t.format === 'zzfxm') return 'lolly';             // our generated / MIDI-converted tracks
  if (t.tags.includes('lofi')) return 'ambient';        // the lo-fi loops
  return 'beats';                                       // the remaining loops (breakbeats)
}

/** Friendly mood label from a track's tags (for the now-playing + list chips). */
export function trackMood(tags: string[]): string {
  if (tags.includes('ambient')) return 'ambient';
  if (tags.includes('beat') || tags.includes('rhythm')) return 'beat';
  if (tags.includes('melodic')) return 'melodic';
  if (tags.includes('radio') || tags.includes('stream')) return 'radio';
  if (tags.includes('lofi')) return 'lo-fi';
  if (tags.includes('generated')) return 'generated';
  return '';
}

/** The player body markup (no enable switch — that lives with the Sound switch). */
export function musicPlayerBodyHtml(): string {
  ensureStyles();
  const playing = isNeurospicyPlaying();
  // Track selector first — you read what's playing before the controls.
  return `<div class="neuro-player" data-music-player>
      <div class="neuro-picker" data-mp-picker data-open="false">
        <button type="button" class="neuro-picker-btn" data-mp-picker-btn aria-haspopup="true" aria-expanded="false">
          <span class="neuro-picker-cur" data-mp-current>Loading beats…</span>
          <span class="neuro-chip" data-mp-mood hidden></span>
          <span class="neuro-picker-caret">${CARET}</span>
        </button>
        <div class="neuro-picker-panel" data-mp-panel hidden>
          <input type="search" class="neuro-search" data-mp-search placeholder="Search tracks…" aria-label="Search tracks">
          <ul class="neuro-list" data-mp-list aria-label="Tracks"><li class="neuro-empty">Loading…</li></ul>
        </div>
      </div>
      <canvas class="neuro-meter" data-mp-meter width="260" height="24" aria-hidden="true"></canvas>
      <div class="neuro-transport">
        <button type="button" class="neuro-tbtn" data-mp-prev aria-label="Previous track">${PREV}</button>
        <button type="button" class="neuro-tbtn neuro-play" data-mp-play aria-label="${playing ? 'Pause' : 'Play'}" aria-pressed="${playing}">${playing ? PAUSE : PLAY}</button>
        <button type="button" class="neuro-tbtn" data-mp-next aria-label="Next track">${NEXT}</button>
      </div>
      <label class="neuro-vol"><span>Music</span><input type="range" min="0" max="1" step="0.05" value="${getNeurospicy().volume}" data-mp-volume aria-label="Music volume"></label>
      <label class="neuro-vol"><span>Effects</span><input type="range" min="0" max="1" step="0.05" value="${getSfxVolume()}" data-mp-sfx aria-label="Interface sound volume — how much of the UI you hear"></label>
    </div>`;
}

let tracksCache: NeuroTrack[] = [];

/** Sync transport icon, current-track label + mood, and the highlighted list row. */
export function paintMusicPlayer(root: ParentNode): void {
  const wrap = root.querySelector<HTMLElement>('[data-music-player]');
  if (!wrap) return;
  const playing = isNeurospicyPlaying();
  const play = wrap.querySelector<HTMLButtonElement>('[data-mp-play]');
  if (play) {
    play.innerHTML = playing ? PAUSE : PLAY;
    play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    play.setAttribute('aria-pressed', String(playing));
  }
  const curId = getNeurospicy().loopId;
  const cur = tracksCache.find((t) => t.id === curId);
  const label = wrap.querySelector<HTMLElement>('[data-mp-current]');
  const chip = wrap.querySelector<HTMLElement>('[data-mp-mood]');
  if (label) label.textContent = cur ? cur.name : 'Select a track';
  if (chip) {
    const m = cur ? trackMood(cur.tags) : '';
    chip.textContent = m;
    chip.hidden = !m;
  }
  for (const btn of wrap.querySelectorAll<HTMLElement>('[data-mp-list] .neuro-track')) {
    btn.setAttribute('aria-current', String(btn.dataset.id === curId));
  }
}

/** Repaint + (re)start the meter — used by the dock when it's shown/expanded. */
export function refreshMusicPlayer(root: ParentNode): void {
  paintMusicPlayer(root);
  startMeter(root);
}

function openPanel(wrap: HTMLElement, open: boolean): void {
  const picker = wrap.querySelector<HTMLElement>('[data-mp-picker]');
  const btn = wrap.querySelector<HTMLButtonElement>('[data-mp-picker-btn]');
  const panel = wrap.querySelector<HTMLElement>('[data-mp-panel]');
  if (!picker || !btn || !panel) return;
  picker.dataset.open = String(open);
  btn.setAttribute('aria-expanded', String(open));
  panel.hidden = !open;
  if (open) wrap.querySelector<HTMLInputElement>('[data-mp-search]')?.focus();
  else if (panel.contains(document.activeElement)) btn.focus(); // return focus to the trigger
}

/**
 * Wire the player body: transport, the searchable track dropdown, volume, and the
 * meter. `host` drives track switching + persistence. Safe once the body is in the DOM.
 */
export function wireMusicPlayerBody(root: ParentNode, host: NeurospicyHost): void {
  ensureStyles();
  const wrap = root.querySelector<HTMLElement>('[data-music-player]');
  if (!wrap) return;
  const list = wrap.querySelector<HTMLUListElement>('[data-mp-list]');
  const search = wrap.querySelector<HTMLInputElement>('[data-mp-search]');
  const vol = wrap.querySelector<HTMLInputElement>('[data-mp-volume]');

  const after = (): void => { paintMusicPlayer(wrap); startMeter(wrap); };

  wrap.querySelector<HTMLButtonElement>('[data-mp-play]')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    await toggleNeurospicyPlay(host);
    after();
  });
  wrap.querySelector<HTMLButtonElement>('[data-mp-prev]')?.addEventListener('click', async (e) => {
    e.stopPropagation(); await cycleNeurospicyLoop(host, -1); after();
  });
  wrap.querySelector<HTMLButtonElement>('[data-mp-next]')?.addEventListener('click', async (e) => {
    e.stopPropagation(); await cycleNeurospicyLoop(host, 1); after();
  });
  vol?.addEventListener('input', (e) => { e.stopPropagation(); setNeurospicyVolume(host, Number(vol.value)); });
  // Effects = interface-sound (SFX) volume. Live on drag; persist to the profile on release.
  const sfx = wrap.querySelector<HTMLInputElement>('[data-mp-sfx]');
  sfx?.addEventListener('input', (e) => { e.stopPropagation(); setSfxVolume(Number(sfx.value)); });
  sfx?.addEventListener('change', (e) => {
    e.stopPropagation();
    void host.profile.get().then((p) => host.profile.set({ ...p, sfxVolume: Number(sfx.value) })).catch(() => { /* best-effort */ });
  });

  // Searchable dropdown open/close.
  wrap.querySelector<HTMLButtonElement>('[data-mp-picker-btn]')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = wrap.querySelector<HTMLElement>('[data-mp-picker]')?.dataset.open === 'true';
    openPanel(wrap, !open);
  });
  search?.addEventListener('input', (e) => {
    e.stopPropagation();
    const q = search.value.trim().toLowerCase();
    let shown = 0;
    for (const cat of wrap.querySelectorAll<HTMLElement>('[data-mp-list] .neuro-cat')) {
      let catShown = 0;
      for (const btn of cat.querySelectorAll<HTMLElement>('.neuro-track')) {
        const hit = !q || (btn.dataset.search ?? '').includes(q);
        btn.hidden = !hit;
        if (hit) catShown++;
      }
      cat.hidden = catShown === 0;
      if (q) cat.classList.remove('is-collapsed'); // expand groups while searching
      shown += catShown;
    }
    const empty = list?.querySelector<HTMLElement>('.neuro-empty');
    if (empty) empty.hidden = shown > 0;
  });
  // Escape anywhere in the open panel (search box OR a track button) closes just the
  // panel and stops the event so the dock's global Escape doesn't also minimize.
  wrap.querySelector<HTMLElement>('[data-mp-picker]')?.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && wrap.querySelector<HTMLElement>('[data-mp-picker]')?.dataset.open === 'true') {
      e.stopPropagation();
      openPanel(wrap, false);
    }
  });
  // Click-away closes the panel.
  document.addEventListener('click', (e) => {
    if (!wrap.isConnected) return;
    if (!(e.target instanceof Node) || !wrap.querySelector('[data-mp-picker]')?.contains(e.target)) openPanel(wrap, false);
  });

  void listLoops(host).then((loops) => {
    tracksCache = loops;
    if (list) {
      if (!loops.length) {
        list.innerHTML = '<li class="neuro-empty">No beats found</li>';
      } else {
        const byCat = new Map<string, NeuroTrack[]>();
        for (const t of loops) { const c = trackCategory(t); (byCat.get(c) ?? byCat.set(c, []).get(c)!).push(t); }
        const trackHtml = (t: NeuroTrack): string => {
          const m = trackMood(t.tags);
          return `<li><button type="button" class="neuro-track" data-id="${escape(t.id)}" data-search="${escape(t.name.toLowerCase())}">` +
            `<span class="neuro-track-dot"></span><span class="neuro-track-name">${escape(t.name)}</span>` +
            (m ? `<span class="neuro-track-mood">${escape(m)}</span>` : '') + `</button></li>`;
        };
        list.innerHTML = CATEGORIES.map((cat) => {
          const items = (byCat.get(cat.key) ?? []).sort((a, b) => a.name.localeCompare(b.name));
          if (!items.length) return '';
          return `<li class="neuro-cat" data-cat="${cat.key}">` +
            `<button type="button" class="neuro-cat-head" data-cat-toggle aria-expanded="true">` +
            `<span class="neuro-cat-caret">${CARET}</span><span>${escape(cat.label)}</span>` +
            (cat.warn ? `<span class="neuro-warn" tabindex="0" role="img" title="${escape(cat.warn)}" aria-label="${escape(cat.warn)}">${WARN}</span>` : '') +
            `<span class="neuro-cat-count">${items.length}</span></button>` +
            `<ul class="neuro-cat-tracks">${items.map(trackHtml).join('')}</ul></li>`;
        }).join('') + '<li class="neuro-empty" hidden>No matches</li>';
      }
      for (const btn of list.querySelectorAll<HTMLButtonElement>('.neuro-track[data-id]')) {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          await setNeurospicyLoop(host, btn.dataset.id!);
          openPanel(wrap, false);
          after();
        });
      }
      for (const head of list.querySelectorAll<HTMLButtonElement>('[data-cat-toggle]')) {
        head.addEventListener('click', (e) => {
          e.stopPropagation();
          const collapsed = head.closest('.neuro-cat')?.classList.toggle('is-collapsed');
          head.setAttribute('aria-expanded', String(!collapsed));
        });
      }
    }
    paintMusicPlayer(wrap);
  });

  startMeter(wrap);
}

// ── level meter (local songs only) ──────────────────────────────────────────
const reducedMotion = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Drive the canvas meter from the focus-loop analyser while the canvas is on-screen. */
function startMeter(root: ParentNode): void {
  const canvas = root.querySelector<HTMLCanvasElement>('[data-mp-meter]');
  if (!canvas || canvas.dataset.running === 'true') return;
  const c2d = canvas.getContext('2d');
  if (!c2d) return;
  canvas.dataset.running = 'true';
  canvas.style.color = 'hsl(var(--primary))';

  const draw = (): void => {
    // Stop when detached OR not visible (offsetParent is null for display:none — a
    // hidden or collapsed dock) so a minimized player doesn't spin rAF forever.
    if (!canvas.isConnected || canvas.offsetParent === null) { canvas.dataset.running = 'false'; return; }
    const a = getNeurospicyAnalyser();
    const w = canvas.width;
    const h = canvas.height;
    c2d.clearRect(0, 0, w, h);
    const color = getComputedStyle(canvas).color || '#888';
    if (a && isNeurospicyPlaying() && !reducedMotion) {
      const bins = a.frequencyBinCount;
      const data = new Uint8Array(bins);
      a.getByteFrequencyData(data);
      const bars = Math.min(32, bins);
      const gap = 2;
      const bw = (w - gap * (bars - 1)) / bars;
      c2d.fillStyle = color;
      for (let i = 0; i < bars; i++) {
        const v = (data[Math.floor((i / bars) * bins)] ?? 0) / 255;
        const bh = Math.max(1, v * h);
        c2d.globalAlpha = 0.35 + v * 0.65;
        c2d.fillRect(i * (bw + gap), h - bh, bw, bh);
      }
      c2d.globalAlpha = 1;
      requestAnimationFrame(draw);
    } else {
      // Idle/paused/reduced-motion: a flat baseline; stop until the next transport
      // action restarts the loop (keeps a hidden dock from spinning rAF forever).
      c2d.fillStyle = color;
      c2d.globalAlpha = 0.25;
      c2d.fillRect(0, h - 1, w, 1);
      c2d.globalAlpha = 1;
      canvas.dataset.running = 'false';
    }
  };
  requestAnimationFrame(draw);
}
