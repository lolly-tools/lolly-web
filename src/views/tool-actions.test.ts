// SPDX-License-Identifier: MPL-2.0
/**
 * tool-actions (export bar) — the SEQUENCE duration contract.
 *
 * A timed composition's artboard carries [data-sequence] + data-seq-ms="<derived
 * length>". The export bar must take its Duration from THAT, keep following it as
 * the timeline changes, stop following it the moment the user types their own
 * value, and flag that user value out to the export opts as `durationUserSet` so
 * the tool hook leaves it alone. "Record live" is SUPPRESSED for a sequence — the
 * compositor is the only motion path there — and untouched for every other tool;
 * there are guards below for both halves of that.
 *
 * Everything here is driven through the REAL renderActions against a jsdom canvas:
 * the assertions read the rendered DOM and the opts object the export actually
 * receives. The runtime/host stubs are inputs to the subject, not the subject —
 * nothing asserts that a stub was called.
 *
 * NOT covered here (needs a browser): the live-capture path itself, MediaRecorder,
 * and whether bridge/export.ts + the sequence-studio hook consume durationUserSet
 * the way the contract says (that's the sibling module's coverage).
 *
 * Run directly:  node --test shells/web/src/views/tool-actions.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// The web shell writes browser-style '.js' specifiers that Vite resolves to the
// '.ts' source. Node doesn't, so map them here (and stub CSS module imports the
// same way the timeline-panel suite does).
registerHooks({
  resolve(spec: string, ctx: { parentURL?: string }, next: (s: string, c: unknown) => unknown) {
    if (spec.endsWith('.js') && spec.startsWith('.') && ctx.parentURL) {
      const js = new URL(spec, ctx.parentURL);
      if (!existsSync(fileURLToPath(js))) {
        const ts = new URL(spec.replace(/\.js$/, '.ts'), ctx.parentURL);
        if (existsSync(fileURLToPath(ts))) return { url: ts.href, format: 'module-typescript', shortCircuit: true };
      }
    }
    return next(spec, ctx);
  },
  load(url: string, ctx: unknown, next: (u: string, c: unknown) => unknown) {
    if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: 'export default {};' };
    return next(url, ctx);
  },
} as Parameters<typeof registerHooks>[0]);

const dom = new JSDOM('<!DOCTYPE html><body></body>', { pretendToBeVisual: true, url: 'https://example.test/' });
for (const k of [
  'window', 'document', 'HTMLElement', 'HTMLCanvasElement', 'Element', 'Node', 'Event', 'CustomEvent',
  'MouseEvent', 'getComputedStyle', 'MutationObserver', 'customElements', 'Blob', 'location', 'localStorage',
]) {
  try { (globalThis as Record<string, unknown>)[k] = (dom.window as unknown as Record<string, unknown>)[k]; } catch { /* getter-only global */ }
}
globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => dom.window.requestAnimationFrame(cb)) as typeof requestAnimationFrame;

// tool-actions.ts probes recording support ONCE at module load (the VIDEO const)
// and gates the whole animated-params row on it, so the probes have to answer
// before the import below. This is capability plumbing, not the code under test.
class FakeRecorder { static isTypeSupported(): boolean { return true; } }
(globalThis as Record<string, unknown>).MediaRecorder = FakeRecorder;
(dom.window as unknown as Record<string, unknown>).MediaRecorder = FakeRecorder;
(dom.window.HTMLCanvasElement.prototype as unknown as { captureStream: () => unknown }).captureStream = () => ({});
// jsdom has no 2D context; the TIFF probe (also module-load) calls getContext and
// logs a "not implemented" wall of text otherwise. Returning null is the honest
// answer — no readback — and only affects the TIFF format option, not this suite.
(dom.window.HTMLCanvasElement.prototype as unknown as { getContext: () => null }).getContext = () => null;
// liveCaptureSupport() also needs a display-capture source, else the "Record live"
// toggle is never rendered at all and test 4 would pass vacuously. Node has its own
// read-only `navigator`, so the jsdom one has to be installed with defineProperty.
Object.defineProperty(dom.window.navigator, 'mediaDevices', { value: { getDisplayMedia: () => Promise.resolve({}) }, configurable: true });
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });

