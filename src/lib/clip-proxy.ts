// SPDX-License-Identifier: MPL-2.0
/**
 * clip-proxy.ts — import-time scrub proxies for uploaded video clips
 * (Fable timeline, phase 4 Track A of plans/55-fable-timeline-phase-4.md).
 *
 * THE PROBLEM. Scrubbing a timeline is a random-access seek per pointer move,
 * and a seek costs "decode every frame from the previous keyframe". A phone
 * camera or a screen recorder happily ships a 5–10 second GOP, so one scrub step
 * can mean 150–300 frame decodes at 1080p. Safari is worst hit (it also cancels
 * a seek issued while another is in flight — see lib/clip-thumbs.ts), but no
 * engine is fast at it. Nothing downstream can fix this: the cost is baked into
 * the container's keyframe density.
 *
 * THE FIX, ONCE, AT INGEST. When a clip is uploaded we transcode a companion
 * copy — 720p long edge, one keyframe every ~0.5 s — and keep it as DERIVED data
 * next to the asset. Every *preview* consumer (filmstrips, waveforms, the scrub
 * clock) reads the proxy when one exists; a scrub then decodes at most ~15 small
 * frames instead of a few hundred big ones.
 *
 * THE NON-NEGOTIABLE RULE: **EXPORT ALWAYS USES THE ORIGINAL.** A proxy is a
 * lossy, downscaled, re-encoded artefact. It exists to make a pointer feel fast
 * and must never reach an exported frame. Three things enforce that here:
 *
 *   1. The proxy is NOT reachable through `host.assets.get(id)`. It lives in its
 *      own IDB store under its own key and is resolved by this module alone —
 *      the engine's `resolveAssetRefs` (the single asset-resolution path both
 *      preview and export share) cannot see it.
 *   2. The proxy URL is never written onto the live `<video>` element's `src`.
 *      `sequence-render.ts:mediaUrl()` and `export.ts` read that attribute off
 *      the mounted DOM, so leaving it alone is what keeps export honest.
 *   3. `clip-proxy.test.ts` carries a source guard that walks the WHOLE of
 *      shells/web/src and fails on any file that mentions this feature and is not
 *      on its declared-consumer list — so a new export module is a failure by
 *      construction, not by somebody remembering to add it. If a future change
 *      *needs* the swap on the element, the swap must stamp `data-original-src`
 *      and the export-side read must prefer it — see the report at the foot of
 *      this header.
 *
 * WHAT LIVES NEXT DOOR. The synchronous, memory-only half — the url→id registry,
 * the proxy object-URL cache and the "no proxy" memo, all bounded and revoking —
 * is `./scrub-registry.ts`. It is split out so `bridge/assets.ts` can register a
 * pairing on a hot path without dragging this module (and the `import('mediabunny')`
 * site in it) into the first-paint graph.
 *
 * ACCEPTING AN OUTPUT IS NOT AUTOMATIC. Three things are checked before a
 * transcode is kept, and each one is a real failure mode rather than a formality:
 * it must be SMALLER than the source (otherwise it is a worse deal on every
 * axis); it must not be SHORT (truncation is silent — a proxy that ended early is
 * a complete-looking container that would spread a clip's first seconds across
 * the whole filmstrip); and whether it still carries AUDIO is recorded, because a
 * proxy re-containered into WebM cannot hold an AAC track and a waveform read off
 * it would draw flat silence over a clip that exports with sound.
 *
 * ONE AT A TIME, AND CANCELLABLE. Builds run through a single-slot FIFO queue and
 * every one of them — queued or running — is abortable, wired to `pagehide`. An
 * idle callback is not a concurrency limit, and a 9-minute source is inside the
 * ceilings: without both, a five-file drop would open five decoder/encoder pairs
 * at once and navigating away would leave them running to completion.
 *
 * ROUTE TAKEN FOR KEYFRAME DENSITY: mediabunny's `Conversion` API, whose
 * `ConversionVideoOptions.keyFrameInterval` controls GOP length directly
 * ("Setting this field forces a transcode" — exactly what a proxy build is).
 * The manual decode→re-encode fallback the spec allowed for is therefore NOT
 * used: `Conversion` already owns the decode/encode/mux pipeline, and hand-
 * rolling it through video-encode-core would duplicate that for no gain and put
 * VideoSample lifetimes back in our hands. Because no sample ever crosses this
 * module's boundary, the phase-3 "at most 2 in flight, closed in the same tick"
 * rule has nothing to bind to here — it is `Conversion`'s internal business.
 * The phase-3 rules that DO bind are honoured: `computeDuration()` is used for
 * the skip probe (never `getDurationFromMetadata()`, which can be a header lie),
 * every failure is normalised through `toCodedError`, and mediabunny is lazily
 * imported with the explicit format singletons only — never `ALL_FORMATS`.
 *
 * FAILURE POLICY: nothing in this module ever throws into its caller. A proxy is
 * an optimisation; a browser without WebCodecs, a codec the encoder refuses, a
 * full disk, a wedged database — every one of them resolves to "no proxy" and
 * the app behaves exactly as it did before this file existed.
 *
 * STORAGE. One row per asset in the `derived-media` IDB store (db.ts v8), keyed
 * `<assetId>:proxy`. It is derived, evictable and regenerable, so — like
 * `asset-blob` and `generated-previews` — it is NOT in `REQUIRED_STORES` and NOT
 * in the portable backup. Its bytes are folded into the storage meter's "Asset
 * cache" slice (profile.ts), whose copy already reads "Downloaded catalog
 * content; it re-downloads on demand. Safe to clear." — so the meter stays
 * honest (no unlabelled growth in "Other") and "Clear cache" already evicts it.
 * `_deleteUserAsset` drops the row with the source asset.
 *
 * REPORTED, NOT DONE (concurrent-workflow ownership): the *preview element* swap.
 * `views/timeline-panel.ts:mediaOf()`, `views/free-canvas.ts` (where boxes mount)
 * and `bridge/sequence-render.ts:mediaUrl()` are owned by another workflow, so
 * this module only swaps the URL inside `lib/clip-thumbs.ts` (filmstrips and
 * waveforms). The sequence *clock's* element pool still scrubs the original.
 * See the "Track A follow-up" note in clip-proxy.test.ts for the exact one-line
 * change each of those files needs, and the `data-original-src` rule that must
 * land in the same commit as any element-level swap.
 */

