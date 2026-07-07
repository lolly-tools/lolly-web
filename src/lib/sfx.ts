// SPDX-License-Identifier: MPL-2.0
/**
 * sfx — a tiny, dependency-free UI sound layer for the web shell.
 *
 * This is host CHROME, not part of a render path, so it lives in the shell (never
 * the engine — the engine is DOM/platform-free). It plays short, tasteful cues for
 * interface actions in the Projects view: pressing an option button, picking up /
 * dropping a card, and deleting a session or asset.
 *
 * Sound source: the cues are SYNTHESISED on the fly with the Web Audio API — a few
 * oscillator + gain envelopes per voice. That means zero shipped assets, zero bytes
 * to sync, works offline, and — importantly for this repo's licensing split — zero
 * new licence obligations (nothing to attribute, nothing copyleft).
 *
 * Swapping in recorded samples later: if you'd rather use recorded clips, Kenney's
 * "Interface Sounds" / "UI Audio" packs are CC0 (public domain — https://kenney.nl).
 * Drop the WAVs under an assets folder, decode each once into an AudioBuffer, and
 * replace the VOICES table below with `bufferSource` playback keyed by SfxName. The
 * public API (playSfx / mute) stays identical, so no call site changes.
 *
 * Playback rules baked in:
 *  - Gesture-gated: the AudioContext is created lazily on the first playSfx() call,
 *    which always originates inside a user gesture (click / dragstart / drop), so
 *    browser autoplay policy is satisfied. resume() is called defensively.
 *  - Mute-aware: an in-memory flag (mirrored to localStorage synchronously, so it's
 *    known before the profile loads) short-circuits playback. The profile is the
 *    canonical store — see hydrateSfxMuted() — mirroring how the theme persists.
 *  - Default: interface sounds are ON. (Reduced-motion is about MOTION, not audio, so
 *    it no longer silences sounds by default.) An explicit stored preference always wins.
 */

export type SfxName = 'click' | 'pickup' | 'drop' | 'delete' | 'toggle' | 'navigate' | 'shutter' | 'shuffle' | 'coverflow' | 'gallery' | 'save' | 'saveProfile' | 'whoosh' | 'vacuum' | 'fanfare' | 'twinkle' | 'shimmer' | 'ding' | 'victory' | 'warn' | 'shoo' | 'reel' | 'aperture' | 'scribble' | 'flick' | 'optIn' | 'optOut' | 'key' | 'slider' | 'scrub' | 'select' | 'hydraulicOpen' | 'hydraulicClose' | 'verify' | 'dashboard' | 'newSession' | 'leaveSession' | 'whisper' | 'crystal' | 'land';

/** localStorage mirror of the mute flag ('1' muted / '0' on). Canonical store is the profile. */
const MUTE_KEY = 'lolly:sfxMuted';

// ── mute state ───────────────────────────────────────────────────────────────

let muted = readInitialMuted();

function readInitialMuted(): boolean {
  try {
    const stored = localStorage.getItem(MUTE_KEY);
    if (stored === '1') return true;
    if (stored === '0') return false;
  } catch { /* private mode / no storage — fall through to the default */ }
  return false; // no explicit preference yet → interface sounds ON by default
}

export function isSfxMuted(): boolean {
  return muted;
}

/** Set + persist (localStorage mirror only) the mute flag. Profile write is the caller's job. */
export function setSfxMuted(next: boolean): void {
  muted = next;
  try { localStorage.setItem(MUTE_KEY, next ? '1' : '0'); } catch { /* best-effort */ }
}

/**
 * Reconcile from the profile (canonical) once it has loaded at boot. Only adopts an
 * explicit boolean; leaves the localStorage-derived value in place otherwise. Also
 * writes the value back through the localStorage mirror so the two stay in sync.
 */
export function hydrateSfxMuted(profileMuted: boolean | undefined): void {
  if (typeof profileMuted !== 'boolean') return;
  setSfxMuted(profileMuted);
}

// ── audio graph (lazy, shared) ─────────────────────────────────────────────────

type WindowWithWebkitAudio = Window & typeof globalThis & { webkitAudioContext?: typeof AudioContext };

let ctx: AudioContext | null = null;
let master: GainNode | null = null;

/** Lazily build (and resume) the shared context + master gain. Returns null where unavailable. */
function audio(): { ctx: AudioContext; master: GainNode } | null {
  if (typeof window === 'undefined') return null;
  const AC = window.AudioContext ?? (window as WindowWithWebkitAudio).webkitAudioContext;
  if (!AC) return null;
  if (!ctx) {
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.26; // modest headroom so overlapping cues don't clip the destination
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => { /* stays suspended until the next gesture */ });
  return { ctx, master: master! };
}

// ── voice primitives ───────────────────────────────────────────────────────────

interface BlipOpts {
  type?: OscillatorType;
  /** Start frequency (Hz). */ from: number;
  /** End frequency (Hz); glides from→to across dur. Omit for a flat tone. */ to?: number;
  /** Duration in seconds. */ dur: number;
  /** Peak gain (0–1, relative to master). */ peak?: number;
  /** Start offset in seconds from "now". */ delay?: number;
}

/** A single enveloped oscillator tone: fast attack, exponential decay to silence. */
function blip(ctx: AudioContext, out: AudioNode, { type = 'sine', from, to, dur, peak = 0.5, delay = 0 }: BlipOpts): void {
  const t0 = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  // A touch of random detune keeps repeated cues from sounding mechanically identical.
  const detune = (Math.random() * 2 - 1) * 6;
  osc.frequency.setValueAtTime(from, t0);
  osc.detune.setValueAtTime(detune, t0);
  if (to !== undefined && to !== from) osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), t0 + dur);
  // exponentialRamp can't touch 0, so bracket the envelope with a tiny epsilon.
  const eps = 0.0001;
  g.gain.setValueAtTime(eps, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + Math.min(0.008, dur * 0.35)); // ~8ms attack
  g.gain.exponentialRampToValueAtTime(eps, t0 + dur);
  osc.connect(g).connect(out);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

interface SweepOpts {
  dur: number;
  peak?: number;
  cutoffFrom: number;
  cutoffTo: number;
  /** Start offset in seconds from "now" — lets a sweep land AFTER earlier hits (e.g. a vacuum after the shutter's 'ssh's). */ delay?: number;
}

/** A short filtered-noise sweep — the "away" texture under the delete cue. */
function sweep(ctx: AudioContext, out: AudioNode, { dur, peak = 0.4, cutoffFrom, cutoffTo, delay = 0 }: SweepOpts): void {
  const t0 = ctx.currentTime + delay;
  const n = Math.max(1, Math.floor(ctx.sampleRate * dur));
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < n; i++) data[i] = Math.random() * 2 - 1; // white noise (shell code — Math.random is fine)
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(cutoffFrom, t0);
  lp.frequency.exponentialRampToValueAtTime(Math.max(1, cutoffTo), t0 + dur);
  const g = ctx.createGain();
  const eps = 0.0001;
  g.gain.setValueAtTime(peak, t0);
  g.gain.exponentialRampToValueAtTime(eps, t0 + dur);
  src.connect(lp).connect(g).connect(out);
  src.start(t0);
  src.stop(t0 + dur + 0.02);
}

interface TickOpts {
  /** Duration in seconds. */ dur: number;
  /** Peak gain (0–1, relative to master). */ peak?: number;
  /** Band-pass centre frequency (Hz) — the transient's timbre. */ freq: number;
  /** Filter Q (resonance). Lower = softer/woodier, higher = tighter/brighter. */ q?: number;
  /** Start offset in seconds from "now" — for layering two hits (e.g. a shutter's ka-chunk). */ delay?: number;
}

/**
 * A very short band-passed noise burst — the crisp, PHYSICAL part of a click (a tap,
 * not a pitched beep). Instant attack, fast exponential decay. Layered under a tonal
 * body it gives a UI tap its tactile edge without sounding electronic.
 */
function tick(ctx: AudioContext, out: AudioNode, { dur, peak = 0.4, freq, q = 0.8, delay = 0 }: TickOpts): void {
  const t0 = ctx.currentTime + delay;
  const n = Math.max(1, Math.floor(ctx.sampleRate * dur));
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < n; i++) data[i] = Math.random() * 2 - 1; // white noise (shell code — Math.random is fine)
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  // A touch of centre-frequency jitter keeps repeated clicks from sounding identical.
  bp.frequency.setValueAtTime(freq * (1 + (Math.random() * 2 - 1) * 0.06), t0);
  bp.Q.setValueAtTime(q, t0);
  const g = ctx.createGain();
  const eps = 0.0001;
  g.gain.setValueAtTime(peak, t0);                    // instant transient, no attack ramp
  g.gain.exponentialRampToValueAtTime(eps, t0 + dur); // fast decay
  src.connect(bp).connect(g).connect(out);
  src.start(t0);
  src.stop(t0 + dur + 0.02);
}

