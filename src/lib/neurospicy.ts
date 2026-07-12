// SPDX-License-Identifier: MPL-2.0
/**
 * Neurospicy Mode — a background focus-beat player. Loops ONE catalog audio asset (any
 * type:'audio' catalog entry — the focus loops/songs tagged 'neurospicy' plus the brand's
 * other audio, e.g. licensed music beds) continuously while using the app, with a
 * volume. State (enabled / loop id / volume) persists to the PROFILE (canonical) + a
 * localStorage mirror (known before the profile loads), exactly like the sfx mute. Gapless:
 * each loop is decoded into an AudioBuffer and played via an AudioBufferSourceNode(loop=true)
 * — so mp3/aac priming gaps never apply. Shell chrome (host audio), never the engine.
 */
import type { HostV1 } from '../../../../engine/src/bridge/host-v1.ts';
import type { ZzfxSong } from '../../../../engine/src/zzfxm.ts';
import { renderSongToAudioBuffer } from './zzfxm-render.ts';
import { renderModToAudioBuffer, isModuleFormat } from './mod-render.ts';
import { RADIO_STATIONS, radioStation, isRadioId, radioAvailable, resolveStreamUrl } from './radio.ts';
import { isSfxMuted } from './sfx.ts';

// Just the host surface this module uses — the catalog assets (loop list + bytes) and the
// profile (persist). host.profile.set is a web-shell capability, not on the read-only engine
// ProfileAPI, so this is the shared shape the shell and this module agree on.
export type NeurospicyHost = {
  // `_listUserAssets` is a web-shell-internal method (not on the read-only engine
  // AssetAPI) — used to surface the user's OWN uploaded audio (which query() can't
  // see, as it only reads catalog assets). Optional so non-web hosts just skip it.
  assets: Pick<HostV1['assets'], 'get' | 'query'> & {
    _listUserAssets?(): Promise<Array<{ id: string; type?: string; format?: string; url?: string; meta?: Record<string, unknown> }>>;
  };
  profile: { get(): Promise<object>; set(p: object): Promise<unknown> };
};

export interface NeurospicyState { enabled: boolean; loopId: string; volume: number; repeat: boolean; }
const KEY = 'lolly:neurospicy';
// repeat: the classic behaviour — the selected track loops forever. false = play
// FORWARD through the list, advancing to the next track when the current one ends.
// Defaults to repeat (true), so nothing changes for anyone who never touches the
// toggle; spread into readInitial/hydrate so older persisted states inherit it.
const DEFAULTS: NeurospicyState = { enabled: false, loopId: '', volume: 0.5, repeat: true };

let state: NeurospicyState = readInitial();
function readInitial(): NeurospicyState {
  try { const raw = localStorage.getItem(KEY); if (raw) return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<NeurospicyState>) }; } catch { /* no storage */ }
  return { ...DEFAULTS };
}
function persistLocal(): void { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* best-effort */ } }
async function persistProfile(host: NeurospicyHost): Promise<void> {
  try { const p = await host.profile.get(); await host.profile.set({ ...p, neurospicy: { ...state } }); } catch { /* best-effort */ }
}
export function getNeurospicy(): NeurospicyState { return { ...state }; }
/** Reconcile from the profile (canonical) at boot; leaves defaults if absent. */
export function hydrateNeurospicy(fromProfile: unknown): void {
  if (fromProfile && typeof fromProfile === 'object') { state = { ...DEFAULTS, ...(fromProfile as Partial<NeurospicyState>) }; persistLocal(); }
}