import { toCodedError, type CodedError } from '../bridge/sequence-plan.ts';
import {
  clearNoProxy, isKnownNoProxy, markNoProxy, proxyUrlFor, revokeProxyUrl, setProxyUrl,
  resetScrubCache as resetRegistry, scrubSourceId,
} from './scrub-registry.ts';

// The synchronous, memory-only half of this feature lives in ./scrub-registry.ts
// (see its header for why it is split out). Re-exported here so every consumer
// still has ONE import site for "the proxy feature", and so the source guard in
// clip-proxy.test.ts can police both halves as one surface.
export {
  noteScrubSource, scrubSourceId, peekScrubUrl, revokeProxyUrl,
  SCRUB_REGISTRY_LIMIT, PROXY_URL_LIMIT,
} from './scrub-registry.ts';

// ── tunables (skip thresholds — see shouldBuildProxy) ───────────────────────

/** Long edge of a proxy, px. 720p is the smallest size that still reads as the
 *  real picture in a filmstrip and on a preview canvas. */
export const PROXY_LONG_EDGE = 720;
/** Keyframe interval of a proxy, seconds. ~0.5 s ⇒ ≤15 frames of decode per seek. */
export const PROXY_KEYFRAME_SEC = 0.5;
/** Target proxy video bitrate, bits/s. Generous for 720p; it is never exported. */
export const PROXY_BITRATE = 2_000_000;

/** Below this duration a whole clip is a couple of GOPs anyway — skip. */
export const MIN_PROXY_DURATION_SEC = 8;
/** Below this size the source is already cheap to seek — skip. */
export const MIN_PROXY_BYTES = 3 * 1024 * 1024;
/** Below this long edge the frames decode so fast that GOP density buys nothing. */
export const MIN_PROXY_LONG_EDGE = 640;
/** Defensive ceiling. The picker caps uploads at 15 MB; this leaves headroom for
 *  other callers without ever letting a background job chew a 500 MB file. */
