// SPDX-License-Identifier: MPL-2.0
/**
 * The shared colour field: its pure track builder, its markup contract, and the
 * four traps that have each cost real hours here.
 *
 * The first two tests are DOM-free (the module only touches document inside its
 * wiring functions, so importing it under node:test is safe); the rest mount the
 * field into jsdom and drive it. Run directly:
 *   node --test shells/web/src/components/color-field.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { lchTrackGradients, LCH_MAX, colorFieldHtml, wireColorField, setSwatches } from './color-field.ts';
import type { ColorChangeDetail, ColorFieldValue } from './color-field.ts';
import { colorSpaces } from './color-spaces.ts';

test('each axis track sweeps its own range while holding the other two', () => {
  const t = lchTrackGradients(0.62, 0.11, 250);
  // L: 9 stops from 0% to 100%, C and H fixed at the current value.
  assert.equal((t.l.match(/oklch\(/g) ?? []).length, 9);
  assert.ok(t.l.startsWith('linear-gradient(to right, oklch(0% 0.11 250)'));
  assert.ok(t.l.endsWith('oklch(100% 0.11 250))'));
  // C: 0 → LCH_MAX.c at the current L/H.
  assert.ok(t.c.includes('oklch(62% 0 250)'));
  assert.ok(t.c.endsWith(`oklch(62% ${LCH_MAX.c} 250))`));
  // H: 13 stops (every 30°), closing the wheel at 360.
  assert.equal((t.h.match(/oklch\(/g) ?? []).length, 13);
  assert.ok(t.h.endsWith('oklch(62% 0.11 360))'));
});

test('the hue track floors chroma so the sweep stays visible near grey', () => {
  const t = lchTrackGradients(0.5, 0, 0);
  assert.ok(t.h.includes('oklch(50% 0.08 '), 'hue stops use the 0.08 floor, not the real C=0');
  // …but the chroma track itself must still start at the true zero.
  assert.ok(t.c.includes('oklch(50% 0 0)'));
});

// ── jsdom harness ────────────────────────────────────────────────────────────

const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});
globalThis.window = dom.window as unknown as typeof globalThis.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Element = dom.window.Element;
globalThis.Event = dom.window.Event;
// positionPopover walks computed styles looking for a fixed containing block.
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
  dom.window.setTimeout(() => cb(0), 0) as unknown as number) as typeof requestAnimationFrame;
(dom.window as unknown as { CSS: { escape(s: string): string } }).CSS = {
  escape: (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`),
};
globalThis.CSS = (dom.window as unknown as { CSS: typeof globalThis.CSS }).CSS;

interface Emitted { id: string; value: ColorFieldValue; detail: ColorChangeDetail }

/** Render + wire one field, recording everything it emits. */
function mount(value: unknown, opts: Parameters<typeof colorFieldHtml>[2] = {}): {
  field: HTMLElement; seen: Emitted[];
} {
  const host = document.getElementById('host')!;
  host.innerHTML = colorFieldHtml('cf', value, opts);
  const seen: Emitted[] = [];
  wireColorField(host, { onChange: (id, v, detail) => { seen.push({ id, value: v, detail }); } });
  return { field: host.querySelector<HTMLElement>('[data-color-field]')!, seen };
}

const fire = (el: Element, type = 'input'): void => {
  el.dispatchEvent(new dom.window.Event(type, { bubbles: true }));
};

/** Drag one channel slider of the active space panel to `to` (display units). */
function drag(field: HTMLElement, mode: string, ch: string, to: number): void {
  const slider = field.querySelector<HTMLInputElement>(`[data-space-group="${mode}"] [data-mode-ch="${ch}"]`)!;
  assert.ok(slider, `no ${mode}/${ch} slider`);
  slider.value = String(to);
  fire(slider);
}

const valueInput = (field: HTMLElement): HTMLInputElement =>
  field.querySelector<HTMLInputElement>('.color-input[data-color-hex]')!;

/** Type into the value field, the way a paste lands. */
function type(field: HTMLElement, text: string): void {
  const input = valueInput(field);
  input.value = text;
  fire(input);
}

// ── Trap 1: nothing may emit at mount ────────────────────────────────────────