// ── audio graph (own context, so muting sfx never touches the focus loop) ────────
type WinAudio = Window & typeof globalThis & { webkitAudioContext?: typeof AudioContext };
let ctx: AudioContext | null = null;
let gain: GainNode | null = null;
// A pass-through analyser between the gain and the speakers, so the player can
// draw a level meter. Only our LOCAL buffer sources (zzfxm/opus) flow through
// this graph — a future web-radio <audio> stream plays outside it, so it never
// lights the meter (matching "meter vis, local songs only").
let analyser: AnalyserNode | null = null;
let src: AudioBufferSourceNode | null = null;
// Progress bookkeeping for the current LOCAL source: position within the looping
// buffer = (ctx.currentTime - srcStartedAt + srcOffset) % duration. Radio has neither
// (a live stream has no duration), so the seek bar hides for it.
let srcStartedAt = 0;
let srcOffset = 0;
// Radio plays through a plain <audio> element, OUTSIDE the Web Audio graph — no
// CORS needed, and the analyser/meter (a local-song feature) stays dark for it.
let radioEl: HTMLAudioElement | null = null;
let playingId = '';
let paused = false;   // transient transport pause (the play/pause button) — mode stays enabled
const buffers = new Map<string, AudioBuffer>();
const urlById = new Map<string, string>();
// A track is either an encoded audio file (fetch + decodeAudioData) or a ZzFXM
// song (format 'zzfxm' → render to PCM). Cache the format alongside the URL so
// loadBuffer picks the right path.
const formatById = new Map<string, string>();
// The most recent host play() ran with — so seekNeurospicy (which carries no host
// of its own) and a source's natural-end handler can advance the playlist in
// FORWARD mode without threading host through every call site.
let activeHost: NeurospicyHost | null = null;

/**
 * Wire a freshly-created buffer source's end behaviour to the current mode:
 * repeat → loop forever (onended never fires); forward → play once and advance to
 * the next track when it ends. onended ALSO fires on a manual stop() (track
 * switch, seek, pause), so those paths null it out BEFORE stopping (see
 * stopSource / seekNeurospicy) — leaving only a natural end to trigger an advance.
 */
function armSourceEnd(s: AudioBufferSourceNode, host: NeurospicyHost | null): void {
  s.loop = state.repeat;
  s.onended = state.repeat ? null : () => {
    // Ignore a stale source (another already took over) or a state that means we
    // shouldn't keep going (paused, disabled, sound muted).
    if (s !== src || !state.enabled || paused || isSfxMuted()) return;
    // Drop the spent one-shot BEFORE advancing: cycleNeurospicyLoop → play() and,
    // for a single-track (or wrap-to-self) list, that lands on the SAME id — where
    // play()'s idempotency guard (`src && playingId === loopId`) would otherwise
    // short-circuit and never build a fresh source, leaving audio dead. Clearing
    // src here forces the rebuild.
    stopSource();
    if (host) void cycleNeurospicyLoop(host, 1);
  };
}