interface SurgeOpts {
  type?: OscillatorType;
  /** Start frequency (Hz). */ from: number;
  /** End frequency (Hz); glides from→to across dur. */ to?: number;
  /** Duration in seconds. */ dur: number;
  /** Peak gain (0–1, relative to master). */ peak?: number;
  /** Seconds to SWELL in to peak (the "takeoff / arrival" onset — unlike blip's ~8ms attack). */ attack?: number;
  /** Start offset in seconds from "now". */ delay?: number;
  /** Fixed detune (cents) for ensemble width when layering. */ detune?: number;
}

/**
 * A swelling glide TONE: pitch glides from→to while the gain SWELLS in over `attack`,
 * holds, then eases out. Where `blip` snaps on and decays (a tap), `surge` arrives — the
 * envelope of an EV pulling away or a maglev gliding in. The core of a "takeoff" cue.
 */
function surge(ctx: AudioContext, out: AudioNode, { type = 'triangle', from, to, dur, peak = 0.2, attack = 0.12, delay = 0, detune = 0 }: SurgeOpts): void {
  const t0 = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  const eps = 0.0001;
  osc.type = type;
  osc.frequency.setValueAtTime(from, t0);
  osc.detune.setValueAtTime(detune, t0);
  if (to !== undefined && to !== from) osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), t0 + dur);
  g.gain.setValueAtTime(eps, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + attack);              // swell in
  g.gain.exponentialRampToValueAtTime(peak * 0.72, t0 + dur * 0.72);   // hold-ish
  g.gain.exponentialRampToValueAtTime(eps, t0 + dur);                  // ease out
  osc.connect(g).connect(out);
  osc.start(t0);
  osc.stop(t0 + dur + 0.03);
}

// ── the sound grammar ───────────────────────────────────────────────────────────
// One small vocabulary, deliberately consistent: rising = "leaving", falling = "settling",
// receding + noise = "gone". Kept quiet and short so it reads as feedback, not decoration.
/** A sweet glassy bell — sine fundamental + a shimmer octave + one inharmonic partial + a
 *  soft mallet strike. Used by the session cues below. */
function bell(ctx: AudioContext, out: AudioNode, { freq, dur = 0.4, peak = 0.2, delay = 0 }: { freq: number; dur?: number; peak?: number; delay?: number }): void {
  blip(ctx, out, { type: 'sine', from: freq, dur, peak, delay });
  blip(ctx, out, { type: 'sine', from: freq * 2.007, dur: dur * 0.6, peak: peak * 0.34, delay });
  blip(ctx, out, { type: 'sine', from: freq * 3.83, dur: dur * 0.28, peak: peak * 0.11, delay });
  tick(ctx, out, { dur: 0.005, peak: peak * 0.45, freq: freq * 3.5, q: 1.1, delay });
}

/** A sweet, high, kawaii "yum" — a formant vowel gliding from an open "yu" into a nasal "m"
 *  close, with an upward playful lilt. Two/three back to back read as "yum-yum(-YUM)". */
function yum(ctx: AudioContext, out: AudioNode, { pitch = 620, dur = 0.16, peak = 0.32, delay = 0, lilt = 1.16 }: { pitch?: number; dur?: number; peak?: number; delay?: number; lilt?: number }): void {
  const t0 = ctx.currentTime + delay;
  const eps = 0.0001;
  const src = ctx.createOscillator(); src.type = 'sawtooth';
  src.frequency.setValueAtTime(pitch, t0);
  src.frequency.exponentialRampToValueAtTime(pitch * lilt, t0 + dur);   // playful upward lilt
  const vib = ctx.createOscillator(); const vibg = ctx.createGain();     // a touch of vibrato = sweetness
  vib.frequency.value = 24; vibg.gain.value = pitch * 0.02; vib.connect(vibg).connect(src.frequency);
  const mix = ctx.createGain(); mix.gain.value = 0.5; src.connect(mix);
  const sum = ctx.createGain();
  const formant = (f0: number, f1: number, q: number, gain: number): void => {
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = q;
    bp.frequency.setValueAtTime(f0, t0); bp.frequency.linearRampToValueAtTime(f1, t0 + dur);
    const fg = ctx.createGain(); fg.gain.value = gain; mix.connect(bp).connect(fg).connect(sum);
  };
  formant(720, 300, 7, 1.0);    // F1 — opens on the "u", closes down for the "m"
  formant(1180, 950, 9, 0.7);   // F2
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2600;
  const bg = ctx.createGain(); bg.gain.value = 0.1; mix.connect(lp).connect(bg).connect(sum); // "y" brightness
  const g = ctx.createGain();
  g.gain.setValueAtTime(eps, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + 0.02);              // "y" onset
  g.gain.setValueAtTime(peak, t0 + dur * 0.5);                       // hold the "u"
  g.gain.exponentialRampToValueAtTime(peak * 0.42, t0 + dur * 0.8);  // dip into the "m"
  g.gain.exponentialRampToValueAtTime(eps, t0 + dur + 0.05);         // nasal tail closes
  sum.connect(g).connect(out);
  src.start(t0); vib.start(t0); src.stop(t0 + dur + 0.08); vib.stop(t0 + dur + 0.08);
}

