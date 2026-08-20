// SPDX-License-Identifier: MPL-2.0
/**
 * The scrub-proxy transcode as a WP-F JOB (lib/clip-proxy.ts + lib/jobs.ts).
 *
 * Run:  node --test shells/web/src/lib/clip-proxy-job.test.ts
 *
 * WHY THIS EXISTS. An ingest proxy build was the last encoder run in the app
 * outside the process-wide serial slot, so a background transcode could start on
 * top of a video matte or upscale run - two decoder/encoder pairs in one tab,
 * which is the out-of-memory the slot exists to prevent. It was also completely
 * invisible: fired from an idle callback, with a `log` nobody passed, so a
 * failure went nowhere at all.
 *
 * WHAT IS PINNED HERE:
 *   • the transcode occupies the ONE heavy slot, in both directions - a proxy
 *     blocks a video job, and a video job blocks a proxy;
 *   • the cheap prelude (a cached row, the skip ladder) registers NO job, which
 *     is the reason the internal FIFO was kept rather than handed to jobs.ts:
 *     an already-answered build must not queue behind a four-minute upscale;
 *   • a transcode failure reaches the toast as job.fail AND still resolves null
 *     into ingest, so a failed proxy can never fail an upload;
 *   • every cancel route (the toast's ✕, abortProxyBuilds) terminates the job
 *     and frees the slot - an orphan there would wedge every later heavy job;
 *   • progress rides mediabunny's 0..1 completion, counted in seconds of the
 *     source; a converter that cannot report leaves the bar indeterminate.
 *
 * Same seams as clip-proxy.test.ts (a fake store, a fake converter): no
 * WebCodecs, no IndexedDB, and the queueing logic is the real thing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ensureProxy, abortProxyBuilds, setProxyStore, setProxyConverter, resetScrubCache,
  type ProxyRecord, type ProxyStore, type ProxyConverter,
} from './clip-proxy.ts';
import { startJob, cancelJob, jobsSnapshot, __resetJobsForTest, type Job } from './jobs.ts';

// ── seams ───────────────────────────────────────────────────────────────────

const blobOf = (bytes: number): Blob => new Blob([new Uint8Array(bytes)], { type: 'video/webm' });
/** A source comfortably inside every skip threshold (3-64 MB, >=8 s, >=640 px). */
const SOURCE = blobOf(6 * 1024 * 1024);

interface Gate { promise: Promise<void>; release: () => void }
function gate(): Gate {
  let release!: () => void;
  const promise = new Promise<void>((r) => { release = r; });
  return { promise, release };
}

type FakeStore = ProxyStore & { rows: Map<string, ProxyRecord> };
function fakeStore(): FakeStore {
  const rows = new Map<string, ProxyRecord>();
  return {
    rows,
    async get(key) { return rows.get(key); },
    async put(rec) { rows.set(rec.key, rec); },
    async delete(key) { rows.delete(key); },
    async all() { return [...rows.values()]; },
  };
}

interface FakeConverter extends ProxyConverter { converts: number }
function fakeConverter(cfg: {
  gate?: Gate;
  throws?: boolean;
  /** Source (and output) length in seconds - 3 makes it a 'too-short' skip. */
  durationSec?: number;
  /** Completion fractions to report through onProgress before the gate. */
  emit?: number[];
} = {}): FakeConverter {
  const seconds = cfg.durationSec ?? 30;
  const c: FakeConverter = {
    converts: 0,
    async probe() { return { durationSec: seconds, width: 1920, height: 1080, hasAudio: true }; },
    async convert(_src, _plan, opts = {}) {
      c.converts++;
      for (const f of cfg.emit ?? []) opts.onProgress?.(f);
      if (cfg.gate) await cfg.gate.promise;
      if (cfg.throws) throw new Error('encoder refused');
      return { blob: blobOf(1000), durationSec: seconds, hasAudio: true };
    },
  };
  return c;
}

/** Fresh module state for one test: proxy seams, scrub caches, job registry. */
function reset(store: ProxyStore | null, converter: ProxyConverter | null): void {
  setProxyStore(store);
  setProxyConverter(converter);
  resetScrubCache();
  __resetJobsForTest();
}

/** Let the queued microtasks and the promise chain settle. */
async function tick(n = 8): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => { setTimeout(r, 0); });
}

const PROXY_TITLE = 'Preparing a clip for scrubbing';
const byTitle = (title: string): Job | undefined => jobsSnapshot().find((j) => j.title === title);

// ── the slot ────────────────────────────────────────────────────────────────

test('a proxy transcode is a HEAVY job and holds the one serial slot', async () => {
  const g = gate();
  reset(fakeStore(), fakeConverter({ gate: g, emit: [0.5] }));

  const built = ensureProxy('user/upload/1-clip.mp4', SOURCE);
  await tick();

  const job = byTitle(PROXY_TITLE);
  assert.ok(job, 'the build announced itself');
  assert.equal(job.heavy, true, 'an encoder run shares the slot with matte/upscale');
  assert.equal(job.status, 'running');
  assert.deepEqual(job.progress, { done: 15, total: 30 }, 'half of a 30 s source');

  // A video job started NOW must wait: that is the whole point of the conversion.
  const video = startJob({ title: 'Removing background' });
  await tick();
  assert.equal(byTitle('Removing background')?.status, 'queued', 'the proxy is holding the slot');

  g.release();
  assert.ok(await built);
  await tick();
  assert.equal(byTitle(PROXY_TITLE)?.status, 'done');
  assert.equal(byTitle('Removing background')?.status, 'running', 'and it handed the slot on');
  video.finish();
});

