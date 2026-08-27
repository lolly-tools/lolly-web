// SPDX-License-Identifier: MPL-2.0
/**
 * tool-actions (export bar) - the SEQUENCE duration contract.
 *
 * A timed composition's artboard carries [data-sequence] + data-seq-ms="<derived
 * length>". The export bar must take its Duration from THAT, keep following it as
 * the timeline changes, stop following it the moment the user types their own
 * value, and flag that user value out to the export opts as `durationUserSet` so
 * the tool hook leaves it alone. "Record live" is SUPPRESSED for a sequence - the
 * compositor is the only motion path there - and untouched for every other tool;
 * there are guards below for both halves of that.
 *
 * Section 5 covers the other half of the sequence export bar: the "Frames" contact
 * sheet control (spec section 4.6) - present only for a timed composition on a still
 * format, and the sole source of `opts.cuts`.
 *
 * Everything here is driven through the REAL renderActions against a jsdom canvas:
 * the assertions read the rendered DOM and the opts object the export actually
 * receives. The runtime/host stubs are inputs to the subject, not the subject - 
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
// answer - no readback - and only affects the TIFF format option, not this suite.
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
  /** Only the exports that carry the video params - the thumbnail capture the
   *  export-history record takes is a second, unrelated runtime.export call. */
  exports: () => Array<{ format: string; opts: Record<string, unknown> }>;
  /** Every exportUnscaled(fn, opts) call, with the formats exported INSIDE it - the
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
  /** The post-export "add your details" line, or null when it wasn't offered. */
  ask: () => HTMLElement | null;
  /** Every profile the panel wrote back, in order. */
  profileWrites: () => Array<Record<string, unknown>>;
  /** Every runtime.setInput(id, value) the panel made, in order. */
  inputWrites: () => Array<{ id: string; value: unknown }>;
  /** Every host.state.save(slot, data) the panel made, in order. */
  stateWrites: () => Array<{ slot: string; data: Record<string, unknown> }>;
  /** Change a model value the way the sidebar would, then notify the panel. */
  setModel: (id: string, value: unknown) => void;
}

/** Mount the export bar over a canvas that is (or isn't) a timed composition.
 *  `profile` installs a profile store on the host (absent by default, the way a
 *  host without one behaves). */
function mount({ seqMs, videoDuration = 12, formats = ['webm', 'mp4', 'png'], profile, model = [], toolId = 'sequence-studio' }:
  { seqMs: number | null; videoDuration?: number; formats?: string[]; profile?: Record<string, unknown>;
    /** The runtime's input model - only the tests that read it pass one. */
    model?: Array<Record<string, unknown>>; toolId?: string }): Harness {
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
    id: toolId, name: 'Sequence Studio', version: '1.0.0', inputs: [],
    render: { width: 1920, height: 1080, formats, video: { wait: 0, duration: videoDuration } },
  };
  const live = model.map(i => ({ ...i }));
  const subscribers: Array<() => void> = [];
  const inputWrites: Array<{ id: string; value: unknown }> = [];
  const runtime = {
    getModel: () => live,
    setInput: async (id: string, value: unknown) => {
      inputWrites.push({ id, value });
      const item = live.find(i => i.id === id);
      if (item) item.value = value;
      subscribers.forEach(fn => fn());
    },
    setInputNoHistory: async () => {},
    subscribe: (fn: () => void) => { subscribers.push(fn); },
    refresh: () => {},
    hasFrameHook: false,
    isLive: () => false,
    export: async (_node: unknown, format: string, opts: Record<string, unknown>) => {
      seen.push({ format, opts: { ...opts } });
      return new dom.window.Blob(['x'], { type: 'video/webm' });
    },
  };
  const profileWrites: Array<Record<string, unknown>> = [];
  const stateWrites: Array<{ slot: string; data: Record<string, unknown> }> = [];
  const host = {
    assets: { query: async () => [] },
    state: {
      save: async (slot: string, data: Record<string, unknown>) => { stateWrites.push({ slot, data }); },
      load: async () => null,
    },
    export: { download: async () => {} },
    ...(profile ? {
      profile: {
        get: async () => ({ ...profile }),
        set: async (p: Record<string, unknown>) => { profileWrites.push(p); },
      },
    } : {}),
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
    ask: () => panel.querySelector('.export-details-ask') as HTMLElement | null,
    profileWrites: () => profileWrites,
    inputWrites: () => inputWrites,
    stateWrites: () => stateWrites,
    setModel: (id: string, value: unknown) => {
      const item = live.find(i => i.id === id);
      if (item) item.value = value;
      subscribers.forEach(fn => fn());
    },
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
  // The canvas only BECOMES a timed composition now - the harness builds no stage
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

// ── 5. "Frames" - the contact sheet (plans/51-fable-timeline-editing.md section 4.6) ────
// A still export of a sequence renders the playhead frame. `cuts=N` instead samples
// N stills at equal midpoint intervals across the timeline - a zip for raster/SVG,
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
  assert.equal(h.framesInput()!.max, '64', 'bounded - a contact sheet is for human review');
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
  assert.equal(h.framesRow(), null, 'every clip deleted - no contact sheet either');
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
  assert.equal(h.downloads()[0]!.opts.cuts, 1, 'the playhead frame - the untouched default path');
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
  // A multi-page PDF sheet is ONE pdf, not a zip - it must stay .pdf.
  assert.equal(extFor('pdf', new dom.window.Blob(['x'], { type: 'application/pdf' })), 'pdf');
});

test('the video container fallback still wins over the requested format', () => {
  assert.equal(extFor('mp4', new dom.window.Blob(['x'], { type: 'video/webm' })), 'webm');
});


