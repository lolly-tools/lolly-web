// SPDX-License-Identifier: MPL-2.0
/**
 * Deck Builder editor tests. Two halves:
 *   • the JSON / Markdown deck PARSERS (pure, DOM-free) — coercion, media-ref shapes,
 *     aliases, layout defaults, the JSON-vs-Markdown router;
 *   • the overlay BEHAVIOUR (against a jsdom stage + an in-memory runtime that echoes
 *     setInput back through getModel — a real round-trip, not a stubbed answer): the
 *     filmstrip renders one thumb per slide, click navigates via focusSlide, add/delete
 *     mutate the deck array, the Load popover parses + commits, a bad paste is rejected
 *     without touching the deck, and destroy tears everything down.
 *
 * Run directly:  node --test shells/web/src/views/deck-editor.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
  parseJsonDeck, parseMarkdownDeck, parseDeck, toMediaRef, coerceSlide, coerceBox, refUrl,
  buildThumbFace, initDeckEditor, deriveContent, contentTitle, contentBody,
  mdToRichHtml, richHtmlToMd, layoutToBoxes, parsePptxGenDeck, isPptxGenSource, toHex,
} from './deck-editor.ts';

// ── jsdom bootstrap (functions touch `document` only at call time) ────────────
const dom = new JSDOM('<!DOCTYPE html><body></body>');
const W = dom.window as unknown as typeof globalThis & { Event: typeof Event; MouseEvent: typeof MouseEvent };
for (const k of ['document', 'HTMLElement', 'KeyboardEvent', 'Event', 'MouseEvent', 'Node']) {
  (globalThis as Record<string, unknown>)[k] = (dom.window as unknown as Record<string, unknown>)[k];
}
const click = (el: Element): void => { el.dispatchEvent(new W.Event('click', { bubbles: true })); };
// A DOMRect-ish for stubbing getBoundingClientRect in jsdom (which returns all-zeros).
const rect = (left: number, top: number, width: number, height: number): DOMRect => ({
  left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() { return this; },
} as DOMRect);
// Dispatch a pointer-family event carrying clientX/clientY (jsdom lacks PointerEvent, but a
// MouseEvent dispatched under a 'pointer*' type triggers the matching listeners just fine).
const pointer = (el: EventTarget, type: string, x: number, y: number): void => {
  el.dispatchEvent(new W.MouseEvent(type, { bubbles: true, clientX: x, clientY: y }));
};

// ── parsers ───────────────────────────────────────────────────────────────────

test('parseJsonDeck: array of slides, aliases, media, defaults', () => {
  const d = parseJsonDeck('[{"title":"Hello","bg":"#0a3d2a","image":"https://x.com/a.png"},{"heading":"Two","body":"sub"}]');
  assert.equal(d.length, 2);
  assert.equal(d[0]!.content, '# Hello');       // title alias → content markdown
  assert.equal(d[0]!.bg, '#0a3d2a');
  assert.equal(refUrl(d[0]!.media1), 'https://x.com/a.png');
  assert.equal(d[0]!.layout, 'full');           // image → picture layout
  assert.equal(d[1]!.content, '# Two\n\nsub');   // heading + body aliases → content
});

test('parseJsonDeck: explicit content string passes through verbatim', () => {
  const d = parseJsonDeck('[{"content":"# Kept\\n\\n- one\\n- two"}]');
  assert.equal(d[0]!.content, '# Kept\n\n- one\n- two');
});

test('parseJsonDeck: {slides:[]} wrapper + bad bg falls back to empty (inherit theme)', () => {
  assert.equal(parseJsonDeck('{"slides":[{"title":"a"}]}').length, 1);
  assert.equal(parseJsonDeck('[{"bg":"notacolor"}]')[0]!.bg, '');   // '' = inherit deck theme bg
});

test('parseJsonDeck: throws on malformed JSON', () => {
  assert.throws(() => parseJsonDeck('[not json'));
});

test('toMediaRef: url vs id vs empty', () => {
  assert.deepEqual(toMediaRef('https://x/a.png'), { url: 'https://x/a.png' });
  assert.deepEqual(toMediaRef('data:image/png;base64,AA'), { url: 'data:image/png;base64,AA' });
  assert.deepEqual(toMediaRef('suse/logo/primary'), { id: 'suse/logo/primary' });
  assert.equal(toMediaRef(''), null);
  assert.equal(toMediaRef(null), null);
  assert.deepEqual(toMediaRef({ url: 'u', junk: 1 }), { url: 'u' });
});

test('parseMarkdownDeck: --- splits, chunk becomes content, image + bg directives peeled', () => {
  const d = parseMarkdownDeck('# First\nSome subtitle\nbg: #112233\n\n---\n\n## Second\n![alt](https://y.com/p.jpg)');
  assert.equal(d.length, 2);
  assert.equal(d[0]!.content, '# First\nSome subtitle');   // heading + prose kept verbatim, bg line peeled
  assert.equal(d[0]!.bg, '#112233');
  assert.equal(d[1]!.content, '## Second');                // standalone image line peeled out
  assert.equal(refUrl(d[1]!.media1), 'https://y.com/p.jpg');
  assert.equal(d[1]!.layout, 'full');
  // inline markup is preserved in content, only flattened for the title preview
  const b = parseMarkdownDeck('# **Bold** title')[0]!;
  assert.equal(b.content, '# **Bold** title');
  assert.equal(contentTitle(b.content!), 'Bold title');
  assert.equal(parseMarkdownDeck('')[0]!.layout, 'title');   // empty → one blank slide
  assert.equal(parseMarkdownDeck('')[0]!.content, '');
});

test('parseMarkdownDeck: layout directive peeled, bullets kept in content', () => {
  const d = parseMarkdownDeck('layout: split\n# Head\n- one\n- two');
  assert.equal(d[0]!.layout, 'split');
  assert.equal(d[0]!.content, '# Head\n- one\n- two');
});

test('parseDeck router: [/{ → JSON, else Markdown', () => {
  assert.equal(parseDeck('[{"title":"j"}]')[0]!.content, '# j');
  assert.equal(parseDeck('# md title')[0]!.content, '# md title');
});

test('deriveContent / contentTitle / contentBody helpers', () => {
  assert.equal(deriveContent({ content: '# raw' }), '# raw');
  assert.equal(deriveContent({ title: 'T', body: 'B' }), '# T\n\nB');
  assert.equal(deriveContent({}), '');
  assert.equal(contentTitle('intro line\n# **main**\nbody'), 'main');   // first heading of any level
  assert.equal(contentBody('# Head\n- first bullet\n- second'), 'first bullet');
  assert.equal(contentBody('# only a heading'), '');
});

test('coerceSlide: image without explicit layout → full', () => {
  assert.equal(coerceSlide({ image: 'https://x/a.png' }).layout, 'full');
  assert.equal(coerceSlide({ image: 'https://x/a.png', layout: 'hero' }).layout, 'hero');
  assert.equal(coerceSlide({}).layout, 'title');
});

test('buildThumbFace: faithful layout-aware mini-slide', () => {
  // title layout: header (title from content markdown), no slot grid, bg + contrasting ink
  const t = buildThumbFace({ layout: 'title', content: '# Hi\n\nsome body', bg: '#0a1020' });
  assert.equal(t.dataset.layout, 'title');
  assert.equal(t.style.background, 'rgb(10, 16, 32)');           // bg applied
  assert.equal(t.style.color, 'rgb(255, 255, 255)');            // dark bg → white ink
  assert.equal(t.querySelector('.deck-thumb__t-title')?.textContent, 'Hi');   // first heading → title
  assert.equal(t.querySelector('.deck-thumb__t-sub')?.textContent, 'some body');  // first body line
  assert.equal(t.querySelector('.deck-thumb__grid'), null);      // title layout has no slots

  // split layout: two slots, one filled with the image
  const s = buildThumbFace({ layout: 'split', media1: { url: 'https://x/a.png' } });
  assert.equal(s.querySelectorAll('.deck-thumb__slot').length, 2);
  assert.equal(s.querySelectorAll('.deck-thumb__slot.is-filled').length, 1);
  assert.equal(s.querySelector('.deck-thumb__slot-img')?.getAttribute('src'), 'https://x/a.png');

  // grid4: four slots
  assert.equal(buildThumbFace({ layout: 'grid4' }).querySelectorAll('.deck-thumb__slot').length, 4);
  // explicit light bg → dark ink (idealInk)
  assert.equal(buildThumbFace({ bg: '#f5f5f5' }).style.color, 'rgb(20, 27, 45)');
});

test('buildThumbFace: reflects the theme scheme when no explicit bg', () => {
  // per-slide theme picks the scheme
  assert.equal(buildThumbFace({ theme: 'dark' }).style.background, 'rgb(23, 32, 41)');    // #172029
  assert.equal(buildThumbFace({ theme: 'primary' }).style.background, 'rgb(48, 186, 120)'); // #30ba78
  // slide theme 'auto' → inherit the deck theme argument
  assert.equal(buildThumbFace({ theme: 'auto' }, 'light').style.background, 'rgb(255, 255, 255)');
  assert.equal(buildThumbFace({}, 'dark').style.background, 'rgb(23, 32, 41)');
  // an explicit per-slide bg still wins over any theme
  assert.equal(buildThumbFace({ bg: '#ff0000', theme: 'light' }, 'dark').style.background, 'rgb(255, 0, 0)');
});

// ── overlay behaviour ──────────────────────────────────────────────────────────

function mountFixture(deck: unknown[], extra: { host?: any; editTool?: any; nativeW?: number; nativeH?: number } = {}) {
  document.body.innerHTML = '<div id="stage"><div id="tool-canvas"></div></div>';
  const stageEl = document.getElementById('stage')!;
  const canvasEl = document.getElementById('tool-canvas')!;
  // Give the canvas a native size + a known on-screen rect so the free-canvas / text-editor
  // native↔screen mapping is deterministic (native 1920×1080, shown at 960×540 ⇒ scale 0.5).
  canvasEl.style.width = '1920px'; canvasEl.style.height = '1080px';
  canvasEl.getBoundingClientRect = () => rect(100, 50, 960, 540);
  stageEl.getBoundingClientRect = () => rect(0, 0, 1200, 700);
  let model: Array<{ id: string; value: unknown }> = [
    { id: 'deck', value: deck },
    { id: 'focusSlide', value: 0 },
    { id: 'theme', value: 'auto' },
  ];
  const subs: Array<() => void> = [];
  const runtime = {
    getModel: () => model,
    setInput: (id: string, v: unknown) => { model = model.map(m => m.id === id ? { ...m, value: v } : m); subs.forEach(f => f()); },
    setInputNoHistory: (id: string, v: unknown) => { model = model.map(m => m.id === id ? { ...m, value: v } : m); subs.forEach(f => f()); },
    subscribe: (f: () => void) => { subs.push(f); return () => { const i = subs.indexOf(f); if (i >= 0) subs.splice(i, 1); }; },
  };
  const val = (id: string): unknown => model.find(m => m.id === id)?.value;
  const handle = initDeckEditor({ viewEl: document.body as HTMLElement & { _cleanup?: () => void }, stageEl, canvasEl, runtime, host: extra.host ?? {}, input: { id: 'deck' }, inputs: [], nativeW: extra.nativeW ?? 1920, nativeH: extra.nativeH ?? 1080, onDirty: () => {}, editTool: extra.editTool });
  return { stageEl, val, handle, subs };
}
// Two quick pointerdowns on the same box = a double-click (deck-editor detects it from
// pointerdown timing, because selecting rebuilds the box DOM between the two clicks).
const dblclickBox = (el: EventTarget): void => {
  pointer(el, 'pointerdown', 300, 200);
  pointer(document, 'pointerup', 300, 200);
  pointer(el, 'pointerdown', 300, 200);
};
// Pointer event carrying modifier keys (shift/meta) for multi-select gestures.
const pmod = (el: EventTarget, type: string, x: number, y: number, mods: Record<string, boolean> = {}): void => {
  el.dispatchEvent(new W.MouseEvent(type, { bubbles: true, clientX: x, clientY: y, ...mods }));
};
// Click a box (pointerdown+up, no drag) to make it the selection.
const clickBox = (el: EventTarget, x = 200, y = 150): void => { pointer(el, 'pointerdown', x, y); pointer(document, 'pointerup', x, y); };
const toolBtn = (stageEl: Element, title: string): HTMLButtonElement =>
  Array.from(stageEl.querySelectorAll<HTMLButtonElement>('.deck-free__btn')).find(b => b.title === title)!;

test('filmstrip: one thumbnail per slide, faithful mini-slide with title + bg', () => {
  const { stageEl } = mountFixture([{ content: '# One', bg: '#0a3d2a', layout: 'title' }, { content: '# Two', bg: '#222222' }]);
  assert.ok(stageEl.querySelector('.deck-strip'), 'strip mounted');
  const thumbs = stageEl.querySelectorAll('.deck-thumb:not(.deck-thumb--add)');
  assert.equal(thumbs.length, 2);
  const face = thumbs[0]!.querySelector<HTMLElement>('.deck-thumb__slide')!;
  assert.equal(face.dataset.layout, 'title');
  assert.equal(face.querySelector('.deck-thumb__t-title')?.textContent, 'One');   // from content markdown
  assert.equal(face.style.background, 'rgb(10, 61, 42)');   // slide bg applied to the face
  assert.ok(stageEl.querySelector('.deck-thumb--add'), 'add button present');
});

test('filmstrip: clicking a thumb navigates via focusSlide', () => {
  const { stageEl, val } = mountFixture([{ title: 'One' }, { title: 'Two' }]);
  click(stageEl.querySelectorAll('.deck-thumb:not(.deck-thumb--add)')[1]!);
  assert.equal(val('focusSlide'), 2);
  assert.equal(stageEl.querySelectorAll('.deck-thumb.is-active').length, 1);
});

test('filmstrip: add appends a slide and activates it', () => {
  const { stageEl, val } = mountFixture([{ title: 'One' }]);
  click(stageEl.querySelector('.deck-thumb--add')!);
  assert.equal((val('deck') as unknown[]).length, 2);
  assert.equal(val('focusSlide'), 2);
});

test('filmstrip: delete removes a slide (keeps at least one)', () => {
  const { stageEl, val } = mountFixture([{ title: 'One' }, { title: 'Two' }]);
  click(stageEl.querySelector('.deck-thumb .deck-thumb__del')!);
  assert.equal((val('deck') as unknown[]).length, 1);
  // last slide can't be deleted
  click(stageEl.querySelector('.deck-thumb .deck-thumb__del')!);
  assert.equal((val('deck') as unknown[]).length, 1);
});

test('load: Markdown paste replaces the deck and closes the popover', () => {
  const { stageEl, val } = mountFixture([{ title: 'old' }]);
  click(stageEl.querySelector('.deck-strip__load')!);
  const ta = stageEl.querySelector('.deck-load__ta') as HTMLTextAreaElement;
  assert.ok(ta, 'popover open');
  ta.value = '# Loaded A\nsub a\n\n---\n\n# Loaded B\n![](https://z.com/i.png)';
  click(stageEl.querySelector('.deck-load__btn--go')!);
  const d = val('deck') as Array<{ content?: string; media1?: { url?: string } }>;
  assert.equal(d.length, 2);
  assert.equal(d[0]!.content, '# Loaded A\nsub a');
  assert.equal(d[1]!.media1?.url, 'https://z.com/i.png');
  assert.equal(stageEl.querySelector('.deck-load'), null, 'popover closed');
  assert.equal(stageEl.querySelectorAll('.deck-thumb:not(.deck-thumb--add)').length, 2, 'strip re-rendered');
});

test('load: malformed JSON is rejected without touching the deck', () => {
  const { stageEl, val } = mountFixture([{ title: 'keep' }]);
  click(stageEl.querySelector('.deck-strip__load')!);
  (stageEl.querySelector('.deck-load__ta') as HTMLTextAreaElement).value = '[not valid json';
  click(stageEl.querySelector('.deck-load__btn--go')!);
  assert.equal((stageEl.querySelector('.deck-load__err') as HTMLElement).hidden, false, 'error shown');
  assert.equal((val('deck') as unknown[]).length, 1, 'deck unchanged');
  assert.ok(stageEl.querySelector('.deck-load'), 'popover stays open');
});

test('destroy: removes the overlay and unsubscribes', () => {
  const { stageEl, handle, subs } = mountFixture([{ title: 'One' }]);
  handle.destroy();
  assert.equal(stageEl.querySelector('.deck-editor'), null);
  assert.equal(subs.length, 0);
});

// ── step 5: rich-text ⇄ markdown round-trip ─────────────────────────────────────

test('mdToRichHtml / richHtmlToMd: heading + bold + bullet round-trips', () => {
  const md = '# Heading\n- **bold** point';
  const div = document.createElement('div');
  div.innerHTML = mdToRichHtml(md);
  // the intermediate HTML is what the editor shows
  assert.equal(div.innerHTML, '<h1>Heading</h1><ul><li><strong>bold</strong> point</li></ul>');
  // …and it serialises back to the exact same markdown subset
  assert.equal(richHtmlToMd(div), md);
});

test('mdToRichHtml / richHtmlToMd: italic + blank line + h2 + h3 round-trip', () => {
  const md = '## Sub\n\n*em* and text\n### Deep';
  const div = document.createElement('div');
  div.innerHTML = mdToRichHtml(md);
  assert.equal(richHtmlToMd(div), md);
  // stray trailing empty paragraph (a browser habit) is trimmed, not emitted as "\n"
  const d2 = document.createElement('div');
  d2.innerHTML = '<h1>Only</h1><p><br></p>';
  assert.equal(richHtmlToMd(d2), '# Only');
  // a soft break (Shift+Enter) inside a block is a newline, not a dropped separator — the two
  // runs must NOT mash into one word ("alphabeta"); regression guard for the review finding.
  const d3 = document.createElement('div');
  d3.innerHTML = '<p>alpha<br>beta</p>';
  assert.ok(richHtmlToMd(d3).includes('alpha\nbeta'), 'BR round-trips to a newline');
});

test('text editor: opens over the active slide, edits, commits content on close', () => {
  const { stageEl, val } = mountFixture([{ content: '# Old', layout: 'title' }]);
  click(stageEl.querySelector('.deck-bar__edit')!);
  const area = stageEl.querySelector<HTMLElement>('.deck-text__area')!;
  assert.ok(area, 'editor mounted over the canvas');
  assert.equal(area.innerHTML, '<h1>Old</h1>');   // seeded from the slide's markdown
  // user rewrites it as rich text…
  area.innerHTML = '<h1>New</h1><ul><li>point</li></ul>';
  // …and Escape commits + closes (blur path shares the same closeTextEditor)
  document.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal((val('deck') as Array<{ content?: string }>)[0]!.content, '# New\n- point');
  assert.equal(stageEl.querySelector('.deck-text'), null, 'editor closed');
});

// ── step 6: per-slide free-canvas ───────────────────────────────────────────────

test('coerceBox: defends kind / geometry / passthrough fields', () => {
  const b = coerceBox({ kind: 'text', text: 'Hi', x: '10', y: 20, w: 0, h: 40, align: 'c', fontSize: 48 });
  assert.equal(b.kind, 'text');
  assert.equal(b.x, 10); assert.equal(b.y, 20);
  assert.equal(b.w, 1);              // clamped to ≥1
  assert.equal(b.align, 'c'); assert.equal(b.fontSize, 48);
  assert.ok(typeof b.id === 'string' && b.id, 'auto-id when absent');
  const img = coerceBox({ kind: 'image', src: 'https://x/a.png' });
  assert.equal(img.kind, 'image'); assert.equal(img.src, 'https://x/a.png');
});

test('free-canvas: freeform slide mounts the layer with one box per boxes[] entry', () => {
  const { stageEl } = mountFixture([{ mode: 'freeform', boxes: [
    { id: 'a', kind: 'text', text: 'Hi', x: 200, y: 100, w: 400, h: 200 },
    { id: 'b', kind: 'text', text: 'Yo', x: 800, y: 100, w: 300, h: 150 },
  ] }]);
  const free = stageEl.querySelector<HTMLElement>('.deck-free')!;
  assert.equal(free.hidden, false, 'layer visible for a freeform slide');
  const boxes = stageEl.querySelectorAll('.deck-free-box');
  assert.equal(boxes.length, 2);
  // native→screen mapping: x=200 native × 0.5 scale ⇒ 100px left
  assert.equal((boxes[0] as HTMLElement).style.left, '100px');
  assert.equal((boxes[0] as HTMLElement).style.width, '200px');   // 400 × 0.5
});

test('free-canvas: drag commits the moved box geometry to deck[i].boxes', () => {
  const { stageEl, val } = mountFixture([{ mode: 'freeform', boxes: [
    { id: 'a', kind: 'text', text: 'Hi', x: 200, y: 100, w: 400, h: 200 },
  ] }]);
  const box = stageEl.querySelector('.deck-free-box')!;
  pointer(box, 'pointerdown', 300, 200);
  pointer(document, 'pointermove', 400, 200);   // +100 client ⇒ +200 native (scale 0.5)
  pointer(document, 'pointerup', 400, 200);
  const b = (val('deck') as Array<{ boxes: Array<{ x: number; y: number }> }>)[0]!.boxes[0]!;
  assert.equal(b.x, 400);   // 200 + 200
  assert.equal(b.y, 100);   // unchanged
});

test('free-canvas: resize (se handle) commits new width/height, anchor corner fixed', () => {
  const { stageEl, val } = mountFixture([{ mode: 'freeform', boxes: [
    { id: 'a', kind: 'text', text: 'Hi', x: 200, y: 100, w: 400, h: 200 },
  ] }]);
  // select the box (pointerdown+up with no move) so its handles render
  const box = stageEl.querySelector('.deck-free-box')!;
  pointer(box, 'pointerdown', 300, 200);
  pointer(document, 'pointerup', 300, 200);
  const se = stageEl.querySelector('.deck-free-h--se')!;
  assert.ok(se, 'resize handle present on the selected box');
  pointer(se, 'pointerdown', 400, 300);
  pointer(document, 'pointermove', 500, 350);   // +100/+50 client ⇒ +200/+100 native
  pointer(document, 'pointerup', 500, 350);
  const b = (val('deck') as Array<{ boxes: Array<{ x: number; y: number; w: number; h: number }> }>)[0]!.boxes[0]!;
  assert.equal(b.w, 600); assert.equal(b.h, 300);   // grown
  assert.equal(b.x, 200); assert.equal(b.y, 100);   // nw anchor stayed put
});

// ── step 7: on-canvas toggles ───────────────────────────────────────────────────

test('toggle: deck theme commits the deck-level theme input (global)', () => {
  const { stageEl, val } = mountFixture([{ content: '# One' }]);
  const sel = stageEl.querySelector<HTMLSelectElement>('.deck-bar__deck-theme')!;
  sel.value = 'dark';
  sel.dispatchEvent(new W.Event('change', { bubbles: true }));
  assert.equal(val('theme'), 'dark');   // NOT a per-slide field
});

test('toggle: per-slide theme / logo / mode clone-and-commit the active slide', () => {
  const { stageEl, val } = mountFixture([{ content: '# One' }, { content: '# Two' }]);
  // make slide 2 active first
  click(stageEl.querySelectorAll('.deck-thumb:not(.deck-thumb--add)')[1]!);
  const setSel = (cls: string, v: string): void => {
    const s = stageEl.querySelector<HTMLSelectElement>(cls)!;
    s.value = v; s.dispatchEvent(new W.Event('change', { bubbles: true }));
  };
  setSel('.deck-bar__slide-theme', 'primary');
  setSel('.deck-bar__slide-logo', 'mono');
  const deck = () => val('deck') as Array<{ theme?: string; logo?: string; mode?: string }>;
  assert.equal(deck()[1]!.theme, 'primary');
  assert.equal(deck()[1]!.logo, 'mono');
  assert.equal(deck()[0]!.theme, undefined, 'the inactive slide is untouched');
  setSel('.deck-bar__slide-mode', 'freeform');
  assert.equal(deck()[1]!.mode, 'freeform');
  // switching the active slide to freeform reveals the free-canvas layer
  assert.equal(stageEl.querySelector<HTMLElement>('.deck-free')!.hidden, false);
});

// ── layout → freeform conversion ("switch to freeform, keep the content") ────────

test('layoutToBoxes: explodes content + filled slots into positioned boxes', () => {
  const boxes = layoutToBoxes({ layout: 'split', content: '# Head\n\nbody', media1: { url: 'a' }, media2: { url: 'b' } } as any, 1920, 1920);
  assert.equal(boxes.length, 3);   // 2 image slots + 1 text
  assert.equal(boxes.filter(b => b.kind === 'image').length, 2);
  const text = boxes.find(b => b.kind === 'text')!;
  assert.equal(text.text, '# Head\n\nbody');   // content carried verbatim
  assert.equal(text.align, 'l');
  assert.ok((text.y as number) < 200, 'text sits in the head band');
  // title layout centres one big text box, no image slots
  const t = layoutToBoxes({ layout: 'title', content: '# Big' } as any, 1920, 1920);
  assert.equal(t.length, 1);
  assert.equal(t[0]!.align, 'c');
  // an empty slide converts to an empty canvas
  assert.equal(layoutToBoxes({ layout: 'title', content: '' } as any).length, 0);
  // image boxes come BEFORE the text box, so a full-bleed caption paints on top
  const full = layoutToBoxes({ layout: 'full', content: '# Cap', media1: { url: 'img' } } as any, 1920, 1920);
  assert.equal(full[0]!.kind, 'image');
  assert.equal(full[1]!.kind, 'text');
});

test('coerceBox: normalises align words to the compact form', () => {
  assert.equal(coerceBox({ kind: 'text', align: 'center' }).align, 'c');
  assert.equal(coerceBox({ kind: 'text', align: 'RIGHT' }).align, 'r');
  assert.equal(coerceBox({ kind: 'text', align: 'left' }).align, 'l');
  assert.equal(coerceBox({ kind: 'text', align: 'c' }).align, 'c');
  assert.equal(coerceBox({ kind: 'text' }).align, undefined);
});

test('mode → freeform explodes the layout content into boxes (keeps the content)', () => {
  const { stageEl, val } = mountFixture([{ layout: 'split', content: '# Hi\n\nbody', media1: { url: 'https://x/a.png' } }]);
  const modeSel = stageEl.querySelector<HTMLSelectElement>('.deck-bar__slide-mode')!;
  modeSel.value = 'freeform';
  modeSel.dispatchEvent(new W.Event('change', { bubbles: true }));
  const d = (val('deck') as Array<{ mode?: string; boxes?: Array<{ kind: string; text?: string }> }>)[0]!;
  assert.equal(d.mode, 'freeform');
  assert.ok(Array.isArray(d.boxes) && d.boxes.length >= 2, 'boxes seeded from content');
  assert.equal(d.boxes!.filter(b => b.kind === 'image').length, 1);   // media1
  assert.equal(d.boxes!.find(b => b.kind === 'text')!.text, '# Hi\n\nbody');
});

test('mode → freeform keeps an already-arranged canvas (never re-explodes)', () => {
  const existing = [{ id: 'x', kind: 'text', text: 'kept', x: 10, y: 10, w: 100, h: 100 }];
  const { stageEl, val } = mountFixture([{ layout: 'title', content: '# Hi', mode: 'layout', boxes: existing }]);
  const modeSel = stageEl.querySelector<HTMLSelectElement>('.deck-bar__slide-mode')!;
  modeSel.value = 'freeform';
  modeSel.dispatchEvent(new W.Event('change', { bubbles: true }));
  const d = (val('deck') as Array<{ boxes?: Array<{ text?: string }> }>)[0]!;
  assert.equal(d.boxes!.length, 1);
  assert.equal(d.boxes![0]!.text, 'kept');
});

// ── on-canvas layout picker ──────────────────────────────────────────────────────

test('on-canvas layout picker: present in layout mode, commits the slide layout', () => {
  const { stageEl, val } = mountFixture([{ content: '# One', layout: 'title' }]);
  const laySel = stageEl.querySelector<HTMLSelectElement>('.deck-bar__slide-layout')!;
  assert.ok(laySel, 'layout picker shown for a layout slide');
  laySel.value = 'split';
  laySel.dispatchEvent(new W.Event('change', { bubbles: true }));
  assert.equal((val('deck') as Array<{ layout?: string }>)[0]!.layout, 'split');
});

test('on-canvas layout picker: hidden for a freeform slide', () => {
  const { stageEl } = mountFixture([{ mode: 'freeform', boxes: [] }]);
  assert.equal(stageEl.querySelector('.deck-bar__slide-layout'), null);
});

// ── freeform box editing: rich text + image pick ────────────────────────────────

test('freeform text box: double-click edits in place, commits markdown back to the box', () => {
  const { stageEl, val } = mountFixture([{ mode: 'freeform', boxes: [
    { id: 'a', kind: 'text', text: '# Old', x: 200, y: 100, w: 600, h: 300 },
  ] }]);
  dblclickBox(stageEl.querySelector('.deck-free-box')!);
  const tx = stageEl.querySelector<HTMLElement>('.deck-free-box.is-editing .deck-free-box__text')!;
  assert.ok(tx, 'text box opened as an editable');
  assert.equal(tx.getAttribute('contenteditable'), 'true');
  assert.equal(tx.innerHTML, '<h1>Old</h1>');   // seeded from the box markdown
  tx.innerHTML = '<h1>New</h1><ul><li>point</li></ul>';
  tx.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal((val('deck') as Array<{ boxes: Array<{ text?: string }> }>)[0]!.boxes[0]!.text, '# New\n- point');
  assert.equal(stageEl.querySelector('.deck-free-box.is-editing'), null, 'edit closed after commit');
});

test('freeform image box: double-click opens the picker and stores the chosen url', async () => {
  const host = { assets: { pick: async () => ({ url: 'https://x/pic.png', id: 'p', source: 'library', type: 'raster', format: 'png' }) } };
  const { stageEl, val } = mountFixture([{ mode: 'freeform', boxes: [
    { id: 'a', kind: 'image', x: 200, y: 100, w: 400, h: 300 },
  ] }], { host });
  dblclickBox(stageEl.querySelector('.deck-free-box')!);
  await new Promise(r => setTimeout(r, 0));
  assert.equal(((val('deck') as Array<{ boxes: Array<{ src?: { url?: string } }> }>)[0]!.boxes[0]!.src)?.url, 'https://x/pic.png', 'stores the full ref (identity kept)');
});

test('freeform "+ Image": adds an image box and opens the picker for it', async () => {
  const host = { assets: { pick: async () => ({ url: 'https://x/new.png' }) } };
  const { stageEl, val } = mountFixture([{ mode: 'freeform', boxes: [] }], { host });
  const addImg = Array.from(stageEl.querySelectorAll('.deck-free__btn')).find(b => b.textContent === '+ Image')!;
  click(addImg);
  await new Promise(r => setTimeout(r, 0));
  const boxes = (val('deck') as Array<{ boxes: Array<{ kind: string; src?: unknown }> }>)[0]!.boxes;
  assert.equal(boxes.length, 1);
  assert.equal(boxes[0]!.kind, 'image');
  assert.equal((boxes[0]!.src as { url?: string })?.url, 'https://x/new.png');
});

// ── Tier B: layout-studio-grade arrange (multi-select, align, distribute, z, rotate) ──

const FF2 = (): unknown[] => [{ mode: 'freeform', boxes: [
  { id: 'a', kind: 'text', text: 'A', x: 100, y: 100, w: 200, h: 200 },
  { id: 'b', kind: 'text', text: 'B', x: 600, y: 400, w: 200, h: 200 },
] }];

test('multi-select: shift-click adds a box; plain click resets to one', () => {
  const { stageEl } = mountFixture(FF2());
  let boxes = stageEl.querySelectorAll('.deck-free-box');
  clickBox(boxes[0]!);                                   // select A
  pmod(boxes[1]!, 'pointerdown', 700, 450, { shiftKey: true });   // +B
  pointer(document, 'pointerup', 700, 450);
  assert.equal(stageEl.querySelectorAll('.deck-free-box.is-sel').length, 2);
  // a plain click on A alone resets the selection to just A
  boxes = stageEl.querySelectorAll('.deck-free-box');
  clickBox(boxes[0]!);
  assert.equal(stageEl.querySelectorAll('.deck-free-box.is-sel').length, 1);
});

test('multi-select: dragging one selected box moves the whole selection', () => {
  const { stageEl, val } = mountFixture([{ mode: 'freeform', boxes: [
    { id: 'a', kind: 'text', text: 'A', x: 100, y: 100, w: 200, h: 200 },
    { id: 'b', kind: 'text', text: 'B', x: 600, y: 100, w: 200, h: 200 },
  ] }]);
  let boxes = stageEl.querySelectorAll('.deck-free-box');
  clickBox(boxes[0]!);
  pmod(boxes[1]!, 'pointerdown', 700, 150, { shiftKey: true }); pointer(document, 'pointerup', 700, 150);
  boxes = stageEl.querySelectorAll('.deck-free-box');
  pointer(boxes[0]!, 'pointerdown', 200, 150);
  pointer(document, 'pointermove', 300, 150);   // +100 client ⇒ +200 native
  pointer(document, 'pointerup', 300, 150);
  const d = (val('deck') as Array<{ boxes: Array<{ x: number }> }>)[0]!.boxes;
  assert.equal(d[0]!.x, 300); assert.equal(d[1]!.x, 800);   // both moved together
});

test('marquee: dragging the empty canvas selects the enclosed boxes', () => {
  const { stageEl } = mountFixture(FF2());
  const bg = stageEl.querySelector('.deck-free__bg')!;
  pointer(bg, 'pointerdown', 100, 50);          // native origin (0,0)
  pointer(document, 'pointermove', 700, 400);   // native (1200,700) — covers both
  pointer(document, 'pointerup', 700, 400);
  assert.equal(stageEl.querySelectorAll('.deck-free-box.is-sel').length, 2);
});

test('align: aligning left snaps every selected box to the selection min-left', () => {
  const { stageEl, val } = mountFixture(FF2());
  const bg = stageEl.querySelector('.deck-free__bg')!;
  pointer(bg, 'pointerdown', 100, 50); pointer(document, 'pointermove', 700, 400); pointer(document, 'pointerup', 700, 400);
  click(toolBtn(stageEl, 'Align left'));
  const d = (val('deck') as Array<{ boxes: Array<{ x: number }> }>)[0]!.boxes;
  assert.equal(d[0]!.x, 100); assert.equal(d[1]!.x, 100);
});

test('distribute: three boxes distribute to equal gaps horizontally', () => {
  const { stageEl, val } = mountFixture([{ mode: 'freeform', boxes: [
    { id: 'a', kind: 'text', text: 'A', x: 0, y: 100, w: 100, h: 100 },
    { id: 'b', kind: 'text', text: 'B', x: 200, y: 100, w: 100, h: 100 },
    { id: 'c', kind: 'text', text: 'C', x: 1000, y: 100, w: 100, h: 100 },
  ] }]);
  const bg = stageEl.querySelector('.deck-free__bg')!;
  pointer(bg, 'pointerdown', 100, 50); pointer(document, 'pointermove', 700, 400); pointer(document, 'pointerup', 700, 400);
  click(toolBtn(stageEl, 'Distribute horizontally'));
  const d = (val('deck') as Array<{ boxes: Array<{ x: number }> }>)[0]!.boxes;
  assert.equal(d[1]!.x, 500);   // middle box centred between the fixed extremes
});

test('z-order: send-to-back moves the selected box to array index 0', () => {
  const { stageEl, val } = mountFixture([{ mode: 'freeform', boxes: [
    { id: 'a', kind: 'text', text: 'A', x: 100, y: 100, w: 200, h: 200 },
    { id: 'b', kind: 'text', text: 'B', x: 150, y: 150, w: 200, h: 200 },
  ] }]);
  clickBox(stageEl.querySelectorAll('.deck-free-box')[1]!, 250, 200);   // select B (index 1)
  click(toolBtn(stageEl, 'Send to back'));
  const d = (val('deck') as Array<{ boxes: Array<{ id: string }> }>)[0]!.boxes;
  assert.equal(d[0]!.id, 'b');
});

test('rotate: dragging the rotate handle rotates the box', () => {
  const { stageEl, val } = mountFixture([{ mode: 'freeform', boxes: [
    { id: 'a', kind: 'text', text: 'A', x: 800, y: 400, w: 320, h: 320 },
  ] }]);
  clickBox(stageEl.querySelector('.deck-free-box')!, 580, 330);
  const rotH = stageEl.querySelector('.deck-free-rot')!;
  assert.ok(rotH, 'rotate handle shows for a single selection');
  // centre native (960,560); start above the centre (angle -90°), drag to its right (0°) ⇒ +90°
  pointer(rotH, 'pointerdown', 580, 200);
  pointer(document, 'pointermove', 760, 330);
  pointer(document, 'pointerup', 760, 330);
  const rot = (val('deck') as Array<{ boxes: Array<{ rot?: number }> }>)[0]!.boxes[0]!.rot ?? 0;
  assert.ok(Math.abs(rot) > 1, `box rotated (rot=${rot})`);
});

test('nudge: arrow keys move the selection (1px, 10px with Shift)', () => {
  const { stageEl, val } = mountFixture([{ mode: 'freeform', boxes: [
    { id: 'a', kind: 'text', text: 'A', x: 100, y: 100, w: 200, h: 200 },
  ] }]);
  clickBox(stageEl.querySelector('.deck-free-box')!);
  document.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  assert.equal((val('deck') as Array<{ boxes: Array<{ x: number }> }>)[0]!.boxes[0]!.x, 101);
  document.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, shiftKey: true }));
  assert.equal((val('deck') as Array<{ boxes: Array<{ x: number }> }>)[0]!.boxes[0]!.x, 111);
});

test('copy/paste: ⌘C then ⌘V duplicates the selection with an offset + a fresh id', () => {
  const { stageEl, val } = mountFixture([{ mode: 'freeform', boxes: [
    { id: 'a', kind: 'text', text: 'A', x: 100, y: 100, w: 200, h: 200 },
  ] }]);
  clickBox(stageEl.querySelector('.deck-free-box')!);
  document.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'c', metaKey: true, bubbles: true }));
  document.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'v', metaKey: true, bubbles: true }));
  const d = (val('deck') as Array<{ boxes: Array<{ id: string; text?: string; x: number }> }>)[0]!.boxes;
  assert.equal(d.length, 2);
  assert.equal(d[1]!.text, 'A');
  assert.ok(d[1]!.x > d[0]!.x, 'pasted copy is offset');
  assert.notEqual(d[1]!.id, d[0]!.id, 'pasted copy gets a fresh id');
});

test('delete key: removes the whole selection', () => {
  const { stageEl, val } = mountFixture(FF2());
  const boxes = stageEl.querySelectorAll('.deck-free-box');
  clickBox(boxes[0]!);
  pmod(boxes[1]!, 'pointerdown', 700, 450, { shiftKey: true }); pointer(document, 'pointerup', 700, 450);
  document.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
  assert.equal((val('deck') as Array<{ boxes: unknown[] }>)[0]!.boxes.length, 0);
});

// ── review-fix regressions ───────────────────────────────────────────────────────

test('fix: selection resets on slide navigation — never mutates the wrong slide', () => {
  const { stageEl, val } = mountFixture([
    { mode: 'freeform', boxes: [{ id: 'a', kind: 'text', text: 'A', x: 100, y: 100, w: 200, h: 200 }] },
    { mode: 'freeform', boxes: [
      { id: 'x', kind: 'text', text: 'X', x: 100, y: 100, w: 200, h: 200 },
      { id: 'y', kind: 'text', text: 'Y', x: 500, y: 100, w: 200, h: 200 },
    ] },
  ]);
  clickBox(stageEl.querySelector('.deck-free-box')!);           // select the box on slide 0
  assert.equal(stageEl.querySelectorAll('.deck-free-box.is-sel').length, 1);
  click(stageEl.querySelectorAll('.deck-thumb:not(.deck-thumb--add)')[1]!);   // navigate to slide 1
  assert.equal(stageEl.querySelectorAll('.deck-free-box.is-sel').length, 0, 'stale selection cleared');
  document.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
  assert.equal((val('deck') as Array<{ boxes: unknown[] }>)[1]!.boxes.length, 2, 'slide 1 boxes untouched');
});

test('fix: a click with sub-threshold jitter still collapses a multi-selection', () => {
  const { stageEl } = mountFixture([{ mode: 'freeform', boxes: [
    { id: 'a', kind: 'text', text: 'A', x: 100, y: 100, w: 200, h: 200 },
    { id: 'b', kind: 'text', text: 'B', x: 600, y: 100, w: 200, h: 200 },
  ] }]);
  let boxes = stageEl.querySelectorAll('.deck-free-box');
  clickBox(boxes[0]!);
  pmod(boxes[1]!, 'pointerdown', 700, 150, { shiftKey: true }); pointer(document, 'pointerup', 700, 150);
  assert.equal(stageEl.querySelectorAll('.deck-free-box.is-sel').length, 2);
  boxes = stageEl.querySelectorAll('.deck-free-box');
  pointer(boxes[0]!, 'pointerdown', 200, 150);
  pointer(document, 'pointermove', 201, 151);   // 1px — below the 3px drag threshold
  pointer(document, 'pointerup', 201, 151);
  assert.equal(stageEl.querySelectorAll('.deck-free-box.is-sel').length, 1, 'jitter-click collapsed to one');
});

test('fix: a box edit commits to the slide it was opened on, even after navigating away', async () => {
  const { stageEl, val } = mountFixture([
    { mode: 'freeform', boxes: [{ id: 'a', kind: 'text', text: '# Old', x: 100, y: 100, w: 400, h: 300 }] },
    { mode: 'freeform', boxes: [{ id: 'x', kind: 'text', text: 'keep', x: 100, y: 100, w: 200, h: 200 }] },
  ]);
  dblclickBox(stageEl.querySelector('.deck-free-box')!);
  const tx = stageEl.querySelector<HTMLElement>('.deck-free-box.is-editing .deck-free-box__text')!;
  tx.innerHTML = '<h1>New</h1>';
  tx.dispatchEvent(new W.Event('blur', { bubbles: true }));                        // schedule the deferred commit
  click(stageEl.querySelectorAll('.deck-thumb:not(.deck-thumb--add)')[1]!);        // navigate to slide 1 first
  await new Promise(r => setTimeout(r, 0));                                        // let the deferred commit fire
  const d = val('deck') as Array<{ boxes: Array<{ text?: string }> }>;
  assert.equal(d[0]!.boxes[0]!.text, '# New', 'edit landed on the slide it was opened on');
  assert.equal(d[1]!.boxes[0]!.text, 'keep', 'the navigated-to slide was not overwritten');
});

// ── shape boxes + pptxgenjs import ───────────────────────────────────────────────

test('toHex: normalises hash-less + short hex, rejects non-hex', () => {
  assert.equal(toHex('30BA78'), '#30BA78');   // pptxgenjs hash-less 6-hex
  assert.equal(toHex('#0c322c'), '#0c322c');
  assert.equal(toHex('fff'), '#fff');
  assert.equal(toHex('notacolour'), '');
  assert.equal(toHex(null), '');
});

test('coerceBox: a shape "box" defends fill / shape / radius / stroke', () => {
  const b = coerceBox({ kind: 'box', x: 10, y: 20, w: 300, h: 100, fill: '30BA78', shape: 'roundRect', radius: 24, lineColor: '#0c322c', lineWidth: 4 });
  assert.equal(b.kind, 'box');
  assert.equal(b.fill, '#30BA78');        // hash-less hex normalised
  assert.equal(b.shape, 'round');         // roundRect → round
  assert.equal(b.radius, 24);
  assert.equal(b.lineColor, '#0c322c');
  assert.equal(b.lineWidth, 4);
  assert.equal(coerceBox({ kind: 'box', shape: 'ellipse' }).shape, 'ellipse');
  assert.equal(coerceBox({ kind: 'box' }).shape, 'rect');   // default
  assert.equal(coerceBox({ kind: 'box' }).kind, 'box');     // no text/src on a shape
});

test('isPptxGenSource: detects a builder script, not plain MD/JSON', () => {
  assert.equal(isPptxGenSource('const p = require("pptxgenjs"); p.addSlide().addText("hi", {x:1,y:1,w:2,h:1})'), true);
  assert.equal(isPptxGenSource('# A markdown title\n\n- bullet'), false);
  assert.equal(isPptxGenSource('[{"content":"# JSON slide"}]'), false);
});

test('parsePptxGenDeck: a pptxgenjs script imports as freeform slides (shape + text boxes)', () => {
  const src = [
    'const pptxgen = require("pptxgenjs");',
    'const p = new pptxgen();',
    'p.defineLayout({ name: "W", width: 13.33, height: 7.5 }); p.layout = "W";',
    'const s = p.addSlide(); s.background = { color: "0B1512" };',
    's.addShape(p.ShapeType.roundRect, { x: 0.6, y: 2.42, w: 6.8, h: 0.72, fill: { color: "223039" }, rectRadius: 0.08 });',
    's.addText([{ text: "Hello", options: { bold: true, color: "FFFFFF", fontSize: 40 } }], { x: 0.6, y: 0.7, w: 12, h: 0.72, align: "center" });',
  ].join('\n');
  const slides = parsePptxGenDeck(src);
  assert.equal(slides.length, 1);
  const s = slides[0]!;
  assert.equal(s.mode, 'freeform');
  assert.equal(s.bg, '#0B1512');
  const boxes = (s.boxes ?? []) as Array<{ kind: string; fill?: string; shape?: string; text?: string; align?: string; x: number }>;
  const shape = boxes.find(b => b.kind === 'box')!;
  assert.equal(shape.fill, '#223039');
  assert.equal(shape.shape, 'round');
  assert.ok(Math.abs(shape.x - Math.round(0.6 / 13.33 * 1920)) <= 1, 'inches → native x');
  const text = boxes.find(b => b.kind === 'text')!;
  assert.equal(text.text, '**Hello**');   // bold run → markdown
  assert.equal(text.align, 'c');           // center → compact
});

test('parseDeck routes a pptxgenjs script through the importer', () => {
  const slides = parseDeck('const p = new (require("pptxgenjs"))(); const s = p.addSlide(); s.addText("Hi", { x:1, y:1, w:3, h:1 });');
  assert.equal(slides[0]!.mode, 'freeform');
});
