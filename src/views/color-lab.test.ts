// SPDX-License-Identifier: MPL-2.0
/*
 * Colour Lab (#/lab) — the report's structure and its picking contract.
 *
 * Run directly:  node --test shells/web/src/views/color-lab.test.ts
 *
 * What matters here is that the report never describes one colour while showing
 * another. The subject is deliberately NOT clamped to sRGB, so there are two
 * values in play at all times — the authored one and the nearest displayable one
 * — and the failure mode to guard against is them being silently conflated.
 *
 * jsdom gives no canvas 2D context and no layout, so the chart fills and the 3D
 * solid can't paint here; both bail cleanly on a zero-size box, which is exactly
 * what lets this file exercise the rest. The pixel work is verified against the
 * engine in tests/gamut.test.ts and tests/gamut-solid.test.ts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body><main id="view"></main></body></html>', {
  url: 'http://localhost/#/lab',
  pretendToBeVisual: true,
});
globalThis.window = dom.window as unknown as typeof globalThis.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Element = dom.window.Element;
globalThis.MutationObserver = dom.window.MutationObserver;
globalThis.localStorage = dom.window.localStorage;
globalThis.sessionStorage = dom.window.sessionStorage;
globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
  dom.window.setTimeout(() => cb(0), 0) as unknown as number) as typeof requestAnimationFrame;
globalThis.cancelAnimationFrame = ((id: number) => dom.window.clearTimeout(id)) as typeof cancelAnimationFrame;
// jsdom has neither of these; the view's picker and drag paths touch both.
dom.window.Element.prototype.setPointerCapture = function () {};
dom.window.Element.prototype.releasePointerCapture = function () {};
dom.window.Element.prototype.hasPointerCapture = function () { return false; };
(dom.window as unknown as { CSS: { escape(s: string): string } }).CSS = {
  escape: (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`),
};
globalThis.CSS = (dom.window as unknown as { CSS: typeof globalThis.CSS }).CSS;

const { mountColorLab } = await import('./color-lab.ts');

const view = document.getElementById('view')!;

/** Mount the view fresh with an optional `?c=` seed. */
async function mount(params = ''): Promise<void> {
  view.innerHTML = '';
  await mountColorLab(view, {}, params);
}

const $ = (sel: string): HTMLElement | null => view.querySelector<HTMLElement>(sel);
const text = (sel: string): string => ($(sel)?.textContent ?? '').trim();

test('the report mounts with every section present', async () => {
  await mount();
  for (const sel of [
    '[data-lab-swatch]', '[data-lab-raw]', '[data-lab-picker]', '[data-lab-limit]',
    '[data-lab-gamut]', '[data-lab-headroom]', '[data-lab-ceilings]',
    '[data-lab-contrast]', '[data-lab-ramp]', '[data-lab-notations]',
    '[data-lab-chart="lc"]', '[data-lab-chart="ch"]', '[data-lab-chart="lh"]',
    '[data-lab-solid]', '[data-lab-steps]', '[data-lab-blend]', '[data-lab-blend-raw]',
  ]) {
    assert.ok($(sel), `${sel} is present`);
  }
  // All four charts at once, not a switcher.
  assert.equal(view.querySelectorAll('[data-lab-chart]').length, 3);
  assert.equal(view.querySelectorAll('[data-lab-solid]').length, 1);
  // The real picker mounted, rather than a native colour input.
  assert.ok($('[data-lab-picker] [data-color-field]'), 'the shared colour field is mounted');
  // The colour field keeps ONE native input as a display:none canonical-hex
  // store, never clicked — the shell deliberately opens no OS colour picker. So
  // the check is that every native input is that store, not that none exists.
  for (const native of view.querySelectorAll('input[type="color"]')) {
    assert.ok(native.closest('.color-popover-native'),
      'a native colour input exists outside the hidden hex store');
  }
  // And the picker brought its OKLCH rings/sliders, which is why this is a view.
  assert.ok($('[data-lab-picker] .color-lch'), 'the LCH sliders are mounted');
});

