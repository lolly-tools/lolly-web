// SPDX-License-Identifier: MPL-2.0
/**
 * Lazy filmstrips + waveforms for timeline clip bars (phase 2, §4 of
 * plans/fable-timeline-phase-2.md).
 *
 * A timeline shows one bar per clip and each bar wants a strip of frames (video)
 * or a peak envelope (audio) painted into a <canvas>. Doing that naively — one
 * <video> per bar, seeks fired in parallel — melts a browser: every element
 * holds its own decoder, and Safari/iOS silently CANCEL a seek that is issued
 * while another is in flight, so the frames you get back are a lottery.
 *
 * The contract this module enforces instead:
 *
 *   • ONE pooled probe <video>, module-level, reused across every capture run
 *     and every bar. Runs are serialised behind a single lock, so the probe is
 *     never re-`src`ed underneath a run in progress. It is removed from the DOM
 *     after an idle period (and by `releaseClipThumbs()`) so a parked editor
 *     holds no decoder.
 *   • ONE pooled decode context for peaks (OfflineAudioContext where available,
 *     plain AudioContext otherwise) — never one per call.
 *   • Seeks go through a queue that never has two in flight. Each landed frame
 *     is confirmed with requestVideoFrameCallback where it exists (its metadata
 *     `mediaTime` is the authoritative presented-frame time, unlike
 *     `video.currentTime` which is the *requested* time), with the `seeked`
 *     event as a parallel fallback and a hard per-seek timeout so a stalled
 *     decoder can never wedge the queue.
 *   • Every await point is abort-aware. Aborting settles the caller's promise
 *     promptly and, once the last caller of a shared run has aborted, tears the
 *     run down and frees anything it had produced.
 *   • An LRU of ~32 decoded results, shared by both entry points. Evicted
 *     filmstrips have their ImageBitmaps `close()`d so GPU memory stays bounded.
 *
 * FAILURE POLICY: never throw into the caller. An undecodable/missing/CORS-blocked
 * asset, an aborted run, a headless (no-DOM) environment, or an oversized audio
 * file all resolve EMPTY (`[]` / a zero-length Float32Array) and the bar just
 * renders its plain fill. Callers therefore need no try/catch around an idle
 * callback.
 *
 * OWNERSHIP: returned ImageBitmaps and Float32Arrays are owned by the cache.
 * Callers must NOT `close()` or mutate them — the same instances are handed to
 * the next caller for the same key. `clearClipThumbCache()` / `releaseClipThumbs()`
 * are the only things that close them.
 *
 * AUDIO SIZE CEILING (phase-1 lesson): `decodeAudioData` expands to raw f32 PCM —
 * ~97× for opus (a 30 MB opus ≈ 2.9 GB of PCM), ~11× for mp3. There is no
 * streaming decode in the platform API, so the only defence is refusing to start.
 * Anything whose Content-Length exceeds `MAX_AUDIO_DECODE_BYTES` is refused before
 * the body is read, and a response that declares no length is read through a bounded
 * reader that abandons it at the same ceiling — the fetch is never allowed to buffer
 * an unlabelled 500 MB asset just to refuse it afterwards. 6 MiB covers a
 * ~6-minute 128 kbps mp3 with a worst case around 0.5 GB of transient PCM.
 *
 * SCHEDULING: this module never schedules itself. Callers own *when* — the panel
 * is expected to call `onIdle()` (exported here) to defer capture until the main
 * thread is free, and to abort in-flight work the moment a drag/zoom starts.
 */

// ── tunables ────────────────────────────────────────────────────────────────

/** Decoded results kept alive (filmstrips + peak arrays share the budget). */
export const CACHE_LIMIT = 32;
/** Compressed bytes above which `peaks()` refuses to decode. See the header. */
export const MAX_AUDIO_DECODE_BYTES = 6 * 1024 * 1024;
/** Frames per filmstrip is clamped to this — a bar is a few hundred px wide. */
export const MAX_FRAMES = 48;
/** Per-seek confirmation budget. Longer than a healthy seek, shorter than a stall. */
export const SEEK_TIMEOUT_MS = 700;
/** Budget for the probe to report metadata after a fresh `src`. */
export const METADATA_TIMEOUT_MS = 8000;
/** Probe <video> is detached this long after the last capture run. */
export const PROBE_IDLE_MS = 15000;

