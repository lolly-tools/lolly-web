// SPDX-License-Identifier: MPL-2.0
/**
 * Main-thread client for the hook Worker (hook-worker.worker.ts) - the web
 * shell's Worker-isolated HookExecutor (plans/86-worker-isolation-hooks.md M2).
 *
 * `getWorkerHookExecutor()` returns a `HookExecutor` the mount chokepoint injects
 * into `createRuntime` when a tool opts in. For each mount it:
 *   1. introspects the live host (which methods exist) → the worker builds a
 *      proxy whose ABSENT methods stay absent (hooks' feature-detection survives);
 *   2. snapshots the brand token doc + the sync feature-detect seeds;
 *   3. inits a shared singleton worker with that mount's runId and returns a
 *      `Hooks` object whose worker-backed slots postMessage a hook invocation and
 *      resolve the patch - which runHook already time-boxes like an async hook.
 * It also SERVICES the worker's `host-call` RPCs against THAT mount's real host
 * (so host.net's per-mount allowlist can't leak across tools), and forwards the
 * worker's batched log lines to host.log.
 *
 * SAFETY: any failure - no Worker, a spawn/init error, a worker crash - makes the
 * executor fall back to the in-realm path, so a tool NEVER fails to mount because
 * isolation was unavailable. The node-carrying export hooks (beforeExport/
 * afterExport/exportStill) always run in-realm (a live DOM node can't cross the
 * boundary) - a documented M2 hybrid.
 */
import { inRealmHookExecutor } from '@lolly/engine';
import type { HookExecutor, Hooks } from '@lolly/engine';
import type { HostV1, TokensAPI } from '@lolly-tools/core/host-v1';
import { getExcludedSwatches } from '../lib/brand-exclusions.ts';
import type {
  HostShape, HostSeeds, HookWorkerOut, WorkerHookName,
  HookHostCallMsg, HookInvokeDoneMsg, HookInitDoneMsg, HookLogMsg,
} from './hook-worker.worker.ts';

/** Backstop for the one unbounded wait (worker init). Beyond this the mount
 *  falls back to the in-realm executor rather than hanging createRuntime. */
const INIT_TIMEOUT_MS = 5000;

let worker: Worker | null = null;
let runSeq = 0;
let callSeq = 0;
const mounts = new Map<number, HostV1>();                                    // runId → the mount's real host
const initWaiters = new Map<number, { resolve: (m: HookInitDoneMsg) => void; reject: (e: unknown) => void }>();
const invokeWaiters = new Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>(); // `runId:callId`

function ensureWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL('./hook-worker.worker.ts', import.meta.url), { type: 'module' });
  w.onmessage = (e: MessageEvent<HookWorkerOut>): void => { onMessage(e.data); };
  w.onerror = (): void => {
    // A hard worker crash: reject everything in flight so each executor falls
    // back to in-realm, and drop the worker so the next mount respawns fresh.
    for (const p of invokeWaiters.values()) p.reject(new Error('hook worker crashed'));
    invokeWaiters.clear();
    for (const p of initWaiters.values()) p.reject(new Error('hook worker crashed'));
    initWaiters.clear();
    if (worker) { worker.onmessage = null; worker.onerror = null; }
    worker = null;
  };
  worker = w;
  return w;
}

function onMessage(m: HookWorkerOut): void {
  if (m.t === 'init-done') { initWaiters.get(m.runId)?.resolve(m); initWaiters.delete(m.runId); return; }
  if (m.t === 'invoke-done') {
    const key = `${m.runId}:${(m as HookInvokeDoneMsg).callId}`;
    const p = invokeWaiters.get(key);
    if (!p) return;
    invokeWaiters.delete(key);
    if (m.ok) p.resolve(m.patch); else p.reject(new Error(m.error ?? 'hook failed'));
    return;
  }
  if (m.t === 'host-call') { void dispatchHostCall(m); return; }
  if (m.t === 'log') { forwardLogs(m); return; }
}