const VOICES: Record<SfxName, (ctx: AudioContext, out: AudioNode) => void> = {
  // Making a NEW session from a tool — "Twinkle bloom" (sound audition #8): a soft shimmer that
  // blooms open and floats down. Feather-light and quietly celebratory — a fresh canvas
  // appearing. Played by views/tool.js when a tool mounts with no resume slot.
  newSession(ctx, out) {
    sweep(ctx, out, { dur: 0.5, peak: 0.1, cutoffFrom: 2200, cutoffTo: 7200 });
    bell(ctx, out, { freq: 2093, dur: 0.6, peak: 0.1, delay: 0.08 });  // C7
    bell(ctx, out, { freq: 2637, dur: 0.5, peak: 0.07, delay: 0.22 }); // E7
  },
  // Leaving an editing session — a sugary "yum-yum-YUM" cheer with a trailing sparkle spray
  // (auditions #10 + #7): three little "yum"s climbing to a happy top, a bell landing, then a
  // spray of sugar sparkles. The sweet reward for stepping away from something you made.
  leaveSession(ctx, out) {
    yum(ctx, out, { pitch: 560, dur: 0.15, peak: 0.3 });
    yum(ctx, out, { pitch: 660, dur: 0.15, peak: 0.32, delay: 0.16 });
    yum(ctx, out, { pitch: 800, dur: 0.2, peak: 0.34, delay: 0.32, lilt: 1.22 });
    bell(ctx, out, { freq: 2093, dur: 0.4, peak: 0.14, delay: 0.5 }); // C7 landing
    [0.5, 0.58, 0.66].forEach((d, i) => tick(ctx, out, { dur: 0.007, peak: 0.06, freq: 6000 + i * 900, q: 1, delay: d }));
  },
  // Flipping past one featured tile / cover — a soft, dry paper flick. A single very short
  // band-passed noise tick, quiet and pitch-jittered so a fast riffle through the strip flutters
  // like thumbing a stack of cards rather than repeating one mechanical click. The caller
  // rate-limits it (see featured-row.ts) so a quick flick stays a riffle, not a buzz.
  flick(ctx, out) {
    tick(ctx, out, { dur: 0.012, peak: 0.09 + Math.random() * 0.03, freq: 2200 + Math.random() * 900, q: 1.1 });
  },
  // A light, high tap: a crisp high band-passed noise transient (the "click") over a
  // quick high sine that settles a hair downward. Deliberately way up in pitch, soft
  // and very short — a barely-there tick that reads as a press, never a bleep.
  click(ctx, out) {
    tick(ctx, out, { dur: 0.007, peak: 0.16, freq: 3600, q: 1.0 });
    blip(ctx, out, { type: 'sine', from: 940, to: 780, dur: 0.024, peak: 0.13 });
  },
  // "Maglev Glide" — Andy's pick for VISITING the Verify page (Sound Lab, 2026-07-06). A
  // frictionless rising doppler: two sine tones SWELLING in and gliding up (a fundamental +
  // an octave shimmer) under an airy forward sweep that opens bright — the sound of sliding
  // cleanly onto the page. Played on the "Verify" nav link (the page visit), not the in-page
  // file action.
  verify(ctx, out) {
    surge(ctx, out, { type: 'sine', from: 320, to: 1000, dur: 0.46, peak: 0.22, attack: 0.12 });
    surge(ctx, out, { type: 'sine', from: 640, to: 2000, dur: 0.46, peak: 0.09, attack: 0.14, detune: 6 });
    sweep(ctx, out, { dur: 0.40, peak: 0.10, cutoffFrom: 900, cutoffTo: 3400 });   // airy top, opening upward
  },
  // A card lifts out of the grid — a short upward glide.
  pickup(ctx, out) {
    blip(ctx, out, { type: 'triangle', from: 560, to: 860, dur: 0.09, peak: 0.5 });
  },
  // A card settles into place — a soft downward tone with a low body under it.
  drop(ctx, out) {
    blip(ctx, out, { type: 'sine', from: 520, to: 300, dur: 0.12, peak: 0.6 });
    blip(ctx, out, { type: 'sine', from: 200, to: 150, dur: 0.14, peak: 0.32, delay: 0.02 });
  },
  // Something is removed — a receding whoosh plus a low tone dropping away.
  delete(ctx, out) {
    sweep(ctx, out, { dur: 0.28, peak: 0.5, cutoffFrom: 1400, cutoffTo: 220 });
    blip(ctx, out, { type: 'sine', from: 320, to: 90, dur: 0.26, peak: 0.4 });
  },
  // A two-step chirp so switching sound back ON gives immediate audible confirmation.
  toggle(ctx, out) {
    blip(ctx, out, { type: 'triangle', from: 700, dur: 0.05, peak: 0.45 });
    blip(ctx, out, { type: 'triangle', from: 1040, dur: 0.06, peak: 0.45, delay: 0.06 });
  },
  // Shifting top-level view (Tools ↔ Projects ↔ Catalog) — a soft airy "swish"
  // forward: a filtered-noise glide that opens UPWARD (arriving, the opposite of
  // delete's receding sweep) under a gently rising tone. Distinct from the tap.
  navigate(ctx, out) {
    sweep(ctx, out, { dur: 0.19, peak: 0.22, cutoffFrom: 700, cutoffTo: 3400 });
    blip(ctx, out, { type: 'sine', from: 440, to: 590, dur: 0.13, peak: 0.2 });
  },
  // Capture (render / save / copy) — Andy's brief (2026-07-06): a staggering of soft 'ssh's
  // that then LIFTS, bright and sunny (no crush). Five breathy, broad low-Q noise 'ssh' bursts
  // fan out (each a hair higher, softly staggered — leaf-shutter blades / soft air), THEN a
  // rising, sunny lift: a climb G5·C6·D6 up to a WARM top that bends UP (E6→F6) and rings out
  // with an airy shimmer + a sparkle. The moment isn't slapped shut — it opens up. This is THE
  // download / capture sound. ~1.5s; there's room to breathe (it fires once, on the capture).
  shutter(ctx, out) {
    tick(ctx, out, { dur: 0.060, peak: 0.10, freq: 4600, q: 0.35 });               // 'ssh' 1
    tick(ctx, out, { dur: 0.060, peak: 0.11, freq: 5100, q: 0.35, delay: 0.09 });  // 'ssh' 2
    tick(ctx, out, { dur: 0.055, peak: 0.11, freq: 5600, q: 0.35, delay: 0.18 });  // 'ssh' 3
    tick(ctx, out, { dur: 0.050, peak: 0.10, freq: 6200, q: 0.35, delay: 0.27 });  // 'ssh' 4
    tick(ctx, out, { dur: 0.050, peak: 0.09, freq: 6800, q: 0.35, delay: 0.35 });  // 'ssh' 5 — softest, trailing into the lift
    // …then the bright, sunny LIFT — a rising figure that climbs and inflects UP, ringing out.
    blip(ctx, out, { type: 'sine',     from: 784,  dur: 0.16, peak: 0.20, delay: 0.44 });             // G5
    blip(ctx, out, { type: 'sine',     from: 1047, dur: 0.18, peak: 0.20, delay: 0.60 });             // C6
    blip(ctx, out, { type: 'sine',     from: 1175, dur: 0.20, peak: 0.19, delay: 0.78 });             // D6
    blip(ctx, out, { type: 'triangle', from: 1319, to: 1397, dur: 0.60, peak: 0.19, delay: 0.96 });   // E6 → F6, warm top bending UP — the lift
    blip(ctx, out, { type: 'sine',     from: 1397, dur: 0.50, peak: 0.11, delay: 1.05 });             // F6 pure shine at the peak
    blip(ctx, out, { type: 'triangle', from: 1760, to: 2093, dur: 0.42, peak: 0.06, delay: 0.98 });   // airy high shimmer above, quiet
    tick(ctx, out, { dur: 0.012, peak: 0.08, freq: 7200, q: 1.0, delay: 0.96 });                       // sparkle at the peak
  },
  // A super-soft, quick riffle for a section opening its contents — a few faint papery
  // ticks in fast succession, like a stack of cards fanning open. Sits UNDER the reveal
  // animation, never over it: quiet (peak ~0.1) and broad (low Q, airy not tonal).
  shuffle(ctx, out) {
    for (let i = 0; i < 5; i++) {
      tick(ctx, out, {
        dur: 0.02,
        peak: 0.09 + Math.random() * 0.03,
        freq: 2600 + Math.random() * 1500, // papery mid-high, varied so it flutters
        q: 0.4,
        delay: i * 0.028 + Math.random() * 0.006,
      });
    }
  },
  // Switching the featured strip to COVER FLOW — cool & futuristic, WITHOUT the buzz. The
  // old twin sawtooth glissandi read as a raspberry/"fart"; replaced with an airy filtered
  // sweep, a clean ascending arpeggio in pure SINE tones (a major triad up an octave) and a
  // sparkle on top. Still says "holographic 3D mode powering up", but smooth, not buzzy.
  coverflow(ctx, out) {
    sweep(ctx, out, { dur: 0.34, peak: 0.13, cutoffFrom: 600, cutoffTo: 5200 });
    [523, 784, 1047].forEach((f, i) =>
      blip(ctx, out, { type: 'sine', from: f, dur: 0.3 - i * 0.03, peak: 0.24 - i * 0.03, delay: i * 0.05 }));
    tick(ctx, out, { dur: 0.02, peak: 0.16, freq: 6000, q: 0.9, delay: 0.16 });
    blip(ctx, out, { type: 'triangle', from: 2093, to: 2637, dur: 0.3, peak: 0.09, delay: 0.2 });
  },
  // Switching the featured strip to GALLERY — ultra-modern & refined: a clean, warm
  // two-note lift (a perfect fifth) with a whisper of high for clarity. No noise, no
  // flash — understated and polished.
  gallery(ctx, out) {
    blip(ctx, out, { type: 'sine', from: 660, dur: 0.24, peak: 0.26 });
    blip(ctx, out, { type: 'sine', from: 990, dur: 0.3, peak: 0.19, delay: 0.045 });
    tick(ctx, out, { dur: 0.009, peak: 0.11, freq: 3400, q: 1.0, delay: 0.045 });
  },
  // A quick, bright "ready" lift played the instant before the export shutter fires on a
  // tool SAVE — a short two-note rise (a perfect fifth) so the save feels deliberate and
  // upbeat, then the camera's ka-chunk lands a beat later. Kept snappy (~0.1s) so it clearly
  // PRECEDES the shutter rather than muddying it.
  save(ctx, out) {
    blip(ctx, out, { type: 'triangle', from: 680,  dur: 0.06,  peak: 0.34 });
    blip(ctx, out, { type: 'triangle', from: 1020, dur: 0.075, peak: 0.3, delay: 0.045 });
    tick(ctx, out, { dur: 0.008, peak: 0.1, freq: 3600, q: 1.0, delay: 0.045 });
  },
  // Saving the PROFILE is a small, lovely "you're all set" moment, so it earns a warmer,
  // fuller cue than a tool save: a clean ascending arpeggio (pure sine — no reedy saw)
  // that RISES the whole way and lands on its highest, brightest note last — a light
  // upward inflection that shines and rings out, the sound of arrival.
  saveProfile(ctx, out) {
    blip(ctx, out, { type: 'sine', from: 523,  dur: 0.16, peak: 0.24 });                // C5
    blip(ctx, out, { type: 'sine', from: 659,  dur: 0.16, peak: 0.23, delay: 0.09 });   // E5
    blip(ctx, out, { type: 'sine', from: 784,  dur: 0.18, peak: 0.22, delay: 0.18 });   // G5
    blip(ctx, out, { type: 'sine', from: 1047, dur: 0.24, peak: 0.22, delay: 0.28 });   // C6
    // The arrival — highest and brightest LAST, inflecting UP (E6→A6): a light, shining
    // top that bends upward and rings out a touch longer than the notes below it.
    blip(ctx, out, { type: 'triangle', from: 1319, to: 1760, dur: 0.5,  peak: 0.2,  delay: 0.42 }); // E6→A6 bright rising top
    blip(ctx, out, { type: 'sine',     from: 1760,            dur: 0.42, peak: 0.11, delay: 0.5 });  // A6 pure shine at the peak
    tick(ctx, out, { dur: 0.01, peak: 0.09, freq: 6200, q: 1.0, delay: 0.44 });                      // sparkle on the peak
  },
  // Export my data — the bundle flies out to a file: a full, airy whoosh, filtered noise
  // opening UPWARD and outward with a light doppler tone riding over it. Reads as "sent".
  whoosh(ctx, out) {
    sweep(ctx, out, { dur: 0.5, peak: 0.34, cutoffFrom: 320, cutoffTo: 4600 });
    blip(ctx, out, { type: 'sine', from: 300, to: 760, dur: 0.42, peak: 0.14 });
    tick(ctx, out, { dur: 0.03, peak: 0.1, freq: 5200, q: 0.5, delay: 0.34 });
  },
  // Import data — the opposite gesture: a vacuum suck pulling everything IN. Filtered noise
  // closing DOWN and in over a descending tone, then a soft low "thunk" as the data lands
  // here. The mirror image of whoosh, so out vs in read as clearly opposite.
  vacuum(ctx, out) {
    sweep(ctx, out, { dur: 0.5, peak: 0.34, cutoffFrom: 4600, cutoffTo: 300 });
    blip(ctx, out, { type: 'triangle', from: 660, to: 150, dur: 0.46, peak: 0.16 });
    blip(ctx, out, { type: 'sine', from: 180, to: 120, dur: 0.16, peak: 0.32, delay: 0.47 }); // landing thunk
  },
  // Export EVERYTHING and render it all — the big one. A long, victorious brass fanfare:
  // discrete sawtooth NOTES (glides read as a raspberry, so no portamento) give a trumpet
  // timbre; an ascending "ta-ta-ta-TAA" lands on a long, sustained C-major chord doubled an
  // octave down for brass-section body, with a low root for weight and a bright confetti
  // shimmer over the top. Deliberately the longest, grandest cue in the app (~1.6s).
  fanfare(ctx, out) {
    // A trumpet-ish voice: a sawtooth note doubled an octave below with a sine to round the
    // reedy edge — three layers per note so it reads as a brass section, not a lone beep.
    const brass = (from: number, dur: number, peak: number, delay: number): void => {
      blip(ctx, out, { type: 'sawtooth', from,            dur, peak,             delay });
      blip(ctx, out, { type: 'sawtooth', from: from / 2,  dur, peak: peak * 0.5, delay });
      blip(ctx, out, { type: 'sine',     from,            dur, peak: peak * 0.4, delay });
    };
    brass(523,  0.16, 0.26, 0.0);   // C5 — ta
    brass(659,  0.16, 0.26, 0.15);  // E5 — ta
    brass(784,  0.2,  0.28, 0.3);   // G5 — ta
    brass(1047, 0.95, 0.3,  0.48);  // C6 — TAAA (held, the arrival)
    blip(ctx, out, { type: 'sawtooth', from: 1319, dur: 0.9,  peak: 0.14, delay: 0.52 }); // E6
    blip(ctx, out, { type: 'sawtooth', from: 1568, dur: 0.9,  peak: 0.12, delay: 0.56 }); // G6
    blip(ctx, out, { type: 'sine',     from: 262,  dur: 0.98, peak: 0.2,  delay: 0.48 }); // C4 low root — weight
    blip(ctx, out, { type: 'triangle', from: 2093, to: 2637, dur: 0.7, peak: 0.09, delay: 0.62 }); // shimmer
    tick(ctx, out, { dur: 0.012, peak: 0.12, freq: 6200, q: 1.0, delay: 0.62 });
  },
  // Favouriting — a little star lights up: two high bell tones leaping up a fourth with
  // airy high sparkles either side. Bright, quick and magical — the literal sound of a
  // twinkle. Kept quiet so it delights rather than startles.
  twinkle(ctx, out) {
    blip(ctx, out, { type: 'sine', from: 1568, dur: 0.13, peak: 0.2 });                // G6
    blip(ctx, out, { type: 'sine', from: 2093, dur: 0.16, peak: 0.17, delay: 0.06 });  // C7
    tick(ctx, out, { dur: 0.01,  peak: 0.12, freq: 7200, q: 1.2 });
    tick(ctx, out, { dur: 0.012, peak: 0.1,  freq: 8400, q: 1.2, delay: 0.085 });
    blip(ctx, out, { type: 'triangle', from: 2637, to: 3136, dur: 0.14, peak: 0.06, delay: 0.05 }); // shimmer up
  },
  // Changing an icon's colour theme — a very airy wash of colour: a soft, breathy
  // filtered-noise sweep opening upward under a gentle high tone gliding up. Light and
  // diffuse (airy, not tonal) so it feels like a new hue washing across the icons.
  shimmer(ctx, out) {
    sweep(ctx, out, { dur: 0.34, peak: 0.16, cutoffFrom: 900, cutoffTo: 6000 });
    blip(ctx, out, { type: 'sine', from: 1318, to: 1760, dur: 0.28, peak: 0.1 });      // E6→A6 gentle glide
    tick(ctx, out, { dur: 0.02, peak: 0.06, freq: 7000, q: 0.4, delay: 0.14 });
  },
  // One item in a bulk-render queue just finished — a soft, satisfying bell "ding": a clean
  // bell tone with a quiet higher partial for shimmer and a whisper of a mallet strike.
  // Deliberately quiet — it repeats once per rendered item, so it must reassure, never nag.
  ding(ctx, out) {
    tick(ctx, out, { dur: 0.006, peak: 0.07, freq: 5000, q: 1.1 });                     // soft mallet strike
    blip(ctx, out, { type: 'sine', from: 1568, dur: 0.3,  peak: 0.17 });                // G6 bell body
    blip(ctx, out, { type: 'sine', from: 2349, dur: 0.24, peak: 0.05, delay: 0.004 });  // D7 partial — bell shimmer
  },
  // A single render finished — a modest, bright "ta-da": a quick rising major arpeggio
  // (G5·C6·E6·G6) capped by a light sparkle. Celebratory but compact (~0.5s) — the subtle
  // sibling of the batch fanfare, so ONE render feels rewarding without the full trumpet.
  victory(ctx, out) {
    blip(ctx, out, { type: 'sine',     from: 784,  dur: 0.12, peak: 0.24 });                // G5
    blip(ctx, out, { type: 'sine',     from: 1047, dur: 0.14, peak: 0.24, delay: 0.08 });   // C6
    blip(ctx, out, { type: 'triangle', from: 1319, dur: 0.34, peak: 0.22, delay: 0.16 });   // E6 — the "-da", rings out
    blip(ctx, out, { type: 'sine',     from: 1568, dur: 0.3,  peak: 0.12, delay: 0.18 });   // G6 shine on top
    tick(ctx, out, { dur: 0.01, peak: 0.09, freq: 6000, q: 1.0, delay: 0.16 });             // sparkle
  },
  // The gentle inverse of victory — a soft, low, DESCENDING two-note "uh-oh" with a
  // little low body: signals "didn't pass" (a broken or missing credential) without a
  // harsh buzzer. Deliberately quiet and cautionary, never alarming.
  warn(ctx, out) {
    blip(ctx, out, { type: 'triangle', from: 392, dur: 0.14, peak: 0.16 });                 // G4
    blip(ctx, out, { type: 'triangle', from: 294, to: 262, dur: 0.26, peak: 0.15, delay: 0.13 }); // D4→C4 — falls
    blip(ctx, out, { type: 'sine',     from: 130, to: 98,  dur: 0.28, peak: 0.09, delay: 0.13 }); // low body
  },
  // A quick, quiet "shoo" for dismissing a modal/overlay — a short airy hush that
  // falls away fast (filtered noise sweeping high→low). Barely there, never a whoosh.
  shoo(ctx, out) {
    sweep(ctx, out, { dur: 0.11, peak: 0.12, cutoffFrom: 5600, cutoffTo: 1500 });
  },
  // MOTION filter — a film reel spinning up: dry ticks that ACCELERATE and fade, then
  // blur into a smooth, quiet whir at running speed.
  reel(ctx, out) {
    let t = 0, gap = 0.085;
    for (let i = 0; i < 16; i++) {
      const p = i / 15;                                     // 0 → 1 across the spin-up
      tick(ctx, out, { dur: 0.012, peak: 0.03 + 0.12 * (1 - p), freq: 2300 + p * 1400, q: 1.1, delay: t });
      t += gap; gap *= 0.82;                                // each interval shorter → accelerando
    }
    blip(ctx, out, { type: 'sawtooth', from: 68, dur: 0.5, peak: 0.045, delay: t * 0.55 }); // smooth running whir
  },
  // IMAGE filter — a quick camera iris/shutter "snick": a crisp mechanical click with a
  // light body and a soft airy tail. Lighter than the capture shutter.
  aperture(ctx, out) {
    tick(ctx, out, { dur: 0.008, peak: 0.26, freq: 5200, q: 1.0 });
    tick(ctx, out, { dur: 0.016, peak: 0.32, freq: 3200, q: 0.8 });
    blip(ctx, out, { type: 'sine', from: 260, to: 150, dur: 0.04, peak: 0.2 });
    tick(ctx, out, { dur: 0.09, peak: 0.09, freq: 4800, q: 0.4, delay: 0.02 });
  },
  // VECTOR filter — a quick pencil scribble: a fast burst of dry, scratchy filtered-noise
  // ticks, pitch- and timing-jittered so it scratches on paper rather than repeats.
  scribble(ctx, out) {
    let t = 0;
    for (let i = 0; i < 9; i++) {
      tick(ctx, out, { dur: 0.02, peak: 0.08 + Math.random() * 0.04, freq: 1900 + Math.random() * 2300, q: 0.5, delay: t });
      t += 0.02 + Math.random() * 0.022;
    }
  },
  // Opting IN to using your details — the most magical moment in the app: a shimmering bell
  // CASCADE up then gently back down (a pentatonic run, so every note is consonant), with
  // sparkles on the climb, a bright shimmer glide over the peak, and a warm low root for body.
  // The sound of everything lighting up and personalising itself for you.
  optIn(ctx, out) {
    const up = [523.25, 587.33, 659.25, 783.99, 880.00, 1046.50, 1318.51]; // C D E G A C E (penta)
    const step = 0.058;
    up.forEach((f, i) => {
      blip(ctx, out, { type: 'sine', from: f, dur: 0.36 - i * 0.02, peak: 0.2, delay: i * step });
      if (i % 2 === 0) tick(ctx, out, { dur: 0.008, peak: 0.05, freq: Math.min(f * 4, 11000), q: 1.2, delay: i * step });
    });
    const peak = up.length * step;
    [1046.50, 880.00, 783.99, 659.25, 587.33, 523.25].forEach((f, i) => // …and gently back down
      blip(ctx, out, { type: 'sine', from: f, dur: 0.34 + i * 0.02, peak: 0.17 - i * 0.012, delay: peak + i * step }));
    blip(ctx, out, { type: 'triangle', from: 1318.51, to: 2637.02, dur: 0.5, peak: 0.07, delay: peak - 0.12 }); // shimmer glide over the top
    tick(ctx, out, { dur: 0.012, peak: 0.09, freq: 8000, q: 1.0, delay: peak - 0.02 });                          // sparkle at the peak
    blip(ctx, out, { type: 'sine', from: 261.63, dur: 1.0, peak: 0.12, delay: 0.02 });                           // warm low root — magic with weight
    blip(ctx, out, { type: 'sine', from: 392.00, dur: 0.9, peak: 0.08, delay: 0.05 });                           // a fifth over the root
  },
  // Opting OUT — very sad: a slow DESCENDING minor sigh that droops at the end. Falling steps,
  // then a long downward bend that keeps sinking (the "aww"), over a hollow low body also sinking.
  optOut(ctx, out) {
    blip(ctx, out, { type: 'triangle', from: 440.00, to: 415.30, dur: 0.36, peak: 0.24 });                // A4, already sagging
    blip(ctx, out, { type: 'triangle', from: 392.00, to: 369.99, dur: 0.40, peak: 0.24, delay: 0.32 });   // G4
    blip(ctx, out, { type: 'triangle', from: 349.23, to: 311.13, dur: 0.46, peak: 0.24, delay: 0.68 });   // F4 → E♭
    blip(ctx, out, { type: 'sawtooth', from: 311.13, to: 174.61, dur: 0.85, peak: 0.20, delay: 1.08 });   // the long final droop, E♭4 → F3
    blip(ctx, out, { type: 'sine',     from: 174.61, to: 116.54, dur: 0.95, peak: 0.15, delay: 1.06 });   // hollow low body, F3 → B♭2
  },
  // A single keystroke in a text field — a soft mechanical "clack": a low woody
  // band-passed tick with a whisper of a low body under it. Deliberately quiet + very
  // short (~14ms) and pitch-jittered so a fast run of typing reads like a keyboard, not
  // a buzz. Lower + woodier than the bright UI `click`, so typing ≠ pressing a button.
  key(ctx, out) {
    tick(ctx, out, { dur: 0.014, peak: 0.10, freq: 1500 + Math.random() * 500, q: 0.7 });
    blip(ctx, out, { type: 'sine', from: 190 + Math.random() * 40, to: 150, dur: 0.03, peak: 0.06 }); // tiny "thock"
  },
  // Dragging a slider — a tiny detent tick as a notched fader passes a step. The SAME
  // paper-flick family as the gallery/coverflow card riffle (`flick`), but deliberately
  // SOFTER: quieter (about half the peak) and woodier (lower centre + lower Q, so it's a
  // muted "tock", not a bright "tick"). The caller ticks it per step + rate-limits, so a
  // fast drag flutters like a ratchet rather than a solid tone.
  slider(ctx, out) {
    tick(ctx, out, { dur: 0.011, peak: 0.05, freq: 2000 + Math.random() * 700, q: 0.85 });
  },
  // Dragging a Figma-style number scrub (the export width/height fields, vector scrubs) —
  // the "better", more mechanical sibling of the slider tick: a crisp detent tick with a
  // tiny low tonal "notch" under it, so a precision drag clicks through calibrated stops
  // like a milled dial. A touch more present than the ambient slider, but still quiet.
  scrub(ctx, out) {
    tick(ctx, out, { dur: 0.009, peak: 0.07, freq: 2500 + Math.random() * 300, q: 1.1 });
    blip(ctx, out, { type: 'sine', from: 430, to: 360, dur: 0.022, peak: 0.05 });
  },
  // Changing a <select> — a soft two-part detent: a tight tick + a tiny upward tonal
  // "notch", so choosing an option feels like a dial clicking into a slot.
  select(ctx, out) {
    tick(ctx, out, { dur: 0.010, peak: 0.11, freq: 2100, q: 1.1 });
    blip(ctx, out, { type: 'sine', from: 640, to: 760, dur: 0.04, peak: 0.11 });
  },
  // Opening the Export panel — "Radar Bloom" (Andy, Sound Lab 2026-07-06): the scope coming
  // alive. A deep tone SWELLS up resonantly (fundamental + a fifth over it) with an airy scan
  // sweeping over the top and a soft glint at the peak. Calm, deep, blooming open. (Name kept
  // for the wiring — render-fab data-sfx; the old hydraulic door is retired.)
  hydraulicOpen(ctx, out) {
    surge(ctx, out, { type: 'sine', from: 174, to: 262, dur: 1.0, peak: 0.24, attack: 0.30 });          // deep swell rising — blooms in
    surge(ctx, out, { type: 'sine', from: 262, to: 392, dur: 1.0, peak: 0.12, attack: 0.34, detune: 5 });// a fifth over it — warmth
    sweep(ctx, out, { dur: 0.70, peak: 0.08, cutoffFrom: 400, cutoffTo: 2600 });                         // airy scan over the top
    blip(ctx, out, { type: 'triangle', from: 784, dur: 0.5, peak: 0.06, delay: 0.5 });                   // soft glint at the top
  },
  // Closing the Export panel — the FLIPPED bloom + a soft crashing hiss fading out (Andy's brief):
  // the deep tone drops instead of rising (a settling-down mirror of the open), under a broad,
  // soft noise 'crash' that washes in bright then bleeds away — a wave receding, sealing low.
  hydraulicClose(ctx, out) {
    blip(ctx, out, { type: 'sine', from: 262, to: 174, dur: 0.70, peak: 0.20 });            // deep tone dropping — flipped bloom
    blip(ctx, out, { type: 'sine', from: 392, to: 262, dur: 0.60, peak: 0.10, delay: 0.01 }); // fifth dropping
    sweep(ctx, out, { dur: 0.85, peak: 0.24, cutoffFrom: 4200, cutoffTo: 420 });             // soft crashing hiss, closing + fading out
    blip(ctx, out, { type: 'sine', from: 150, to: 110, dur: 0.22, peak: 0.13, delay: 0.55 });// a low settle at the bottom
  },
  // Launching the Dashboard (#/d) — "Deep Sonar" (Andy, Dashboard Lab 2026-07-06): a warm, deep
  // sonar ping sounding into the deep — a low fundamental with a fifth over a sub octave, and a
  // faint high glint, all ringing out with a long, spacious tail. Pleasant but DEEP. Played on
  // the Dashboard nav buttons (the launch).
  dashboard(ctx, out) {
    blip(ctx, out, { type: 'sine', from: 196, dur: 1.4, peak: 0.30 });                 // G3 deep ping, long ring
    blip(ctx, out, { type: 'sine', from: 294, dur: 1.1, peak: 0.12, delay: 0.02 });    // D4 fifth
    blip(ctx, out, { type: 'sine', from: 98,  dur: 1.2, peak: 0.16 });                 // G2 sub octave — real depth
    blip(ctx, out, { type: 'triangle', from: 784, dur: 0.5, peak: 0.04, delay: 0.03 });// a faint high glint
  },
  // Opening TOOL DETAILS (the gallery info modal) or an ASSET's details (the catalog) —
  // "Whisper" (Andy's pick, Sound Lab 2026-07-07): an airy light elevation, almost all air. A
  // breathy filtered sweep opens upward and outward with just a faint tone rising under it —
  // wind and tyres, barely a pitch. The panel lifting into view, not a click. Sibling of the
  // "Land" dismiss below (same elevation family).
  whisper(ctx, out) {
    sweep(ctx, out, { dur: 0.52, peak: 0.20, cutoffFrom: 400, cutoffTo: 4800 });
    surge(ctx, out, { type: 'sine', from: 300, to: 820, dur: 0.44, peak: 0.09, attack: 0.14 });
    tick(ctx, out, { dur: 0.03, peak: 0.06, freq: 5600, q: 0.4, delay: 0.34 });
  },
  // The unsaved-changes / "save before leaving?" dialog APPEARING — "Crystal" (Andy's pick):
  // a glass-elevator lift. A clean two-note rise (a perfect fifth) with an airy glide over the
  // top and a pinch of sparkle — elegant and light, the decision rising up to meet you.
  crystal(ctx, out) {
    blip(ctx, out, { type: 'sine', from: 660, dur: 0.26, peak: 0.22 });
    blip(ctx, out, { type: 'sine', from: 990, dur: 0.34, peak: 0.18, delay: 0.06 });
    surge(ctx, out, { type: 'sine', from: 1320, to: 1980, dur: 0.4, peak: 0.06, attack: 0.14, delay: 0.05 });
    sweep(ctx, out, { dur: 0.34, peak: 0.09, cutoffFrom: 1400, cutoffTo: 6000 });
    tick(ctx, out, { dur: 0.009, peak: 0.07, freq: 8000, q: 1.2, delay: 0.12 });
  },
  // Dismissing that dialog with Cancel (or Escape) — "Land": the takeoff run in REVERSE. The
  // same voices as the "Liftoff" audition, time-flipped: the pitch glides DOWN, the airy sweep
  // CLOSES instead of opening, and the little tick lands early as the release. The panel settling
  // back down, nothing changed — the mirror of the elevation cues above.
  land(ctx, out) {
    surge(ctx, out, { type: 'triangle', from: 720, to: 200, dur: 0.5, peak: 0.22, attack: 0.10 });
    surge(ctx, out, { type: 'sine', from: 1080, to: 300, dur: 0.5, peak: 0.09, attack: 0.12, detune: 6 });
    sweep(ctx, out, { dur: 0.42, peak: 0.10, cutoffFrom: 3600, cutoffTo: 600 });
    tick(ctx, out, { dur: 0.012, peak: 0.06, freq: 6800, q: 1.0, delay: 0.12 });
  },
};