const EMPTY_PEAKS = new Float32Array(0);

// ── pure helpers (DOM-free — these are what the unit tests can reach) ────────

const clampInt = (v: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, Math.round(Number.isFinite(v) ? v : lo)));

export interface FilmstripOpts {
  /** How many frames to capture (clamped 1..MAX_FRAMES). */
  count: number;
  /** Target bitmap height in px (clamped 8..240); width follows the video aspect. */
  h: number;
  /** Clip in-point in seconds (source time, not timeline time). */
  clipInSec: number;
  /** Clip out-point in seconds; non-finite/<= in means "to the end of the media". */
  clipOutSec: number;
}

/**
 * Cache key for a filmstrip. `h` is part of the key on purpose (the spec's key
 * lists url|in|out|count): two bars of different heights want different bitmap
 * resolutions, and returning the shorter one would render blurry.
 */
export function filmstripKey(url: string, opts: FilmstripOpts): string {
  const count = clampInt(opts.count, 1, MAX_FRAMES);
  const h = clampInt(opts.h, 8, 240);
  const inS = Number.isFinite(opts.clipInSec) ? Math.max(0, opts.clipInSec) : 0;
  const outS = Number.isFinite(opts.clipOutSec) ? Math.max(0, opts.clipOutSec) : -1;
  return `f|${url}|${inS.toFixed(3)}|${outS.toFixed(3)}|${count}|${h}`;
}

/** Cache key for a peak envelope. */
export function peaksKey(url: string, buckets: number): string {
  return `p|${url}|${clampInt(buckets, 1, 4096)}`;
}

/**
 * Sample times (seconds, source time) for a filmstrip.
 *
 * Frames are taken at the MIDPOINT of each of `count` equal slices, not at the
 * slice edges: sampling exactly at the in-point very often yields the black or
 * blank leader frame, and sampling exactly at the out-point can land past the
 * last decodable frame. Times are clamped inside the media when its duration
 * is known.
 */
export function frameTimes(
  clipInSec: number,
  clipOutSec: number,
  count: number,
  durationSec: number = Number.POSITIVE_INFINITY,
): number[] {
  const n = clampInt(count, 1, MAX_FRAMES);
  const dur = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : Number.POSITIVE_INFINITY;
  const last = Number.isFinite(dur) ? Math.max(0, dur - 1 / 60) : Number.POSITIVE_INFINITY;

  let inS = Number.isFinite(clipInSec) ? Math.max(0, clipInSec) : 0;
  if (Number.isFinite(last)) inS = Math.min(inS, last);
  let outS = Number.isFinite(clipOutSec) && clipOutSec > inS ? clipOutSec : dur;
  if (!Number.isFinite(outS)) outS = inS; // unknown duration and no out-point: degenerate to a single point
  if (Number.isFinite(last)) outS = Math.min(outS, dur);

  const span = Math.max(0, outS - inS);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    let t = inS + ((i + 0.5) * span) / n;
    if (Number.isFinite(last)) t = Math.min(t, last);
    out.push(Math.max(0, t));
  }
  return out;
}

/**
 * Peak envelope for decoded PCM — the audiogram tool's computation, deliberately
 * unchanged (community/audiogram/template.html): bucket the samples, take the
 * max |sample| of a stride-32 sparse scan per bucket, normalise so the loudest
 * bucket is 1.0 with a 0.04 visual floor so quiet passages still draw a sliver.
 *
 * Channels are mixed to mono as (L+R)/2 using at most the first two channels.
 * Digital silence returns all zeros (the caller draws its plain fill rather than
 * a synthetic placeholder — that is the one deliberate difference from the tool,
 * which fabricates `synthPeaks` because it must always show something).
 */
