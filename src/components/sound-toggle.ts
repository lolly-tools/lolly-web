// SPDX-License-Identifier: MPL-2.0
/**
 * Sound toggle — the interface-sound (sfx) on/off control, in the two presentations the
 * theme control uses so it can sit wherever settings live:
 *
 *   createSoundToggle(host)          → an icon-only button for the canvas zoom HUD
 *                                      (.stage-nav), beside the theme toggle.
 *   soundSegmentHtml() / wireSound…  → an On/Off segment for the gallery / catalogue /
 *                                      Projects view-options popovers.
 *
 * The mute flag lives in lib/sfx.ts (in-memory + localStorage mirror); the PROFILE is the
 * canonical store, exactly like the theme (an undeclared `sfxMuted` field on the record).
 * Turning sound back ON plays a short confirming chirp; turning it off stays silent.
 */
import { isSfxMuted, setSfxMuted, playSfx } from '../lib/sfx.ts';
import { getNeurospicy, setNeurospicyEnabled, setNeurospicyLoop, setNeurospicyVolume, listLoops, applyNeurospicy, isNeurospicyPlaying, toggleNeurospicyPlay } from '../lib/neurospicy.ts';
import { escape } from '../utils.ts';
import type { HostV1 } from '../../../../engine/src/bridge/host-v1.ts';

/** The slice of the host this control needs — the profile record it spreads + persists. */
interface SoundToggleHost {
  profile: {
    get(): Promise<object>;
    set(profile: object): Promise<unknown>;
  };
}
/** The switch surface also drives Neurospicy Mode, which needs host.assets (loop list + bytes). */
type NeuroHost = SoundToggleHost & Pick<HostV1, 'assets'>;

// A heartbeat/waveform — the "beat" behind Neurospicy Mode's focus loop.
const NEURO_ICON =
  `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12h3l2-7 4 18 3-14 2 7h6"/></svg>`;
const PLAY_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M7 4.5a1 1 0 0 1 1.53-.85l12 7.5a1 1 0 0 1 0 1.7l-12 7.5A1 1 0 0 1 7 19.5z"/></svg>`;
const PAUSE_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><rect x="6.5" y="5" width="4" height="14" rx="1.2"/><rect x="13.5" y="5" width="4" height="14" rx="1.2"/></svg>`;

const ICON_ON =
  `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>`;
const ICON_OFF =
  `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="22" x2="16" y1="9" y2="15"/><line x1="16" x2="22" y1="9" y2="15"/></svg>`;

/**
 * Apply + persist a new mute state everywhere: the in-memory flag + localStorage mirror
 * (via setSfxMuted), and the profile (canonical, best-effort). Plays the confirming chirp
 * when enabling. Exported so bespoke settings surfaces (e.g. the profile page) can reuse it.
 */
export async function applySfxMuted(host: SoundToggleHost, muted: boolean): Promise<void> {
  setSfxMuted(muted);
  if (!muted) playSfx('toggle');
  // Master mute: stop the Neurospicy focus loop when muting, resume it (if still enabled) when
  // un-muting. The runtime host is the full WebHost (has assets), so the cast is safe.
  void applyNeurospicy(host as unknown as Parameters<typeof applyNeurospicy>[0]);
  try {
    const profile = await host.profile.get();
    await host.profile.set({ ...profile, sfxMuted: muted });
  } catch { /* preference save is best-effort */ }
}

/**
 * Icon-only toggle for the stage-nav zoom HUD, styled like the theme toggle it sits with.
 * No `data-nav` attribute, so the HUD's zoom-click delegation ignores it.
 */
export function createSoundToggle(host: SoundToggleHost): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'stage-nav-btn stage-nav-sound';
  const paint = () => {
    const on = !isSfxMuted();
    btn.innerHTML = on ? ICON_ON : ICON_OFF;
    btn.dataset.on = on ? 'true' : 'false';
    const label = on ? 'Interface sounds: on — mute' : 'Interface sounds: off — unmute';
    btn.setAttribute('aria-label', label);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.title = label;
  };
  paint();
  btn.addEventListener('click', async () => {
    await applySfxMuted(host, !isSfxMuted());
    paint();
  });
  return btn;
}

// The one on/off presentation used everywhere sound is a labelled setting (view-option
// popovers + the Profile page): a big speaker indicator, the word "Sound:", then a sliding
// switch whose knob animates left (off) → right (on). role="switch" + aria-checked make it a
// real toggle for AT; the knob/track transition is pure CSS. Style is injected once (below)
// so this control is self-contained and needs no edit to a shared stylesheet.
const SWITCH_STYLE_ID = 'lolly-sound-switch-styles';
const SWITCH_CSS = `
.sound-switch { display: inline-flex; align-items: center; gap: 9px; }
.sound-switch-icon { display: inline-flex; color: hsl(var(--muted-foreground)); transition: color .2s ease; }
.sound-switch-icon svg { width: 22px; height: 22px; }          /* the "big" speaker indicator */
.sound-switch[data-on="true"] .sound-switch-icon { color: hsl(var(--foreground)); }
.sound-switch-label { font-weight: 600; font-size: .9rem; color: hsl(var(--foreground)); }
.sound-switch-track {
  position: relative; flex-shrink: 0; width: 46px; height: 26px; padding: 0; border: none;
  border-radius: var(--radius); cursor: pointer; background: hsl(var(--muted));
  transition: background .2s ease;
}
.sound-switch-track[aria-checked="true"] { background: hsl(var(--primary)); }
.sound-switch-knob {
  position: absolute; top: 3px; left: 3px; width: 20px; height: 20px; border-radius: var(--radius);
  background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.35);
  transition: transform .22s cubic-bezier(.2,.7,.3,1);
}
.sound-switch-track[aria-checked="true"] .sound-switch-knob { transform: translateX(20px); }
.sound-switch-track:focus-visible { outline: 2px solid hsl(var(--primary)); outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) {
  .sound-switch-knob, .sound-switch-track, .sound-switch-icon { transition: none; }
}
/* Neurospicy sits directly under Sound as ONE group — no dividing rule between them; the loop
   picker + volume tuck underneath its own switch. */
