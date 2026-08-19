// SPDX-License-Identifier: MPL-2.0
/**
 * Generated thumbnails for TEXT assets - the text sibling of the audio waveform
 * thumbs (views/picker.ts mountAudioThumbs), built to the same contract: a calm
 * glyph placeholder in the markup, a lazy queue that only touches tiles the user
 * scrolls to, a brand-colour pool resolved once per mount, and the glyph as the
 * honest fallback when anything fails.
 *
 * What a tile shows, and why:
 *  - An EXCERPT of the text, not all of it - sized down as the document grows
 *    (a short quote renders big, a long document renders as a tiny wall), so
 *    length itself becomes a recognisable shape.
 *  - The excerpt is FOCUSED on the hottest AI-signal region when one exists,
 *    with context before and after, and the flagged spans wear the same
 *    cat-hl--tN heat marks as the reading views - for large bits of copy, the
 *    AI-likely area IS the focal point people are scanning for.
 *  - A deterministic brand-palette ink per asset (the audio thumbs' own
 *    audioThumbInk hash, so the same asset keeps the same colour forever -
 *    wayfinding, not decoration). The ink drives a faint background wash;
 *    body text stays in foreground ink, because the pool's contrast floor is
 *    tuned for big shapes, not 7px type.
 *  - A faint score DONUT in the corner (the same 0-100 arc as the panel gauge)
 *    when the text carries signals, so "which assets have AI-likely content"
 *    reads across a whole grid without opening anything.
 *
 * DOM built with createElement/textContent only - no raw-HTML sink.
 */

import { analyzeTextSignals } from '@lolly/engine';
import { audioThumbPool, audioThumbInk, type ThumbTheme } from './audio-thumb-colour.ts';
import { livePalette } from './live-palette.ts';

/** One run of the excerpt: plain text, or a heat-marked span (bucket 1-5). */
export interface TextThumbRun {
  text: string;
  /** Present on a flagged run: the 5-step temperature bucket (t1 cool - t5 hot). */
  bucket?: 1 | 2 | 3 | 4 | 5;
}

export interface TextThumbModel {
  /** Type-size class by TOTAL document length: xl (quote) - sm (tiny wall). */
  size: 'xl' | 'lg' | 'md' | 'sm';
  runs: TextThumbRun[];
  /** The 0-100 signal score of the analysed slice (drives the corner donut). */
  score: number;
  band: 'none' | 'weak' | 'notable' | 'strong';
}

/** A flagged span in the analysed slice. */
export interface ThumbMark {
  index: number;
  length: number;
  heat: number;
}

/** Only this much of a document is fetched into the analyser for a thumbnail. */
export const TEXT_THUMB_ANALYSIS_CAP = 32 * 1024;
/** Excerpt window: context ahead of the focus, and the total excerpt budget. */
const CONTEXT_BEFORE = 80;
const EXCERPT_CHARS = 300;

/** Heat 0-1 → the 5-step bucket (mirrors views/valid-text.ts heatBucket; restated
 *  here because lib must not import views). */
function bucketOf(heat: number): 1 | 2 | 3 | 4 | 5 {
  if (heat >= 0.8) return 5;
  if (heat >= 0.6) return 4;
  if (heat >= 0.45) return 3;
  if (heat >= 0.3) return 2;
  return 1;
}

/** Total document length → the tile's type-size class. */
export function textThumbSize(totalChars: number): TextThumbModel['size'] {
  if (totalChars <= 90) return 'xl';
  if (totalChars <= 280) return 'lg';
  if (totalChars <= 900) return 'md';
  return 'sm';
}

/** Snap an index forward to just past the next space (never past `max`). */
function snapForward(text: string, i: number, max: number): number {
  if (i <= 0) return 0;
  const sp = text.indexOf(' ', i);
  return sp >= 0 && sp + 1 < max ? sp + 1 : i;
}

/** Snap an index back to the last space before it (never before `min`). */
function snapBack(text: string, i: number, min: number): number {
  if (i >= text.length) return text.length;
  const sp = text.lastIndexOf(' ', i);
  return sp > min ? sp : i;
}

/**
 * The excerpt: a window of the text FOCUSED on the hottest flagged span (context
 * before and after it), or the head of the document when nothing is flagged.
 * Marks are clipped and re-based into the window; an ellipsis run marks each cut
 * edge. Pure and exported for its test.
 */