// ── 7. the export shutter covers ANIMATED exports too ────────────────────────
// It used to be gated `shutter: !isAnimated`, on the reasoning that an animated
// format records the live canvas. That is true only of a LIVE take, which never
// reaches exportUnscaled at all - every other motion path composites off-screen,
// and `.export-shutter` is a sibling of #tool-canvas-outer so it is outside the
// captured subtree regardless. Meanwhile the resize shake is just as visible for
// video. A regression here puts a camera-iris inside someone's exported file, or
// puts the shake back on screen - neither is something a type checker will catch.

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

test('a LIVE take bypasses exportUnscaled entirely - the shutter would be filmed', async () => {
  const h = mount({ seqMs: null, formats: ['webm', 'png'] });
  h.setFormat('webm');
  const live = h.panel.querySelector('[data-action="video-live"]') as HTMLInputElement | null;
  if (!live) return;                       // liveCaptureSupport() false in this env
  live.checked = true;
  h.download();
  await settle();
  // A live take keeps the fit-to-stage scale AND films the screen, so the webm
  // itself must not be produced inside a wrapper. (Other wrapped calls may exist - 
  // the export-history thumbnail capture wraps its own png.)
  assert.equal(h.unscaled().some(o => o.formats.includes('webm')), false,
    'the live take must not run inside exportUnscaled at all');
});

// ── the pro float formats (exr/hdr) open only for a deep-capable tool ─────────
// A tool that owns a float-compose exportStill hook and has host.codec can
// originate exr/hdr on-device (runtime.export routes those to exportStill before
// the 8-bit DOM path) - so the format picker opens the Pro <optgroup> for it even
// though the generic Node float rasteriser (proFormatSupport) is absent on the web.

/** Mount just the export bar and return the format <select>'s option values. */
function formatOptionValues(opts: {
  formats: string[];
  hooks?: Record<string, boolean>;
  codec?: boolean;
}): string[] {
  const doc = dom.window.document;
  doc.body.innerHTML = '';
  const panel = doc.createElement('div');
  const canvas = doc.createElement('div');
  doc.body.append(panel, canvas);
  const manifest = {
    id: 'darkroom', name: 'Darkroom', version: '1.0.0', inputs: [],
    ...(opts.hooks ? { hooks: opts.hooks } : {}),
    render: { width: 1080, height: 1080, formats: opts.formats },
  };
  const runtime = {
    getModel: () => [], setInput: async () => {}, setInputNoHistory: async () => {},
    subscribe: () => {}, refresh: () => {}, hasFrameHook: false, isLive: () => false,
    export: async () => new dom.window.Blob(['x']),
  };
  const host: Record<string, unknown> = {
    assets: { query: async () => [] }, state: { save: async () => {} },
    export: { download: async () => {} },
  };
  if (opts.codec) host.codec = { exr: async () => new Uint8Array() };
  renderActions(
    panel as never, manifest as never, runtime as never, canvas, host as never,
    () => {}, (async (fn: () => unknown) => fn()) as never, {},
  );
  return [...panel.querySelectorAll('[data-action="format"] option')]
    .map(o => (o as HTMLOptionElement).value);
}

test('exr/hdr are hidden for a plain tool (no exportStill hook)', () => {
  // Two ordinary survivors so a <select> renders (a single format needs no dropdown).
  const vals = formatOptionValues({ formats: ['png', 'jpg', 'exr', 'hdr'], codec: true });
  assert.deepEqual(vals, ['png', 'jpg'], 'a tool with no float master must not offer the float formats');
});

test('exr/hdr are hidden when the shell has no host.codec, even with the hook', () => {
  const vals = formatOptionValues({ formats: ['png', 'jpg', 'exr', 'hdr'], hooks: { exportStill: true }, codec: false });
  assert.ok(!vals.includes('exr') && !vals.includes('hdr'), 'no float producer → no float options');
});

test('exr/hdr open for a tool with exportStill + host.codec (Bitmap Studio on the web)', () => {
  const vals = formatOptionValues({ formats: ['png', 'exr', 'hdr'], hooks: { exportStill: true }, codec: true });
  assert.ok(vals.includes('exr'), 'EXR is offered');
  assert.ok(vals.includes('hdr'), 'Radiance HDR is offered');
  assert.ok(vals.includes('png'), 'ordinary formats are unaffected');
});

// ── 8. the canvas layout box on a dimension change: artboard vs preview thumbnail ─
// A dimension change resizes #tool-canvas via refreshCanvasPreview. For a preview
// tool the canvas is a thumbnail and is CLAMPED so its longest side never exceeds
// the native render size (fitCanvas's transform then does the on-screen fit). For a
// freeform EDITOR (render.layout:'editor') the canvas IS the artboard - its box
// coordinates are absolute pixels in its own space - so it must take the TRUE export
// px with no clamp, or a bigger export size shrinks the artboard under fixed boxes
// and pushes them off the frame (thread B). Both drive through the same input event.

/** Mount the export bar over a canvas and return the width/height fields + canvas. */
function mountDims(
  layout?: string,
  render: Record<string, unknown> = {},
  inputs: unknown[] = [],
): { canvas: HTMLElement; wField: HTMLInputElement; hField: HTMLInputElement } {
  const doc = dom.window.document;
  doc.body.innerHTML = '';
  const panel = doc.createElement('div');
  const canvas = doc.createElement('div');
  canvas.style.width = '1080px';
  canvas.style.height = '1080px';
  doc.body.append(panel, canvas);
  const manifest = {
    id: 'dims-probe', name: 'Dims Probe', version: '1.0.0', inputs,
    render: { width: 1080, height: 1080, formats: ['png', 'svg'], ...(layout ? { layout } : {}), ...render },
  };
  const runtime = {
    getModel: () => [], setInput: async () => {}, setInputNoHistory: async () => {},
    subscribe: () => {}, refresh: () => {}, hasFrameHook: false, isLive: () => false,
    export: async () => new dom.window.Blob(['x']),
  };
  const host = { assets: { query: async () => [] }, state: { save: async () => {} }, export: { download: async () => {} } };
  renderActions(
    panel as never, manifest as never, runtime as never, canvas, host as never,
    () => {}, (async (fn: () => unknown) => fn()) as never, {},
  );
  return {
    canvas,
    wField: panel.querySelector('[data-action="export-width"]') as HTMLInputElement,
    hField: panel.querySelector('[data-action="export-height"]') as HTMLInputElement,
  };
}

