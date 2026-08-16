// SPDX-License-Identifier: MPL-2.0
/**
 * Hook Worker (M2, plans/86-worker-isolation-hooks.md §13.1) - the DOM-free
 * executor that runs a tool's hooks.js OFF the main thread.
 *
 * A hook is compiled here with `new Function('host', src)` exactly as the
 * in-realm path does, but the `host` it receives is a PROXY:
 *   - Bucket A (color, geom, tokens, log) is CO-LOCATED - built right here from
 *     the pure engine modules + a snapshot of the brand token doc, so a hook's
 *     `host.color.distinct(...)` / `host.tokens.resolve(...)` never leaves the
 *     worker (the whole point - sync APIs cost ~0 across the boundary).
 *   - Bucket B (assets, profile, state, export, net, …) is PROXIED: each call
 *     posts a `host-call` to the main thread and awaits the reply, so the hook's
 *     `await host.assets.get(id)` is unchanged - an awaited RPC is an awaited RPC.
 *   - Bucket C (media/recorder/audio/viz.isAvailable, …) is SEEDED with the value
 *     the main thread computed, because those read globals a worker lacks.
 *
 * The pure core (`createHookWorkerCore`) takes an injected `port` and never
 * touches `postMessage`/`addEventListener`, so it is unit-testable in plain Node
 * with a stub port + a mock host dispatcher (see hook-worker.test.ts), mirroring
 * sequence-render.worker.ts's `handleStart`/`createRunRegistry` seam.
 */
import { makeColorApi } from '../../../../engine/src/color-tools.ts';
import { makeGeomApi } from '../../../../engine/src/geom-api.ts';
import { createTokenSet, aliasPath } from '../../../../engine/src/tokens.ts';
import type { HostV1, TokenSet } from '@lolly-tools/core/host-v1';

// ── Wire protocol ─────────────────────────────────────────────────────────────
// Every message carries `runId` (one per mounted tool); a shared singleton worker
// holds many mounts. `callId`/`hostCallId` correlate the two RPC directions.

/** The introspected structure of the main-thread host: which methods actually exist,
 *  so an ABSENT optional method stays absent on the proxy (a hook's
 *  `host.pdf?.redact` feature-detection keeps working). */
export interface HostShape { [ns: string]: string[] }

/** Sync feature-detect answers the worker can't compute (worker-unsafe globals),
 *  keyed `ns.method` → value (or, for recorder.isAvailable, a by-kind object). */
export type HostSeeds = Record<string, unknown>;

export interface HookInitMsg {
  t: 'init';
  runId: number;
  hooksSource: string;
  tokenDoc: unknown | null;
  tokenExcluded: string[];
  hostShape: HostShape;
  seeds: HostSeeds;
  shell: string;
  capabilities: readonly string[];
}
export interface HookInvokeMsg { t: 'invoke'; runId: number; callId: number; name: string; ctx: Record<string, unknown> }
export interface HookHostReplyMsg { t: 'host-reply'; runId: number; hostCallId: number; ok: boolean; value?: unknown; error?: string }
export interface HookDisposeMsg { t: 'dispose'; runId: number }
export type HookWorkerIn = HookInitMsg | HookInvokeMsg | HookHostReplyMsg | HookDisposeMsg;

const WORKER_HOOK_NAMES = ['onInit', 'onInput', 'onFrame', 'onLevel', 'exportFile'] as const;
export type WorkerHookName = (typeof WORKER_HOOK_NAMES)[number];

export interface HookInitDoneMsg { t: 'init-done'; runId: number; declared: WorkerHookName[]; compileError?: string }
export interface HookInvokeDoneMsg { t: 'invoke-done'; runId: number; callId: number; ok: boolean; patch?: unknown; error?: string }
export interface HookHostCallMsg { t: 'host-call'; runId: number; hostCallId: number; method: string; args: unknown[] }
export interface HookLogMsg { t: 'log'; runId: number; entries: { level: string; msg: string; ctx?: unknown }[] }
export type HookWorkerOut = HookInitDoneMsg | HookInvokeDoneMsg | HookHostCallMsg | HookLogMsg;

/** A transport the core posts through - the real worker `postMessage`, or a stub in a test. */
export interface HookWorkerPort { post(msg: HookWorkerOut, transfer?: Transferable[]): void }