export const MAX_PROXY_SOURCE_BYTES = 64 * 1024 * 1024;
/** Defensive ceiling on length — a background transcode must stay a background job. */
export const MAX_PROXY_DURATION_SEC = 600;
/**
 * Don't write a proxy if doing so would push the origin past this share of quota.
 *
 * DELIBERATELY BELOW the assets bridge's own `QUOTA_SAFETY_FRACTION` (0.9). These
 * are two different kinds of byte: a user's upload is irreplaceable data they
 * asked to keep, a proxy is derived, regenerable and invisible. At equal ceilings
 * a background transcode could consume the last of the quota and make the user's
 * NEXT upload fail with "Not enough local storage space" — a real failure caused
 * entirely by an optimisation nobody asked for. The gap is the margin that can
 * never be eaten by derived data.
 */
export const PROXY_QUOTA_FRACTION = 0.7;
/**
 * How far a proxy's own measured duration may fall short of its source's before
 * it is rejected. Truncation is silent (phase 3 rule 7): a proxy that ends early
 * is a complete-looking container that would spread the first few seconds of a
 * clip across the whole filmstrip bar, with no error anywhere. Absolute floor for
 * short clips, proportional above it.
 */
export const PROXY_DURATION_TOLERANCE_SEC = 0.25;
export const PROXY_DURATION_TOLERANCE_FRACTION = 0.01;

// ── keys + record shape ─────────────────────────────────────────────────────

/** The IDB store this module owns. Created at DB_VERSION 8 (bridge/db.ts). */
export const PROXY_STORE = 'derived-media';

/**
 * The row key for an asset's proxy.
 *
 * ONE row per asset on purpose: a rebuild overwrites in place, so a regenerated
 * proxy can never leave an orphan behind (a key that mixed in a source
 * fingerprint would strand the previous row forever).
 */
export function proxyKey(assetId: string): string {
  return `${assetId}:proxy`;
}

/** What a `derived-media` row holds. `srcBytes` is the invalidation fingerprint. */
export interface ProxyRecord {
  key: string;
  assetId: string;
  kind: 'proxy';
  blob: Blob;
  /** Byte length of the source this was built from — see proxyMatchesSource. */
  srcBytes: number;
  /** Proxy pixel dimensions (informational; the filmstrip re-derives its own). */
  w: number;
  h: number;
  /**
   * Did the transcode keep an audio track?
   *
   * A proxy is re-containered into whatever the browser can encode, and an AAC
   * source track cannot ride in WebM — mediabunny then discards it and the
   * conversion is still perfectly valid. A waveform read off such a proxy would
   * be flat silence over a clip that exports with sound, so the fact travels with
   * the row and `peekScrubUrl(url, { audio: true })` refuses the swap.
   * Rows written before this field existed read as `undefined`, which is treated
   * as "unknown ⇒ don't trust it for audio".
   */
  hasAudio?: boolean;
  createdAt: number;
}

/**
 * Is a stored proxy still the right one for this source?
 *
 * Uploads mint a fresh id per file (`user/upload/<ts>-<name>`), so "the source
 * was replaced" normally means "a different id", which can't collide. The one
 * path that reuses an id is a rewrite of an existing record, so the source's
 * byte length is kept as a cheap fingerprint and checked whenever the caller has
 * it to hand. A caller that doesn't know the size (the scrub read path, which
 * only has a URL) passes `undefined` and accepts the row.
 */
export function proxyMatchesSource(rec: Pick<ProxyRecord, 'srcBytes'>, srcBytes?: number): boolean {
  if (srcBytes == null || !Number.isFinite(srcBytes)) return true;
  return rec.srcBytes === srcBytes;
}

// ── the skip decision (pure) ────────────────────────────────────────────────

/** What `shouldBuildProxy` needs to know about a source clip. */
export interface ProxyProbe {
  bytes: number;
  durationSec: number;
  width: number;
  height: number;
}

/** Why a proxy was skipped. `null` means "build it". */
export type ProxySkipReason =
  | 'too-short'
  | 'too-small'
  | 'too-low-res'
  | 'too-large'
  | 'too-long'
  | 'unreadable';

/**
 * The skip ladder, pure and ordered so the reason is stable.
 *
 * A proxy has to pay for itself: it costs a transcode now, disk forever, and it
 * is worthless if the source was already cheap to scrub. The thresholds are
 * deliberate, not tuned — the useful window on this platform is a 3–15 MB,
 * ≥8 s, ≥640 px upload, which is exactly the phone-clip / screen-recording shape
 * that ships a multi-second GOP.
 */
