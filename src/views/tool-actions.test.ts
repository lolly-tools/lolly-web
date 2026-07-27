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
 * Section 5 covers the other half of the sequence export bar: the "Frames" contact
 * sheet control (spec §4.6) — present only for a timed composition on a still
 * format, and the sole source of `opts.cuts`.
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

const { renderActions, extFor } = await import('./tool-actions.ts');

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
  /** Every exportUnscaled(fn, opts) call, with the formats exported INSIDE it — the
   *  export-history thumbnail capture also wraps itself, so the shutter decision can
   *  only be judged against the call that produced the actual format. */
  unscaled: () => Array<{ shutter?: boolean; formats: string[] }>;
  /** Every DOWNLOAD export, any format. `onProgress` is the discriminator: the
   *  download builds it, the export-history thumbnail capture doesn't. */
  downloads: () => Array<{ format: string; opts: Record<string, unknown> }>;
  /** The "Frames" (contact sheet) row, or null when it isn't in the panel at all. */
  framesRow: () => HTMLElement | null;
  framesInput: () => HTMLInputElement | null;
  setFormat: (f: string) => void;
  download: () => void;
}

/** Mount the export bar over a canvas that is (or isn't) a timed composition. */
function mount({ seqMs, videoDuration = 12, formats = ['webm', 'mp4', 'png'] }:
  { seqMs: number | null; videoDuration?: number; formats?: string[] }): Harness {
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
    render: { width: 1920, height: 1080, formats, video: { wait: 0, duration: videoDuration } },
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

  const unscaledCalls: Array<{ shutter?: boolean; formats: string[] }> = [];
  renderActions(
    panel as never, manifest as never, runtime as never, canvas, host as never,
    () => {},
    (async (fn: () => unknown, o: { shutter?: boolean } = {}) => {
      const before = seen.length;
      try { return await fn(); }
      finally { unscaledCalls.push({ ...o, formats: seen.slice(before).map(e => e.format) }); }
    }) as never,
    {},
  );

  return {
    panel, canvas, stage,
    exports: () => seen.filter(e => 'durationUserSet' in e.opts),
    unscaled: () => unscaledCalls,
    downloads: () => seen.filter(e => typeof e.opts.onProgress === 'function'),
    duration: () => panel.querySelector('[data-action="video-duration"]') as HTMLInputElement,
    liveLabel: () => panel.querySelector('[data-live-capture]') as HTMLElement | null,
    framesRow: () => panel.querySelector('[data-seq-still-only]') as HTMLElement | null,
    framesInput: () => panel.querySelector('[data-action="export-cuts"]') as HTMLInputElement | null,
    setFormat: (f: string) => {
      const sel = panel.querySelector('[data-action="format"]') as HTMLSelectElement;
      sel.value = f;
      sel.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    },
    download: () => (panel.querySelector('[data-action="download"]') as HTMLElement)
      .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })),
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

// ── 5. "Frames" — the contact sheet (plans/fable-timeline-editing.md §4.6) ────
// A still export of a sequence renders the playhead frame. `cuts=N` instead samples
// N stills at equal midpoint intervals across the timeline — a zip for raster/SVG,
// N pages for PDF. The control belongs to timed compositions on still formats ONLY,
// and `opts.cuts` is the pinned name the export bridge reads.

const STILL = { formats: ['png', 'pdf', 'webm'] };

test('Frames is absent for a tool that is not a timed composition', () => {
  const h = mount({ seqMs: null, ...STILL });
  assert.equal(h.framesRow(), null, 'no sequence, no contact sheet');
  assert.equal(h.framesInput(), null);
});

test('Frames is hidden for a sequence on a motion format', () => {
  const h = mount({ seqMs: 6000, formats: ['webm', 'png'] });   // initial format = webm
  assert.equal(h.framesRow()!.style.display, 'none', 'a video has frames by definition');
});

test('Frames is shown for a sequence on a still format, defaulting to 1', () => {
  const h = mount({ seqMs: 6000, ...STILL });                    // initial format = png
  assert.equal(h.framesRow()!.style.display, 'flex');
  assert.equal(h.framesInput()!.value, '1', 'the default is the playhead frame');
  assert.equal(h.framesInput()!.min, '1');
  assert.equal(h.framesInput()!.max, '64', 'bounded — a contact sheet is for human review');
});

test('Frames appears and disappears across a format switch', () => {
  const h = mount({ seqMs: 6000, ...STILL });
  h.setFormat('webm');
  assert.equal(h.framesRow()!.style.display, 'none');
  h.setFormat('pdf');
  assert.equal(h.framesRow()!.style.display, 'flex', 'PDF takes N pages');
  h.setFormat('png');
  assert.equal(h.framesRow()!.style.display, 'flex');
});

test('Frames appears when a plain canvas BECOMES a timed composition, and goes when it stops', async () => {
  const h = mount({ seqMs: null, ...STILL });
  assert.equal(h.framesRow(), null);
  const stage = dom.window.document.createElement('div');
  stage.setAttribute('data-sequence', '');
  stage.setAttribute('data-seq-ms', '8000');
  h.canvas.appendChild(stage);
  await settle();
  assert.equal(h.framesRow()!.style.display, 'flex', 'the same observer that re-seeds Duration');
  stage.remove();
  await settle();
  assert.equal(h.framesRow(), null, 'every clip deleted — no contact sheet either');
});