/** Service a worker host-call against the MOUNT's own host (per-mount scoping). */
async function dispatchHostCall(m: HookHostCallMsg): Promise<void> {
  const w = worker;
  if (!w) return;
  const reply = (ok: boolean, value?: unknown, error?: string): void =>
    w.postMessage({ t: 'host-reply', runId: m.runId, hostCallId: m.hostCallId, ok, value, error });
  const host = mounts.get(m.runId);
  if (!host) { reply(false, undefined, 'mount disposed'); return; }
  const dot = m.method.indexOf('.');
  const ns = m.method.slice(0, dot);
  const method = m.method.slice(dot + 1);
  const nsObj = (host as unknown as Record<string, Record<string, unknown>>)[ns];
  const fn = nsObj?.[method];
  if (typeof fn !== 'function') { reply(false, undefined, `no host.${m.method}`); return; }
  try {
    const value = await (fn as (...a: unknown[]) => unknown).apply(nsObj, m.args);
    reply(true, value);
  } catch (e) {
    reply(false, undefined, e instanceof Error ? e.message : String(e));
  }
}

function forwardLogs(m: HookLogMsg): void {
  const host = mounts.get(m.runId);
  if (!host) return;
  for (const e of m.entries) host.log(e.level as 'debug' | 'info' | 'warn' | 'error', e.msg, e.ctx as object | undefined);
}

/** The live host's shape: namespace → its own function-valued method names. An
 *  absent optional method is simply not listed, so the worker never builds a
 *  stub for it and a hook's `host.x?.y` feature-detect keeps working. */
function introspect(host: HostV1): HostShape {
  const shape: HostShape = {};
  for (const [ns, val] of Object.entries(host as unknown as Record<string, unknown>)) {
    if (val && typeof val === 'object') {
      const methods = Object.keys(val).filter(k => typeof (val as Record<string, unknown>)[k] === 'function');
      if (methods.length) shape[ns] = methods;
    }
  }
  return shape;
}

/** Compute the sync feature-detect answers the worker can't (worker-absent globals). */
function gatherSeeds(host: HostV1): HostSeeds {
  const h = host as unknown as Record<string, Record<string, (...a: unknown[]) => unknown>>;
  const call = (ns: string, method: string, ...args: unknown[]): unknown => {
    try { const o = h[ns]; return o && typeof o[method] === 'function' ? o[method](...args) : undefined; }
    catch { return undefined; }
  };
  return {
    'media.isAvailable': call('media', 'isAvailable'),
    'recorder.isAvailable': { audio: call('recorder', 'isAvailable', 'audio'), video: call('recorder', 'isAvailable', 'video'), screen: call('recorder', 'isAvailable', 'screen') },
    'audio.isAvailable': call('audio', 'isAvailable'),
    'viz.isAvailable': call('viz', 'isAvailable'),
    'speech.isAvailable': call('speech', 'isAvailable'),
    'speech.transcribeAvailable': call('speech', 'transcribeAvailable'),
    'upscale.isAvailable': call('upscale', 'isAvailable'),
    'matte.isAvailable': call('matte', 'isAvailable'),
  };
}

/** The raw brand token doc + its exclusion list, snapshotted once per mount so
 *  the worker rebuilds a local TokenSet (sync get/colors/resolve without RPC). */
async function snapshotTokens(host: HostV1): Promise<{ doc: unknown | null; excluded: string[] }> {
  const t = host.tokens as (TokensAPI & { raw?: () => Promise<unknown> }) | undefined;
  if (!t || typeof t.raw !== 'function') return { doc: null, excluded: [] };
  try {
    const doc = (await t.raw()) ?? null;
    return { doc, excluded: doc ? getExcludedSwatches(doc) : [] };
  } catch { return { doc: null, excluded: [] }; }
}

/** Run one hook in the worker: strip the (non-serializable) host from ctx - the
 *  worker supplies its own proxy - and await the patch. */
function invokeInWorker(runId: number, name: WorkerHookName, ctx: unknown): Promise<unknown> {
  const w = ensureWorker();
  const callId = ++callSeq;
  const key = `${runId}:${callId}`;
  const { host: _omit, ...rest } = (ctx ?? {}) as Record<string, unknown> & { host?: unknown };
  // An onFrame ctx carries `frame.data` (a Uint8ClampedArray); it crosses by
  // STRUCTURED CLONE, deliberately NOT a Transferable. media.ts fans ONE shared
  // MediaFrame object to every live subscriber synchronously (media.ts:74-77), so
  // transferring its buffer would neuter it for a second subscriber. Clone is
  // ~0.1ms at the 480px default working edge (≤~1ms at the 1920 cap) - negligible
  // beside the worker's per-frame encode, and it can't corrupt the camera loop.
  return new Promise((resolve, reject) => {
    invokeWaiters.set(key, { resolve, reject });
    w.postMessage({ t: 'invoke', runId, callId, name, ctx: rest });
  });
}