// ── theme chimes ────────────────────────────────────────────────────────────────
// Changing theme is a small moment of magic, so it gets its own longer, shimmering
// cue — and a DIFFERENT one per theme: light rises (sunrise), dark descends (dusk),
// suse is a warm playful lift. Kept off the SfxName grammar (parameterised by theme
// string) and played via playThemeSfx() at the user-initiated switch sites only.
const THEME_VOICES: Record<string, (ctx: AudioContext, out: AudioNode) => void> = {
  // Sunrise — a bright ascending sparkle (C E G C) with a high shimmer tail.
  light(ctx, out) {
    [523, 659, 784, 1047].forEach((f, i) =>
      blip(ctx, out, { type: 'sine', from: f, dur: 0.5 - i * 0.05, peak: 0.26, delay: i * 0.075 }));
    blip(ctx, out, { type: 'triangle', from: 1568, to: 2093, dur: 0.42, peak: 0.09, delay: 0.28 });
  },
  // Dusk — a soft descending shimmer (A F D A) over a warm low pad.
  dark(ctx, out) {
    [880, 698, 587, 440].forEach((f, i) =>
      blip(ctx, out, { type: 'sine', from: f, dur: 0.55 - i * 0.04, peak: 0.24, delay: i * 0.085 }));
    blip(ctx, out, { type: 'sine', from: 174, dur: 0.62, peak: 0.18, delay: 0.1 });
  },
  // SUSE — a warm, playful lift with a wink of sparkle, then a gentle settle.
  suse(ctx, out) {
    blip(ctx, out, { type: 'sine', from: 587, dur: 0.42, peak: 0.27 });
    blip(ctx, out, { type: 'sine', from: 880, dur: 0.5, peak: 0.27, delay: 0.09 });
    blip(ctx, out, { type: 'triangle', from: 1318, to: 1760, dur: 0.34, peak: 0.12, delay: 0.19 });
    blip(ctx, out, { type: 'sine', from: 784, dur: 0.46, peak: 0.2, delay: 0.27 });
  },
};

