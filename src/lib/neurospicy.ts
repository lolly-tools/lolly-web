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

export interface NeurospicyState { enabled: boolean; loopId: string; volume: number; }
const KEY = 'lolly:neurospicy';
const DEFAULTS: NeurospicyState = { enabled: false, loopId: '', volume: 0.5 };

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

function stopSource(): void {
  if (src) { try { src.stop(); } catch { /* already stopped */ } src.disconnect(); src = null; }
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

// Decoded PCM is big (~1.4 MB per stereo second), and the track list now spans the
// whole catalog — cap the cache and drop the least-recently-played buffer instead of
// pinning every audition in memory.
const MAX_BUFFERS = 8;

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
    } else {
      const bytes = await (await fetch(url)).arrayBuffer();
      buf = await a.ctx.decodeAudioData(bytes);
    }
    buffers.set(id, buf);
    for (const k of buffers.keys()) {
      if (buffers.size <= MAX_BUFFERS) break;
      if (k !== id) buffers.delete(k);
    }
    return buf;
  } catch { return null; }
}

// Start (or switch to) the selected loop; idempotent when already playing it.
async function play(host: NeurospicyHost): Promise<void> {
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
  s.buffer = buf; s.loop = true; s.connect(a.gain);
  a.gain.gain.value = state.volume; s.start();
  src = s; playingId = id;
  notifyPlaying();
}

// Signal that audio just started, so the dock's level meter (re)starts its rAF —
// notably on the boot autoplay-resume path, where the analyser doesn't exist until
// the armed gesture fires play(). Kept as a DOM event to avoid the lib↔component dep.
function notifyPlaying(): void {
  if (typeof document !== 'undefined') document.dispatchEvent(new Event('lolly:neuro-playing'));
}

export async function applyNeurospicy(host: NeurospicyHost): Promise<void> { await play(host); }

export async function setNeurospicyEnabled(host: NeurospicyHost, on: boolean): Promise<void> {
  state.enabled = on;
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
/** Stop playback now WITHOUT changing the saved enabled state — used when the
 *  Neurospicy feature flag is switched off (hide + silence, keep the preference). */
export function stopNeurospicy(): void { stopSource(); }

// ── the track catalogue (every type:'audio' catalog asset) ──────────────────────
// The classic breaks earn the top of the picker; the amen loops trail; the rest sit
// between. Shared by BOTH the Neurospicy select and the video music picker (tool.ts).
export const FEATURED_LOOPS = ['fools-gold', 'amen-brother', 'funky-drummer'];
export function loopRank(id: string): number {
  const slug = id.split('/').pop() ?? '';
  const fi = FEATURED_LOOPS.indexOf(slug);
  if (fi >= 0) return fi;                    // 0,1,2 — the named classics, up top
  if (/^amen-\d+$/.test(slug)) return 2000;  // the amen loops trail
  return 1000;                               // the other breaks, in between
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
    // The user's OWN uploaded audio (tagged 'neurospicy') — query() only reads catalog
    // assets, so pull user uploads separately and merge them in.
    try {
      const userAssets = host.assets._listUserAssets ? await host.assets._listUserAssets() : [];
      for (const a of userAssets) {
        const tags = Array.isArray(a.meta?.tags) ? (a.meta.tags as string[]) : [];
        if (a.type !== 'audio' || !tags.includes('neurospicy')) continue;
        if (a.url) urlById.set(a.id, a.url);
        if (a.format) formatById.set(a.id, a.format);
        loops.push({ id: a.id, name: String((a.meta?.name as string | undefined) ?? a.id), tags, format: a.format ?? '' });
      }
    } catch { /* no user assets on this host */ }
    localLoopsCache = loops;
  }
  // Opt-in radio (SomaFM) trails the local tracks — only when we're online (re-evaluated each call).
  if (radioAvailable()) {
    for (const s of RADIO_STATIONS) formatById.set(s.id, 'stream');
    return localLoopsCache.concat(
      RADIO_STATIONS.map((s): NeuroTrack => ({ id: s.id, name: s.name, tags: ['radio', 'stream'], format: 'stream' })),
    );
  }
  return localLoopsCache;
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