test('a wide-gamut seed is described unclamped, and the clamp is disclosed', async () => {
  await mount('?c=' + encodeURIComponent('color(display-p3 1 0 0)'));
  // The gamut verdict names P3, not sRGB.
  assert.match(text('[data-lab-gamut] [data-lab-gamut-name]'), /Display-P3/);
  assert.equal($('[data-lab-gamut]')!.dataset.gamut, 'p3');
  // Headroom is negative — it is past the sRGB ceiling.
  assert.equal($('[data-lab-headroom]')!.dataset.state, 'over');
  assert.match(text('[data-lab-headroom] [data-lab-headroom-val]'), /^-/);
  // And the report SAYS the swatch is showing something else.
  const clamp = $('[data-lab-clamp]')!;
  assert.equal(clamp.hidden, false, 'the clamp notice is shown');
  assert.match(clamp.textContent ?? '', /outside sRGB/i);
  // The raw field holds what the user AUTHORED, not the mapped hex — on the
  // first paint as much as after an edit.
  assert.equal(($('[data-lab-raw]') as HTMLInputElement).value, 'color(display-p3 1 0 0)');
  // The swatch leads with the space the PICKER is set to (OKLCH by default), and
  // says where the colour was actually authored so it can't read as if it were
  // typed in OKLCH. The authored form itself stays in the field and the alternates.
  assert.match(text('[data-lab-sw-primary]'), /^oklch\(/);
  assert.match(text('[data-lab-sw-space]'), /^oklch · set in display-p3/);
  const altSpaces = [...view.querySelectorAll('[data-lab-sw-alts] .lab-sw-alt-space')]
    .map(el => (el.textContent ?? '').trim());
  assert.ok(altSpaces.includes('display-p3'), `the authored space is an alternate: ${altSpaces}`);
  assert.match($('[data-lab-clamp]')!.textContent ?? '', /#FF/i);
  // The swatch asks the browser for the REAL colour, with the hex only as the
  // CSS fallback underneath it.
  assert.equal($('[data-lab-swatch]')!.style.background, 'color(display-p3 1 0 0)');
});

test('an in-gamut colour hides the clamp notice entirely', async () => {
  await mount('?c=%23c0392b');
  assert.equal($('[data-lab-clamp]')!.hidden, true);
  assert.equal($('[data-lab-gamut]')!.dataset.gamut, 'srgb');
  assert.equal($('[data-lab-headroom]')!.dataset.state, 'under');
  assert.match(text('[data-lab-headroom] [data-lab-headroom-val]'), /^\+/);
});

test('a junk seed falls back instead of rendering an empty report', async () => {
  await mount('?c=not-a-colour');
  assert.ok(text('[data-lab-gamut] [data-lab-gamut-name]').length > 0, 'still describes something');
  assert.equal($('[data-lab-clamp]')!.hidden, true);
});

test('the free-text field accepts any space and rejects junk visibly', async () => {
  await mount();
  const raw = $('[data-lab-raw]') as HTMLInputElement;
  const err = $('[data-lab-raw-err]')!;

  raw.value = 'oklch(70% 0.30 145)';
  raw.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  assert.equal(err.hidden, true, 'a valid wide-gamut value is accepted');
  assert.equal($('[data-lab-gamut]')!.dataset.gamut, 'rec2020');

  raw.value = 'lab(55% 70 50)';
  raw.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  assert.equal(err.hidden, true, 'lab() is accepted');
  assert.equal($('[data-lab-gamut]')!.dataset.gamut, 'srgb');

  raw.value = 'chartreuse-ish';
  raw.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  assert.equal(err.hidden, false, 'junk reports an error');
  assert.match(err.textContent ?? '', /colour I can read/i);
  // …and does NOT change the subject.
  assert.equal($('[data-lab-gamut]')!.dataset.gamut, 'srgb');
});

test('the notation table lists every space and marks the ones that clamp', async () => {
  await mount('?c=' + encodeURIComponent('color(display-p3 1 0 0)'));
  const rows = [...view.querySelectorAll('[data-lab-notations] tr')];
  assert.ok(rows.length >= 8, `${rows.length} notation rows`);
  const inexact = rows.filter(r => r.classList.contains('is-inexact'));
  assert.ok(inexact.length > 0, 'a P3 colour cannot be written in sRGB exactly');
  // Every row offers its value for copying.
  for (const r of rows) {
    assert.ok(r.querySelector('[data-lab-copy]'), 'each row has a copy button');
    assert.ok((r.querySelector('code')?.textContent ?? '').length > 0, 'each row shows a value');
  }
  // sRGB specifically must be flagged for this colour.
  const srgbRow = rows.find(r => r.querySelector('th')?.textContent === 'srgb');
  assert.ok(srgbRow?.classList.contains('is-inexact'), 'the sRGB row is flagged');
});

test('readability is scored both ways, with the better one marked', async () => {
  await mount('?c=%23c0392b');
  const cards = [...view.querySelectorAll('.lab-contrast-card')];
  assert.equal(cards.length, 2, 'white text and black text');
  assert.equal(cards.filter(c => c.classList.contains('is-best')).length, 1,
    'exactly one is marked best');
  for (const c of cards) {
    assert.match(c.textContent ?? '', /\d+\.\d+:1/, 'shows a ratio');
    assert.equal(c.querySelectorAll('.lab-wcag').length, 2, 'body and large badges');
  }
  assert.match(text('[data-lab-contrast-note]'), /Best pairing/);
});

test('the tone ramp is pickable and every step re-seeds the report', async () => {
  await mount('?c=%23c0392b');
  // Scoped to the TONES ramp — there is a second ramp (the blend) further down.
  const steps = [...view.querySelectorAll<HTMLElement>('[data-lab-ramp] [data-lab-step]')];
  assert.equal(steps.length, 9);
  const before = text('[data-lab-sw-primary]');
  const target = steps[1]!;
  const wanted = target.dataset.labStep!;
  target.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.notEqual(text('[data-lab-sw-primary]'), before, 'the subject moved');
  // The swatch reads in OKLCH, so check the step landed via the raw field and the
  // hex alternate rather than expecting a hex on the swatch.
  assert.equal(($('[data-lab-raw]') as HTMLInputElement).value.toLowerCase(), wanted.toLowerCase());
  const hexAlt = [...view.querySelectorAll('[data-lab-sw-alts] .lab-sw-alt')]
    .find(li => (li.querySelector('.lab-sw-alt-space')?.textContent ?? '').trim() === 'hex');
  assert.equal((hexAlt?.querySelector('code')?.textContent ?? '').toLowerCase(), wanted.toLowerCase());
});

test('the gamut limit narrows the charts and their legends', async () => {
  await mount();
  const legendKeys = (): number => view.querySelectorAll('[data-lab-chart="lc"] .okls-key').length;
  const seg = $('[data-lab-limit]')!;
  // Rec.2020 is the DEFAULT — the report should not start by hiding colour the
  // user's screen might well be able to show.
  assert.equal(seg.querySelector('[data-val="rec2020"]')!.getAttribute('aria-pressed'), 'true');
  const atWidest = legendKeys();

  seg.querySelector<HTMLElement>('[data-val="srgb"]')!
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.ok(legendKeys() < atWidest, `sRGB-only shows fewer keys (${legendKeys()} < ${atWidest})`);
  assert.equal(seg.querySelector('[data-val="srgb"]')!.getAttribute('aria-pressed'), 'true');
  assert.equal(seg.querySelector('[data-val="rec2020"]')!.getAttribute('aria-pressed'), 'false');

  seg.querySelector<HTMLElement>('[data-val="rec2020"]')!
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.equal(legendKeys(), atWidest, 'and back');
});

test('the report opens on an oklch() value, not a hex', async () => {
  await mount();
  const raw = ($('[data-lab-raw]') as HTMLInputElement).value;
  assert.match(raw, /^oklch\(/, `default seed is OKLCH, got ${raw}`);
});

test('all three planes are sliced through the SAME colour', async () => {
  await mount('?c=' + encodeURIComponent('oklch(62% 0.15 260)'));
  // Each plane holds a different channel constant, and each must hold the
  // subject's own value for it — otherwise the three charts are unrelated views
  // rather than three cuts through one colour.
  assert.match(text('[data-lab-slice-at="lc"]'), /^260°$/);   // hue
  assert.match(text('[data-lab-slice-at="ch"]'), /^62%$/);    // lightness
  assert.match(text('[data-lab-slice-at="lh"]'), /^0\.15/);   // chroma
  // And each chart carries a dot for the subject.
  for (const plane of ['lc', 'ch', 'lh']) {
    assert.ok($(`[data-lab-chart="${plane}"] [data-okls-idx="0"]`), `${plane} plots the subject`);
  }
});

test('the URL keeps the subject shareable without stacking history', async () => {
  await mount('?c=%23c0392b');
  const before = dom.window.history.length;
  const raw = $('[data-lab-raw]') as HTMLInputElement;
  raw.value = 'oklch(70% 0.12 200)';
  raw.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  assert.match(dom.window.location.hash, /^#\/lab\?c=/);
  assert.match(decodeURIComponent(dom.window.location.hash), /oklch\(70% 0\.12 200\)/);
  assert.equal(dom.window.history.length, before, 'replaceState, not pushState');
});

test('the page reads as one narrowing sequence, in order', async () => {
  await mount();
  // The hierarchy IS the feature: set a colour, choose what to see it against,
  // the charts, every notation, then what you build from it. A reorder that puts
  // the notation table before the charts (or the gamut control back above the
  // charts, away from the verdict it drives) should fail here.
  const heads = [...view.querySelectorAll('.lab-step-h')].map(h => (h.textContent ?? '').trim());
  assert.equal(heads.length, 5, `five steps, got ${heads.length}`);
  assert.match(heads[0]!, /Set a colour/);
  assert.match(heads[1]!, /Where it sits/);
  assert.match(heads[2]!, /Every notation/);
  assert.match(heads[3]!, /Tones and blends/);
  assert.match(heads[4]!, /Displayable range and readability/);

  // The charts sit high — second block, right after setting a colour — and the
  // gamut control travels WITH them, because it governs what they draw.
  const charts = view.querySelectorAll('.lab-step-block')[1]!;
  assert.equal(charts.querySelectorAll('[data-lab-chart]').length, 3);
  assert.ok(charts.querySelector('[data-lab-solid]'), 'the 3D chart is in the charts block');
  assert.ok(charts.querySelector('[data-lab-limit]'), 'the limit control is with the charts');

  // The verdict and the readability scores are reference material: LAST block.
  const ref = view.querySelectorAll('.lab-step-block')[4]!;
  assert.ok(ref.querySelector('[data-lab-gamut]'), 'the gamut verdict is at the bottom');
  assert.ok(ref.querySelector('[data-lab-contrast]'), '…with the readability scores');
  assert.equal(ref.querySelector('[data-lab-chart]'), null, 'and no charts down there');

  // Setting a colour is step 1, and all three ways in are there together.
  const setStep = view.querySelectorAll('.lab-step-block')[0]!;
  for (const sel of ['[data-lab-raw]', '[data-lab-picker]', '[data-lab-brand]']) {
    assert.ok(setStep.querySelector(sel), `${sel} is a way into step 1`);
  }
});

test('the blend ramp spans the subject to a second colour the user sets', async () => {
  await mount('?c=%23c0392b');
  const blendSteps = (): string[] =>
    [...view.querySelectorAll<HTMLElement>('[data-lab-blend] [data-lab-step]')]
      .map(b => b.dataset.labStep!);
  const before = blendSteps();
  assert.equal(before.length, 9);
  // It starts at the subject.
  assert.equal(before[0]!.toLowerCase(), '#c0392b');

  // Changing the far end changes the ramp — and only the far end of it.
  const raw = $('[data-lab-blend-raw]') as HTMLInputElement;
  raw.value = 'oklch(90% 0.15 200)';
  raw.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  const after = blendSteps();
  assert.equal(after[0]!.toLowerCase(), '#c0392b', 'the near end is still the subject');
  assert.notEqual(after[8], before[8], 'the far end moved');
  // Junk is rejected without wrecking the ramp.
  raw.value = 'nope';
  raw.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  assert.equal(raw.getAttribute('aria-invalid'), 'true');
  assert.deepEqual(blendSteps(), after, 'an invalid far end changes nothing');
});

test('the stop count drives both ramps', async () => {
  await mount('?c=%23c0392b');
  const count = (sel: string): number => view.querySelectorAll(`${sel} [data-lab-step]`).length;
  assert.equal(count('[data-lab-ramp]'), 9);
  assert.equal(count('[data-lab-blend]'), 9);

  const range = $('[data-lab-steps]') as HTMLInputElement;
  range.value = '5';
  range.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.equal(count('[data-lab-ramp]'), 5, 'tones follow the stop count');
  assert.equal(count('[data-lab-blend]'), 5, 'and so does the blend');
  assert.equal(($('[data-lab-steps-out]')!.textContent ?? '').trim(), '5');

  // Clamped, not trusted: the range is the UI but the value is guarded.
  range.value = '999';
  range.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.ok(count('[data-lab-ramp]') <= 24, 'an absurd count is clamped');
});

test('the swatch leads in the picker’s space and lists popular alternates', async () => {
  await mount('?c=' + encodeURIComponent('color(display-p3 1 0 0)'));
  // Read the LABEL element, not textContent — the label and the value sit in
  // adjacent elements with no whitespace between them, so textContent runs
  // "oklch" straight into "oklch(64.857% …".
  const spacesOf = (): string[] =>
    [...view.querySelectorAll('[data-lab-sw-alts] .lab-sw-alt-space')]
      .map(el => (el.textContent ?? '').trim().toLowerCase());

  // OKLCH leads, because that is the picker's default tab.
  assert.match(text('[data-lab-sw-primary]'), /^oklch\(/);
  const spaces = spacesOf();
  assert.ok(!spaces.includes('oklch'), `the leading space is not repeated: ${spaces}`);
  assert.ok(spaces.includes('display-p3'), `the authored space is listed: ${spaces}`);
  assert.ok(spaces.includes('lch'), `lch present: ${spaces}`);
  // Hex is LAST — sRGB-only, so it's the fallback expression, not a peer.
  assert.equal(spaces[spaces.length - 1], 'hex');
  // Every alternate carries a real value beside its label.
  for (const li of view.querySelectorAll('[data-lab-sw-alts] .lab-sw-alt')) {
    assert.ok((li.querySelector('code')?.textContent ?? '').length > 0, 'an alternate has no value');
  }

  // Switching the picker's tab re-leads the swatch in that space.
  const hexTab = view.querySelector<HTMLElement>('[data-color-modes] [data-mode="hex"]')
    ?? view.querySelector<HTMLElement>('[data-color-modes] [data-val="hex"]');
  if (hexTab) {
    hexTab.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await new Promise(r => dom.window.setTimeout(r, 30));
    assert.match(text('[data-lab-sw-primary]'), /^#[0-9A-F]{6}$/, 'the hex tab leads with a hex');
  }
});

test('a picker echo of the mapped hex does not collapse a wide-gamut subject', async () => {
  // The bug this pins: the picker emits an onChange as it wires up, carrying the
  // sRGB hex it was just handed. Unguarded, that arrives as if the user had picked
  // it, replacing `color(display-p3 1 0 0)` with #FF0B0C — so EVERY colour in the
  // report read "sRGB" no matter what was typed.
  //
  // jsdom does not fire the mount-time event, which is exactly why the suite was
  // blind to it and a browser check found it. So the guard itself is what's tested
  // here: feed the picker's value field the mapped hex and assert nothing moves.
  await mount('?c=' + encodeURIComponent('color(display-p3 1 0 0)'));
  assert.equal($('[data-lab-gamut]')!.dataset.gamut, 'p3', 'precondition: P3 subject');
  const mapped = describeHex();

  const valueField = view.querySelector<HTMLInputElement>('[data-lab-picker] .color-input[data-color-hex]');
  assert.ok(valueField, 'the picker has a value field');
  valueField.value = mapped;
  valueField.dispatchEvent(new dom.window.Event('input', { bubbles: true }));

  assert.equal($('[data-lab-gamut]')!.dataset.gamut, 'p3', 'still P3 after the echo');
  assert.equal(($('[data-lab-raw]') as HTMLInputElement).value, 'color(display-p3 1 0 0)');

  // …but a DIFFERENT value from the picker is a real edit and must land. Written
  // in the ACTIVE MODE's format (OKLCH by default), because that is what the
  // picker's value field parses — a hex would simply be held as unparseable there.
  valueField.value = '55% 0.13 145';
  valueField.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.equal($('[data-lab-gamut]')!.dataset.gamut, 'srgb', 'a real pick still works');
  assert.match(($('[data-lab-raw]') as HTMLInputElement).value, /^#/, 'and becomes an sRGB hex');
});

/** The mapped sRGB hex currently shown in the swatch's hex alternate. */
function describeHex(): string {
  const li = [...view.querySelectorAll('[data-lab-sw-alts] .lab-sw-alt')]
    .find(x => (x.querySelector('.lab-sw-alt-space')?.textContent ?? '').trim() === 'hex');
  return (li?.querySelector('code')?.textContent ?? '').trim();
}