export function textThumbExcerpt(text: string, marks: readonly ThumbMark[]): TextThumbRun[] {
  const focus = marks.length
    ? marks.reduce((a, b) => (b.heat > a.heat ? b : a))
    : null;
  let start = focus ? Math.max(0, focus.index - CONTEXT_BEFORE) : 0;
  start = snapForward(text, start, focus ? focus.index : text.length);
  let end = Math.min(text.length, start + EXCERPT_CHARS);
  if (end < text.length) end = snapBack(text, end, focus ? focus.index + focus.length : start + 1);
  if (end <= start) end = Math.min(text.length, start + EXCERPT_CHARS);

  const inWindow = marks
    .filter((m) => m.index < end && m.index + m.length > start)
    .map((m) => ({
      index: Math.max(m.index, start),
      end: Math.min(m.index + m.length, end),
      heat: m.heat,
    }))
    .sort((a, b) => a.index - b.index);

  const runs: TextThumbRun[] = [];
  if (start > 0) runs.push({ text: '… ' });
  let pos = start;
  for (const m of inWindow) {
    if (m.index > pos) runs.push({ text: text.slice(pos, m.index) });
    if (m.end > Math.max(pos, m.index)) {
      runs.push({ text: text.slice(Math.max(pos, m.index), m.end), bucket: bucketOf(m.heat) });
      pos = m.end;
    }
  }
  if (pos < end) runs.push({ text: text.slice(pos, end) });
  if (end < text.length) runs.push({ text: ' …' });
  return runs;
}

/** Analyse a text slice into the thumb model. Pure given the slice. */
export function textThumbModel(slice: string, totalChars: number): TextThumbModel {
  const report = analyzeTextSignals(slice, { source: 'digital' });
  const marks: ThumbMark[] = [];
  for (const f of report.findings) {
    if (f.kind === 'ai-span') continue; // the region note would swallow the precise spans
    for (const s of f.spans ?? []) marks.push({ index: s.index, length: s.length, heat: f.heat });
  }
  return {
    size: textThumbSize(totalChars),
    runs: textThumbExcerpt(slice, marks),
    score: report.score,
    band: report.band,
  };
}

// ── The mount (the audio-thumbs contract, minus the decode) ──────────────────

type Lookup = (id: string) => { id: string; url: string; version?: string; type: string } | undefined;

/** Built models, kept across re-renders (id|version keyed - an edited asset gets
 *  a new version and therefore a fresh model). Module-level like memoPeaks. */
const modelCache = new Map<string, TextThumbModel>();
const MAX_WORKERS = 4;

/** The tile surface's light/dark, MEASURED - a copy of mountAudioThumbs's helper
 *  (views/picker.ts): the theme attribute has three values and `brand` can be
 *  either, so the real background decides. */
function measuredTheme(root: Element): ThumbTheme {
  try {
    const bg = getComputedStyle(root).backgroundColor || getComputedStyle(document.body).backgroundColor;
    const m = /rgba?\(([^)]+)\)/.exec(bg);
    if (m) {
      const [r, g, b] = m[1]!.split(',').map((v) => Number.parseFloat(v));
      if (Number.isFinite(r!) && Number.isFinite(g!) && Number.isFinite(b!)) {
        return (0.299 * r! + 0.587 * g! + 0.114 * b!) < 128 ? 'dark' : 'light';
      }
    }
  } catch { /* fall through to the attribute */ }
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** The faint corner donut: the panel gauge's 0-100 arc, echoed subtly. */
function ringSvg(score: number, band: TextThumbModel['band']): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 64 64');
  svg.setAttribute('class', 'cat-ttxt-ring');
  svg.setAttribute('data-band', band);
  svg.setAttribute('aria-hidden', 'true');
  const c = 2 * Math.PI * 26;
  const track = document.createElementNS(SVG_NS, 'circle');
  const fill = document.createElementNS(SVG_NS, 'circle');
  for (const [el, cls] of [[track, 'cat-ttxt-ring-track'], [fill, 'cat-ttxt-ring-fill']] as const) {
    el.setAttribute('cx', '32'); el.setAttribute('cy', '32'); el.setAttribute('r', '26');
    el.setAttribute('class', cls);
  }
  fill.setAttribute('stroke-dasharray', `${((Math.max(0, Math.min(100, score)) / 100) * c).toFixed(2)} ${c.toFixed(2)}`);
  svg.append(track, fill);
  return svg;
}

/**
 * Upgrade every `[data-text-thumb]` tile under `root` to a generated text
 * thumbnail. Same shape as mountAudioThumbs: lazy (IntersectionObserver),
 * concurrency-capped, glyph-fallback, teardown via the returned destroy().
 */