// ── public API ───────────────────────────────────────────────────────────────

/** Play a named interface cue. No-op when muted, when audio is unavailable, or on error. */
export function playSfx(name: SfxName): void {
  if (muted) return;
  const a = audio();
  if (!a) return;
  try { VOICES[name]?.(a.ctx, a.master); } catch { /* audio is best-effort, never throws into the UI */ }
}

// Rate-limited detent ticks for DRAGGING a continuous control. The caller fires one per
// value step (so a slow drag ticks each step, like a ratchet); the cap here keeps a fast
// drag from machine-gunning into a solid tone. Global — only one control is dragged at a
// time. Used both by native <input type=range> (below) and by the tool view's CUSTOM
// slider + Figma-style number scrubs, which aren't range inputs so the global input
// listener never sees them.
let _lastSliderTick = 0;
export function playSliderTick(): void {
  const now = nowMs();
  if (now - _lastSliderTick < 40) return; // ≤ ~25 ticks/sec
  _lastSliderTick = now;
  playSfx('slider');
}
let _lastScrubTick = 0;
export function playScrubTick(): void {
  const now = nowMs();
  if (now - _lastScrubTick < 32) return; // a hair faster than the slider — the scrub is finer
  _lastScrubTick = now;
  playSfx('scrub');
}