test('editor: a wider export size makes the artboard that exact size (no clamp)', () => {
  const { canvas, wField } = mountDims('editor');
  wField.value = '1920';
  wField.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.equal(canvas.style.width, '1920px', 'the artboard takes the true export width');
  assert.equal(canvas.style.height, '1080px', 'the untouched height stays put - no aspect distortion');
});

test('preview tool: the same change is CLAMPED to the native render size', () => {
  const { canvas, wField } = mountDims(); // no layout → preview thumbnail
  wField.value = '1920';
  wField.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  // previewScale = min(1, 1080/1920, 1080/1080) = 0.5625 → 1920*0.5625=1080, 1080*0.5625=608
  assert.equal(canvas.style.width, '1080px', 'the thumbnail longest side is capped at native');
  assert.equal(canvas.style.height, '608px', 'the thumbnail keeps the requested aspect, scaled down');
});

test('fixed-canvas editor (Org Chart): artboard stays native-locked - keeps the clamp', () => {
  // canvas.fixedCanvas keeps connector geometry 1:1 with box coords, so the artboard must
  // NOT grow to the export size even though it is layout:'editor'. Same clamp as a preview.
  const { canvas, wField } = mountDims('editor', {}, [{ id: 'boxes', type: 'blocks', canvas: { fixedCanvas: true } }]);
  wField.value = '1920';
  wField.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.equal(canvas.style.width, '1080px', 'a fixed-canvas editor is clamped, not resized to the export width');
});

test('carousel editor (render.pages): the page strip owns the size - no 1:1 resize', () => {
  // A carousel editor sets render.pages; the canvas is the page strip, owned by syncStrip.
  // (Real carousel tools also set render.dims:false so the fields are hidden; here we prove
  // the sizing branch alone excludes them.) It must take the clamp, not the artboard path.
  const { canvas, wField } = mountDims('editor', { pages: { count: 'n', width: 'w', height: 'h' } }, [{ id: 'boxes', type: 'blocks', canvas: {} }]);
  wField.value = '1920';
  wField.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.equal(canvas.style.width, '1080px', 'a carousel editor is clamped, not resized to the export width');
});

// ── 9. per-artboard still fan-out for the Design frame primitive ──────────────
// A multi-artboard Design doc - render.layout:'editor' with a boxes
// input declaring canvas.frameField - emits one [data-pdf-page] per frame box. A STILL
// export must fan out ONE image per artboard (a zip for several, a single file for one),
// matching carousel-maker (render.pages). The gate is the ONLY [data-pdf-page] fanout in
// the export path; render.paged (multi-page-pdf / doc-studio) must stay a single flat file,
// and a no-frames Design doc (single .artboard, zero page els) must stay a single flat file.

/** Mount the export bar over a canvas holding `pages` [data-pdf-page] els. Captures every
 *  runtime.export call's target node so we can tell a per-artboard fanout (calls that land
 *  on a [data-pdf-page]) from a single flat export (call lands on the whole canvas). */
function mountPaged(opts: {
  pages: number;
  render?: Record<string, unknown>;
  inputs?: unknown[];
  /** Frame ids to stamp as `data-frame-id`, page by page - what `?s=<id>` addresses.
   *  Omitted ⇒ unstamped pages, exactly as a plain render.pages carousel emits them. */
  ids?: Array<string | null>;
  /** Export defaults, i.e. the link: `{ slide }` is the `?s=` state address. */
  exportDefaults?: Record<string, unknown>;
}): {
  panel: HTMLElement;
  canvas: HTMLElement;
  pageExports: () => Array<{ format: string; opts: Record<string, unknown> }>;
  /** The `data-frame-id` of each per-page export target, in the order they ran. */
  pageIds: () => Array<string | null>;
  /** Filenames handed to host.export.download. */
  downloads: () => string[];
  download: () => void;
  setFormat: (f: string) => void;
} {
  const doc = dom.window.document;
  doc.body.innerHTML = '';
  const panel = doc.createElement('div');
  const canvas = doc.createElement('div');
  doc.body.append(panel, canvas);
  for (let i = 0; i < opts.pages; i++) {
    const p = doc.createElement('div');
    p.setAttribute('data-pdf-page', '');
    const id = opts.ids?.[i];
    if (id != null) p.setAttribute('data-frame-id', id);
    canvas.appendChild(p);
  }
  const pageExports: Array<{ format: string; opts: Record<string, unknown> }> = [];
  const pageIds: Array<string | null> = [];
  const downloads: string[] = [];
  const manifest = {
    id: 'design', name: 'Design', version: '1.0.0', inputs: opts.inputs ?? [],
    render: { width: 1080, height: 1080, formats: ['png', 'svg', 'pdf'], ...(opts.render ?? {}) },
  };
  const runtime = {
    getModel: () => [], setInput: async () => {}, setInputNoHistory: async () => {},
    subscribe: () => {}, refresh: () => {}, hasFrameHook: false, isLive: () => false,
    export: async (node: unknown, format: string, o: Record<string, unknown>) => {
      // Count only DOWNLOAD per-page exports, not the export-history thumbnail capture,
      // which (for render.paged) also targets the first [data-pdf-page] but sets thumbnail:true.
      if ((node as HTMLElement)?.matches?.('[data-pdf-page]') && o.thumbnail !== true) {
        pageExports.push({ format, opts: { ...o } });
        pageIds.push((node as HTMLElement).getAttribute('data-frame-id'));
      }
      return new dom.window.Blob(['x'], { type: 'image/png' });
    },
  };
  const host = {
    assets: { query: async () => [] }, state: { save: async () => {} },
    export: { download: async (_b: Blob, name: string) => { downloads.push(name); } },
  };
  renderActions(
    panel as never, manifest as never, runtime as never, canvas, host as never,
    () => {}, (async (fn: () => unknown) => fn()) as never, (opts.exportDefaults ?? {}) as never,
  );
  const setFormat = (f: string) => {
    const sel = panel.querySelector('[data-action="format"]') as HTMLSelectElement | null;
    if (sel) { sel.value = f; sel.dispatchEvent(new dom.window.Event('change', { bubbles: true })); }
  };
  setFormat('png');
  return {
    panel, canvas, setFormat, pageExports: () => pageExports,
    pageIds: () => pageIds, downloads: () => downloads,
    download: () => (panel.querySelector('[data-action="download"]') as HTMLElement)
      .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })),
  };
}