test('a proxy build WAITS for a video job already in the slot', async () => {
  const conv = fakeConverter();
  reset(fakeStore(), conv);

  const video = startJob({ title: 'Upscaling video' });
  await video.started;

  const built = ensureProxy('user/upload/2-clip.mp4', SOURCE);
  await tick();
  assert.equal(conv.converts, 0, 'no encoder was opened alongside the upscale');
  assert.equal(byTitle(PROXY_TITLE)?.status, 'queued');

  video.finish();
  assert.ok(await built);
  assert.equal(conv.converts, 1, 'and it ran once the slot was free');
});

// ── the cheap prelude stays out of the queue ────────────────────────────────

test('a skipped source and a cache hit register NO job at all', async () => {
  const store = fakeStore();

  // Too short to be worth a proxy: decided before any job exists.
  reset(store, fakeConverter({ durationSec: 3 }));
  assert.equal(await ensureProxy('user/short', SOURCE, { log: () => {} }), null);
  assert.deepEqual(jobsSnapshot(), [], 'the skip ladder is not background work');

  // Build once...
  reset(store, fakeConverter());
  assert.ok(await ensureProxy('user/keep', SOURCE));
  assert.equal(jobsSnapshot().length, 1, 'the transcode itself is one job');

  // ...then serve the stored row. A reuse must answer immediately rather than
  // queue behind whatever heavy job happens to be running.
  __resetJobsForTest();
  const blocker = startJob({ title: 'Upscaling video' });
  await blocker.started;
  assert.ok(await ensureProxy('user/keep', SOURCE), 'the stored row came straight back');
  assert.equal(byTitle(PROXY_TITLE), undefined, 'and it never entered the queue');
  blocker.finish();
});

// ── failure is visible, ingest is untouched ─────────────────────────────────

test('a transcode failure FAILS the job and still resolves null into ingest', async () => {
  const store = fakeStore();
  reset(store, fakeConverter({ throws: true }));

  const out = await ensureProxy('user/upload/3-clip.mp4', SOURCE, { log: () => {} });
  assert.equal(out, null, 'ensureProxy never throws - a failed proxy cannot fail the upload');

  const job = byTitle(PROXY_TITLE);
  assert.equal(job?.status, 'failed', 'no longer swallowed: the toast carries it');
  assert.match(job?.error ?? '', /encoder refused/);
  assert.equal(store.rows.size, 0, 'and nothing was written');
});

test('a failed proxy leaves the slot free for the next heavy job', async () => {
  reset(fakeStore(), fakeConverter({ throws: true }));
  await ensureProxy('user/upload/4-clip.mp4', SOURCE, { log: () => {} });

  const next = startJob({ title: 'Cropping video' });
  await tick();
  assert.equal(byTitle('Cropping video')?.status, 'running', 'a failed job must not wedge the queue');
  next.finish();
});

// ── cancellation, both routes ───────────────────────────────────────────────

test("the toast's cancel aborts the transcode and stores nothing", async () => {
  const store = fakeStore();
  const g = gate();
  reset(store, fakeConverter({ gate: g }));

  const built = ensureProxy('user/upload/5-clip.mp4', SOURCE);
  await tick();
  const id = byTitle(PROXY_TITLE)!.id;

  cancelJob(id);          // what the ✕ calls
  g.release();
  assert.equal(await built, null);
  assert.equal(byTitle(PROXY_TITLE)?.status, 'cancelled');
  assert.equal(store.rows.size, 0, 'a cancelled build is never written');
});

test('abortProxyBuilds cancels the JOB too, so no orphan holds the slot', async () => {
  const g = gate();
  reset(fakeStore(), fakeConverter({ gate: g }));

  const built = ensureProxy('user/upload/6-clip.mp4', SOURCE);
  await tick();
  abortProxyBuilds();     // pagehide, view teardown
  g.release();
  assert.equal(await built, null);
  assert.equal(byTitle(PROXY_TITLE)?.status, 'cancelled', 'the list agrees with reality');

  const next = startJob({ title: 'Cropping video' });
  await tick();
  assert.equal(byTitle('Cropping video')?.status, 'running');
  next.finish();
});

// ── progress ────────────────────────────────────────────────────────────────

test('a converter that reports nothing leaves the bar indeterminate', async () => {
  reset(fakeStore(), fakeConverter());
  assert.ok(await ensureProxy('user/upload/7-clip.mp4', SOURCE));
  assert.equal(byTitle(PROXY_TITLE)?.progress, null, 'null progress is what the toast draws as indeterminate');
});

test('reported completion is counted in seconds of the source', async () => {
  reset(fakeStore(), fakeConverter({ durationSec: 90, emit: [0.1, 0.75, 1] }));
  assert.ok(await ensureProxy('user/upload/8-clip.mp4', SOURCE));
  assert.deepEqual(byTitle(PROXY_TITLE)?.progress, { done: 90, total: 90 }, 'the last report wins');
});