export function bucketPeaks(channels: Float32Array[], buckets: number): Float32Array {
  const n = clampInt(buckets, 1, 4096);
  const ch0 = channels[0];
  if (!ch0 || ch0.length === 0) return new Float32Array(n);
  const ch1 = channels.length > 1 ? channels[1] : null;

  const out = new Float32Array(n);
  const per = Math.max(1, Math.floor(ch0.length / n));
  let max = 0;
  for (let i = 0; i < n; i++) {
    let peak = 0;
    const start = i * per;
    const end = Math.min(ch0.length, start + per);
    for (let j = start; j < end; j += 32) {
      const l = ch0[j] ?? 0;
      const r = ch1 ? (ch1[j] ?? 0) : null;
      const v = Math.abs(r === null ? l : (l + r) / 2);
      if (v > peak) peak = v;
    }
    out[i] = peak;
    if (peak > max) max = peak;
  }
  if (max > 0) for (let k = 0; k < n; k++) out[k] = Math.max(0.04, (out[k] ?? 0) / max);
  else out.fill(0);
  return out;
}

/** True when a byte length is small enough to risk `decodeAudioData` on. */
export function withinDecodeBudget(bytes: number | null | undefined): boolean {
  if (bytes == null || !Number.isFinite(bytes)) return true; // unknown: the post-fetch check catches it
  return bytes >= 0 && bytes <= MAX_AUDIO_DECODE_BYTES;
}

// ── LRU ─────────────────────────────────────────────────────────────────────

export interface Lru<T> {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
  has(key: string): boolean;
  clear(): void;
  size(): number;
  keys(): string[];
}

/**
 * Insertion-ordered LRU over a Map. `dispose` runs for every value that leaves
 * the cache (eviction, overwrite, or `clear()`) — that is where ImageBitmaps get
 * closed, so GPU memory is bounded by CACHE_LIMIT rather than by session length.
 */
export function createLru<T>(limit: number, dispose?: (value: T) => void): Lru<T> {
  const cap = Math.max(1, Math.floor(limit));
  const map = new Map<string, T>();
  const drop = (value: T): void => {
    try { dispose?.(value); } catch { /* a disposer must never break the cache */ }
  };
  return {
    get(key) {
      if (!map.has(key)) return undefined;
      const value = map.get(key) as T;
      map.delete(key);
      map.set(key, value); // refresh recency
      return value;
    },
    set(key, value) {
      const prev = map.get(key);
      if (map.has(key)) {
        map.delete(key);
        if (prev !== value && prev !== undefined) drop(prev);
      }
      map.set(key, value);
      while (map.size > cap) {
        const oldest = map.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        const victim = map.get(oldest) as T;
        map.delete(oldest);
        drop(victim);
      }
    },
    has: (key) => map.has(key),
    clear() {
      for (const value of map.values()) drop(value);
      map.clear();
    },
    size: () => map.size,
    keys: () => [...map.keys()],
  };
}

type CacheEntry = ImageBitmap[] | Float32Array;

const closeBitmaps = (value: CacheEntry): void => {
  if (!Array.isArray(value)) return;
  for (const bmp of value) {
    try { (bmp as { close?: () => void }).close?.(); } catch { /* already gone */ }
  }
};

const cache: Lru<CacheEntry> = createLru<CacheEntry>(CACHE_LIMIT, closeBitmaps);

/** Drop every cached result, closing any ImageBitmaps. */
export function clearClipThumbCache(): void {
  cache.clear();
}

// ── shared-run dedup (ref-counted, abort-aware) ─────────────────────────────

interface Job<T> {
  promise: Promise<T>;
  refs: number;
  ctrl: AbortController;
}

const inflight = new Map<string, Job<unknown>>();

/**
 * Run at most one capture per key even when several bars ask at once, while
 * still honouring each caller's own signal: a caller that aborts detaches and
 * settles empty immediately, and only when the LAST caller has detached is the
 * underlying run aborted (so one bar scrolling out of view can't cancel the
 * capture another bar is still waiting on).
 */