.neurospicy { display: flex; flex-direction: column; gap: 9px; margin-top: 9px; transition: opacity .18s ease; }
/* Sound is the master switch: while it's muted, Neurospicy reads as off + dimmed and can't be
   toggled until sound is turned back on. */
.neurospicy.is-muted { opacity: .45; pointer-events: none; }
.neurospicy-body { display: flex; flex-direction: column; gap: 9px; padding-left: 31px; }
.neurospicy-body[hidden] { display: none; }
.neurospicy-row { display: flex; align-items: center; gap: 9px; }
.neurospicy-play { flex: 0 0 auto; width: 34px; height: 34px; border-radius: 50%; border: none; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; background: hsl(var(--primary)); color: hsl(var(--primary-foreground)); transition: filter .15s ease, transform .1s ease; }
.neurospicy-play:hover { filter: brightness(1.08); }
.neurospicy-play:active { transform: scale(.93); }
.neurospicy-play:focus-visible { outline: 2px solid hsl(var(--primary)); outline-offset: 2px; }
.neurospicy-loop { flex: 1; min-width: 0; padding: 7px 15px; border-radius: var(--radius); border: 1px solid hsl(var(--border)); background: hsl(var(--card)); color: hsl(var(--foreground)); font-size: .85rem; cursor: pointer; }
.neurospicy-vol { display: flex; align-items: center; gap: 9px; font-size: .8rem; color: hsl(var(--muted-foreground)); }
.neurospicy-vol input[type="range"] { flex: 1; accent-color: hsl(var(--primary)); }`;
function ensureSoundSwitchStyles(): void {
  if (typeof document === 'undefined' || document.getElementById(SWITCH_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = SWITCH_STYLE_ID;
  style.textContent = SWITCH_CSS;
  document.head.appendChild(style);
}

/**
 * The unified "Sound:" switch — a speaker indicator + label + sliding on/off toggle. Returned
 * as HTML; wire with wireSoundSwitch once it's in the DOM. Self-styling (injects its CSS on
 * first build), so it drops into any settings surface unchanged.
 */
export function soundSwitchHtml(): string {
  ensureSoundSwitchStyles();
  const on = !isSfxMuted();
  return `<div class="sound-switch" data-sound-switch-root data-on="${on}">
      <span class="sound-switch-icon">${on ? ICON_ON : ICON_OFF}</span>
      <span class="sound-switch-label">Sound:</span>
      <button type="button" class="sound-switch-track" role="switch" aria-checked="${on}" aria-label="Interface sounds" data-sound-switch>
        <span class="sound-switch-knob"></span>
      </button>
    </div>${neurospicyHtml()}`;
}

// Neurospicy Mode — a background focus BEAT that loops while you use the app: a switch (like
// Sound), then a loop picker + volume. Rendered alongside soundSwitchHtml so it appears
// everywhere the sound on/off toggle does. The <select> is filled from the catalog in
// wireNeurospicy (async), so this stays a synchronous HTML string.
function neurospicyHtml(): string {
  const ns = getNeurospicy();
  const muted = isSfxMuted();
  const on = ns.enabled && !muted;   // shows OFF (and dimmed) while sound is muted — see .is-muted
  return `<div class="neurospicy${muted ? ' is-muted' : ''}" data-neurospicy-root>
      <div class="sound-switch" data-on="${on}">
        <span class="sound-switch-icon">${NEURO_ICON}</span>
        <span class="sound-switch-label">Neurospicy:</span>
        <button type="button" class="sound-switch-track" role="switch" aria-checked="${on}" aria-label="Neurospicy Mode — a looping focus beat" data-neurospicy-switch>
          <span class="sound-switch-knob"></span>
        </button>
      </div>
      <div class="neurospicy-body"${on ? '' : ' hidden'}>
        <div class="neurospicy-row">
          <button type="button" class="neurospicy-play" data-neurospicy-play aria-label="${isNeurospicyPlaying() ? 'Pause focus loop' : 'Play focus loop'}" aria-pressed="${isNeurospicyPlaying()}">${isNeurospicyPlaying() ? PAUSE_ICON : PLAY_ICON}</button>
          <select class="neurospicy-loop" data-neurospicy-loop aria-label="Focus loop"><option>Loading beats…</option></select>
        </div>
        <label class="neurospicy-vol"><span>Volume</span><input type="range" min="0" max="1" step="0.05" value="${ns.volume}" data-neurospicy-volume aria-label="Focus loop volume"></label>
      </div>
    </div>`;
}

/**
 * Wire a soundSwitchHtml() block within `root`: the switch applies + persists the choice and
 * animates in place (knob + speaker indicator both track the new state). stopPropagation keeps
 * a host popover from treating the click as a select/dismiss. Call once after it's in the DOM.
 */
export function wireSoundSwitch(root: ParentNode, host: NeuroHost): void {
  ensureSoundSwitchStyles();
  wireNeurospicy(root, host);
  const wrap = root.querySelector<HTMLElement>('[data-sound-switch-root]');
  const btn = root.querySelector<HTMLButtonElement>('[data-sound-switch]');
  const icon = wrap?.querySelector<HTMLElement>('.sound-switch-icon');
  if (!wrap || !btn) return;
  const paint = (): void => {
    const on = !isSfxMuted();
    wrap.dataset.on = String(on);
    btn.setAttribute('aria-checked', String(on));
    if (icon) icon.innerHTML = on ? ICON_ON : ICON_OFF;
    paintNeurospicy(root);   // master mute greys out + switches off the Neurospicy control too
  };
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    await applySfxMuted(host, !isSfxMuted());
    paint();
  });
}

/** Repaint the Neurospicy control from its state + the master (sfx) mute: OFF and dimmed
 *  (.is-muted, non-interactive) while sound is muted; its real enabled state when sound is on. */
function paintNeurospicy(root: ParentNode): void {
  const wrap = root.querySelector<HTMLElement>('[data-neurospicy-root]');
  if (!wrap) return;
  const muted = isSfxMuted();
  const on = getNeurospicy().enabled && !muted;
  wrap.classList.toggle('is-muted', muted);
  wrap.querySelector<HTMLElement>('.sound-switch')?.setAttribute('data-on', String(on));
  wrap.querySelector<HTMLButtonElement>('[data-neurospicy-switch]')?.setAttribute('aria-checked', String(on));
  const body = wrap.querySelector<HTMLElement>('.neurospicy-body');
  if (body) body.hidden = !on;
  paintNeurospicyPlay(wrap);
}

/** Sync the play/pause button's icon + aria to whether the loop is actually sounding. */
function paintNeurospicyPlay(wrap: ParentNode): void {
  const btn = wrap.querySelector<HTMLButtonElement>('[data-neurospicy-play]');
  if (!btn) return;
  const playing = isNeurospicyPlaying();
  btn.innerHTML = playing ? PAUSE_ICON : PLAY_ICON;
  btn.setAttribute('aria-label', playing ? 'Pause focus loop' : 'Play focus loop');
  btn.setAttribute('aria-pressed', String(playing));
}

// Wire the Neurospicy block: the switch starts/stops the looping focus beat, the select
// swaps loops, the range sets volume — each persisted (see lib/neurospicy.ts). stopPropagation
// keeps a host popover from treating the interaction as a dismiss/select.
function wireNeurospicy(root: ParentNode, host: NeuroHost): void {
  const wrap = root.querySelector<HTMLElement>('[data-neurospicy-root]');
  if (!wrap) return;
  const sw = wrap.querySelector<HTMLButtonElement>('[data-neurospicy-switch]');
  const swWrap = sw?.closest<HTMLElement>('.sound-switch');
  const body = wrap.querySelector<HTMLElement>('.neurospicy-body');
  const sel = wrap.querySelector<HTMLSelectElement>('[data-neurospicy-loop]');
  const vol = wrap.querySelector<HTMLInputElement>('[data-neurospicy-volume]');
  const play = wrap.querySelector<HTMLButtonElement>('[data-neurospicy-play]');
  paintNeurospicy(root);   // sync the initial dimmed/off look to the current mute state
  void listLoops(host).then((loops) => {
    if (!sel) return;
    const cur = getNeurospicy().loopId;
    sel.innerHTML = loops.length
      ? loops.map((l) => `<option value="${escape(l.id)}"${l.id === cur ? ' selected' : ''}>${escape(l.name)}</option>`).join('')
      : '<option value="">No beats found</option>';
  });
  sw?.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (isSfxMuted()) return;   // sound is the master switch — turn it on first (also .is-muted blocks this)
    const on = !getNeurospicy().enabled;
    sw.setAttribute('aria-checked', String(on));
    swWrap?.setAttribute('data-on', String(on));
    if (body) body.hidden = !on;
    // Celebrate turning it ON: a one-shot confetti blast across the screen, launched from the
    // toggle itself (like the /info hero's click-burst). Only on enable, once per activation.
    if (on) {
      const r = sw.getBoundingClientRect();
      // Lazy: confetti code only loads on first activation of this niche feature,
      // not on the gallery boot path. celebrateBurst is already fire-and-forget.
      // Passing the host lets the chips take the LOADED brand's light/dark pairs
      // (the runtime host is the full WebHost, so tokens rides along even though
      // this control's slice type doesn't declare it).
      void import('../lib/particles.ts').then(m =>
        m.celebrateBurst(r.left + r.width / 2, r.top + r.height / 2,
          host as import('../lib/particles.ts').ChipPairsHost));
    }
    await setNeurospicyEnabled(host, on);
    if (sel && getNeurospicy().loopId) sel.value = getNeurospicy().loopId; // enabling may auto-pick the first loop
    paintNeurospicyPlay(wrap);   // switching the mode resets the transport to "play"
  });
  play?.addEventListener('click', async (e) => {
    e.stopPropagation();
    await toggleNeurospicyPlay(host);   // pause/resume the loop WITHOUT leaving the mode
    paintNeurospicyPlay(wrap);
  });
  sel?.addEventListener('change', async (e) => { e.stopPropagation(); await setNeurospicyLoop(host, sel.value); paintNeurospicyPlay(wrap); });
  vol?.addEventListener('input', (e) => { e.stopPropagation(); setNeurospicyVolume(host, Number(vol.value)); });
}

/**
 * Back-compat aliases: the view-option popovers (gallery / catalogue / Projects) call these to
 * drop a sound control into their settings popover. They now render the unified switch above —
 * so every labelled sound control in the app is the same speaker + "Sound:" + sliding toggle.
 */
export function soundSegmentHtml(_headClass?: string): string {
  return soundSwitchHtml();  // _headClass ignored — the switch is self-contained (kept for call-site compat)
}
export function wireSoundSegment(root: ParentNode, host: NeuroHost): void {
  wireSoundSwitch(root, host);
}
