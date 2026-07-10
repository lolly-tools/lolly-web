// SPDX-License-Identifier: MPL-2.0
/**
 * Neurospicy Mode — a background focus-beat player. Loops ONE catalog audio asset (the
 * suse/loops/* Amen breaks, tagged 'neurospicy') continuously while using the app, with a
 * volume. State (enabled / loop id / volume) persists to the PROFILE (canonical) + a
 * localStorage mirror (known before the profile loads), exactly like the sfx mute. Gapless:
 * each loop is decoded into an AudioBuffer and played via an AudioBufferSourceNode(loop=true)
 * — so mp3/aac priming gaps never apply. Shell chrome (host audio), never the engine.
 */
import type { HostV1 } from '../../../../engine/src/bridge/host-v1.ts';
import type { ZzfxSong } from '../../../../engine/src/zzfxm.ts';
import { renderSongToAudioBuffer } from './zzfxm-render.ts';
import { isSfxMuted } from './sfx.ts';

// Just the host surface this module uses — the catalog assets (loop list + bytes) and the
// profile (persist). host.profile.set is a web-shell capability, not on the read-only engine
// ProfileAPI, so this is the shared shape the shell and this module agree on.
export type NeurospicyHost = {
  assets: Pick<HostV1['assets'], 'get' | 'query'>;
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
let src: AudioBufferSourceNode | null = null;
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
  if (!ctx) { ctx = new AC(); gain = ctx.createGain(); gain.gain.value = state.volume; gain.connect(ctx.destination); }
  if (ctx.state === 'suspended') void ctx.resume().catch(() => { /* stays suspended until the next gesture */ });
  return { ctx, gain: gain! };
}

function stopSource(): void {
  if (src) { try { src.stop(); } catch { /* already stopped */ } src.disconnect(); src = null; }
  playingId = '';
}

async function loadBuffer(id: string, url: string, format: string | undefined): Promise<AudioBuffer | null> {
  const cached = buffers.get(id); if (cached) return cached;
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
    buffers.set(id, buf); return buf;
  } catch { return null; }
}

// Start (or switch to) the selected loop; idempotent when already playing it.
async function play(host: NeurospicyHost): Promise<void> {
  // The interface-sound mute is the MASTER mute: while sound is off, the focus loop is silent
  // too (its enabled preference is kept, so it resumes when sound is turned back on).
  if (!state.enabled || !state.loopId || isSfxMuted() || paused) { stopSource(); return; }
  if (src && playingId === state.loopId) { if (gain) gain.gain.value = state.volume; return; }
  const a = audio(); if (!a) return;
  let url = urlById.get(state.loopId);
  let format = formatById.get(state.loopId);
  if (!url || format === undefined) {
    try {
      const ref = await host.assets.get(state.loopId);
      url = ref.url; format = ref.format;
      if (url) urlById.set(state.loopId, url);
      if (format) formatById.set(state.loopId, format);
    } catch { return; }
  }
  if (!url) return;
  const buf = await loadBuffer(state.loopId, url, format); if (!buf || !state.enabled) return;
  stopSource();
  const s = a.ctx.createBufferSource();
  s.buffer = buf; s.loop = true; s.connect(a.gain);
  a.gain.gain.value = state.volume; s.start();
  src = s; playingId = state.loopId;
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
}

// ── the loop catalogue (audio assets tagged 'neurospicy') ────────────────────────
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

let loopsCache: { id: string; name: string }[] | null = null;
export async function listLoops(host: NeurospicyHost): Promise<{ id: string; name: string }[]> {
  if (loopsCache) return loopsCache;
  try {
    const refs = await host.assets.query({ tags: ['neurospicy'] });
    for (const r of refs) { if (r.url) urlById.set(r.id, r.url); if (r.format) formatById.set(r.id, r.format); }
    loopsCache = refs
      .map((r) => ({ id: r.id, name: String((r.meta?.name as string | undefined) ?? r.id) }))
      .sort((a, b) => loopRank(a.id) - loopRank(b.id) || a.name.localeCompare(b.name));
  } catch { loopsCache = []; }
  return loopsCache;
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