const { renderActions } = await import('./tool-actions.ts');

// ── harness ──────────────────────────────────────────────────────────────────

interface Harness {
  panel: HTMLElement;
  canvas: HTMLElement;
  stage: HTMLElement | null;
  duration: () => HTMLInputElement;
  liveLabel: () => HTMLElement | null;
  /** Only the exports that carry the video params — the thumbnail capture the
   *  export-history record takes is a second, unrelated runtime.export call. */
  exports: () => Array<{ format: string; opts: Record<string, unknown> }>;
}

/** Mount the export bar over a canvas that is (or isn't) a timed composition. */
function mount({ seqMs, videoDuration = 12 }: { seqMs: number | null; videoDuration?: number }): Harness {
  const doc = dom.window.document;
  doc.body.innerHTML = '';
  const panel = doc.createElement('div');
  const canvas = doc.createElement('div');
  doc.body.append(panel, canvas);

  let stage: HTMLElement | null = null;
  if (seqMs != null) {
    stage = doc.createElement('div');
    stage.setAttribute('data-sequence', '');
    stage.setAttribute('data-seq-ms', String(seqMs));
    canvas.appendChild(stage);
  }

  const seen: Array<{ format: string; opts: Record<string, unknown> }> = [];
  const manifest = {
    id: 'sequence-studio', name: 'Sequence Studio', version: '1.0.0', inputs: [],
    render: { width: 1920, height: 1080, formats: ['webm', 'mp4', 'png'], video: { wait: 0, duration: videoDuration } },
  };
  const runtime = {
    getModel: () => [],
    setInput: async () => {},
    setInputNoHistory: async () => {},
    subscribe: () => {},
    refresh: () => {},
    hasFrameHook: false,
    export: async (_node: unknown, format: string, opts: Record<string, unknown>) => {
      seen.push({ format, opts: { ...opts } });
      return new dom.window.Blob(['x'], { type: 'video/webm' });
    },
  };
  const host = {
    assets: { query: async () => [] },
    state: { save: async () => {} },
    export: { download: async () => {} },
  };

  renderActions(
    panel as never, manifest as never, runtime as never, canvas, host as never,
    () => {}, (async (fn: () => unknown) => await fn()) as never, {},
  );

  return {
    panel, canvas, stage,
    exports: () => seen.filter(e => 'durationUserSet' in e.opts),
    duration: () => panel.querySelector('[data-action="video-duration"]') as HTMLInputElement,
    liveLabel: () => panel.querySelector('[data-live-capture]') as HTMLElement | null,
  };
}

/** Let the MutationObserver callback (a microtask) run. */
const settle = (): Promise<void> => new Promise(r => setTimeout(r, 0));

// ── 1. the field is seeded from the timeline, not the manifest ───────────────

test('sequence: Duration is seeded from data-seq-ms, not render.video.duration', () => {
  const h = mount({ seqMs: 6000, videoDuration: 12 });
  assert.equal(h.duration().value, '6', 'a 6s timeline must show 6s, not the manifest 12');
});

test('sequence: sub-second timelines keep centisecond precision', () => {
  assert.equal(mount({ seqMs: 9500 }).duration().value, '9.5');
  assert.equal(mount({ seqMs: 1234 }).duration().value, '1.23');
});

test('no sequence: Duration still comes from the manifest, unchanged', () => {
  const h = mount({ seqMs: null, videoDuration: 12 });
  assert.equal(h.duration().value, '12');
});

// ── 2. the ceiling ───────────────────────────────────────────────────────────

test('sequence: the 60s recording ceiling is raised to the timeline ceiling', () => {
  assert.equal(mount({ seqMs: 6000 }).duration().max, '3600');
  assert.equal(mount({ seqMs: null }).duration().max, '60', 'other tools keep 60s');
});

test('sequence: a timeline longer than 60s seeds its real length', async () => {
  const h = mount({ seqMs: 6000 });
  h.stage!.setAttribute('data-seq-ms', '125000');
  await settle();
  assert.equal(h.duration().value, '125');
});

// ── 3. re-sync, and the user-intervention flag that stops it ─────────────────