test('the Frames value reaches the export opts as opts.cuts', async () => {
  const h = mount({ seqMs: 6000, ...STILL });
  h.framesInput()!.value = '6';
  h.download();
  await settle();
  assert.equal(h.downloads().length, 1);
  assert.equal(h.downloads()[0]!.format, 'png');
  assert.equal(h.downloads()[0]!.opts.cuts, 6);
});

test('a nonsense Frames value coerces to 1, and the ceiling clamps', async () => {
  for (const [typed, want] of [['', 1], ['0', 1], ['-3', 1], ['2.7', 2], ['999', 64]] as Array<[string, number]>) {
    const h = mount({ seqMs: 6000, ...STILL });
    h.framesInput()!.value = typed;
    h.download();
    await settle();
    assert.equal(h.downloads()[0]!.opts.cuts, want, `"${typed}" → ${want}`);
  }
});

test('the default sequence export asks for a single frame', async () => {
  const h = mount({ seqMs: 6000, ...STILL });
  h.download();
  await settle();
  assert.equal(h.downloads()[0]!.opts.cuts, 1, 'the playhead frame — the untouched default path');
});

test('cuts never reaches the opts for a motion format or a non-sequence tool', async () => {
  const seq = mount({ seqMs: 6000, ...STILL });
  seq.setFormat('webm');
  seq.download();
  await settle();
  assert.equal('cuts' in seq.downloads()[0]!.opts, false, 'a video export has no contact sheet');

  const plain = mount({ seqMs: null, ...STILL });
  plain.download();
  await settle();
  assert.equal('cuts' in plain.downloads()[0]!.opts, false, 'ordinary tools are untouched');
});

// ── 6. the download extension follows the BYTES, not the requested format ─────
// A contact sheet (cuts > 1) of a still format returns a ZIP of N members while the
// format id still says png/pdf/svg. Without this the user downloads "sheet.png" that
// is really an archive and nothing will open it.

test('a zipped contact sheet downloads as .zip, not the still extension', () => {
  const z = new dom.window.Blob(['x'], { type: 'application/zip' });
  assert.equal(extFor('png', z), 'zip');
  assert.equal(extFor('pdf', z), 'zip');
  assert.equal(extFor('svg', z), 'zip');
});

test('a single-cut still keeps its own extension', () => {
  assert.equal(extFor('png', new dom.window.Blob(['x'], { type: 'image/png' })), 'png');
  // A multi-page PDF sheet is ONE pdf, not a zip — it must stay .pdf.
  assert.equal(extFor('pdf', new dom.window.Blob(['x'], { type: 'application/pdf' })), 'pdf');
});

test('the video container fallback still wins over the requested format', () => {
  assert.equal(extFor('mp4', new dom.window.Blob(['x'], { type: 'video/webm' })), 'webm');
});


// ── 7. the export shutter covers ANIMATED exports too ────────────────────────
// It used to be gated `shutter: !isAnimated`, on the reasoning that an animated
// format records the live canvas. That is true only of a LIVE take, which never
// reaches exportUnscaled at all — every other motion path composites off-screen,
// and `.export-shutter` is a sibling of #tool-canvas-outer so it is outside the
// captured subtree regardless. Meanwhile the resize shake is just as visible for
// video. A regression here puts a camera-iris inside someone's exported file, or
// puts the shake back on screen — neither is something a type checker will catch.

test('an animated export runs behind the shutter', async () => {
  const h = mount({ seqMs: 6000 });
  h.setFormat('mp4');
  h.download();
  await settle();
  assert.ok(h.unscaled().some(o => o.shutter === true && o.formats.includes('mp4')),
    'the mp4 export itself must run inside a closed shutter');
});

test('a still export still runs behind the shutter', async () => {
  const h = mount({ seqMs: null, formats: ['png', 'mp4'] });
  h.setFormat('png');
  h.download();
  await settle();
  assert.ok(h.unscaled().some(o => o.shutter === true && o.formats.includes('png')),
    'png keeps the behaviour it always had');
});

test('a LIVE take bypasses exportUnscaled entirely — the shutter would be filmed', async () => {
  const h = mount({ seqMs: null, formats: ['webm', 'png'] });
  h.setFormat('webm');
  const live = h.panel.querySelector('[data-action="video-live"]') as HTMLInputElement | null;
  if (!live) return;                       // liveCaptureSupport() false in this env
  live.checked = true;
  h.download();
  await settle();
  // A live take keeps the fit-to-stage scale AND films the screen, so the webm
  // itself must not be produced inside a wrapper. (Other wrapped calls may exist —
  // the export-history thumbnail capture wraps its own png.)
  assert.equal(h.unscaled().some(o => o.formats.includes('webm')), false,
    'the live take must not run inside exportUnscaled at all');
});