function share<T>(key: string, run: (signal: AbortSignal) => Promise<T>, signal: AbortSignal | undefined, empty: T): Promise<T> {
  let job = inflight.get(key) as Job<T> | undefined;
  // A job whose last subscriber just left is already aborted but may not have
  // reached its `finally` yet — never join a corpse, start a fresh run.
  if (job?.ctrl.signal.aborted) job = undefined;
  if (!job) {
    const ctrl = new AbortController();
    const created: Job<T> = { refs: 0, ctrl, promise: Promise.resolve(empty) };
    created.promise = (async () => run(ctrl.signal))().finally(() => {
      if ((inflight.get(key) as Job<T> | undefined) === created) inflight.delete(key);
    });
    inflight.set(key, created as Job<unknown>);
    job = created;
  }
  const owner = job;
  owner.refs++;
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    owner.refs--;
    if (owner.refs <= 0) owner.ctrl.abort();
  };

  return new Promise<T>((resolve) => {
    let settled = false;
    const finish = (value: T): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      resolve(value);
    };
    function onAbort(): void {
      release();
      finish(empty);
    }
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    owner.promise.then(
      (value) => { release(); finish(value); },
      () => { release(); finish(empty); },
    );
  });
}

// ── seek queue ──────────────────────────────────────────────────────────────

/** The slice of HTMLVideoElement the queue needs — duck-typed so it is testable. */
export interface SeekableEl {
  currentTime: number;
}

export interface SeekQueue {
  /**
   * Queue a seek. Resolves with the landed presentation time, or null if the
   * seek failed, timed out, was aborted, or was superseded.
   * `supersede: true` is latest-wins scrub behaviour — any earlier *queued*
   * supersede request is dropped (resolving null). A seek already in flight is
   * never interrupted; that is the whole point.
   */
  seek(t: number, opts?: { supersede?: boolean; signal?: AbortSignal }): Promise<number | null>;
  /** True while a seek is awaiting confirmation. Never true for two at once. */
  inFlight(): boolean;
  /** Queued-but-not-started count. */
  pending(): number;
  /** Drop everything queued (resolving null); an in-flight seek still settles. */
  clear(): void;
}

/**
 * Strictly serialised seek pump. `waitFrame` is injected so the real
 * rVFC/`seeked` confirmation can be swapped for a fake in tests.
 */
export function createSeekQueue(
  el: SeekableEl,
  waitFrame: (el: SeekableEl, signal?: AbortSignal) => Promise<number | null>,
): SeekQueue {
  interface Entry { t: number; supersede: boolean; signal?: AbortSignal; resolve(v: number | null): void }
  const queue: Entry[] = [];
  let running = false;
  let busy = false;

  async function pump(): Promise<void> {
    if (running) return;
    running = true;
    try {
      while (queue.length) {
        const job = queue.shift() as Entry;
        if (job.signal?.aborted) { job.resolve(null); continue; }
        busy = true;
        let landed: number | null = null;
        try {
          el.currentTime = job.t;
          landed = await waitFrame(el, job.signal);
        } catch {
          landed = null;
        }
        busy = false;
        job.resolve(landed);
      }
    } finally {
      running = false;
    }
  }

  return {
    seek(t, opts) {
      return new Promise<number | null>((resolve) => {
        if (opts?.supersede) {
          for (let i = queue.length - 1; i >= 0; i--) {
            const entry = queue[i];
            if (entry?.supersede) {
              queue.splice(i, 1);
              entry.resolve(null);
            }
          }
        }
        queue.push({ t, supersede: !!opts?.supersede, signal: opts?.signal, resolve });
        void pump();
      });
    },
    inFlight: () => busy,
    pending: () => queue.length,
    clear() {
      while (queue.length) (queue.shift() as Entry).resolve(null);
    },
  };
}

// ── idle scheduling (callers own *when*) ────────────────────────────────────