export function proxySkipReason(p: ProxyProbe): ProxySkipReason | null {
  const { bytes, durationSec, width, height } = p;
  if (!Number.isFinite(bytes) || bytes <= 0) return 'unreadable';
  if (!Number.isFinite(durationSec) || durationSec <= 0) return 'unreadable';
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 'unreadable';
  if (bytes > MAX_PROXY_SOURCE_BYTES) return 'too-large';
  if (durationSec > MAX_PROXY_DURATION_SEC) return 'too-long';
  if (durationSec < MIN_PROXY_DURATION_SEC) return 'too-short';
  if (bytes < MIN_PROXY_BYTES) return 'too-small';
  if (Math.max(width, height) < MIN_PROXY_LONG_EDGE) return 'too-low-res';
  return null;
}

/** Convenience predicate over `proxySkipReason`. */
export function shouldBuildProxy(p: ProxyProbe): boolean {
  return proxySkipReason(p) === null;
}

/**
 * Output dimensions for a proxy: long edge clamped to PROXY_LONG_EDGE, aspect
 * preserved, both edges even (encoders reject odd dimensions for 4:2:0 chroma)
 * and never zero. A source already at or under the target is passed through
 * unscaled — it is here for the keyframes, not the pixels.
 */
export function proxyDimensions(width: number, height: number): { width: number; height: number } {
  const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2);
  const long = Math.max(width, height);
  if (!Number.isFinite(long) || long <= 0) return { width: PROXY_LONG_EDGE, height: PROXY_LONG_EDGE };
  const scale = long > PROXY_LONG_EDGE ? PROXY_LONG_EDGE / long : 1;
  return { width: even(width * scale), height: even(height * scale) };
}

// ── the storage seam ────────────────────────────────────────────────────────

/**
 * The three operations this module needs from IndexedDB.
 *
 * A seam, not a second storage abstraction: the default implementation is the
 * ONE shared `openDB()` connection from bridge/db.ts (the same pattern
 * lib/trustmark.ts uses for its model cache). It exists so the headless tests
 * can exercise the real read/write/evict logic without an IDB implementation,
 * and so a browser with a wedged database degrades to "no proxy" instead of
 * throwing on import.
 */
export interface ProxyStore {
  get(key: string): Promise<ProxyRecord | undefined>;
  put(rec: ProxyRecord): Promise<void>;
  delete(key: string): Promise<void>;
  all(): Promise<ProxyRecord[]>;
}

let storeOverride: ProxyStore | null = null;
let realStore: Promise<ProxyStore | null> | null = null;

/** Inject a store (tests). Passing `null` restores the IndexedDB-backed one. */
export function setProxyStore(store: ProxyStore | null): void {
  storeOverride = store;
  realStore = null;
}

async function openProxyStore(): Promise<ProxyStore | null> {
  if (storeOverride) return storeOverride;
  if (!realStore) {
    realStore = (async (): Promise<ProxyStore | null> => {
      try {
        // Dynamic on purpose: keeps `idb` (and the whole bridge) off this
        // module's static import graph, so the pure logic above is importable
        // in a plain node test run.
        const { openDB } = await import('../bridge/db.ts');
        const db = await openDB();
        if (!db.objectStoreNames.contains(PROXY_STORE)) return null;
        return {
          get: (key) => db.get(PROXY_STORE, key) as Promise<ProxyRecord | undefined>,
          put: async (rec) => { await db.put(PROXY_STORE, rec); },
          delete: async (key) => { await db.delete(PROXY_STORE, key); },
          all: () => db.getAll(PROXY_STORE) as Promise<ProxyRecord[]>,
        };
      } catch {
        return null; // no DB → no proxies, and nothing else changes
      }
    })();
  }
  return realStore;
}

// ── the mediabunny seam ─────────────────────────────────────────────────────

/** What a probe can tell us about a container. */
export interface ProxyMeasure {
  durationSec: number;
  width: number;
  height: number;
  /** Does the container carry an audio track at all? */
  hasAudio?: boolean;
}

/**
 * What a transcode produced.
 *
 * The blob alone is not enough to accept a proxy. Phase 3's rule 7 is that
 * TRUNCATION IS SILENT — a decode that ends early yields a clean, complete-looking
 * short container with no error anywhere — so the output's own measured duration
 * has to come back and be checked against the source's.
 */