// Speak a control's NAME in a robot voice — build-time clips at /voice/<slug>.mp3 (see
// scripts/build-voice-clips.ts). Lazy-loaded + cached per slug; respects the sound mute.
// A control opts in with `data-voice="<label>"`, spoken by the global click delegation.
const voiceCache = new Map<string, HTMLAudioElement>();
export function playVoice(text: string): void {
  if (muted || typeof Audio === 'undefined') return;
  const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) return;
  let a = voiceCache.get(slug);
  if (!a) { a = new Audio(`/voice/${slug}.mp3`); a.volume = 0.6; a.preload = 'auto'; voiceCache.set(slug, a); }
  try { a.currentTime = 0; void a.play().catch(() => { /* autoplay-gated or clip missing */ }); } catch { /* best-effort */ }
}

/**
 * Play the magical theme-change chime for `theme` ('light' | 'dark' | 'suse' | …).
 * A longer, shimmering cue that differs per theme; falls back to the light chime for
 * an unknown theme. Same mute / availability / never-throw guarantees as playSfx.
 * Call ONLY at user-initiated switches (not applyTheme, which also runs at boot).
 */
export function playThemeSfx(theme: string): void {
  if (muted) return;
  const a = audio();
  if (!a) return;
  try { (THEME_VOICES[theme] ?? THEME_VOICES.light)?.(a.ctx, a.master); } catch { /* best-effort */ }
}

// ── arrival "ahhh" (gallery + catalog) ───────────────────────────────────────────
// A single, PUNCHY "ahhh" — the sound of landing on a top-level page. One-shot (never loops):
// a fast swell in, a brief peak, then a fade. Built from a config so each surface gets its own
// character: the GALLERY is low, bassy and breathy; the CATALOG is lighter and brighter (an
// octave-plus up, no sub, brighter vowel + more air) and is led in by four rising "stacking"
// clicks — like assets snapping into a stack. Synthesised (zero assets), gesture-gated, and
// silent only when sound is muted (sound defaults ON — reduced motion no longer mutes it; that
// preference gates visual motion, not audio). Tune per surface via the config.
interface AahConfig {
  peak: number;       // env target before the formant filtering + 0.26 master attenuate it
  attack: number;     // s — punchy onset
  dur: number;        // s — short; self-terminating (no loop)
  chord: readonly number[];
  formants: readonly { f: number; q: number; g: number }[];
  soften: number;     // low-pass cutoff over the vowel (higher = brighter)
  breath: number;     // aspiration-noise level sung through the vowel (the breathiness)
  air: number;        // high-pass "air" over the top
  airHz: number;
  sub: number;        // sub-root sine level under the vowel (0 = none)
  clicks: number;     // leading rising "stacking" ticks (0 = none)
}