type IdleWindow = typeof globalThis & {
  requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

/**
 * Run `fn` when the main thread is free, or after `timeout` ms at the latest.
 * Returns a canceller. Falls back to setTimeout where requestIdleCallback is
 * missing (Safari < 17, and any headless test run).
 */
export function onIdle(fn: () => void, timeout = 200): () => void {
  const g = globalThis as IdleWindow;
  if (typeof g.requestIdleCallback === 'function') {
    const handle = g.requestIdleCallback(fn, { timeout });
    return () => { try { g.cancelIdleCallback?.(handle); } catch { /* already ran */ } };
  }
  const handle = setTimeout(fn, Math.min(timeout, 50));
  return () => clearTimeout(handle);
}

// ── the pooled probe <video> ────────────────────────────────────────────────

type RvfcVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime?: number }) => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

let probe: HTMLVideoElement | null = null;
let probeUrl = '';
let probeQueue: SeekQueue | null = null;
let probeIdleTimer: ReturnType<typeof setTimeout> | null = null;
let scratch: HTMLCanvasElement | null = null;

const hasDom = (): boolean => typeof document !== 'undefined' && !!document.createElement;

function getProbe(): HTMLVideoElement {
  if (probe) return probe;
  const v = document.createElement('video');
  v.preload = 'auto';
  v.muted = true;
  v.defaultMuted = true;
  v.autoplay = false;
  v.setAttribute('playsinline', '');
  v.setAttribute('aria-hidden', 'true');
  // Off-screen but attached: a detached <video> is allowed to skip decoding
  // entirely in some engines, which makes seeks never present a frame.
  v.style.cssText = 'position:absolute;left:-99999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none';
  document.body.appendChild(v);
  probe = v;
  probeQueue = createSeekQueue(v, (el, signal) => waitSeekLanded(el as HTMLVideoElement, signal));
  return v;
}

function touchProbeIdle(): void {
  if (probeIdleTimer) clearTimeout(probeIdleTimer);
  probeIdleTimer = setTimeout(() => { probeIdleTimer = null; teardownProbe(); }, PROBE_IDLE_MS);
}

function teardownProbe(): void {
  if (probeIdleTimer) { clearTimeout(probeIdleTimer); probeIdleTimer = null; }
  probeQueue?.clear();
  probeQueue = null;
  if (probe) {
    try {
      probe.pause?.();
      probe.removeAttribute('src');
      probe.load?.();
      probe.remove();
    } catch { /* already detached */ }
  }
  probe = null;
  probeUrl = '';
  scratch = null;
}

/**
 * Release every pooled resource: the probe <video>, the scratch canvas, the
 * decode AudioContext, and the whole result cache. Call from a view's destroy().
 */
export function releaseClipThumbs(): void {
  teardownProbe();
  clearClipThumbCache();
  if (audioCtx) {
    try { (audioCtx as { close?: () => Promise<void> }).close?.(); } catch { /* offline ctxs have no close */ }
    audioCtx = null;
  }
}

/**
 * Await confirmation that a seek actually presented a frame.
 * rVFC is authoritative (`meta.mediaTime` is the time of the frame on screen —
 * `video.currentTime` only reflects what we *asked* for), but not every engine
 * fires it for a paused seek, so `seeked` races alongside it and a timeout
 * guarantees the queue drains.
 */
function waitSeekLanded(v: HTMLVideoElement, signal?: AbortSignal, timeoutMs = SEEK_TIMEOUT_MS): Promise<number | null> {
  return new Promise((resolve) => {
    let done = false;
    let handle = 0;
    const rv = v as RvfcVideo;
    const cleanup = (): void => {
      clearTimeout(timer);
      v.removeEventListener('seeked', onSeeked);
      v.removeEventListener('error', onFail);
      signal?.removeEventListener('abort', onFail);
      if (handle) { try { rv.cancelVideoFrameCallback?.(handle); } catch { /* gone */ } }
    };
    const finish = (value: number | null): void => {
      if (done) return;
      done = true;
      cleanup();
      resolve(value);
    };
    const onSeeked = (): void => finish(v.currentTime);
    const onFail = (): void => finish(null);
    const timer = setTimeout(() => finish(null), timeoutMs);

    if (typeof rv.requestVideoFrameCallback === 'function') {
      try {
        handle = rv.requestVideoFrameCallback((_now, meta) => {
          finish(typeof meta?.mediaTime === 'number' ? meta.mediaTime : v.currentTime);
        });
      } catch { handle = 0; }
    }
    v.addEventListener('seeked', onSeeked, { once: true });
    v.addEventListener('error', onFail, { once: true });
    if (signal?.aborted) { finish(null); return; }
    signal?.addEventListener('abort', onFail, { once: true });
  });
}