export interface ProxyOutput {
  blob: Blob;
  /** The output's OWN measured duration (`computeDuration`), or 0 when unmeasured. */
  durationSec: number;
  /** Did the output keep an audio track? */
  hasAudio: boolean;
}

/** What a converter must do: bytes in, keyframe-dense 720p bytes out (or null). */
export interface ProxyConverter {
  /** Probe the source. Returns null when it can't be read at all. */
  probe(source: Blob): Promise<ProxyMeasure | null>;
  /** Transcode. Returns null when no encodable codec is available. */
  convert(
    source: Blob,
    plan: { width: number; height: number },
    opts?: { signal?: AbortSignal },
  ): Promise<ProxyOutput | null>;
}

let converterOverride: ProxyConverter | null = null;

/** Inject a converter (tests). Passing `null` restores the mediabunny one. */
export function setProxyConverter(c: ProxyConverter | null): void {
  converterOverride = c;
}

/**
 * The ONE place mediabunny is loaded in this module.
 *
 * Named members only, and only the container singletons we accept — never
 * `ALL_FORMATS`, which drags MP3/WAVE/Ogg/FLAC/ADTS/TS/HLS along (the same rule
 * bridge/sequence-providers.ts states and guards).
 */
async function mediabunnyConverter(): Promise<ProxyConverter> {
  // Literal specifier: a variable here would defeat Vite's chunking.
  const m = await import('mediabunny');
  const formats = [m.MP4, m.QTFF, m.WEBM, m.MATROSKA];

  const openInput = (source: Blob): InstanceType<typeof m.Input> =>
    new m.Input({ formats, source: new m.BlobSource(source) });

  const measure = async (source: Blob): Promise<ProxyMeasure | null> => {
    const input = openInput(source);
    try {
      const track = await input.getPrimaryVideoTrack();
      if (!track) return null;
      // computeDuration(), never getDurationFromMetadata(): the header can lie
      // (a truncated container still claims its original length), and the skip
      // ladder must not be fooled into transcoding a 3-second file forever.
      const durationSec = await input.computeDuration();
      const audio = await input.getPrimaryAudioTrack().catch(() => null);
      return {
        durationSec,
        width: track.displayWidth,
        height: track.displayHeight,
        hasAudio: !!audio,
      };
    } finally {
      // ALWAYS dispose: an Input holds a demuxer over a BlobSource, and the early
      // `return null` paths above are exactly the ones that used to strand one.
      try { await input.dispose?.(); } catch { /* already disposed */ }
    }
  };

  return {
    probe: measure,

    async convert(source, plan, opts = {}) {
      const codec = await m.getFirstEncodableVideoCodec(['vp8', 'avc', 'vp9'], {
        width: plan.width,
        height: plan.height,
        bitrate: PROXY_BITRATE,
      });
      if (!codec) return null;
      // WebM/VP8 is the first choice (it is the widest-supported encode target in
      // WebCodecs and seeks well with dense keyframes); an H.264 answer means the
      // browser only offered AVC, which has to ride in MP4.
      const isMp4 = codec === 'avc';
      const target = new m.BufferTarget();
      const output = new m.Output({
        format: isMp4 ? new m.Mp4OutputFormat() : new m.WebMOutputFormat(),
        target,
      });
      const input = openInput(source);
      let conversion: Awaited<ReturnType<typeof m.Conversion.init>> | null = null;
      let onAbort: (() => void) | null = null;
      try {
        conversion = await m.Conversion.init({
          input,
          output,
          video: {
            width: plan.width,
            height: plan.height,
            fit: 'contain',
            codec,
            bitrate: PROXY_BITRATE,
            // The whole point of the proxy. Forces a transcode, by design.
            keyFrameInterval: PROXY_KEYFRAME_SEC,
          },
          // Audio rides along, but it is NOT guaranteed to survive: an AAC track
          // cannot be contained in WebM, and `isValid` stays true when the video
          // track alone makes a valid file. `discardedTracks` is the only place
          // that fact is stated, so it is read rather than assumed.
          showWarnings: false,
        });
        if (!conversion.isValid) return null;
        // Cancellation is the difference between "a background job" and "a
        // decoder+encoder pair that keeps running after the user navigated away".
        const c = conversion;
        if (opts.signal) {
          if (opts.signal.aborted) return null;
          onAbort = (): void => { void c.cancel().catch(() => { /* already done */ }); };
          opts.signal.addEventListener('abort', onAbort, { once: true });
        }
        const lostAudio = c.discardedTracks.some((d) => d.track?.type === 'audio');
        await c.execute();
        const buf = target.buffer;
        if (!buf) return null;
        const blob = new Blob([buf], { type: isMp4 ? 'video/mp4' : 'video/webm' });
        // Measure what we actually produced. `measure` opens its own Input over
        // the output bytes, so a short container reports its real length here even
        // though nothing threw during the transcode.
        const out = await measure(blob).catch(() => null);
        return {
          blob,
          durationSec: out?.durationSec ?? 0,
          hasAudio: !lostAudio && (out?.hasAudio ?? false),
        };
      } finally {
        if (onAbort) opts.signal?.removeEventListener('abort', onAbort);
        try { await input.dispose?.(); } catch { /* already disposed */ }
      }
    },
  };
}