test('wiring a field emits NOTHING — no mount-time echo, in any configuration', () => {
  // The bug this pins: the picker used to emit an onChange while wiring up,
  // carrying the sRGB hex it had just been handed. A host that treats that as a
  // user edit overwrites its own state — in Colour Lab it made EVERY colour report
  // "sRGB" regardless of what was authored. jsdom never fires `input`, so this
  // assertion is the only guard there is.
  for (const opts of [
    {},
    { float: true },
    { inline: true },
    { inline: true, modes: true },
    { float: true, modes: true, dials: true },
    { swatchesOnly: true },
    { block: true },
  ]) {
    for (const v of ['#30ba78', '#30ba7880', 'transparent', '', 'not a colour', 'color(display-p3 1 0 0)']) {
      const { seen } = mount(v, opts);
      assert.equal(seen.length, 0, `emitted on mount for ${JSON.stringify({ v, opts })}`);
    }
  }
});

test('switching space emits nothing — it changes the numbers, not the colour', () => {
  const { field, seen } = mount('#30ba78', { inline: true, modes: true });
  const modes = field.querySelector<HTMLElement>('[data-color-modes]')!;
  for (const spec of colorSpaces()) {
    field.querySelector<HTMLElement>(`[data-mode="${spec.mode}"]`)!
      .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    assert.equal(modes.dataset.activeMode, spec.mode);
    const panel = field.querySelector<HTMLElement>(`[data-space-group="${spec.mode}"]`)!;
    assert.equal(panel.hidden, false, `${spec.mode}'s panel is visible`);
    assert.equal(field.querySelectorAll('[data-space-group]:not([hidden])').length, 1, 'exactly one panel shows');
  }
  assert.equal(seen.length, 0, 'a mode switch must never emit');
  // …and the value field re-notates into the space being edited.
  field.querySelector<HTMLElement>('[data-mode="hex"]')!
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.equal(valueInput(field).value, '#30ba78');
  field.querySelector<HTMLElement>('[data-mode="oklch"]')!
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.match(valueInput(field).value, /^oklch\(/);
});

// ── The tab strip ────────────────────────────────────────────────────────────

test('one flat tablist, grouped into three labelled families, wired to its panels', () => {
  const { field } = mount('#30ba78', { inline: true, modes: true });
  assert.equal(field.querySelectorAll('[role="tablist"]').length, 1, 'ONE tablist — not one per family');
  const tabs = [...field.querySelectorAll<HTMLElement>('[role="tab"]')];
  assert.equal(tabs.length, colorSpaces().length);
  // Order in the registry IS visual order IS arrow-key order.
  assert.deepEqual(tabs.map(t => t.dataset.mode), colorSpaces().map(s => s.mode));
  // Three presentational family wrappers with aria-hidden labels; the family
  // reaches assistive tech through each tab's own aria-label instead.
  const fams = [...field.querySelectorAll<HTMLElement>('.color-mode-fam')];
  assert.deepEqual(fams.map(f => f.dataset.modeFamily), ['perceptual', 'device', 'output']);
  for (const f of fams) {
    assert.equal(f.getAttribute('role'), 'presentation');
    assert.equal(f.querySelector('.color-mode-fam-label')!.getAttribute('aria-hidden'), 'true');
  }
  assert.match(field.querySelector<HTMLElement>('[data-mode="oklch"]')!.getAttribute('aria-label')!,
    /^OKLCH, perceptual$/);
  assert.match(field.querySelector<HTMLElement>('[data-mode="cmyk"]')!.getAttribute('aria-label')!,
    /^CMYK, output, uncalibrated$/);
  // Every tab controls a real tabpanel, and that panel points back.
  for (const tab of tabs) {
    const panel = field.querySelector(`#${tab.getAttribute('aria-controls')!}`);
    assert.ok(panel, `${tab.dataset.mode} has no panel`);
    assert.equal(panel!.getAttribute('role'), 'tabpanel');
    assert.equal(panel!.getAttribute('aria-labelledby'), tab.id);
    assert.equal(panel!.getAttribute('tabindex'), '-1');
  }
  // One tab stop for the whole strip.
  assert.equal(tabs.filter(t => t.tabIndex === 0).length, 1);
  // One live caution line per field, silent until it has something to say.
  const notes = [...field.querySelectorAll<HTMLElement>('.color-space-note')];
  assert.equal(notes.length, 1);
  assert.equal(notes[0]!.getAttribute('role'), 'status');
  assert.equal(notes[0]!.getAttribute('aria-live'), 'polite');
  // The OKLCH panel keeps .color-lch: views/color-lab.test.ts asserts it, and the
  // non-modes popover's focus-to-expand selector depends on it.
  assert.ok(field.querySelector('.color-space.color-lch[data-space-group="oklch"]'));
});

test('a field with no space tabs still renders the OKLCH panel as a popover child', () => {
  const { field } = mount('#30ba78', { float: true });
  assert.equal(field.querySelectorAll('[role="tablist"]').length, 0);
  // A DIRECT child of .color-popover, hidden — that pair is what the value-field
  // focus handler expands and what measuredFullHeight measures.
  const panel = field.querySelector<HTMLElement>('.color-popover > .color-lch')!;
  assert.ok(panel);
  assert.equal(panel.hidden, true);
  assert.equal(panel.getAttribute('role'), null, 'a lone panel is not a tabpanel');
  valueInput(field).dispatchEvent(new dom.window.FocusEvent('focus', { bubbles: false }));
  assert.equal(panel.hidden, false, 'focusing the value field expands the sliders');
});

// ── Trap 2: the dials are no longer gated on `inline` ────────────────────────

test('dials follow their own option, defaulting to inline', () => {
  assert.equal(mount('#30ba78', { inline: true }).field.querySelectorAll('.color-dials').length > 0, true);
  assert.equal(mount('#30ba78', { float: true }).field.querySelectorAll('.color-dials').length, 0);
  // The point of the decoupling: a float popover can ask for them…
  assert.ok(mount('#30ba78', { float: true, dials: true }).field.querySelector('.color-dials'));
  // …and an inline panel can decline them.
  assert.equal(mount('#30ba78', { inline: true, dials: false }).field.querySelectorAll('.color-dials').length, 0);
  // Every dial stays out of the tab order and out of the a11y tree — the slider
  // beneath it is the control of record.
  const { field } = mount('#30ba78', { inline: true });
  for (const d of field.querySelectorAll<HTMLElement>('.color-dial')) {
    assert.equal(d.tabIndex, -1);
    assert.equal(d.getAttribute('aria-hidden'), 'true');
  }
});

// ── Trap 3: the value field takes ANY CSS colour ─────────────────────────────

test('the value field accepts any CSS colour, not just the active space format', () => {
  const { field, seen } = mount('#30ba78', { inline: true, modes: true });
  // A hex typed while OKLCH is active. This used to be silently held.
  type(field, '#c0392b');
  assert.equal(seen.at(-1)!.value, '#c0392b');
  // A wide-gamut notation, in its authored space.
  type(field, 'color(display-p3 1 0 0)');
  const wide = seen.at(-1)!;
  assert.equal(wide.detail.color.space, 'display-p3');
  assert.equal(wide.detail.css, 'color(display-p3 1 0 0)');
  assert.equal(wide.detail.baked, true, 'the emitted hex is an approximation and says so');
  assert.match(wide.value as string, /^#[0-9a-f]{6}$/, 'the emitted value is still an sRGB hex');
  // A named colour, and a perceptual one.
  type(field, 'rebeccapurple');
  assert.equal(seen.at(-1)!.value, '#663399');
  type(field, 'oklch(62% 0.11 250)');
  assert.equal(seen.at(-1)!.detail.color.space, 'oklch');
  assert.equal(seen.at(-1)!.detail.baked, false);
  // The bare component list the picker has always spoken still works.
  const before = seen.length;
  type(field, '55% 0.13 145');
  assert.equal(seen.length, before + 1);
  assert.deepEqual(seen.at(-1)!.detail.color.components, [0.55, 0.13, 145]);
  // Junk mid-edit holds the last good colour rather than emitting nonsense.
  type(field, 'oklch(55% 0.13');
  assert.equal(seen.length, before + 1);
});

// ── Trap 4: slider state is one-directional ──────────────────────────────────

test('a near-grey keeps its hue across lightness drags (no hex round trip)', () => {
  const { field, seen } = mount('#808080', { inline: true, modes: true });
  const hue = (): number => seen.at(-1)!.detail.color.components[2];
  // Grey has no hue of its own, so the sliders show the remembered one and every
  // drag must carry it through. Round-tripping the slider output back through a
  // hex is what used to make it wander.
  for (const l of [70, 40, 85, 12]) {
    drag(field, 'oklch', 'l', l);
    assert.equal(seen.at(-1)!.detail.color.space, 'oklch');
    assert.equal(hue(), 250, `hue drifted at L=${l}`);
  }
  // Moving the hue slider WRITES the memory; lightness then carries the new one.
  drag(field, 'oklch', 'h', 137);
  assert.equal(hue(), 137);
  drag(field, 'oklch', 'l', 55);
  assert.equal(hue(), 137);
  // The same rule in a space whose hue is component 0 rather than 2.
  field.querySelector<HTMLElement>('[data-mode="hsl"]')!
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  drag(field, 'hsl', 'h', 200);
  drag(field, 'hsl', 'l', 30);
  assert.equal(seen.at(-1)!.detail.color.components[0], 200, 'HSL hue survived a lightness drag');
});

test('a drag composes straight to the space it is in — CMYK stays put on K', () => {
  const { field, seen } = mount('#3c7a9f', { inline: true, modes: true });
  field.querySelector<HTMLElement>('[data-mode="cmyk"]')!
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  const k = field.querySelector<HTMLInputElement>('[data-space-group="cmyk"] [data-mode-ch="k"]')!;
  const c = field.querySelector<HTMLInputElement>('[data-space-group="cmyk"] [data-mode-ch="c"]')!;
  const k0 = k.value;
  // CMYK→RGB is many-to-one on K, so re-deriving the panel from the colour after
  // every drag would make K jump under the user's hand. Dragging C must not move it.
  c.value = '80';
  fire(c);
  assert.equal(k.value, k0, 'K moved while dragging C');
  assert.ok(seen.length > 0);
  assert.equal(seen.at(-1)!.detail.mode, 'cmyk', 'the emit names the space being edited');
});

// ── The emit contract ────────────────────────────────────────────────────────

test('the emitted value is unchanged: a lowercase sRGB hex, alpha byte-exact', () => {
  const { field, seen } = mount('#30ba7880', { inline: true, modes: true });
  const alpha = field.querySelector<HTMLInputElement>('.color-alpha-slider')!;
  assert.equal(alpha.value, '128', 'the alpha byte round-trips into the slider');
  alpha.value = '64';
  fire(alpha);
  assert.equal(seen.at(-1)!.value, '#30ba7840', 'alpha = byte/255 in, round(alpha*255) out');
  alpha.value = '255';
  fire(alpha);
  assert.equal(seen.at(-1)!.value, '#30ba78', 'a full alpha drops the pair entirely');
  assert.equal(field.querySelector<HTMLElement>('.color-alpha-pct')!.textContent, '100%');
});

test('transparent stays transparent — it is not a CssColor and must not become black', () => {
  const { field, seen } = mount('transparent', { inline: true, modes: true });
  assert.equal(field.dataset.colorCanon, 'transparent');
  type(field, 'transparent');
  assert.equal(seen.at(-1)!.value, 'transparent');
  assert.equal(seen.at(-1)!.detail.css, 'transparent');
  // The engine parses 'transparent' to opaque-black-at-alpha-0, so a state without
  // the explicit sentinel would emit '#00000000' here.
  assert.notEqual(seen.at(-1)!.value, '#00000000');
});

test('seeding is widened: any CSS colour is kept in its authored space', () => {
  for (const [input, canon] of [
    ['#30ba78', 'color(srgb 0.188235 0.729412 0.470588)'],
    ['oklch(62% 0.11 250)', 'oklch(62% 0.11 250)'],
    ['color(display-p3 1 0 0)', 'color(display-p3 1 0 0)'],
    ['rebeccapurple', 'color(srgb 0.4 0.2 0.6)'],
    ['transparent', 'transparent'],
    ['', ''],
    ['not a colour', ''],
  ] as const) {
    const { field } = mount(input, { float: true });
    assert.equal(field.dataset.colorCanon, canon, `seeding ${input}`);
  }
  // A wide-gamut seed survives the render → wire handoff and comes back out whole.
  const { field, seen } = mount('color(display-p3 0 1 0)', { inline: true, modes: true });
  drag(field, 'oklch', 'l', 70);
  assert.equal(seen.at(-1)!.detail.color.space, 'oklch', 'the drag lands in the space being dragged');
  assert.equal(field.dataset.colorCanon, seen.at(-1)!.detail.css, 'the handoff attribute stays truthful');
});

test('a token-backed swatch emits a token value; editing afterwards de-links it', () => {
  // Runs last: setSwatches is global state.
  setSwatches([{ value: '#30ba78', label: 'Jungle', group: 'Brand', ref: '{color.brand.jungle}' }]);
  const { field, seen } = mount('#c0392b', { float: true });
  field.querySelector<HTMLElement>('.color-trigger')!
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  field.querySelector<HTMLElement>('[data-swatch-value="#30ba78"]')!
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.deepEqual(seen.at(-1)!.value, { ref: '{color.brand.jungle}', value: '#30ba78' });
  assert.equal(seen.at(-1)!.detail.ref, '{color.brand.jungle}');
  // Any manual edit clears the link, so the value stops claiming to be the token.
  drag(field, 'oklch', 'c', 0.2);
  assert.equal(typeof seen.at(-1)!.value, 'string');
  assert.equal(seen.at(-1)!.detail.ref, null);
});