function waitMetadata(v: HTMLVideoElement, signal?: AbortSignal): Promise<boolean> {
  if (v.readyState >= 1 /* HAVE_METADATA */) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    const cleanup = (): void => {
      clearTimeout(timer);
      v.removeEventListener('loadedmetadata', onOk);
      v.removeEventListener('error', onFail);
      signal?.removeEventListener('abort', onFail);
    };
    const finish = (ok: boolean): void => { if (done) return; done = true; cleanup(); resolve(ok); };
    const onOk = (): void => finish(true);
    const onFail = (): void => finish(false);
    const timer = setTimeout(() => finish(false), METADATA_TIMEOUT_MS);
    v.addEventListener('loadedmetadata', onOk, { once: true });
    v.addEventListener('error', onFail, { once: true });
    if (signal?.aborted) { finish(false); return; }
    signal?.addEventListener('abort', onFail, { once: true });
  });
}

// One capture run at a time: the probe is a single element, so overlapping runs
// would re-`src` it out from under each other.
let videoLock: Promise<unknown> = Promise.resolve();
function withProbe<T>(fn: () => Promise<T>): Promise<T> {
  const next = videoLock.then(fn, fn);
  videoLock = next.then(() => undefined, () => undefined);
  return next;
}

const isCrossOrigin = (url: string): boolean => {
  if (typeof location === 'undefined') return false;
  if (!/^https?:/i.test(url)) return false;
  try { return new URL(url, location.href).origin !== location.origin; } catch { return false; }
};

async function captureFilmstrip(url: string, opts: FilmstripOpts, signal: AbortSignal): Promise<ImageBitmap[]> {
  if (!hasDom() || typeof createImageBitmap !== 'function') return [];
  // Check the signal BEFORE touching the probe. `share()` defers this run by a
  // microtask, so a caller that aborted in the same tick (the prescribed
  // abort-on-drag/zoom pattern) would otherwise still create the <video>, attach it,
  // and fire a real media request that nothing will ever consume.
  if (signal.aborted) return [];
  const count = clampInt(opts.count, 1, MAX_FRAMES);
  const targetH = clampInt(opts.h, 8, 240);
  const made: ImageBitmap[] = [];

  const bail = (): ImageBitmap[] => {
    for (const b of made) { try { b.close?.(); } catch { /* gone */ } }
    return [];
  };

  const v = getProbe();
  touchProbeIdle();
  if (probeUrl !== url) {
    probeUrl = url;
    if (isCrossOrigin(url)) v.crossOrigin = 'anonymous';
    else v.removeAttribute('crossorigin');
    v.src = url;
    try { v.load(); } catch { /* some engines auto-load */ }
    const ok = await waitMetadata(v, signal);
    if (!ok || signal.aborted) { probeUrl = ''; return bail(); }
  }

  const dur = v.duration;
  const vw = v.videoWidth;
  const vh = v.videoHeight;
  if (!Number.isFinite(dur) || dur <= 0 || !vw || !vh) return bail();

  const w = Math.max(1, Math.round((targetH * vw) / vh));
  if (!scratch) scratch = document.createElement('canvas');
  if (scratch.width !== w || scratch.height !== targetH) { scratch.width = w; scratch.height = targetH; }
  const ctx = scratch.getContext('2d', { willReadFrequently: false });
  if (!ctx) return bail();

  const times = frameTimes(opts.clipInSec, opts.clipOutSec, count, dur);
  const queue = probeQueue;
  if (!queue) return bail();

  for (const t of times) {
    if (signal.aborted) return bail();
    // Re-arm the idle reaper on every frame, not just at the two ends of the run: a
    // 24-frame strip on a stalling asset can spend longer than PROBE_IDLE_MS inside
    // this loop, and a teardown mid-run strips the probe's src underneath us — every
    // remaining seek then times out and the whole strip is discarded.
    touchProbeIdle();
    const landed = await queue.seek(t, { signal });
    if (signal.aborted) return bail();
    if (landed === null && v.readyState < 2 /* HAVE_CURRENT_DATA */) return bail();
    try {
      ctx.clearRect(0, 0, w, targetH);
      ctx.drawImage(v, 0, 0, w, targetH);
      made.push(await createImageBitmap(scratch));
    } catch {
      // Tainted canvas (no CORS headers) or a decoder hiccup: give up on this
      // asset entirely rather than returning a half strip.
      return bail();
    }
    if (signal.aborted) return bail();
  }
  touchProbeIdle();
  return made;
}