// The gallery arrival — a warm, musical low "hum": a soft C-major chord in a cosy
// low-mid register (with its third, so it reads major and friendly, not an ominous
// hollow drone), rounded formants and only a little sub. Led in by the SAME four
// rising "stacking" clicks the catalog uses. Quiet, soft and hummy — but musical.
const GALLERY_AAH: AahConfig = {
  peak: 0.30, attack: 0.09, dur: 1.1,
  chord: [130.81, 196.00, 261.63, 329.63], // C3 · G3 · C4 · E4 — a warm major chord
  formants: [{ f: 350, q: 5, g: 1.0 }, { f: 700, q: 6, g: 0.45 }], // rounded "hum", not nasal-menacing
  soften: 1100, breath: 0.16, air: 0.05, airHz: 3600, sub: 0.28, clicks: 4,
};

const CATALOG_AAH: AahConfig = {
  peak: 0.42, attack: 0.11, dur: 1.25,
  chord: [261.63, 392.00, 523.25, 659.25], // C4 · G4 · C5 · E5 — light + bright
  formants: [{ f: 800, q: 6, g: 0.85 }, { f: 1250, q: 9, g: 0.6 }, { f: 2950, q: 11, g: 0.42 }],
  soften: 4400, breath: 0.4, air: 0.22, airHz: 5200, sub: 0, clicks: 4,
};

// Projects: the highest, brightest, lightest of the three — up another octave, the brightest
// vowel, the most air, no bass and no stacking clicks; a delicate airy sparkle on arrival.
const PROJECTS_AAH: AahConfig = {
  peak: 0.36, attack: 0.10, dur: 1.1,
  chord: [523.25, 659.25, 783.99, 1046.50], // C5 · E5 · G5 · C6 — highest + brightest
  formants: [{ f: 880, q: 6, g: 0.7 }, { f: 1400, q: 9, g: 0.6 }, { f: 3200, q: 11, g: 0.5 }],
  soften: 6000, breath: 0.36, air: 0.28, airHz: 6000, sub: 0, clicks: 0,
};

/** Render one "ahhh" (+ any lead-in stacking clicks) into `out`. Caller guarantees a RUNNING,
 *  un-muted context. One-shot: a punchy attack, a brief peak, then a fade. */
function renderAah(ctx: AudioContext, out: AudioNode, cfg: AahConfig): void {
  const t0 = ctx.currentTime;
  const eps = 0.0001;
  const DUR = cfg.dur;

  // Optional lead-in — a few rising "stacking" clicks (assets snapping into a stack): each a
  // touch higher + louder so it builds. The vowel then blooms once the stack has landed.
  for (let i = 0; i < cfg.clicks; i++) {
    tick(ctx, out, { dur: 0.02, peak: 0.16 + i * 0.02, freq: 1500 * 1.16 ** i, q: 1.3, delay: i * 0.06 });
  }
  const s = t0 + (cfg.clicks ? cfg.clicks * 0.06 : 0); // the vowel's own start (after the stack)

  // Master one-shot envelope — punchy attack, a brief peak, then an exponential fade to silence.
  const env = ctx.createGain();
  env.gain.setValueAtTime(eps, s);
  env.gain.exponentialRampToValueAtTime(cfg.peak, s + cfg.attack);
  env.gain.setValueAtTime(cfg.peak, s + cfg.attack + 0.18);   // brief hold at the peak
  env.gain.exponentialRampToValueAtTime(eps, s + DUR);        // fade out — the tail of the "ahh"
  env.connect(out);

  // "Ah" vowel formant bank — tone AND breath pass through it, so the whole hit sings the vowel;
  // the low-pass sets the brightness.
  const mix = ctx.createGain();
  mix.gain.value = 0.34;
  const formantSum = ctx.createGain();
  for (const fm of cfg.formants) {
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = fm.f;
    bp.Q.value = fm.q;
    const fg = ctx.createGain();
    fg.gain.value = fm.g;
    mix.connect(bp).connect(fg).connect(formantSum);
  }
  const soften = ctx.createBiquadFilter();
  soften.type = 'lowpass';
  soften.frequency.value = cfg.soften;
  soften.Q.value = 0.4;
  formantSum.connect(soften).connect(env);

  // The chord — each note doubled + detuned for ensemble width; feeds the vowel formants.
  for (const f of cfg.chord) {
    for (const det of [-7, 7]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      o.detune.value = det;
      o.connect(mix);
      o.start(s);
      o.stop(s + DUR + 0.05);
    }
  }

  // Sub-root — pure low sines UNDER the vowel (parallel to the formants, whose lowest band
  // would filter the fundamental right out) for bass weight. Omitted for the light/bright config.
  if (cfg.sub > 0) {
    for (const [f, g] of [[cfg.chord[0]! / 2, cfg.sub], [cfg.chord[0]!, cfg.sub * 0.55]] as const) {
      const sub = ctx.createOscillator();
      const sg = ctx.createGain();
      sub.type = 'sine';
      sub.frequency.value = f;
      sg.gain.setValueAtTime(eps, s);
      sg.gain.exponentialRampToValueAtTime(g, s + cfg.attack);
      sg.gain.exponentialRampToValueAtTime(eps, s + DUR);
      sub.connect(sg).connect(env);
      sub.start(s);
      sub.stop(s + DUR + 0.05);
    }
  }

  // Breath — aspiration noise sung through the vowel formants (a breathy "ahh"), plus a whisper
  // of high air. Front-loaded (fast in, out before the tone) so it's the breath at the TOP of
  // the hit, not a wash underneath.
  const n = Math.max(1, Math.floor(ctx.sampleRate * DUR));
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < n; i++) data[i] = Math.random() * 2 - 1; // shell code — Math.random is fine
  const nSrc = ctx.createBufferSource();
  nSrc.buffer = buf;
  const nEnv = ctx.createGain();
  nEnv.gain.setValueAtTime(eps, s);
  nEnv.gain.exponentialRampToValueAtTime(cfg.breath, s + 0.10); // quick breath in
  nEnv.gain.exponentialRampToValueAtTime(eps, s + DUR * 0.8);   // fades before the tone tail
  nSrc.connect(nEnv);
  nEnv.connect(mix); // breathy vowel — through the formants
  const air = ctx.createBiquadFilter();
  air.type = 'highpass';
  air.frequency.value = cfg.airHz;
  const airG = ctx.createGain();
  airG.gain.value = cfg.air;
  nEnv.connect(air).connect(airG).connect(env); // a little high "air" over the top
  nSrc.start(s);
  nSrc.stop(s + DUR + 0.05);
}

type ArrivalRender = (ctx: AudioContext, out: AudioNode) => void;
let pendingArrival: ArrivalRender | null = null; // an arrival hit waiting for the first gesture
let arrivalArmed = false;                         // a one-shot gesture listener is pending (autoplay-gated)

/** Play an arrival cue (a view landing) — now if audio is live, else on the first gesture. */
function scheduleArrival(render: ArrivalRender): void {
  if (muted) return;
  const a = audio();
  if (!a) return;
  if (a.ctx.state === 'running') { try { render(a.ctx, a.master); } catch { /* best-effort */ } return; }
  pendingArrival = render;
  armArrival(); // autoplay-gated — play once on the first gesture, if the view is still up
}

// The gallery arrival — faint, high FAIRY BELLS: a quick, sparkly "ding-a-ring-ding"
// of tiny high bells (a C-major sparkle up to a shimmering top and a soft echo),
// each a bright sine with an octave shimmer and a fast decay. High-pitched but quiet,
// delicate and magical — under a second, never a chime.
function renderGalleryBell(ctx: AudioContext, out: AudioNode): void {
  // [freq, peak, ring seconds, delay] — "ding · a · ring · DING · (echo)".
  const notes: readonly (readonly [number, number, number, number])[] = [
    [1046.50, 0.075, 0.34, 0.00],  // C6 — ding
    [1318.51, 0.05,  0.24, 0.10],  // E6 — a
    [1567.98, 0.055, 0.26, 0.18],  // G6 — ring
    [2093.00, 0.07,  0.40, 0.30],  // C7 — DING (the sparkling top)
    [1567.98, 0.038, 0.30, 0.44],  // G6 — a soft echo tail
  ];
  for (const [f, peak, dur, delay] of notes) {
    blip(ctx, out, { type: 'sine', from: f, dur, peak, delay });
    blip(ctx, out, { type: 'sine', from: f * 2, dur: dur * 0.6, peak: peak * 0.4, delay }); // octave shimmer
  }
  tick(ctx, out, { dur: 0.006, peak: 0.05, freq: 7200, q: 1.0, delay: 0.30 }); // a pinch of sparkle on the top ding
}