async function mountInWorker(tool: Parameters<HookExecutor>[0], host: HostV1): Promise<Hooks> {
  const w = ensureWorker();
  const runId = ++runSeq;
  const { doc, excluded } = await snapshotTokens(host);
  const initMsg = await new Promise<HookInitDoneMsg>((resolve, reject) => {
    const timer = setTimeout(() => { initWaiters.delete(runId); reject(new Error('hook worker init timed out')); }, INIT_TIMEOUT_MS);
    initWaiters.set(runId, {
      resolve: (m) => { clearTimeout(timer); resolve(m); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    w.postMessage({
      t: 'init', runId,
      hooksSource: tool.hooksSource ?? '',
      tokenDoc: doc, tokenExcluded: excluded,
      hostShape: introspect(host), seeds: gatherSeeds(host),
      shell: host.shell, capabilities: host.capabilities ?? [],
    });
  });
  // A worker compile error can't run the hooks there - reject so the executor
  // falls back to in-realm (matching in-realm's loud failure), never a silent
  // all-null-slots mount.
  if (initMsg.compileError) throw new Error(`hook worker compile error: ${initMsg.compileError}`);
  // Register the mount ONLY after a clean init, so a failed/timed-out init (which
  // falls back to in-realm) never leaks a host into `mounts`.
  mounts.set(runId, host);
  host.log('info', `hooks running in a Worker (${initMsg.declared.join(', ') || 'none declared'})`, { toolId: tool.manifest.id });
  const has = new Set(initMsg.declared);
  const slot = (name: WorkerHookName): ((ctx: unknown) => Promise<unknown>) | null =>
    has.has(name) ? (ctx: unknown) => invokeInWorker(runId, name, ctx) : null;

  // The node-carrying export hooks (beforeExport/afterExport/exportStill) receive
  // a live DOM Element and MUST run in-realm - it can't cross the boundary. Always
  // compile in-realm and source them from there: a hooks.js may DEFINE an export
  // hook without declaring it in the manifest (filter-duotone defines beforeExport
  // but lists only onInit/onInput/onFrame), so the manifest is not a reliable
  // signal - the compiled module is. The in-realm compile is cheap (top-level is
  // function definitions); its onInit/onInput/onFrame exist but are never called
  // (those come from the worker). An export hook that reads render state must read
  // it from the DOM (ctx.node), NOT from module vars an isolated interactive hook
  // wrote - those live in the worker closure (see the overlay-export refactor,
  // plans/86 §18); this split is only sound once that holds.
  const inRealm = await inRealmHookExecutor(tool, host);

  return {
    onInit: slot('onInit'),
    onInput: slot('onInput'),
    onFrame: slot('onFrame'),
    onLevel: slot('onLevel'),
    exportFile: slot('exportFile'),
    beforeExport: inRealm.beforeExport,
    afterExport: inRealm.afterExport,
    exportStill: inRealm.exportStill,
    // Teardown (runtime.destroy → hooks.dispose): tell the worker to drop this
    // run and release the main-side host reference, so the singleton worker
    // doesn't retain one run per mount. Idempotent.
    dispose: () => {
      if (!mounts.has(runId)) return;
      mounts.delete(runId);
      worker?.postMessage({ t: 'dispose', runId });
    },
  } as unknown as Hooks;
}

/**
 * The Worker-isolated executor. Falls back to the in-realm path on ANY failure - 
 * so opting a tool in can never make it fail to mount, only lose isolation.
 */
export function getWorkerHookExecutor(): HookExecutor {
  return async (tool, host) => {
    if (typeof Worker === 'undefined' || !tool.hooksSource) return inRealmHookExecutor(tool, host);
    try {
      return await mountInWorker(tool, host);
    } catch (e) {
      host.log('warn', `worker hooks unavailable — running in-realm: ${(e as Error).message}`, { toolId: tool.manifest.id });
      return inRealmHookExecutor(tool, host);
    }
  };
}