/**
 * Frames from a video (or any seekable media) asset, for a clip bar's filmstrip.
 *
 * Resolves an EMPTY array — never throws — when the asset can't be decoded, the
 * signal aborts, CORS taints the canvas, or there is no DOM (headless).
 * The returned bitmaps are owned by this module's cache: do not close them.
 */
export function filmstrip(assetUrl: string, opts: FilmstripOpts, signal?: AbortSignal): Promise<ImageBitmap[]> {
  if (!assetUrl || !hasDom()) return Promise.resolve([]);
  const key = filmstripKey(assetUrl, opts);
  const hit = cache.get(key);
  if (Array.isArray(hit)) return Promise.resolve(hit);
  return share<ImageBitmap[]>(
    key,
    async (runSignal) => {
      const frames = await withProbe(() => captureFilmstrip(assetUrl, opts, runSignal));
      if (frames.length) cache.set(key, frames);
      return frames;
    },
    signal,
    [],
  );
}

// ── peaks ───────────────────────────────────────────────────────────────────

interface DecodeCtx {
  decodeAudioData(
    buffer: ArrayBuffer,
    ok?: (b: AudioBuffer) => void,
    fail?: (e: unknown) => void,
  ): Promise<AudioBuffer> | void;
}

let audioCtx: DecodeCtx | null = null;

/**
 * One pooled decode context. OfflineAudioContext is preferred: it needs no
 * output device, is never suspended by autoplay policy, and holds no hardware.
 */
function getDecodeCtx(): DecodeCtx | null {
  if (audioCtx) return audioCtx;
  const g = globalThis as unknown as {
    OfflineAudioContext?: new (ch: number, len: number, rate: number) => DecodeCtx;
    webkitOfflineAudioContext?: new (ch: number, len: number, rate: number) => DecodeCtx;
    AudioContext?: new () => DecodeCtx;
    webkitAudioContext?: new () => DecodeCtx;
  };
  const OAC = g.OfflineAudioContext || g.webkitOfflineAudioContext;
  const AC = g.AudioContext || g.webkitAudioContext;
  try {
    if (OAC) audioCtx = new OAC(1, 1, 44100);
    else if (AC) audioCtx = new AC();
  } catch {
    audioCtx = null;
  }
  return audioCtx;
}

function decode(ctx: DecodeCtx, buf: ArrayBuffer): Promise<AudioBuffer> {
  return new Promise((resolve, reject) => {
    let settled = false;
    // Callback form as well as the promise form — old Safari only has the former.
    const maybe = ctx.decodeAudioData(
      buf,
      (b) => { if (!settled) { settled = true; resolve(b); } },
      (e) => { if (!settled) { settled = true; reject(e); } },
    );
    if (maybe && typeof (maybe as Promise<AudioBuffer>).then === 'function') {
      (maybe as Promise<AudioBuffer>).then(
        (b) => { if (!settled) { settled = true; resolve(b); } },
        (e) => { if (!settled) { settled = true; reject(e); } },
      );
    }
  });
}