async function getConverter(): Promise<ProxyConverter | null> {
  if (converterOverride) return converterOverride;
  try {
    return await mediabunnyConverter();
  } catch {
    return null;
  }
}

// ── quota ───────────────────────────────────────────────────────────────────

/**
 * A proxy is a nicety; it must never be the write that fills the disk. Mirrors
 * the assets bridge's `assertQuotaRoom` fraction, but refuses silently rather
 * than throwing — nobody asked for this write.
 */
async function hasRoomFor(bytes: number): Promise<boolean> {
  try {
    // `globalThis.navigator`, not a bare `navigator`: optional chaining does not
    // save you from an UNDECLARED identifier, and this module is imported in
    // environments (node tests, a worker) that may not have one.
    const est = await globalThis.navigator?.storage?.estimate?.();
    if (!est || !est.quota) return true; // can't estimate → let IDB be the backstop
    return (est.usage ?? 0) + bytes <= est.quota * PROXY_QUOTA_FRACTION;
  } catch {
    return true;
  }
}

// ── build ───────────────────────────────────────────────────────────────────

/** Optional wiring for `ensureProxy` — all of it has a working default. */
export interface EnsureProxyOpts {
  /** Skip the mediabunny probe when the caller already measured the source. */
  hint?: Partial<ProxyProbe>;
  /** Rebuild even if a matching row already exists (the regenerate action). */
  force?: boolean;
  /** Diagnostics. Never a user-facing surface — a proxy failing is not an error. */
  log?: (level: 'info' | 'warn', message: string, detail?: unknown) => void;
  /** Cancel an in-flight transcode. Also honoured while queued. */
  signal?: AbortSignal;
}

/**
 * ONE transcode at a time, process-wide.
 *
 * A multi-file drop schedules N proxy builds in the same idle period, and an idle
 * callback is not a concurrency limit: five 64 MB sources would open five
 * decoder/encoder pairs and five whole output buffers at once, which is precisely
 * the "don't queue transcodes in front of the UI" outcome the scheduling was
 * supposed to buy. The queue is a plain promise chain — FIFO, never rejecting,
 * and each link is already wrapped so one failure cannot stall the next.
 */
let proxyQueue: Promise<unknown> = Promise.resolve();
/** In-flight + queued builds, so a teardown can cancel every one of them. */
const inFlight = new Set<AbortController>();

function enqueue<T>(run: () => Promise<T>, fallback: T): Promise<T> {
  const next = proxyQueue.then(run, run).catch(() => fallback);
  proxyQueue = next;
  return next;
}

/**
 * Cancel every queued and in-flight proxy build.
 *
 * A 9-minute source is inside the ceilings, so "the user navigated away" must not
 * leave a decoder/encoder pair running to completion for a proxy nobody will look
 * at. Wire this to teardown and `pagehide`.
 */
export function abortProxyBuilds(): void {
  for (const c of [...inFlight]) { try { c.abort(); } catch { /* already aborted */ } }
  inFlight.clear();
}

const noteFailure = (log: EnsureProxyOpts['log'], what: string, err: unknown): null => {
  let coded: CodedError;
  try { coded = toCodedError(err); } catch { coded = { code: 'SEQ_DECODE_FAILED', message: String(err) }; }
  log?.('warn', `[clip-proxy] ${what}: ${coded.code} ${coded.message}`);
  return null;
};