export function mountTextThumbs(
  root: Element,
  host: unknown,
  lookup: Lookup,
  isCurrent: () => boolean,
): { destroy(): void } {
  let live = true;
  const queue: HTMLElement[] = [];
  const done = new WeakSet<HTMLElement>();
  let workers = 0;
  let pool: string[] = [];
  const painted = new Set<WeakRef<HTMLElement>>();

  const paint = (el: HTMLElement, id: string, model: TextThumbModel): void => {
    if (!live || !isCurrent() || !el.isConnected) return;
    el.replaceChildren();
    el.classList.add('cat-ttxt', `cat-ttxt--${model.size}`);
    const ink = audioThumbInk(id, pool);
    if (ink) el.style.setProperty('--ttxt-ink', ink.hex);
    if (model.score >= 20) el.appendChild(ringSvg(model.score, model.band));
    const body = document.createElement('div');
    body.className = 'cat-ttxt-body';
    for (const run of model.runs) {
      if (run.bucket == null) {
        body.appendChild(document.createTextNode(run.text));
      } else {
        const mark = document.createElement('mark');
        mark.className = `cat-hl cat-hl--t${run.bucket} cat-ttxt-hl`;
        mark.textContent = run.text;
        body.appendChild(mark);
      }
    }
    el.appendChild(body);
    // FIT the type to the box: binary-search the largest font-size whose excerpt
    // still fits (the ring is absolute, so el.scrollHeight measures the text
    // alone). The length bucket stays as the weight/line-height look; the size
    // itself is measured, so a short quote fills its tile and a long excerpt
    // shrinks instead of clipping mid-line. ~6 layout passes per visible tile.
    if (el.clientHeight > 0) {
      const fits = (): boolean =>
        el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1;
      let lo = 5;
      let hi = 26;
      while (hi - lo > 0.5) {
        const mid = (lo + hi) / 2;
        body.style.fontSize = `${mid}px`;
        if (fits()) lo = mid;
        else hi = mid;
      }
      body.style.fontSize = `${lo}px`;
    }
    painted.add(new WeakRef(el));
  };

  const repaintPainted = (): void => {
    for (const ref of painted) {
      const el = ref.deref();
      if (!el?.isConnected) { painted.delete(ref); continue; }
      const id = el.dataset.textThumb ?? '';
      const ink = id ? audioThumbInk(id, pool) : null;
      if (ink) el.style.setProperty('--ttxt-ink', ink.hex);
    }
  };

  void (async () => {
    const theme = measuredTheme(root);
    const h = host as Parameters<typeof livePalette>[0] & Parameters<typeof audioThumbPool>[1];
    try { pool = audioThumbPool(await livePalette(h), h, theme); } catch { pool = []; }
    // Tiles painted before the palette resolved carry no ink - colour them in
    // rather than leaving the grid half grey (the audio thumbs' own rule).
    repaintPainted();
  })();

  const build = async (el: HTMLElement): Promise<void> => {
    const id = el.dataset.textThumb;
    const ref = id ? lookup(id) : undefined;
    if (!id || !ref || ref.type !== 'text') return;
    const key = `${id}|${ref.version ?? ''}`;
    let model = modelCache.get(key);
    if (!model) {
      const text = await (await fetch(ref.url)).text();
      model = textThumbModel(text.slice(0, TEXT_THUMB_ANALYSIS_CAP), text.length);
      modelCache.set(key, model);
    }
    paint(el, id, model);
  };

  const drain = async (): Promise<void> => {
    if (workers >= MAX_WORKERS) return;
    workers++;
    try {
      while (live) {
        const el = queue.pop();
        if (!el) break;
        if (!el.isConnected || done.has(el)) continue;
        done.add(el);
        try { await build(el); } catch { /* fetch/decode failed: the ¶ glyph stays */ }
      }
    } finally {
      workers--;
    }
  };

  const consider = (el: HTMLElement): void => {
    if (done.has(el)) return;
    if (!queue.includes(el)) queue.push(el);
    void drain();
  };

  const els = Array.from(root.querySelectorAll<HTMLElement>('[data-text-thumb]'));
  let observer: IntersectionObserver | null = null;
  if (typeof IntersectionObserver === 'function') {
    observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) { observer?.unobserve(e.target); consider(e.target as HTMLElement); }
      }
    }, { rootMargin: '160px' });
    for (const el of els) observer.observe(el);
  } else {
    // No observer (jsdom): text is cheap, but stay bounded - queue them all and
    // let the worker cap pace the fetches.
    for (const el of els) consider(el);
  }

  return {
    destroy(): void {
      live = false;
      observer?.disconnect();
      queue.length = 0;
    },
  };
}