// ── Bucket policy ─────────────────────────────────────────────────────────────
// Which host namespaces are co-located (never proxied), and which methods are
// seeded / omitted rather than turned into an RPC stub.
const COLOCATED_NS = new Set(['color', 'geom', 'tokens', 'raster']); // raster: only canRaster is local (below)
// Sync feature-detects that MUST come from a seed (they read worker-absent globals).
const SEED_METHODS = new Set([
  'media.isAvailable', 'recorder.isAvailable', 'audio.isAvailable', 'viz.isAvailable',
  'speech.isAvailable', 'speech.transcribeAvailable', 'upscale.isAvailable', 'matte.isAvailable',
]);
// Methods that must never be a hook-facing RPC: the runtime drives these itself
// (it stays main-thread-resident and PUSHES frames/levels into the worker), and
// export.render carries a live DOM node.
const OMIT_METHODS = new Set([
  'media.start', 'media.stop', 'media.subscribe',
  'recorder.meter', 'profile.subscribe', 'export.render',
  // Sync feature-detects that are NOT the isAvailable family and are NOT yet
  // seeded (§14 follow-up): omit them so they can't be mis-proxied as a
  // truthy Promise a hook branches on synchronously (the §1-edge-1 hazard). A
  // tool that actually reads these must not opt into isolation until they seed.
  'upscale.backend', 'upscale.models', 'upscale.modelBytes',
  'matte.backend', 'matte.models', 'matte.modelBytes',
  'speech.modelBytes', 'speech.transcribeModelBytes',
]);

// ── The pure, testable core ───────────────────────────────────────────────────

interface Run {
  host: HostV1;
  mod: Partial<Record<WorkerHookName, (ctx: unknown) => unknown>>;
  /** pending worker→main host-calls, by hostCallId. */
  waiters: Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>;
  logBuf: { level: string; msg: string; ctx?: unknown }[];
  flushTimer: ReturnType<typeof setTimeout> | null;
}

/** Build the singleton color/geom once (shared across all runs in this worker). */
function makeColocatedApis() {
  return { color: makeColorApi(), geom: makeGeomApi() };
}

/**
 * The worker's message handler + host-proxy construction, with the transport
 * injected. Returns `{ handle }` - feed it every inbound message.
 */