/**
 * Build (or reuse) the scrub proxy for one uploaded clip.
 *
 * Returns the proxy blob, or `null` when there shouldn't be one — a source below
 * the skip thresholds, an unreadable container, no encodable codec, no storage
 * room, no database. **Never throws**: the caller is a fire-and-forget idle job
 * behind a successful upload and must not be able to fail it.
 */
export function ensureProxy(assetId: string, bytes: Blob, opts: EnsureProxyOpts = {}): Promise<Blob | null> {
  if (!assetId || !bytes || !(bytes.size > 0)) return Promise.resolve(null);
  armPageHide();
  // The controller is minted HERE, not when the job reaches the front of the
  // queue: a build that is still queued must be cancellable too, or a teardown
  // would only stop the one transcode that happens to be running and let four
  // more start behind it.
  const ctl = new AbortController();
  if (opts.signal) {
    if (opts.signal.aborted) return Promise.resolve(null);
    opts.signal.addEventListener('abort', () => ctl.abort(), { once: true });
  }
  inFlight.add(ctl);
  return enqueue(async () => {
    try {
      if (ctl.signal.aborted) return null;
      return await buildProxyInner(assetId, bytes, opts, ctl.signal, opts.log);
    } finally {
      inFlight.delete(ctl);
    }
  }, null);
}

/**
 * Cancel builds when the page goes away.
 *
 * Installed on first use rather than at import: this module is lazily imported,
 * and a listener that only matters once a transcode exists should not be a side
 * effect of loading the file. `pagehide` (not `unload`) is the event that fires
 * on the bfcache path too.
 */
let pageHideArmed = false;
function armPageHide(): void {
  if (pageHideArmed) return;
  pageHideArmed = true;
  try {
    globalThis.addEventListener?.('pagehide', () => abortProxyBuilds(), { once: false });
  } catch { /* no event target (node tests, a worker) */ }
}

async function buildProxyInner(
  assetId: string, bytes: Blob, opts: EnsureProxyOpts,
  signal: AbortSignal, log: EnsureProxyOpts['log'],
): Promise<Blob | null> {
  const store = await openProxyStore();
  const key = proxyKey(assetId);

  if (store && !opts.force) {
    try {
      const existing = await store.get(key);
      if (existing?.blob && proxyMatchesSource(existing, bytes.size)) return existing.blob;
      // A row built from different bytes is stale — drop it before rebuilding so
      // a failed rebuild can't leave the wrong picture behind.
      if (existing) await store.delete(key);
    } catch (err) {
      noteFailure(log, `read ${key}`, err);
    }
  }

  const converter = await getConverter();
  if (!converter) return null;

  let probe: ProxyProbe;
  try {
    const hint = opts.hint ?? {};
    const measured = (hint.durationSec != null && hint.width != null && hint.height != null)
      ? { durationSec: hint.durationSec, width: hint.width, height: hint.height }
      : await converter.probe(bytes);
    if (!measured) return null;
    probe = { bytes: bytes.size, ...measured };
  } catch (err) {
    return noteFailure(log, `probe ${assetId}`, err);
  }

  const skip = proxySkipReason(probe);
  if (skip) {
    log?.('info', `[clip-proxy] skipped ${assetId}: ${skip}`);
    return null;
  }

  if (signal.aborted) return null;
  const plan = proxyDimensions(probe.width, probe.height);
  let out: ProxyOutput | null;
  try {
    out = await converter.convert(bytes, plan, { signal });
  } catch (err) {
    return noteFailure(log, `transcode ${assetId}`, err);
  }
  if (signal.aborted) return null;
  const proxy = out?.blob ?? null;
  if (!out || !proxy || proxy.size <= 0) return null;
  // A "proxy" no smaller than the source is a worse deal on every axis (same
  // decode cost, extra bytes) — throw it away rather than store it.
  if (proxy.size >= bytes.size) {
    log?.('info', `[clip-proxy] discarded ${assetId}: proxy (${proxy.size}B) not smaller than source (${bytes.size}B)`);
    return null;
  }
  // A SHORT proxy is the dangerous output, because nothing about it looks wrong:
  // the filmstrip would spread the clip's first few seconds across the whole bar.
  // Only reject on a MEASURED shortfall — a converter that cannot measure its own
  // output reports 0, and an unmeasured proxy is no worse than the old behaviour.
  if (out.durationSec > 0) {
    const tolerance = Math.max(PROXY_DURATION_TOLERANCE_SEC, probe.durationSec * PROXY_DURATION_TOLERANCE_FRACTION);
    if (probe.durationSec - out.durationSec > tolerance) {
      log?.('warn', `[clip-proxy] discarded ${assetId}: proxy is ${out.durationSec.toFixed(2)}s of a ${probe.durationSec.toFixed(2)}s source — the transcode ended early`);
      return null;
    }
  }

  if (store && await hasRoomFor(proxy.size)) {
    try {
      await store.put({
        key, assetId, kind: 'proxy', blob: proxy,
        srcBytes: bytes.size, w: plan.width, h: plan.height,
        hasAudio: out.hasAudio, createdAt: Date.now(),
      });
    } catch (err) {
      noteFailure(log, `write ${key}`, err); // built but unstored: still usable now
    }
  }
  // The proxy now EXISTS, so any "this asset has no proxy" memo taken while the
  // transcode was running is a lie. Clearing it is what lets the clip that was
  // dropped on the timeline mid-build pick the proxy up on its next capture —
  // without this the very upload the feature exists for never uses its own proxy.
  clearNoProxy(assetId);
  revokeProxyUrl(assetId);   // a rebuild (force) must not leave the OLD url primed
  return proxy;
}