const FRAME_INPUT = [{ id: 'boxes', type: 'blocks', canvas: { frameField: 'frame' } }];

test('Design frame primitive: a multi-artboard doc fans a PNG out to one still per artboard', async () => {
  const h = mountPaged({ pages: 3, render: { layout: 'editor' }, inputs: FRAME_INPUT });
  h.download();
  await settle();
  assert.equal(h.pageExports().length, 3, 'three artboards → three per-page still exports (zipped downstream)');
  for (const e of h.pageExports()) assert.equal(e.format, 'png');
});

test('Design frame primitive: a single-artboard doc exports one flat still (still fans, one file)', async () => {
  const h = mountPaged({ pages: 1, render: { layout: 'editor' }, inputs: FRAME_INPUT });
  h.download();
  await settle();
  assert.equal(h.pageExports().length, 1, 'one artboard → a single per-page still (no zip downstream)');
});

test('Design with NO frames (zero page els) stays a single flat export', async () => {
  const h = mountPaged({ pages: 0, render: { layout: 'editor' }, inputs: FRAME_INPUT });
  h.download();
  await settle();
  assert.equal(h.pageExports().length, 0, 'no [data-pdf-page] → the flat whole-canvas path, never the fanout');
});

test('the frame arm requires canvas.frameField, not merely a boxes canvas (Org Chart is excluded)', async () => {
  // A fixed-canvas editor (org-chart) declares canvas but NO frameField. Even if page els
  // were somehow present, the gate must not fan out - it renders a single .artboard.
  const h = mountPaged({ pages: 2, render: { layout: 'editor' }, inputs: [{ id: 'boxes', type: 'blocks', canvas: { fixedCanvas: true } }] });
  h.download();
  await settle();
  assert.equal(h.pageExports().length, 0, 'no frameField → hasFrames false → no per-artboard fanout');
});

test('render.paged (multi-page-pdf / doc-studio) is NOT admitted to the still fanout', async () => {
  // render.paged marks the paged document tools whose SVG/still export must stay ONE
  // whole-canvas file. It carries no frameField and no render.pages, so it must not fan out.
  const h = mountPaged({ pages: 4, render: { layout: 'document', paged: true }, inputs: [] });
  h.download();
  await settle();
  assert.equal(h.pageExports().length, 0, 'render.paged stays a single whole-canvas file - never per-page stills');
});

test('carousel-maker (render.pages) keeps fanning out unchanged', async () => {
  const h = mountPaged({ pages: 2, render: { pages: { count: 'n', width: 'w', height: 'h' } }, inputs: [{ id: 'slides', type: 'blocks', canvas: {} }] });
  h.download();
  await settle();
  assert.equal(h.pageExports().length, 2, 'render.pages fans out per page exactly as before the frame arm was added');
});

test('a framed still fanout drops the inert cuts opt from the per-page render', async () => {
  // A framed timed doc still-export routes to per-artboard fanout (precedence over the
  // whole-timeline cuts contact sheet, which only applies to a [data-sequence] stage). The
  // per-page opts must not carry a stray cuts value.
  const h = mountPaged({ pages: 2, render: { layout: 'editor' }, inputs: FRAME_INPUT });
  h.download();
  await settle();
  for (const e of h.pageExports()) assert.equal('cuts' in e.opts, false, 'cuts is deleted from the per-artboard opts');
});

// ── 10. print marks & bleed are OFF by default for RGB vector output ──────────
// PRINT_MARK_FORMATS says which formats CAN carry marks (pdf/svg/eps included);
// print INTENT is only the separating press formats (pdf-cmyk / cmyk-tiff /
// eps-cmyk), an explicit ?bleed=/?marks= (or saved) setting, a manual toggle, or
// a manifest that declares render.printMarks: true. An everyday PDF or SVG must
// export trim-sized with no marks - and physical units (mm + dpi) are a size
// statement, never print intent.

interface PrintDefaults { format?: string; bleed?: string; marks?: Record<string, boolean> | null; unit?: string; dpi?: number }