// Projects arrival — the four rising "stacking" clicks (kept), then a soft, quick puff
// of wind: band-passed noise that fades IN then OUT (a gentle gust), the filter opening
// as it swells and closing as it eases away. Airy, calm and quiet.
function renderProjectsWind(ctx: AudioContext, out: AudioNode): void {
  const eps = 0.0001;
  for (let i = 0; i < 4; i++) { // the same rising stack the catalog used to lead with
    tick(ctx, out, { dur: 0.02, peak: 0.14 + i * 0.02, freq: 1500 * 1.16 ** i, q: 1.3, delay: i * 0.06 });
  }
  const s = ctx.currentTime + 4 * 0.06; // the gust starts as the stack lands
  const dur = 0.55;
  const n = Math.max(1, Math.floor(ctx.sampleRate * dur));
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < n; i++) data[i] = Math.random() * 2 - 1; // white noise (shell code — Math.random is fine)
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.Q.value = 0.6;
  bp.frequency.setValueAtTime(500, s);
  bp.frequency.linearRampToValueAtTime(1400, s + dur * 0.5); // opens as it swells
  bp.frequency.linearRampToValueAtTime(700, s + dur);        // closes as it eases off
  const g = ctx.createGain();
  g.gain.setValueAtTime(eps, s);
  g.gain.exponentialRampToValueAtTime(0.11, s + dur * 0.4);  // fade in — the swell
  g.gain.exponentialRampToValueAtTime(eps, s + dur);         // fade out
  src.connect(bp).connect(g).connect(out);
  src.start(s);
  src.stop(s + dur + 0.02);
}

/** The gallery's arrival — faint, high fairy bells (a sparkly "ding-a-ring-ding"). */
export function playGalleryAah(): void { scheduleArrival(renderGalleryBell); }
/** The catalog's arrival — now the (old projects) bright, delicate airy sparkle. */
export function playCatalogAah(): void { scheduleArrival((c, o) => renderAah(c, o, PROJECTS_AAH)); }
/** The projects tab's arrival — the stacking clicks, then a soft quick puff of wind. */
export function playProjectsAah(): void { scheduleArrival(renderProjectsWind); }
/** Cancel a pending arrival hit — call on leaving a view so it can't fire on another page. */
export function cancelArrivalAah(): void { pendingArrival = null; }

function armArrival(): void {
  if (arrivalArmed || typeof document === 'undefined') return;
  arrivalArmed = true;
  const events = ['pointerdown', 'keydown', 'touchstart'] as const;
  const go = (): void => {
    for (const ev of events) document.removeEventListener(ev, go, true);
    arrivalArmed = false;
    const render = pendingArrival;
    pendingArrival = null;
    if (!render) return; // navigated away before the first gesture
    const a = audio();
    if (a && !muted) { try { render(a.ctx, a.master); } catch { /* best-effort */ } }
  };
  for (const ev of events) document.addEventListener(ev, go, { passive: true, capture: true });
}

// ── app-wide delegation ─────────────────────────────────────────────────────────
// One set of document-level listeners drives cues for the WHOLE app, so a view never
// has to wire sounds itself. A control opts into a richer cue with `data-sfx="<name>"`;
// the shared destructive-confirm button plays "delete"; everything else clicks.

/** Button-like controls that should tick on click. Plain text / range inputs stay quiet. */
const INTERACTIVE_SEL =
  'button, [role="button"], a.btn, .btn, summary, label.switch, ' +
  'input[type="checkbox"], input[type="radio"], select, [data-sfx]';

function isSfxName(v: string | undefined): v is SfxName {
  return v === 'click' || v === 'pickup' || v === 'drop' || v === 'delete' || v === 'toggle'
    || v === 'navigate' || v === 'shutter' || v === 'shuffle' || v === 'coverflow' || v === 'gallery'
    || v === 'save' || v === 'saveProfile' || v === 'whoosh' || v === 'vacuum' || v === 'fanfare'
    || v === 'twinkle' || v === 'shimmer' || v === 'ding' || v === 'victory' || v === 'warn'
    || v === 'shoo' || v === 'reel' || v === 'aperture' || v === 'scribble' || v === 'flick'
    || v === 'optIn' || v === 'optOut' || v === 'key' || v === 'slider' || v === 'scrub'
    || v === 'select' || v === 'hydraulicOpen' || v === 'hydraulicClose' || v === 'verify' || v === 'dashboard' || v === 'newSession' || v === 'leaveSession'
    || v === 'whisper' || v === 'crystal' || v === 'land';
}

/** Decide which cue a clicked control should make. */
function cueForTarget(el: Element): SfxName {
  const tagged = el.closest<HTMLElement>('[data-sfx]');
  if (tagged && isSfxName(tagged.dataset.sfx)) return tagged.dataset.sfx as SfxName;
  // The shared confirm dialog's destructive button (confirm-dialog.ts, danger:true) —
  // fires the "gone" cue at the moment of confirmation, everywhere it's used.
  if (el.closest('.projects-confirm-danger')) return 'delete';
  return 'click';
}

let installed = false;

/**
 * Install the app-wide interface-sound cues. Idempotent; call once at boot. Listeners
 * are CAPTURE-phase so they run before a view's own handler can stopPropagation or remove
 * the node (e.g. the confirm dialog closing itself) — the clicked control is still live.
 */
export function installGlobalSfx(): void {
  if (installed || typeof document === 'undefined') return;
  installed = true;

  document.addEventListener('click', (e) => {
    const t = e.target;
    if (!(t instanceof Element)) return;
    const el = t.closest<HTMLElement>(INTERACTIVE_SEL);
    if (!el) return;
    if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') return;
    playSfx(cueForTarget(el));
    const voiced = el.closest<HTMLElement>('[data-voice]');
    if (voiced?.dataset.voice) playVoice(voiced.dataset.voice); // robot voice speaks the name
  }, true);

  // HTML5 drag-and-drop, app-wide: a card / asset lifts out, then lands.
  document.addEventListener('dragstart', (e) => {
    const t = e.target;
    if (t instanceof Element && t.closest('[draggable="true"]')) playSfx('pickup');
  }, true);
  document.addEventListener('drop', () => { playSfx('drop'); }, true);

  // Typing — a soft keyboard clack per keystroke in a text-editable field. Skips auto-
  // repeat (a held key), pure modifier presses, and any keystroke carrying a Ctrl/Meta
  // shortcut, so it tracks actual typing and never machine-guns.
  document.addEventListener('keydown', (e) => {
    if (e.repeat || e.ctrlKey || e.metaKey || MODIFIER_KEYS.has(e.key)) return;
    if (isTextEditable(e.target)) playSfx('key');
  }, true);

  // Slider drag — a detent tick as a native range input's value changes (the tool view's
  // custom slider / scrub fields tick themselves via playSliderTick / playScrubTick, since
  // they aren't <input type=range> and never fire a native 'input' here).
  document.addEventListener('input', (e) => {
    const t = e.target;
    if (t instanceof HTMLInputElement && t.type === 'range') playSliderTick();
  }, true);

  // Select — a soft detent when the chosen option actually changes.
  document.addEventListener('change', (e) => {
    if (e.target instanceof HTMLSelectElement) playSfx('select');
  }, true);

  // Any native <dialog> modal dismissing — a quick "shoo". The close event doesn't
  // bubble, so (like the others) catch it in the capture phase. Fires on a button
  // close, Esc/cancel, or a form method="dialog", covering the share/confirm dialogs,
  // the catalog download dialog, the headshot cropper, etc. with no per-site wiring.
  // A dialog can opt OUT (dataset.sfxClose === 'off') to own its own dismiss cue —
  // e.g. the unsaved-changes dialog plays 'land' on Cancel instead of a generic shoo.
  document.addEventListener('close', (e) => {
    if (e.target instanceof HTMLDialogElement && e.target.dataset.sfxClose !== 'off') playSfx('shoo');
  }, true);
}

/** Keys that are held/pressed without "typing" a character — no keyboard clack for these. */
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'NumLock', 'ScrollLock', 'Dead', 'Tab']);

// input types that aren't text entry (their own cue or none), PLUS password — a per-key
// clack there would audibly betray the password's length to anyone nearby. No clack.
const NON_TEXT_INPUT = new Set(['range', 'checkbox', 'radio', 'button', 'submit', 'reset', 'color', 'file', 'image', 'password']);

/** True when a keystroke on this target is genuine text entry (text-like input / textarea / contenteditable). */
function isTextEditable(target: EventTarget | null): boolean {
  if (target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLInputElement) return !NON_TEXT_INPUT.has(target.type);
  return target instanceof HTMLElement && target.isContentEditable;
}

/** Monotonic-ish millisecond clock for rate-limiting (shell code — performance/Date are fine). */
function nowMs(): number {
  return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
}