// ── read + evict ────────────────────────────────────────────────────────────

/** The stored proxy for an asset, or null. Never throws. */
export async function getProxy(assetId: string, srcBytes?: number): Promise<Blob | null> {
  const store = await openProxyStore();
  if (!store) return null;
  try {
    const rec = await store.get(proxyKey(assetId));
    if (!rec?.blob) return null;
    return proxyMatchesSource(rec, srcBytes) ? rec.blob : null;
  } catch {
    return null;
  }
}

/** Drop an asset's proxy (source deleted or replaced). Never throws. */
export async function deleteProxy(assetId: string): Promise<void> {
  revokeProxyUrl(assetId);
  const store = await openProxyStore();
  if (!store) return;
  try { await store.delete(proxyKey(assetId)); } catch { /* nothing to drop */ }
}

/** Total derived bytes, for the storage meter. 0 when unavailable. */
export async function derivedMediaSize(): Promise<number> {
  const store = await openProxyStore();
  if (!store) return 0;
  try {
    const all = await store.all();
    return all.reduce((sum, r) => sum + (r?.blob?.size ?? 0), 0);
  } catch {
    return 0;
  }
}

// ── the preview-side URL swap ───────────────────────────────────────────────
//
// The maps themselves live in ./scrub-registry.ts (bounded, revoking, and free of
// this module's IO). What stays here is the one operation that needs the database:
// turning a stored proxy into an object URL the synchronous `peekScrubUrl` can
// hand back.

/** A record read, kept next to the blob so the audio fact travels with it. */
async function readProxyRecord(assetId: string): Promise<ProxyRecord | null> {
  const store = await openProxyStore();
  if (!store) return null;
  try {
    const rec = await store.get(proxyKey(assetId));
    return rec?.blob ? rec : null;
  } catch {
    return null;
  }
}

/** In-flight primes, so N bars asking at once cause ONE database read. */
const priming = new Map<string, Promise<string | null>>();

/**
 * Load the proxy for a media URL and mint its object URL, so the next
 * `peekScrubUrl` returns it. Resolves the proxy URL, or null when there is no
 * proxy (a fact that is then remembered). Never throws.
 */
export function primeScrubUrl(mediaUrl: string): Promise<string | null> {
  const id = scrubSourceId(mediaUrl);
  if (!id) return Promise.resolve(null);
  const already = proxyUrlFor(id);
  if (already) return Promise.resolve(already);
  if (isKnownNoProxy(id)) return Promise.resolve(null);
  const inflight = priming.get(id);
  if (inflight) return inflight;

  const run = (async (): Promise<string | null> => {
    const rec = await readProxyRecord(id);
    if (!rec) { markNoProxy(id); return null; }
    if (typeof URL?.createObjectURL !== 'function') return null;
    const url = URL.createObjectURL(rec.blob);
    setProxyUrl(id, url, rec.hasAudio === true);
    return url;
  })().catch(() => null).finally(() => { priming.delete(id); });

  priming.set(id, run);
  return run;
}

/** Drop every cached URL + registry entry, and cancel any build (teardown, tests). */
export function resetScrubCache(): void {
  abortProxyBuilds();
  resetRegistry();
  priming.clear();
}