/** Mount the export bar for a plain (non-sequence) tool and expose the print card. */
function mountPrintCard({ formats = ['png', 'pdf', 'svg', 'pdf-cmyk'], exportDefaults = {}, printMarks }:
  { formats?: string[]; exportDefaults?: PrintDefaults; printMarks?: boolean } = {}) {
  const doc = dom.window.document;
  doc.body.innerHTML = '';
  const panel = doc.createElement('div');
  const canvas = doc.createElement('div');
  doc.body.append(panel, canvas);

  const seen: Array<{ format: string; opts: Record<string, unknown> }> = [];
  const manifest = {
    id: 'qr-code', name: 'QR Code', version: '1.0.0', inputs: [],
    render: { width: 800, height: 600, formats, ...(printMarks === undefined ? {} : { printMarks }) },
  };
  const runtime = {
    getModel: () => [], setInput: async () => {}, setInputNoHistory: async () => {},
    subscribe: () => {}, refresh: () => {}, hasFrameHook: false, isLive: () => false,
    export: async (_node: unknown, format: string, opts: Record<string, unknown>) => {
      seen.push({ format, opts: { ...opts } });
      return new dom.window.Blob(['x'], { type: 'application/pdf' });
    },
  };
  const host = {
    assets: { query: async () => [] },
    state: { save: async () => {} },
    export: { download: async () => {} },
  };
  renderActions(
    panel as never, manifest as never, runtime as never, canvas, host as never,
    () => {}, (async (fn: () => unknown) => fn()) as never, exportDefaults as never,
  );
  return {
    panel,
    enable: () => panel.querySelector('[data-action="print-enable"]') as HTMLInputElement | null,
    card: () => panel.querySelector('.export-print') as HTMLElement | null,
    mark: (a: string) => panel.querySelector(`[data-action="${a}"]`) as HTMLInputElement,
    downloads: () => seen.filter(e => typeof e.opts.onProgress === 'function'),
    setFormat: (f: string) => {
      const sel = panel.querySelector('[data-action="format"]') as HTMLSelectElement;
      sel.value = f;
      sel.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    },
    toggleEnable: (on: boolean) => {
      const en = panel.querySelector('[data-action="print-enable"]') as HTMLInputElement;
      en.checked = on;
      en.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    },
    download: () => (panel.querySelector('[data-action="download"]') as HTMLElement)
      .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })),
  };
}

test('an everyday PDF starts with the print card OFF and exports no bleed and no marks', async () => {
  const h = mountPrintCard({ exportDefaults: { format: 'pdf' } });
  assert.ok(h.card(), 'the card is still OFFERED for pdf - capability is not the question');
  assert.equal(h.enable()!.checked, false, 'but its master toggle starts off');
  h.download();
  await settle();
  assert.equal(h.downloads().length, 1);
  assert.equal(h.downloads()[0]!.format, 'pdf');
  const opts = h.downloads()[0]!.opts;
  for (const k of ['bleed', 'cropMarks', 'registrationMarks', 'bleedMarks', 'colorBars', 'provenance']) {
    assert.equal(k in opts, false, `a default pdf export must not carry ${k}`);
  }
});

test('SVG starts with the print card OFF and exports no bleed and no marks', async () => {
  const h = mountPrintCard({ exportDefaults: { format: 'svg' } });
  assert.equal(h.enable()!.checked, false);
  h.download();
  await settle();
  const opts = h.downloads()[0]!.opts;
  assert.equal(h.downloads()[0]!.format, 'svg');
  for (const k of ['bleed', 'cropMarks', 'registrationMarks', 'bleedMarks']) {
    assert.equal(k in opts, false, `a default svg export must not carry ${k}`);
  }
});

test('a separating press format still defaults the card ON - PDF/X behaviour unchanged', async () => {
  const h = mountPrintCard({ exportDefaults: { format: 'pdf-cmyk' } });
  assert.equal(h.enable()!.checked, true, 'Print PDF is print intent by definition');
  h.download();
  await settle();
  const opts = h.downloads()[0]!.opts;
  assert.equal(opts.cropMarks, true);
  assert.equal(opts.registrationMarks, true);
  assert.equal(opts.bleedMarks, true);
  assert.equal(opts.colorBars, true, 'colour bars default on for a CMYK press format');
  assert.equal(opts.bleed, '3mm', 'the print-standard default bleed');
  assert.equal(opts.barStyle, 'cmyk-verify');
});

test('format switches re-apply the intent default in both directions', () => {
  const h = mountPrintCard({ exportDefaults: { format: 'png' } });
  h.setFormat('pdf');
  assert.equal(h.enable()!.checked, false, 'pdf: card shown, toggle off');
  h.setFormat('pdf-cmyk');
  assert.equal(h.enable()!.checked, true, 'press format: toggle on');
  h.setFormat('svg');
  assert.equal(h.enable()!.checked, false, 'svg: back off');
});

test('a manual toggle is an explicit request - it exports marks and survives format switches', async () => {
  const h = mountPrintCard({ exportDefaults: { format: 'pdf' } });
  h.toggleEnable(true);
  h.setFormat('svg');
  assert.equal(h.enable()!.checked, true, 'the user asked; the per-format auto-close must stand down');
  h.download();
  await settle();
  const opts = h.downloads()[0]!.opts;
  assert.equal(opts.cropMarks, true);
  assert.equal(opts.bleed, '3mm');
  assert.equal(opts.barStyle, 'rgb-swatches', 'RGB output paints brand swatches, not a CMYK verify bar');
});

test('an explicit marks (link/save) default turns the card on for a plain pdf', () => {
  const h = mountPrintCard({ exportDefaults: {
    format: 'pdf',
    marks: { crop: true, registration: false, bleed: false, colorBars: false, provenance: false },
  } });
  assert.equal(h.enable()!.checked, true, '?marks= is an explicit request');
  assert.equal(h.mark('mark-crop').checked, true);
  assert.equal(h.mark('mark-reg').checked, false, 'the linked mark set restores exactly');
});

test('an explicit bleed (link/save) default turns the card on for a plain pdf', () => {
  const h = mountPrintCard({ exportDefaults: { format: 'pdf', bleed: '5mm' } });
  assert.equal(h.enable()!.checked, true, '?bleed= is an explicit request');
  assert.equal((h.panel.querySelector('[data-action="print-bleed"]') as HTMLInputElement).value, '5');
});

test('physical units + dpi are NOT print intent', () => {
  const h = mountPrintCard({ exportDefaults: { format: 'pdf', unit: 'mm', dpi: 300 } });
  assert.equal(h.enable()!.checked, false, 'an A4 pdf is a size statement, not a print order');
  const s = mountPrintCard({ exportDefaults: { format: 'svg', unit: 'in', dpi: 150 } });
  assert.equal(s.enable()!.checked, false);
});

test('a manifest declaring render.printMarks: true IS print intent - the card defaults on', () => {
  const h = mountPrintCard({ exportDefaults: { format: 'pdf' }, printMarks: true });
  assert.equal(h.enable()!.checked, true, 'declared intent covers the RGB print-capable formats too');
  h.setFormat('svg');
  assert.equal(h.enable()!.checked, true);
  h.setFormat('png');
  assert.equal(h.enable()!.checked, false, 'png cannot carry marks - never on');
});