test('sequence: trimming the timeline re-syncs the Duration field', async () => {
  const h = mount({ seqMs: 12000 });
  assert.equal(h.duration().value, '12');
  h.stage!.setAttribute('data-seq-ms', '6000');
  await settle();
  assert.equal(h.duration().value, '6', 'a trim must pull the export duration down with it');
});

test('sequence: an artboard replaced wholesale by a re-render still re-syncs', async () => {
  const h = mount({ seqMs: 12000 });
  h.stage!.remove();
  const fresh = dom.window.document.createElement('div');
  fresh.setAttribute('data-sequence', '');
  fresh.setAttribute('data-seq-ms', '4000');
  h.canvas.appendChild(fresh);
  await settle();
  assert.equal(h.duration().value, '4');
});

test('sequence: a user edit stops the re-sync for good', async () => {
  const h = mount({ seqMs: 12000 });
  const d = h.duration();
  d.value = '20';
  d.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  h.stage!.setAttribute('data-seq-ms', '6000');
  await settle();
  assert.equal(d.value, '20', 'the timeline must not overwrite a deliberate user value');
});

test('durationUserSet reaches the export opts only after a user edit', async () => {
  const h = mount({ seqMs: 12000 });
  const download = h.panel.querySelector('[data-action="download"]') as HTMLElement;

  download.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await settle();
  assert.equal(h.exports().length, 1);
  assert.equal(h.exports()[0]!.opts.durationUserSet, false, 'an auto-derived duration is NOT a user value');
  assert.equal(h.exports()[0]!.opts.duration, 12);

  const d = h.duration();
  d.value = '20';
  d.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  download.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await settle();
  assert.equal(h.exports().length, 2);
  assert.equal(h.exports()[1]!.opts.durationUserSet, true);
  assert.equal(h.exports()[1]!.opts.duration, 20);
});

// ── 4. Record live is hidden for a sequence, offered everywhere else ─────────
// Andy, 2026-07-27, after testing a real take: "live record mode doesn't play or
// work but this method is fast". Screen-recording a sequence in real time has no
// upside over the compositor (same output, deterministic, ~30x realtime) and did
// not actually animate, so the control is suppressed for a timed composition
// rather than shipped slower and wrong. Every OTHER tool keeps it untouched.

test('Record live is hidden for a sequence and offered for every other tool', () => {
  const seq = mount({ seqMs: 6000 });
  const plain = mount({ seqMs: null });
  assert.equal(seq.liveLabel()!.style.display, 'none', 'suppressed for a timed composition');
  assert.equal(seq.liveLabel()!.dataset.suppressed, '1');
  assert.equal(plain.liveLabel()!.style.display, 'flex', 'untouched for an ordinary video tool');
  assert.equal(plain.liveLabel()!.dataset.suppressed, undefined);
});

test('a format switch does not hand Record live back on a sequence', () => {
  // The format-change handler re-shows every [data-video-only] control; without the
  // data-suppressed check it would undo the hide on the first format change.
  const h = mount({ seqMs: 6000 });
  const fmt = h.panel.querySelector('[data-action="format"]') as HTMLSelectElement;
  fmt.value = 'mp4';
  fmt.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  assert.equal(h.liveLabel()!.style.display, 'none');
});

test('a box ticked before the tool became a sequence cannot leave opts.live set', async () => {
  // The suppression un-ticks on the way out: a hidden control must not still be
  // steering the export away from the compositor.
  const h = mount({ seqMs: null });
  (h.panel.querySelector('[data-action="video-live"]') as HTMLInputElement).checked = true;
  // The canvas only BECOMES a timed composition now — the harness builds no stage
  // for a non-sequence tool, so this is what the MutationObserver has to notice.
  const stage = dom.window.document.createElement('div');
  stage.setAttribute('data-sequence', '');
  stage.setAttribute('data-seq-ms', '7000');
  h.canvas.appendChild(stage);
  await settle();
  assert.equal((h.panel.querySelector('[data-action="video-live"]') as HTMLInputElement).checked, false);
  (h.panel.querySelector('[data-action="download"]') as HTMLElement)
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await settle();
  assert.notEqual(h.exports()[0]!.opts.live, true, 'the compositor must get the export');
  assert.equal(h.exports()[0]!.opts.duration, 7, 'and it still renders the timeline length');
});