/**
 * Read a response body into memory, abandoning it the instant it exceeds `max`
 * bytes. `arrayBuffer()` cannot do this — it buffers the WHOLE body first, so a
 * chunked/CDN response with no Content-Length would allocate a 500 MB asset in full
 * before the size check downstream could refuse it, which is the larger allocation of
 * the two this module is defending against. Returns null when the body is oversized,
 * aborted, or unreadable. Falls back to `arrayBuffer()` only where streams are
 * unavailable (no `body` — e.g. a polyfilled/test fetch).
 */
export interface BoundedBody {
  body?: { getReader?: () => ReadableStreamDefaultReader<Uint8Array> } | null;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export async function readBounded(res: BoundedBody, max: number, signal?: { aborted: boolean }): Promise<ArrayBuffer | null> {
  const reader = res.body?.getReader?.();
  if (!reader) {
    const whole = await res.arrayBuffer();
    return whole.byteLength <= max ? whole : null;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const giveUp = async (): Promise<null> => {
    try { await reader.cancel(); } catch { /* already closed */ }
    return null;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > max || signal?.aborted) return await giveUp();
      chunks.push(value);
    }
  } catch {
    return await giveUp();
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.byteLength; }
  return out.buffer as ArrayBuffer;
}

async function computePeaks(url: string, buckets: number, signal: AbortSignal): Promise<Float32Array> {
  const ctx = getDecodeCtx();
  if (!ctx || typeof fetch !== 'function') return EMPTY_PEAKS;
  try {
    const res = await fetch(url, { signal });
    if (!res.ok || signal.aborted) return EMPTY_PEAKS;
    // Refuse before reading the body when the server tells us it is too big.
    const declared = Number(res.headers?.get?.('content-length') ?? Number.NaN);
    if (!withinDecodeBudget(Number.isFinite(declared) ? declared : null)) return EMPTY_PEAKS;
    // And bound the read itself, so a chunked/unlabelled response is abandoned at the
    // ceiling instead of being buffered whole and refused afterwards.
    const buf = await readBounded(res, MAX_AUDIO_DECODE_BYTES, signal);
    if (!buf || signal.aborted) return EMPTY_PEAKS;
    if (!withinDecodeBudget(buf.byteLength)) return EMPTY_PEAKS;
    const audio = await decode(ctx, buf);
    if (signal.aborted) return EMPTY_PEAKS;
    const channels: Float32Array[] = [audio.getChannelData(0)];
    if (audio.numberOfChannels > 1) channels.push(audio.getChannelData(1));
    return bucketPeaks(channels, buckets);
  } catch {
    return EMPTY_PEAKS; // undecodable / offline / aborted — the bar keeps its plain fill
  }
}

/**
 * Peak envelope (0..1 per bucket) for a pure-audio asset, for a waveform bar.
 *
 * Video-clip audio is phase 3 (it needs AudioBufferSink) — pass audio files only.
 * Resolves an EMPTY Float32Array — never throws — when the asset is undecodable,
 * larger than MAX_AUDIO_DECODE_BYTES, aborted, or Web Audio is unavailable.
 * The returned array is owned by this module's cache: do not mutate it.
 */
export function peaks(audioUrl: string, buckets: number, signal?: AbortSignal): Promise<Float32Array> {
  if (!audioUrl) return Promise.resolve(EMPTY_PEAKS);
  const key = peaksKey(audioUrl, buckets);
  const hit = cache.get(key);
  if (hit && !Array.isArray(hit)) return Promise.resolve(hit);
  return share<Float32Array>(
    key,
    async (runSignal) => {
      const out = await computePeaks(audioUrl, buckets, runSignal);
      if (out.length) cache.set(key, out);
      return out;
    },
    signal,
    EMPTY_PEAKS,
  );
}