test('render.printMarks: false still hides the card entirely', () => {
  const h = mountPrintCard({ exportDefaults: { format: 'pdf' }, printMarks: false });
  assert.equal(h.card(), null);
  assert.equal(h.enable(), null);
});

// ── 10. the `?s=` still-export filter (plan 112 section 10) ───────────────────
// A framed document exports one still PER PAGE. `?s=` narrows that fan-out to the one
// addressed slide - which is what makes `?s=2&format=png` a per-slide image link (and buys
// per-slide embeds/OG later). WHAT an address means is the engine's (frame-address.ts, so
// the CLI's `--s=` picks the same page from the same string); what is guarded here is the
// wiring: the pick reaches the fan-out, one page downloads as one clean file rather than a
// zip, and - the part that matters most - an address naming nothing never quietly becomes
// slide 1. A wrong slide under the right filename is the failure mode this must not have.

const SLIDE_IDS = ['intro', 'pricing', 'thanks'];

test('?s= absent: every page still fans out, exactly as before the filter existed', async () => {
  const h = mountPaged({ pages: 3, render: { layout: 'editor' }, inputs: FRAME_INPUT, ids: SLIDE_IDS });
  h.download();
  await settle();
  assert.deepEqual(h.pageIds(), SLIDE_IDS);
});

test('?s=2 exports ONLY that slide, as a single clean file (not a zip of one)', async () => {
  const h = mountPaged({
    pages: 3, render: { layout: 'editor' }, inputs: FRAME_INPUT, ids: SLIDE_IDS,
    exportDefaults: { format: 'png', filename: 'deck', slide: '2' },
  });
  h.download();
  await settle();
  assert.deepEqual(h.pageIds(), ['pricing'], 'a positional address counts pages from 1');
  assert.deepEqual(h.downloads(), ['deck.png'], 'one page → one file under the plain name');
});

test('?s=<frame id> addresses a slide wherever it sits (reorder-proof)', async () => {
  const h = mountPaged({
    pages: 3, render: { layout: 'editor' }, inputs: FRAME_INPUT, ids: SLIDE_IDS,
    exportDefaults: { format: 'png', slide: 'thanks' },
  });
  h.download();
  await settle();
  assert.deepEqual(h.pageIds(), ['thanks']);
});

test('?s=2.3 - the build suffix still exports that whole slide (builds are presenter-only)', async () => {
  const h = mountPaged({
    pages: 3, render: { layout: 'editor' }, inputs: FRAME_INPUT, ids: SLIDE_IDS,
    exportDefaults: { format: 'png', slide: '2.3' },
  });
  h.download();
  await settle();
  assert.deepEqual(h.pageIds(), ['pricing']);
});

test('an ?s= that names nothing exports the WHOLE deck - never a silent slide 1', async () => {
  for (const bad of ['9', '0', 'nope']) {
    const h = mountPaged({
      pages: 3, render: { layout: 'editor' }, inputs: FRAME_INPUT, ids: SLIDE_IDS,
      exportDefaults: { format: 'png', slide: bad },
    });
    h.download();
    await settle();
    assert.deepEqual(h.pageIds(), SLIDE_IDS, `?s=${bad} names no slide - the deck exports whole`);
  }
});

test('?s= on an unstamped paged tool still works positionally', async () => {
  // A carousel (render.pages) emits [data-pdf-page] without frame ids: a number is the
  // only address it can answer, and it must still answer it.
  const h = mountPaged({ pages: 3, render: { pages: { count: 'n' } }, exportDefaults: { format: 'png', slide: '3' } });
  h.download();
  await settle();
  assert.equal(h.pageExports().length, 1, 'the third page, and only it');
});

// ── 6. Cancel - the abort signal the shutter's button trips ──────────────────
// Audit finding T1: the status block could only ever offer Hide because no export
// carried a way to stop. Every shuttered export now creates one controller, passes
// its signal in the export opts, and hands the abort to the shutter as onCancel -
// so the two are the SAME controller, which is the half that could silently break.

test('a shuttered export passes an abort signal, and its onCancel aborts THAT signal', async () => {
  const h = mount({ seqMs: 6000 });
  h.download();
  await settle();
  const exp = h.downloads()[0]!;
  const signal = exp.opts.signal as AbortSignal;
  assert.ok(signal instanceof AbortSignal, 'the export must be cancellable at all');
  assert.equal(signal.aborted, false);

  const call = h.unscaled().find(c => c.shutter) as { onCancel?: () => void } | undefined;
  assert.equal(typeof call?.onCancel, 'function', 'the shutter needs the abort to label its button Cancel');
  call!.onCancel!();
  assert.equal(signal.aborted, true, 'the button and the export must share one controller');
  assert.equal((signal.reason as { name?: string })?.name, 'AbortError',
    'the one shape every cancelled export path arrives in');
});

// ── 7. The provenance ask after a real export (plans/137 WP-E) ───────────────
// "Add your details to what you make?" belongs to the moment a file has actually
// been made, not to a cold gallery visit. The panel asks once per profile and
// writes the same flag the gallery toast reads, so the two can never both ask.

test('a finished export offers the details ask once, and spends the flag', async () => {
  const h = mount({ seqMs: null, formats: ['png'], profile: { firstname: 'Ada' } });
  h.download();
  await settle();
  const ask = h.ask();
  assert.ok(ask, 'the line must appear after the file has gone');
  assert.equal(ask!.querySelector('a')?.getAttribute('href'), '#/profile?focus=use-details');
  assert.deepEqual(h.profileWrites(), [{ firstname: 'Ada', personalizeNudgeDismissed: true }],
    'showing it retires the gallery toast for this profile - and keeps the rest of the profile');

  h.download();
  await settle();
  assert.equal(h.panel.querySelectorAll('.export-details-ask').length, 1, 'never a second line');
  assert.equal(h.profileWrites().length, 1, 'and never a second write');
});