export function createHookWorkerCore(port: HookWorkerPort, opts: { hostCallSeq?: () => number } = {}) {
  const runs = new Map<number, Run>();
  const apis = makeColocatedApis();
  let hostCallCounter = 0;
  const nextHostCallId = opts.hostCallSeq ?? (() => ++hostCallCounter);

  function scheduleFlush(runId: number, run: Run): void {
    if (run.flushTimer != null) return;
    run.flushTimer = setTimeout(() => {
      run.flushTimer = null;
      if (run.logBuf.length) { port.post({ t: 'log', runId, entries: run.logBuf.splice(0) }); }
    }, 250);
  }

  /** Build the co-located tokens surface from the snapshotted doc - a local
   *  per-theme TokenSet cache; the async signatures just wrap the sync result. */
  function makeTokens(doc: unknown, excluded: string[]): NonNullable<HostV1['tokens']> {
    const byTheme = new Map<string, TokenSet>();
    const excl = new Set(excluded);
    const ensure = (theme?: string): TokenSet => {
      const key = theme ?? '';
      let set = byTheme.get(key);
      if (!set) { set = createTokenSet(doc, { theme }); byTheme.set(key, set); }
      return set;
    };
    return {
      get: async (o = {}) => ensure(o.theme),
      resolve: async (ref, o = {}) => ensure(o.theme).resolve(ref),
      themes: async () => ensure().themes(),
      colors: async (o = {}) => {
        const list = ensure(o.theme).colors();
        if (!excl.size) return list;
        return list.filter(c => {
          const p = aliasPath(c.ref) ?? c.ref;
          return !excl.has(p) && !excl.has(p.startsWith('color.') ? p : `color.${p}`);
        });
      },
    };
  }

  /** Assemble the proxy `host` a hook sees inside the worker. */
  function buildHost(runId: number, msg: HookInitMsg): HostV1 {
    const run = () => runs.get(runId)!;
    const host: Record<string, unknown> = {
      version: '1',
      shell: msg.shell,
      capabilities: msg.capabilities,
      log: (level: string, m: string, ctx?: unknown) => {
        const r = run();
        r.logBuf.push({ level, msg: m, ctx });
        scheduleFlush(runId, r);
      },
      color: apis.color,
      geom: apis.geom,
    };
    if (msg.tokenDoc != null) host.tokens = makeTokens(msg.tokenDoc, msg.tokenExcluded);

    // Bucket B/C: build stubs from the introspected shape.
    for (const [ns, methods] of Object.entries(msg.hostShape)) {
      if (COLOCATED_NS.has(ns) && ns !== 'raster') continue; // color/geom/tokens handled above
      const nsObj: Record<string, unknown> = (host[ns] as Record<string, unknown>) ?? {};
      for (const method of methods) {
        const full = `${ns}.${method}`;
        if (OMIT_METHODS.has(full)) continue;
        if (ns === 'raster' && method === 'canRaster') {
          // C5: recompute locally - realm-portable by design (the M1 point).
          nsObj[method] = () =>
            typeof createImageBitmap === 'function' &&
            (typeof OffscreenCanvas === 'function' ||
              (typeof document !== 'undefined' && !!(document as { createElement?: unknown }).createElement));
          continue;
        }
        if (SEED_METHODS.has(full)) {
          const seeded = msg.seeds[full];
          if (full === 'recorder.isAvailable') {
            // seeded is a by-kind map { audio, video, screen }
            const map = (seeded ?? {}) as Record<string, boolean>;
            nsObj[method] = (kind: string = 'audio') => Boolean(map[kind]);
          } else {
            nsObj[method] = () => seeded;
          }
          continue;
        }
        // Default: an async RPC to the main-thread host.
        nsObj[method] = (...args: unknown[]) => rpcHostCall(runId, full, args);
      }
      if (Object.keys(nsObj).length) host[ns] = nsObj;
    }
    return host as unknown as HostV1;
  }

  function rpcHostCall(runId: number, method: string, args: unknown[]): Promise<unknown> {
    const r = runs.get(runId);
    if (!r) return Promise.reject(new Error(`host-call after dispose (${method})`));
    const hostCallId = nextHostCallId();
    return new Promise((resolve, reject) => {
      r.waiters.set(hostCallId, { resolve, reject });
      port.post({ t: 'host-call', runId, hostCallId, method, args });
    });
  }

  /** Compile hooks.js in this realm - same factory shape as engine getHookFactory. */
  function compile(host: HostV1, source: string): Partial<Record<WorkerHookName, (ctx: unknown) => unknown>> {
    const factory = new Function(
      'host',
      `${source}; return {` +
      WORKER_HOOK_NAMES.map(n => `${n}: typeof ${n} !== 'undefined' ? ${n} : null`).join(',') +
      `};`,
    ) as (h: HostV1) => Record<string, unknown>;
    const raw = factory(host);
    const mod: Partial<Record<WorkerHookName, (ctx: unknown) => unknown>> = {};
    for (const n of WORKER_HOOK_NAMES) {
      if (typeof raw[n] === 'function') mod[n] = raw[n] as (ctx: unknown) => unknown;
    }
    return mod;
  }

  function handle(msg: HookWorkerIn): void {
    if (msg.t === 'init') {
      const run: Run = { host: null as unknown as HostV1, mod: {}, waiters: new Map(), logBuf: [], flushTimer: null };
      runs.set(msg.runId, run);
      let declared: WorkerHookName[] = [];
      let compileError: string | undefined;
      try {
        run.host = buildHost(msg.runId, msg);
        run.mod = compile(run.host, msg.hooksSource);
        declared = WORKER_HOOK_NAMES.filter(n => run.mod[n] != null);
      } catch (e) {
        // A hooks.js that throws AT COMPILE TIME can't run here. Report it so the
        // main client REJECTS the mount and falls back to the in-realm executor - 
        // matching in-realm loudness (a syntax error there fails createRuntime),
        // not a silent all-null-hooks mount. Drop the dead run so it can't leak.
        compileError = (e as Error).message;
        runs.delete(msg.runId);
      }
      port.post({ t: 'init-done', runId: msg.runId, declared, compileError });
      return;
    }
    if (msg.t === 'invoke') {
      const run = runs.get(msg.runId);
      const fn = run?.mod[msg.name as WorkerHookName];
      if (!run || !fn) {
        port.post({ t: 'invoke-done', runId: msg.runId, callId: msg.callId, ok: false, error: `no hook '${msg.name}'` });
        return;
      }
      // Re-attach the worker's host proxy - ctx crossed the wire WITHOUT it.
      const ctx = { ...msg.ctx, host: run.host };
      Promise.resolve()
        .then(() => fn(ctx))
        .then(
          (patch) => port.post({ t: 'invoke-done', runId: msg.runId, callId: msg.callId, ok: true, patch }),
          (err: unknown) => port.post({ t: 'invoke-done', runId: msg.runId, callId: msg.callId, ok: false, error: err instanceof Error ? err.message : String(err) }),
        );
      return;
    }
    if (msg.t === 'host-reply') {
      const w = runs.get(msg.runId)?.waiters;
      const waiter = w?.get(msg.hostCallId);
      if (waiter) {
        w!.delete(msg.hostCallId);
        if (msg.ok) waiter.resolve(msg.value);
        else waiter.reject(new Error(msg.error ?? 'host call failed'));
      }
      return;
    }
    if (msg.t === 'dispose') {
      const run = runs.get(msg.runId);
      if (run) {
        if (run.flushTimer != null) clearTimeout(run.flushTimer);
        for (const wtr of run.waiters.values()) wtr.reject(new Error('mount disposed'));
        runs.delete(msg.runId);
      }
      return;
    }
  }

  return { handle, _runs: runs };
}

// ── Wire entry (only inside a real Worker; importing on main is inert) ────────
function inWorkerScope(): boolean {
  const g = globalThis as { WorkerGlobalScope?: unknown; document?: unknown };
  return typeof g.WorkerGlobalScope !== 'undefined' && typeof g.document === 'undefined';
}

if (inWorkerScope()) {
  const post = postMessage as (message: unknown, transfer: Transferable[]) => void;
  const core = createHookWorkerCore({ post: (m, transfer) => post(m, transfer ?? []) });
  addEventListener('message', (e: MessageEvent<HookWorkerIn>) => core.handle(e.data));
}