function audio(): { ctx: AudioContext; gain: GainNode } | null {
  if (typeof window === 'undefined') return null;
  const AC = window.AudioContext ?? (window as WinAudio).webkitAudioContext;
  if (!AC) return null;
  if (!ctx) {
    ctx = new AC();
    gain = ctx.createGain();
    gain.gain.value = state.volume;
    analyser = ctx.createAnalyser();
    analyser.fftSize = 128;
    analyser.smoothingTimeConstant = 0.8;
    gain.connect(analyser);
    analyser.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') void ctx.resume().catch(() => { /* stays suspended until the next gesture */ });
  return { ctx, gain: gain! };
}

/** The analyser on the focus-loop graph, for a level meter. Null until audio starts. */
export function getNeurospicyAnalyser(): AnalyserNode | null { return analyser; }

/** Position within the current LOCAL track (a looping buffer, so it wraps). Null for
 *  radio or while no local source is sounding — callers hide their seek bar then. */
export function getNeurospicyProgress(): { position: number; duration: number } | null {
  if (!src?.buffer || !ctx) return null;
  const dur = src.buffer.duration;
  if (!(dur > 0)) return null;
  const pos = (ctx.currentTime - srcStartedAt + srcOffset) % dur;
  return { position: pos < 0 ? pos + dur : pos, duration: dur };
}

/** Jump to `seconds` within the current local track (the player's skip-to bar). A
 *  buffer source is one-shot, so seeking = swap in a new source starting at that
 *  offset. No-op for radio / while nothing local is sounding. */
export function seekNeurospicy(seconds: number): void {
  const a = audio();
  const buf = src?.buffer;
  if (!a || !src || !buf) return;
  const offset = ((seconds % buf.duration) + buf.duration) % buf.duration;
  src.onended = null; // our own swap, not a natural end — don't advance the list
  try { src.stop(); } catch { /* already stopped */ }
  src.disconnect();
  const s = a.ctx.createBufferSource();
  s.buffer = buf; s.connect(a.gain);
  armSourceEnd(s, activeHost); // keep the same repeat/forward behaviour after a seek
  s.start(0, offset);
  src = s;
  srcStartedAt = a.ctx.currentTime; srcOffset = offset;
}

function stopSource(): void {
  if (src) { src.onended = null; try { src.stop(); } catch { /* already stopped */ } src.disconnect(); src = null; }
  if (radioEl) { try { radioEl.pause(); } catch { /* ignore */ } radioEl.removeAttribute('src'); }
  playingId = '';
}

// Play a live radio stream via a bare <audio> element (resolving the current
// stream URL from the station's .pls). Silent no-op offline or on stream error.
async function playRadio(): Promise<void> {
  const id = state.loopId;
  const station = radioStation(id);
  if (!station) return;
  if (playingId === id && radioEl && !radioEl.paused) { radioEl.volume = state.volume; return; }
  stopSource();
  try {
    const streamUrl = await resolveStreamUrl(station.pls);
    if (state.loopId !== id || !state.enabled || paused || isSfxMuted()) return; // state changed while resolving
    if (!radioEl) { radioEl = new Audio(); radioEl.preload = 'none'; }
    radioEl.src = streamUrl;
    radioEl.volume = state.volume;
    void radioEl.play().catch(() => { /* needs a gesture or a live connection */ });
    playingId = id;
    notifyPlaying();
  } catch { /* offline / stream unavailable — leave silent */ }
}

// Decoded PCM is big (~1.4 MB per stereo second) and the track list now spans the
// whole catalog, including multi-minute music beds (tens of MB each decoded) — so the
// cache is bounded by BYTES, not entries, evicting least-recently-played first. The
// currently-sounding buffer is skipped (its source holds it alive regardless, so
// evicting it would only force a pointless re-decode on replay).
const MAX_BUFFER_BYTES = 96 * 1024 * 1024;
const bufferBytes = (b: AudioBuffer): number => b.length * b.numberOfChannels * 4;

async function loadBuffer(id: string, url: string, format: string | undefined): Promise<AudioBuffer | null> {
  const cached = buffers.get(id);
  if (cached) { buffers.delete(id); buffers.set(id, cached); return cached; } // refresh recency
  const a = audio(); if (!a) return null;
  try {
    let buf: AudioBuffer;
    if (format === 'zzfxm') {
      // A ZzFXM song: a few KB of nested-array data, synthesised to PCM in a worker.
      const song = (await (await fetch(url)).json()) as ZzfxSong;
      buf = await renderSongToAudioBuffer(a.ctx, song);
    } else if (isModuleFormat(format)) {
      // A tracker module (.mod/.xm/.s3m/.it/…): tiny sample-based song data no browser
      // <audio> can play. libopenmpt (WASM) decodes it to PCM in a worker, one pass, so
      // it flows through this same buffer path — meter, seek, loop all come for free.
      const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
      buf = await renderModToAudioBuffer(a.ctx, bytes);
    } else {
      const bytes = await (await fetch(url)).arrayBuffer();
      buf = await a.ctx.decodeAudioData(bytes);
    }
    buffers.set(id, buf);
    let total = 0;
    for (const b of buffers.values()) total += bufferBytes(b);
    for (const [k, b] of buffers) {
      if (total <= MAX_BUFFER_BYTES) break;
      if (k === id || k === playingId) continue;
      buffers.delete(k);
      total -= bufferBytes(b);
    }
    return buf;
  } catch { return null; }
}

// Start (or switch to) the selected loop; idempotent when already playing it.
async function play(host: NeurospicyHost): Promise<void> {
  activeHost = host; // remembered for seek + end-of-track advance (see armSourceEnd)
  // The interface-sound mute is the MASTER mute: while sound is off, the focus loop is silent
  // too (its enabled preference is kept, so it resumes when sound is turned back on).
  if (!state.enabled || !state.loopId || isSfxMuted() || paused) { stopSource(); return; }
  // Radio station? Stream it via <audio>, not the focus-loop buffer path.
  if (isRadioId(state.loopId) || formatById.get(state.loopId) === 'stream') { await playRadio(); return; }
  if (src && playingId === state.loopId) { if (gain) gain.gain.value = state.volume; return; }
  const a = audio(); if (!a) return;
  // Capture the target now: awaits below can interleave with another play() (rapid
  // next/next, or a concurrent playRadio), so re-validate the selection afterwards
  // — otherwise a slow load could start a stale source over the current one.
  const id = state.loopId;
  let url = urlById.get(id);
  let format = formatById.get(id);
  if (!url || format === undefined) {
    try {
      const ref = await host.assets.get(id);
      url = ref.url; format = ref.format;
      if (url) urlById.set(id, url);
      if (format) formatById.set(id, format);
    } catch { return; }
  }
  if (!url || state.loopId !== id) return;
  const buf = await loadBuffer(id, url, format);
  if (!buf || state.loopId !== id || !state.enabled || paused || isSfxMuted()) return;
  stopSource();
  const s = a.ctx.createBufferSource();
  s.buffer = buf; s.connect(a.gain);
  armSourceEnd(s, host); // loop (repeat) or advance-on-end (forward), per state.repeat
  a.gain.gain.value = state.volume; s.start();
  src = s; playingId = id;
  srcStartedAt = a.ctx.currentTime; srcOffset = 0;
  notifyPlaying();
}

// Signal that audio just started, so the dock's level meter (re)starts its rAF —
// notably on the boot autoplay-resume path, where the analyser doesn't exist until
// the armed gesture fires play(). Kept as a DOM event to avoid the lib↔component dep.
function notifyPlaying(): void {
  if (typeof document !== 'undefined') document.dispatchEvent(new Event('lolly:neuro-playing'));
}

// Signal that the enabled flag changed, so other rendered instances of the Sound-settings
// toggle (e.g. an already-open popover elsewhere) can repaint to match — see wireNeurospicy
// in sound-toggle.ts.
function notifyEnabledChanged(): void {
  if (typeof document !== 'undefined') document.dispatchEvent(new Event('lolly:neuro-enabled'));
}

export async function applyNeurospicy(host: NeurospicyHost): Promise<void> { await play(host); }

export async function setNeurospicyEnabled(host: NeurospicyHost, on: boolean): Promise<void> {
  state.enabled = on;
  notifyEnabledChanged();
  paused = false; // enabling/disabling the mode always resets the transport to "play"
  if (on && !state.loopId) { const loops = await listLoops(host); state.loopId = loops[0]?.id ?? ''; }
  persistLocal(); void persistProfile(host);
  await play(host);
}

/** Is the loop actually sounding right now (mode on, not paused, sound not muted)? */
export function isNeurospicyPlaying(): boolean {
  return state.enabled && !paused && !isSfxMuted();
}
/** The play/pause transport — pause/resume WITHOUT turning the mode off. Returns the new playing state. */
export async function toggleNeurospicyPlay(host: NeurospicyHost): Promise<boolean> {
  paused = !paused;
  if (paused) stopSource(); else await play(host);
  return !paused;
}
export async function setNeurospicyLoop(host: NeurospicyHost, id: string): Promise<void> {
  state.loopId = id; persistLocal(); void persistProfile(host);
  await play(host);
}
export function setNeurospicyVolume(host: NeurospicyHost, v: number): void {
  state.volume = Math.max(0, Math.min(1, v)); persistLocal(); void persistProfile(host);
  if (gain) gain.gain.value = state.volume;
  if (radioEl) radioEl.volume = state.volume;
}
/** Switch between repeat (loop the current track) and forward (advance through
 *  the list when a track ends). Re-arms the live source so it takes effect at once
 *  — repeat→forward lets the current track finish then advances; forward→repeat
 *  makes it loop from here on. */
export async function setNeurospicyRepeat(host: NeurospicyHost, repeat: boolean): Promise<void> {
  state.repeat = repeat; persistLocal(); void persistProfile(host);
  activeHost = host;
  if (src) armSourceEnd(src, host);
}
/** Stop playback now WITHOUT changing the saved enabled state — used when the
 *  Neurospicy feature flag is switched off (hide + silence, keep the preference). */
export function stopNeurospicy(): void { stopSource(); }

// ── the track catalogue (every type:'audio' catalog asset) ──────────────────────
// Optional hand-picked slugs (no path prefix) to float to the top of the picker;
// everything else sorts alphabetically. Shared by BOTH the Neurospicy select and the
// video music picker (tool.ts). Empty by default — populate with real catalog ids.
export const FEATURED_LOOPS: string[] = [];
export function loopRank(id: string): number {
  const slug = id.split('/').pop() ?? '';
  const fi = FEATURED_LOOPS.indexOf(slug);
  return fi >= 0 ? fi : 1000;                // featured up top; the rest alphabetical
}

/** A track for the player: id + display name, plus tags (for a mood chip) and the
 *  format (zzfxm/opus → local, meter-capable; a future 'stream' → radio, no meter). */
export interface NeuroTrack { id: string; name: string; tags: string[]; format: string }
// Cache only the connectivity-INDEPENDENT part (catalog + user uploads). Radio is
// appended fresh on every call so it appears/disappears with `navigator.onLine`
// instead of being frozen at whatever the first call saw.
let localLoopsCache: NeuroTrack[] | null = null;
export async function listLoops(host: NeurospicyHost): Promise<NeuroTrack[]> {
  if (!localLoopsCache) {
    let loops: NeuroTrack[] = [];
    try {
      // ALL catalog audio, not just the 'neurospicy'-tagged focus sets — the brand's
      // other audio (e.g. licensed music beds) is playable here too; the player's
      // picker groups it under a separate "Catalog" section (see trackCategory).
      const refs = await host.assets.query({ type: 'audio' });
      for (const r of refs) { if (r.url) urlById.set(r.id, r.url); if (r.format) formatById.set(r.id, r.format); }
      loops = refs
        .map((r): NeuroTrack => ({
          id: r.id,
          name: String((r.meta?.name as string | undefined) ?? r.id),
          tags: Array.isArray(r.meta?.tags) ? (r.meta.tags as string[]) : [],
          format: r.format ?? '',
        }))
        .sort((a, b) => loopRank(a.id) - loopRank(b.id) || a.name.localeCompare(b.name));
    } catch { loops = []; }
    // The user's OWN uploaded audio — query() only reads catalog assets, so pull user
    // uploads separately and merge them in. ANY user audio plays here (tags only drive
    // the picker grouping/mood chip — older uploads, e.g. MIDI-converted songs, predate
    // the ingest tagging and must not be dropped).
    try {
      const userAssets = host.assets._listUserAssets ? await host.assets._listUserAssets() : [];
      for (const a of userAssets) {
        const tags = Array.isArray(a.meta?.tags) ? (a.meta.tags as string[]) : [];
        if (a.type !== 'audio') continue;
        if (a.url) urlById.set(a.id, a.url);
        if (a.format) formatById.set(a.id, a.format);
        loops.push({ id: a.id, name: String((a.meta?.name as string | undefined) ?? a.id), tags, format: a.format ?? '' });
      }
    } catch { /* no user assets on this host */ }
    // Never cache EMPTINESS: on a cold install the dock builds before the catalog
    // sync lands, and caching that zero-track answer would hide the whole library
    // until reload. An empty result stays uncached so the next call re-queries
    // (main.ts also invalidates once the sync resolves).
    if (loops.length) localLoopsCache = loops;
    else return radioTracks();
  }
  // Opt-in radio (SomaFM) trails the local tracks — re-evaluated each call so it
  // appears/disappears with `navigator.onLine` instead of freezing in the cache.
  return localLoopsCache.concat(radioTracks());
}

/** The connectivity-gated radio stations (empty offline; fresh each call). */
function radioTracks(): NeuroTrack[] {
  if (!radioAvailable()) return [];
  for (const s of RADIO_STATIONS) formatById.set(s.id, 'stream');
  return RADIO_STATIONS.map((s): NeuroTrack => ({ id: s.id, name: s.name, tags: ['radio', 'stream'], format: 'stream' }));
}

/** Drop the cached track list (an audio upload changed it) and nudge any mounted
 *  player to rebuild — listLoops re-queries on its next call. */
export function invalidateNeurospicyTracks(): void {
  localLoopsCache = null;
  if (typeof document !== 'undefined') document.dispatchEvent(new Event('lolly:neuro-tracks'));
}

/** DELETED assets need more than a list rebuild: purge them from every player cache,
 *  and if one of them is the CURRENT track, stop it — the looping source would keep
 *  sounding with no row in the picker and a dangling persisted loopId. When the mode
 *  was actively sounding, move on to the first remaining track (like pressing next);
 *  otherwise just clear the selection. */
export async function dropNeurospicyTracks(host: NeurospicyHost, ids: string[]): Promise<void> {
  for (const id of ids) { buffers.delete(id); urlById.delete(id); formatById.delete(id); }
  localLoopsCache = null;
  if (ids.includes(state.loopId)) {
    const wasSounding = !!src && state.enabled && !paused && !isSfxMuted();
    stopSource();
    state.loopId = '';
    // Skip radio when advancing: it's an OPT-IN networked source — a delete
    // gesture must never silently start (and persist) a live internet stream.
    const next = (await listLoops(host)).find((t) => !ids.includes(t.id) && t.format !== 'stream' && !t.tags.includes('radio'));
    if (next && wasSounding) {
      await setNeurospicyLoop(host, next.id); // persists + plays
    } else {
      persistLocal(); void persistProfile(host);
    }
  }
  if (typeof document !== 'undefined') document.dispatchEvent(new Event('lolly:neuro-tracks'));
}

/** Boot reconcile for a persisted selection that no longer exists. A loopId lives in the
 *  PROFILE (+ localStorage mirror), so an asset RETIRED FROM THE CATALOG since the user
 *  last picked it (they didn't delete it — we did) leaves a dangling id that nothing
 *  self-heals: play() calls assets.get(), it throws, the catch silently returns, and the
 *  mode sits enabled-but-silent with no row selected. Same cure as dropNeurospicyTracks:
 *  clear it, and advance to the first real track if the mode was left on.
 *  Call ONLY after the catalog sync resolves — see the empty-list guard below. */
export async function reconcileNeurospicySelection(host: NeurospicyHost): Promise<void> {
  const id = state.loopId;
  if (!id || isRadioId(id)) return;              // nothing picked, or a station (always resolvable)
  const loops = await listLoops(host);
  // Local = catalog assets + the user's own uploads. Radio is appended fresh on every
  // call and is present even offline, so it must NOT count as evidence the catalog loaded:
  // on a cold/offline boot listLoops() legitimately returns radio-only, and treating that
  // as "your track is gone" would wipe a perfectly good selection.
  const local = loops.filter((t) => t.format !== 'stream' && !t.tags.includes('radio'));
  if (!local.length) return;                     // catalog not loaded yet — never clear on no evidence
  if (local.some((t) => t.id === id)) return;    // still there — nothing to do
  const wasEnabled = state.enabled;
  stopSource();
  state.loopId = '';
  const next = local[0];                         // never radio: an opt-in stream must not auto-start
  if (next && wasEnabled) {
    await setNeurospicyLoop(host, next.id);      // persists + plays
  } else {
    persistLocal(); void persistProfile(host);
  }
  if (typeof document !== 'undefined') document.dispatchEvent(new Event('lolly:neuro-tracks'));
}

/** Step to the previous/next track in picker order (wraps). Keeps the mode enabled. */
export async function cycleNeurospicyLoop(host: NeurospicyHost, dir: 1 | -1): Promise<void> {
  const loops = await listLoops(host);
  if (!loops.length) return;
  const cur = loops.findIndex((l) => l.id === state.loopId);
  const next = ((cur < 0 ? 0 : cur) + dir + loops.length) % loops.length;
  await setNeurospicyLoop(host, loops[next]!.id);
}

// Autoplay policy: audio can't start before a user gesture. If enabled at boot, arm a
// one-shot gesture that (re)starts the loop.
export function armNeurospicy(host: NeurospicyHost): void {
  if (!state.enabled || !state.loopId || typeof document === 'undefined') return;
  const go = (): void => {
    document.removeEventListener('pointerdown', go, true);
    document.removeEventListener('keydown', go, true);
    void play(host);
  };
  document.addEventListener('pointerdown', go, { capture: true, passive: true });
  document.addEventListener('keydown', go, { capture: true, passive: true });
}