test('no ask for someone already opted in, or who already answered it', async () => {
  for (const profile of [{ useDetails: true }, { personalizeNudgeDismissed: true }]) {
    const h = mount({ seqMs: null, formats: ['png'], profile });
    h.download();
    await settle();
    assert.equal(h.ask(), null, JSON.stringify(profile));
    assert.deepEqual(h.profileWrites(), [], 'nothing to ask means nothing to write');
  }
});

test('a host with no profile store exports exactly as before', async () => {
  const h = mount({ seqMs: null, formats: ['png'] });
  h.download();
  await settle();
  assert.equal(h.ask(), null);
  assert.equal(h.downloads().length, 1, 'the export itself is untouched');
});

// ── 11. sheet order: timing sits with size, not at the bottom of the chip strip ──
// plans/163 F17. "Start after" / Duration used to be the last child of the unlabeled
// settings chip strip, below the audio card - so for a video the length of the clip
// ranked under the music bed's ducking level. They are a size-like decision, so the
// row belongs directly under the dimensions and above every format card.

/** Index of the first element matching `sel` among the panel's direct children. */
function rowIndex(panel: HTMLElement, sel: string): number {
  return [...panel.children].findIndex(c => c.matches(sel));
}

test('the timing row sits directly after dims and above the format cards', () => {
  const h = mount({ seqMs: null, formats: ['webm', 'mp4', 'png'] });
  const dims = rowIndex(h.panel, '.export-dims');
  const timing = rowIndex(h.panel, '[data-anim-params]');
  assert.ok(dims >= 0 && timing >= 0, 'both rows are in the panel at all');
  assert.equal(timing, dims + 1, 'timing is the row immediately after the dimensions');
  for (const later of ['.export-hdr', '.export-protection', '.export-audio', '.export-settings']) {
    const i = rowIndex(h.panel, later);
    if (i >= 0) assert.ok(i > timing, `${later} must rank below the timing row`);
  }
  assert.equal(h.panel.querySelector('.export-settings [data-anim-params]'), null,
    'and it has left the ancillary chip strip entirely');
});

test('the timing labels read as words, with a help tip on the pair', () => {
  const h = mount({ seqMs: null, formats: ['webm', 'png'] });
  const row = h.panel.querySelector('[data-anim-params]') as HTMLElement;
  assert.match(row.textContent ?? '', /Start after/, '"Wait" was jargon for a hold before recording');
  assert.doesNotMatch(row.textContent ?? '', /\bWait\b/);
  assert.ok(row.querySelector('.help-tip-host .help-tip-btn'), 'the pair carries the standard (i)');
  const live = h.liveLabel()!;
  assert.ok(live.querySelector('.help-tip-btn'), 'Record live had only a title= - now a real tip');
  assert.equal(live.getAttribute('title'), null, 'and the title is not left behind as a second copy');
});

// ── 12. Convert paths renders the help the engine already wrote (F18) ──────────
// engine/src/inputs.ts injects the export-option inputs WITH a `help` string. The
// chip renderer dropped it, which made the one piece of jargon in the sheet the one
// with an unreadable answer attached.

test('an export-option chip renders its engine help as the standard (i)', () => {
  const doc = dom.window.document;
  doc.body.innerHTML = '';
  const panel = doc.createElement('div');
  const canvas = doc.createElement('div');
  doc.body.append(panel, canvas);
  const model = [
    { id: 'convertPaths', label: 'Convert paths', type: 'boolean', group: 'export', control: 'checkbox',
      value: true, help: 'Outline text as vector paths so SVG/PDF render identically.' },
    { id: 'transparent', label: 'Transparent', type: 'boolean', group: 'export', control: 'checkbox', value: false },
  ];
  const runtime = {
    getModel: () => model, setInput: async () => {}, setInputNoHistory: async () => {},
    subscribe: () => {}, refresh: () => {}, hasFrameHook: false, isLive: () => false,
    export: async () => new dom.window.Blob(['x']),
  };
  const host = { assets: { query: async () => [] }, state: { save: async () => {} }, export: { download: async () => {} } };
  renderActions(
    panel as never, { id: 't', name: 'T', version: '1.0.0', inputs: [], render: { width: 8, height: 8, formats: ['svg', 'png'] } } as never,
    runtime as never, canvas, host as never, () => {}, (async (fn: () => unknown) => fn()) as never, {},
  );
  const chip = panel.querySelector('.export-option:has([data-input-id="convertPaths"])') as HTMLElement;
  assert.ok(chip, 'the chip still renders');
  assert.match(chip.textContent ?? '', /Convert paths/, 'the label is the engine\'s, unrelabelled');
  assert.ok(chip.classList.contains('help-tip-host'), 'the chip anchors its own tip');
  assert.match(chip.querySelector('.help-tip-pop')?.textContent ?? '', /Outline text as vector paths/);
  const plain = panel.querySelector('.export-option:has([data-input-id="transparent"])') as HTMLElement;
  assert.equal(plain.querySelector('.help-tip-btn'), null, 'an option with no help gets no empty (i)');
});

// ── 13. Destinations are ONE row, not a card per provider (F23) ───────────────
// Every registered target used to paint a full .section-card with an icon head and a
// full-width button - the same weight as Content protection, and heavier than
// Download, for someone who has never connected a cloud.

test('every send destination shares one "Send to" row', async () => {
  const { registerSendTarget, unregisterSendTarget } = await import('../lib/send-target.ts');
  const mk = (kind: string, label: string) => ({
    kind, label, available: () => true,
    actionLabel: () => `Send to ${label}`,
    send: async () => ({ label: 'done' }),
  });
  registerSendTarget(mk('testcloud', 'Test Cloud'));
  registerSendTarget(mk('testdrive', 'Test Drive'));
  try {
    const h = mount({ seqMs: null, formats: ['png'] });
    const cards = h.panel.querySelectorAll('.export-send');
    assert.equal(cards.length, 1, 'one card for the whole destination list');
    assert.match(cards[0]!.querySelector('.c2pa-head')?.textContent ?? '', /Send to/,
      'the head names the job once');
    const btns = [...cards[0]!.querySelectorAll('[data-send-kind]')];
    assert.deepEqual(btns.map(b => b.getAttribute('data-send-kind')), ['testcloud', 'testdrive'],
      'the click delegation still keys off data-send-kind');
    assert.deepEqual(btns.map(b => b.querySelector('span')?.textContent), ['Test Cloud', 'Test Drive'],
      'each button is the provider NAME - the head already said "Send to"');
    assert.equal(cards[0]!.querySelectorAll('.export-send-row').length, 1, 'they wrap in one row');
    assert.equal(cards[0]!.querySelectorAll('[data-send-status]').length, 2,
      'and each keeps its own outcome line');
  } finally {
    unregisterSendTarget('testcloud');
    unregisterSendTarget('testdrive');
  }
});

// ── 14. one vocabulary for the credential lifetime (F25) ──────────────────────
// /profile calls the identical 7/30/90/365 select "Verified for"; the export sheet
// said "Expires:" and said it untranslated.

test('the credential lifetime label matches the profile view, translated', () => {
  const h = mount({ seqMs: null, formats: ['png'] });
  const label = h.panel.querySelector('.c2pa-life-label') as HTMLElement;
  assert.equal(label.textContent, 'Verified for');
});

// ── 15. transparency, mirrored from the sidebar (F22) ─────────────────────────
// `transparentBg` is a SIDEBAR input (the engine synthesises it that way, and the
// engine is not changing), but people go looking for it while they are exporting a
// PNG. The sheet gets a second view of the same input - never a second setting - and
// only for a format with an alpha channel to keep.

const TRANSPARENT_INPUT = {
  id: 'transparentBg', label: 'Transparent background', type: 'boolean', control: 'checkbox',
  value: false, help: 'Remove the background fill so alpha-supporting formats keep transparency.',
};

const mirror = (h: Harness): HTMLInputElement | null =>
  h.panel.querySelector('[data-action="transparent-bg"]');

test('the transparency mirror renders only for a tool that has the input', () => {
  assert.ok(mirror(mount({ seqMs: null, formats: ['png'], model: [TRANSPARENT_INPUT] })),
    'a tool with render.transparentBg gets the chip');
  assert.equal(mirror(mount({ seqMs: null, formats: ['png'] })), null,
    'a tool without the input gets nothing');
});

test('the mirror wears the engine label and its help tip', () => {
  const h = mount({ seqMs: null, formats: ['png'], model: [TRANSPARENT_INPUT] });
  const chip = mirror(h)!.closest('label') as HTMLElement;
  assert.match(chip.textContent ?? '', /Transparent background/);
  assert.ok(chip.classList.contains('help-tip-host'), 'the engine help text is offered, not dropped');
});

test('the mirror is shown for alpha formats and hidden for the rest', () => {
  const h = mount({ seqMs: null, formats: ['png', 'jpg', 'svg', 'pdf'], model: [TRANSPARENT_INPUT] });
  const chip = mirror(h)!.closest('label') as HTMLElement;
  assert.equal(chip.style.display, 'flex', 'png opens on it');
  h.setFormat('jpg');
  assert.equal(chip.style.display, 'none', 'a JPEG has no alpha to keep');
  h.setFormat('svg');
  assert.equal(chip.style.display, 'flex');
  h.setFormat('pdf');
  assert.equal(chip.style.display, 'none');
});

test('ticking the mirror writes through to the one input it reflects', () => {
  const h = mount({ seqMs: null, formats: ['png'], model: [TRANSPARENT_INPUT] });
  const box = mirror(h)!;
  box.checked = true;
  box.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  assert.deepEqual(h.inputWrites(), [{ id: 'transparentBg', value: true }],
    'the sheet sets the input - it does not keep a second copy of the setting');
});

test('the sidebar moving the input re-syncs the mirror', () => {
  const h = mount({ seqMs: null, formats: ['png'], model: [TRANSPARENT_INPUT] });
  assert.equal(mirror(h)!.checked, false);
  h.setModel('transparentBg', true);          // the sidebar toggle, from the panel's side
  assert.equal(mirror(h)!.checked, true, 'the two views must agree');
  h.setModel('transparentBg', false);
  assert.equal(mirror(h)!.checked, false);
});

// ── 16. the export shape is remembered per tool (L3) ──────────────────────────
// A successful Download writes {format, width, height, unit, dpi} through
// host.state - never localStorage - under the hidden `__xprefs__:` slot, so the
// next fresh mount of the tool opens on it. See lib/export-prefs.test.ts for the
// precedence rule on the way back in.

test('a finished download remembers the shape it was exported at', async () => {
  const h = mount({ seqMs: null, formats: ['png'], toolId: 'qr-code' });
  (h.panel.querySelector('[data-action="export-width"]') as HTMLInputElement).value = '1080';
  (h.panel.querySelector('[data-action="export-height"]') as HTMLInputElement).value = '1080';
  h.download();
  await settle();

  const write = h.stateWrites().find(w => w.slot.startsWith('__xprefs__:'));
  assert.ok(write, 'the download path writes the remembered shape');
  assert.equal(write.slot, '__xprefs__:qr-code', 'one slot per tool');
  assert.deepEqual(write.data, { format: 'png', width: 1080, height: 1080, unit: 'px', dpi: 300 });
});

test('nothing is remembered when nothing was downloaded', () => {
  const h = mount({ seqMs: null, formats: ['png'], toolId: 'qr-code' });
  assert.deepEqual(h.stateWrites().filter(w => w.slot.startsWith('__xprefs__:')), []);
});
