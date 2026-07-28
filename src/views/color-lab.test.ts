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
import { readFileSync } from 'node:fs';
import { describeColor } from '@lolly/engine';

const dom = new JSDOM('<!doctype html><html><body><main id="view"></main></body></html>', {
  url: 'http://localhost/#/lab',
  pretendToBeVisual: true,
});
globalThis.window = dom.window as unknown as typeof globalThis.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Element = dom.window.Element;
globalThis.MutationObserver = dom.window.MutationObserver;
// jsdom rejects an Event built by Node's own constructor (different realm), and
// `applyTheme` dispatches one on window — so the jsdom versions have to win here.
globalThis.CustomEvent = dom.window.CustomEvent;
globalThis.Event = dom.window.Event;
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
/** jsdom has no clipboard — record what the view tries to copy. `navigator` is a
 *  getter-only global, so define the property rather than assigning it. */
const copied: string[] = [];
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { clipboard: { writeText: (v: string) => { copied.push(v); return Promise.resolve(); } } },
});

const { mountColorLab } = await import('./color-lab.ts');

const view = document.getElementById('view')!;

/** Mount the view fresh with an optional `?c=` seed. */
async function mount(params = ''): Promise<void> {
  // Tear the previous mount down the way the router does — `#view` is persistent,
  // so clearing its children alone leaves the last view's rAF loop, observers and
  // its body-level toast behind (which is exactly what used to leak in the app).
  (view as HTMLElement & { _cleanup?: () => void })._cleanup?.();
  delete (view as HTMLElement & { _cleanup?: () => void })._cleanup;
  view.innerHTML = '';
  await mountColorLab(view, {}, params);
}

const $ = (sel: string): HTMLElement | null => view.querySelector<HTMLElement>(sel);
const text = (sel: string): string => ($(sel)?.textContent ?? '').trim();

/** The subject's sRGB hex, read off the swatch's hex alternate. There is no text
 *  field to read any more — the picker's own value pill is the single entry. */
function subjectHex(): string {
  const li = [...view.querySelectorAll('[data-lab-sw-alts] .lab-sw-alt')]
    .find(x => (x.querySelector('.lab-sw-alt-space')?.textContent ?? '').trim() === 'hex');
  return (li?.querySelector('code')?.textContent ?? '').trim().toLowerCase();
}
/** The subject's OKLCH, read off the panels' numeric inputs. */
function subjectOklch(): { l: number; c: number; h: number } {
  const num = (plane: string): number =>
    Number(($(`[data-lab-num="${plane}"]`) as HTMLInputElement).value);
  return { l: num('lc'), c: num('ch'), h: num('lh') };
}

test('the report mounts with every section present', async () => {
  await mount();
  for (const sel of [
    '[data-lab-swatch]', '[data-lab-picker]', '[data-lab-limit]',
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
  // The notice is a toast — the nudge on crossing the boundary. The standing
  // record is the gamut card in step 5, so nothing sits in the flow.
  const toast = document.querySelector('[data-lab-toast]');
  assert.ok(toast, 'the out-of-gamut toast was raised');
  assert.match(toast!.textContent ?? '', /outside sRGB/i);
  // The swatch leads with the space the PICKER is set to (OKLCH by default), and
  // says where the colour was actually authored so it can't read as if it were
  // typed in OKLCH. The authored form itself stays in the field and the alternates.
  assert.match(text('[data-lab-sw-primary]'), /^oklch\(/);
  assert.match(text('[data-lab-sw-space]'), /^oklch · set in display-p3/);
  const altSpaces = [...view.querySelectorAll('[data-lab-sw-alts] .lab-sw-alt-space')]
    .map(el => (el.textContent ?? '').trim());
  assert.ok(altSpaces.includes('display-p3'), `the authored space is an alternate: ${altSpaces}`);
  assert.match(toast!.textContent ?? '', /#FF/i);
  // The authored form survives as an alternate even though nothing echoes it back
  // in a text field any more.
  const altCodes = [...view.querySelectorAll('[data-lab-sw-alts] code')].map(c => (c.textContent ?? '').trim());
  assert.ok(altCodes.some(c => c === 'color(display-p3 1 0 0)'), `authored form listed: ${altCodes}`);
  // The swatch asks the browser for the REAL colour, with the hex only as the
  // CSS fallback underneath it.
  assert.equal($('[data-lab-swatch]')!.style.background, 'color(display-p3 1 0 0)');
});

test('the picker is handed the authored colour, not its sRGB restatement', async () => {
  const subject = 'color(display-p3 1 0 0)';
  await mount('?c=' + encodeURIComponent(subject));
  // Read what the field was SEEDED with — the canonical attribute when the component
  // publishes one, otherwise the rendered value attribute. Not the live input value:
  // that is the picker's own working notation, which is its business, not the view's.
  const field = $('[data-lab-picker] [data-color-field]') ?? $('[data-lab-picker]')!;
  const seeded = field.getAttribute('data-color-canon')
    ?? $('[data-lab-picker] input.color-input')!.getAttribute('value') ?? '';
  const seededDesc = describeColor(seeded);
  assert.ok(seededDesc, `the picker's seed is a readable colour: ${seeded}`);
  // Seeding it with srgbHex is what used to flatten the subject: the picker echoes
  // its value back, and the echo then BECAME the subject. So the seed must still be
  // the wide colour, and must not be the gamut-mapped hex.
  assert.equal(seededDesc!.gamut, 'p3', `seeded at its real gamut: ${seeded}`);
  assert.notEqual(seeded.trim().toLowerCase(), describeColor(subject)!.srgbHex.toLowerCase());
});

test('an in-gamut colour raises no gamut toast at all', async () => {
  await mount('?c=%23c0392b');
  assert.equal(document.querySelector('[data-lab-toast]'), null);
  assert.equal($('[data-lab-gamut]')!.dataset.gamut, 'srgb');
  assert.equal($('[data-lab-headroom]')!.dataset.state, 'under');
  assert.match(text('[data-lab-headroom] [data-lab-headroom-val]'), /^\+/);
});

test('a junk seed falls back instead of rendering an empty report', async () => {
  await mount('?c=not-a-colour');
  assert.ok(text('[data-lab-gamut] [data-lab-gamut-name]').length > 0, 'still describes something');
  assert.equal(document.querySelector('[data-lab-toast]'), null);
});

test('any CSS space still arrives via ?c=, and junk falls back', async () => {
  // The removed text field was the only in-page way to type a wide-gamut value;
  // the URL param remains, and becomes redundant once the picker carries tabs for
  // those spaces. Junk must fall back rather than render an empty report.
  for (const [seed, gamut] of [
    ['oklch(70% 0.30 145)', 'rec2020'],
    ['lab(55% 70 50)', 'srgb'],
    ['color(display-p3 1 0 0)', 'p3'],
  ] as [string, string][]) {
    await mount('?c=' + encodeURIComponent(seed));
    assert.equal($('[data-lab-gamut]')!.dataset.gamut, gamut, seed);
  }
  await mount('?c=' + encodeURIComponent('chartreuse-ish'));
  assert.ok(text('[data-lab-gamut-name]').length > 0, 'junk still renders a report');
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

test('readability leads with APCA and follows with WCAG, on three surfaces', async () => {
  await mount('?c=%23c0392b');
  const cards = [...view.querySelectorAll('.lab-contrast-card')];
  assert.equal(cards.length, 3, 'white text, black text, and a surface you choose');
  assert.equal(cards.filter(c => c.classList.contains('is-best')).length, 1,
    'exactly one of the two extremes is marked best');

  for (const c of cards) {
    // APCA first — an Lc and the band it falls in.
    const apca = c.querySelector('[data-lab-apca]');
    assert.ok(apca, 'every card carries an Lc');
    assert.match(apca!.textContent ?? '', /Lc \d+\.\d/, 'the Lc is shown');
    assert.ok((apca as HTMLElement).dataset.use, 'and the band it falls in');
    // WCAG second — still present, still with both badges.
    assert.match(c.textContent ?? '', /\d+\.\d+:1/, 'shows a ratio');
    assert.equal(c.querySelectorAll('.lab-wcag').length, 2, 'body and large badges');
    // The order in the DOM IS the hierarchy — APCA must come first.
    const kids = [...c.children].map(k => k.className);
    const iApca = kids.findIndex(k => k.includes('lab-apca'));
    const iWcag = kids.findIndex(k => k.includes('lab-contrast-wcag'));
    assert.ok(iApca >= 0 && iWcag > iApca, `APCA precedes WCAG: ${kids.join(' | ')}`);
  }

  // The summary line leads with the Lc too, and names WCAG's number second.
  const note = text('[data-lab-contrast-note]');
  assert.match(note, /Best pairing/);
  assert.match(note, /Lc \d+\.\d/);
  assert.ok(note.indexOf('Lc') < note.indexOf('WCAG'), `APCA first in the summary: ${note}`);
});

test('the third surface is pickable and re-scores when it changes', async () => {
  await mount('?c=%23c0392b');
  const third = [...view.querySelectorAll('.lab-contrast-card')][2]!;
  // A popover picker, which is what a secondary control on a card wants — the
  // expanded form's rings would dominate the two numbers beside them.
  const pick = third.querySelector('[data-lab-ink-pick]');
  assert.ok(pick, 'the third card carries its own picker');
  assert.ok(pick!.querySelector('[data-color-field], .color-field, input'),
    'and the picker actually mounted');

  // Re-query after every change: a re-score REPLACES the cards, so a held
  // reference goes stale and would report the old number forever.
  const lcOf = (): string => (
    view.querySelectorAll('.lab-contrast-card')[2]?.querySelector('.lab-apca-lc')?.textContent ?? ''
  ).trim();
  const before = lcOf();
  // Drive it the way the component reports a pick — its own value field.
  const field = pick!.querySelector('input[data-color-hex]') as HTMLInputElement | null;
  assert.ok(field, 'the popover has a value field');
  field!.value = '#111111';
  field!.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 0));
  assert.notEqual(lcOf(), before, `a new surface re-scores the card: ${before} → ${lcOf()}`);
  // A near-black surface under a mid red is a far worse pairing than white was, so
  // the direction is checkable, not just the fact that something moved.
  assert.ok(Number(lcOf().replace(/[^\d.]/g, '')) < Number(before.replace(/[^\d.]/g, '')),
    `and it re-scores in the right direction: ${before} → ${lcOf()}`);
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
  // The swatch reads in OKLCH, so the step is confirmed through the hex alternate.
  assert.equal(subjectHex(), wanted.toLowerCase(), 'to the step that was clicked');
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

test('the report opens in OKLCH, not hex', async () => {
  await mount();
  // The swatch leads in the picker's space, which defaults to OKLCH — hex is the
  // sRGB-only fallback expression and must not be what greets you.
  assert.match(text('[data-lab-sw-primary]'), /^oklch\(/, text('[data-lab-sw-primary]'));
  assert.match(text('[data-lab-sw-space]'), /^oklch/);
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
  const step = view.querySelector<HTMLElement>('[data-lab-ramp] [data-lab-step]')!;
  const wanted = step.dataset.labStep!;
  step.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.match(dom.window.location.hash, /^#\/lab\?c=/);
  assert.equal(decodeURIComponent(dom.window.location.hash), `#/lab?c=${wanted}`);
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
  for (const sel of ['[data-lab-picker]', '[data-lab-brand]']) {
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

test('each ramp carries its own stop count, and both are clamped', async () => {
  await mount('?c=%23c0392b');
  const count = (sel: string): number => view.querySelectorAll(`${sel} [data-lab-step]`).length;
  assert.equal(count('[data-lab-ramp]'), 9);
  assert.equal(count('[data-lab-blend]'), 9);

  // The counts are separate on purpose: a tone ramp is a palette of a handful, a
  // blend gets cut finely to find one particular intermediate. So moving one must
  // NOT move the other.
  const tones = $('[data-lab-steps]') as HTMLInputElement;
  tones.value = '5';
  tones.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.equal(count('[data-lab-ramp]'), 5, 'tones follow their own count');
  assert.equal(count('[data-lab-blend]'), 9, 'and the blend is left alone');
  assert.equal(($('[data-lab-steps-out]')!.textContent ?? '').trim(), '5');

  const mix = $('[data-lab-blend-steps] [data-gsl-input]') as HTMLInputElement;
  mix.value = '4';
  mix.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.equal(count('[data-lab-blend]'), 4, 'the blend follows the mixer slider');
  assert.equal(count('[data-lab-ramp]'), 5, 'and the tones are left alone');
  assert.equal(($('[data-lab-blend-steps] [data-gsl-val]')!.textContent ?? '').trim(), '4');

  // Clamped, not trusted: the range is the UI but the value is guarded.
  for (const [el, sel] of [[tones, '[data-lab-ramp]'], [mix, '[data-lab-blend]']] as const) {
    el.value = '999';
    el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    assert.ok(count(sel) <= 24, `an absurd count is clamped (${sel})`);
  }
});

test('the blend style tabs change what the middle looks like', async () => {
  // Subject and target are far apart in hue, which is where the spaces diverge most.
  await mount('?c=%23c0392b');
  const midHex = (): string => {
    const steps = [...view.querySelectorAll('[data-lab-blend] [data-lab-step]')];
    return (steps[Math.floor(steps.length / 2)]?.querySelector('.lab-step-hex')?.textContent ?? '').trim();
  };
  const seg = $('[data-lab-blend-space]')!;
  const pick = (val: string): void => {
    seg.querySelector<HTMLElement>(`[data-val="${val}"]`)!.dispatchEvent(
      new dom.window.MouseEvent('click', { bubbles: true }));
  };

  // VIVID is the default on this page — it is where you come to see how much colour
  // a blend can hold — and the tab says so.
  assert.equal(seg.querySelector('[data-val="oklch"]')!.getAttribute('aria-pressed'), 'true');
  const vivid = midHex();
  assert.match(vivid, /^#[0-9A-F]{6}$/);

  // Smooth goes through the middle instead of round, so the midpoint differs.
  pick('oklab');
  const smooth = midHex();
  assert.notEqual(smooth, vivid, 'Smooth is not Vivid');
  assert.equal(seg.querySelector('[data-val="oklab"]')!.getAttribute('aria-pressed'), 'true');
  assert.equal(seg.querySelector('[data-val="oklch"]')!.getAttribute('aria-pressed'), 'false');

  // sRGB is the classic behaviour, named plainly. Also distinct.
  pick('srgb');
  assert.notEqual(midHex(), vivid, 'sRGB is not Vivid');

  // The ends are exact in every style — a blend that does not start at the subject
  // is describing a different colour from the one the page is about.
  const ends = (): [string, string] => {
    const steps = [...view.querySelectorAll('[data-lab-blend] [data-lab-step] .lab-step-hex')];
    return [(steps[0]?.textContent ?? '').trim(), (steps[steps.length - 1]?.textContent ?? '').trim()];
  };
  for (const style of ['oklch', 'oklab', 'srgb']) {
    pick(style);
    assert.equal(ends()[0], '#C0392B', `${style} starts at the subject`);
  }
});

test('the hue route appears only where hue travel is a real choice', async () => {
  await mount('?c=%23c0392b');
  const hue = $('[data-lab-blend-hue]') as HTMLElement;
  const pickSpace = (val: string): void => {
    $('[data-lab-blend-space]')!.querySelector<HTMLElement>(`[data-val="${val}"]`)!
      .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  };
  // Vivid is the default and IS polar, so the row starts visible. OKLab and sRGB are
  // rectangular — no circle to go round, and CSS would reject `in oklab longer hue`.
  assert.equal(hue.hidden, false, 'shown for the default Vivid');
  pickSpace('srgb');
  assert.equal(hue.hidden, true, 'hidden for sRGB');
  pickSpace('oklab');
  assert.equal(hue.hidden, true, 'hidden for Smooth');
  pickSpace('oklch');
  assert.equal(hue.hidden, false, 'shown again for Vivid');

  const midHex = (): string => {
    const steps = [...view.querySelectorAll('[data-lab-blend] [data-lab-step] .lab-step-hex')];
    return (steps[Math.floor(steps.length / 2)]?.textContent ?? '').trim();
  };
  const short = midHex();
  hue.querySelector<HTMLElement>('[data-val="longer"]')!
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.notEqual(midHex(), short, 'the long way round is a different midpoint');
});

test('the blend slider rail carries the gradient it subdivides', async () => {
  await mount('?c=%23c0392b');
  // The rail IS the preview — there is no separate strip — so it has to be painted,
  // in the chosen space, from the AUTHORED values rather than their sRGB hexes.
  const seg = $('[data-lab-blend-steps] [data-gsl-track] .gsl-seg') as HTMLElement;
  assert.ok(seg, 'the rail has a painted segment');
  assert.match(seg.getAttribute('style') ?? '', /linear-gradient\(90deg in oklch,/);
  $('[data-lab-blend-space]')!.querySelector<HTMLElement>('[data-val="oklab"]')!
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.match(
    view.querySelector('[data-lab-blend-steps] [data-gsl-track] .gsl-seg')!.getAttribute('style') ?? '',
    /in oklab/);
  $('[data-lab-blend-space]')!.querySelector<HTMLElement>('[data-val="oklch"]')!
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  const after = view.querySelector('[data-lab-blend-steps] [data-gsl-track] .gsl-seg')!;
  // `shorter` is the CSS default and must be left OFF; `longer` must be stated.
  assert.doesNotMatch(after.getAttribute('style') ?? '', /shorter/);
  $('[data-lab-blend-hue]')!.querySelector<HTMLElement>('[data-val="longer"]')!
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.match(
    view.querySelector('[data-lab-blend-steps] [data-gsl-track] .gsl-seg')!.getAttribute('style') ?? '',
    /in oklch longer hue/);
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
  const mapped = subjectHex();

  const valueField = view.querySelector<HTMLInputElement>('[data-lab-picker] .color-input[data-color-hex]');
  assert.ok(valueField, 'the picker has a value field');
  valueField.value = mapped;
  valueField.dispatchEvent(new dom.window.Event('input', { bubbles: true }));

  assert.equal($('[data-lab-gamut]')!.dataset.gamut, 'p3', 'still P3 after the echo');
  assert.match(text('[data-lab-sw-space]'), /set in display-p3/, 'the authored space survives');

  // …but a DIFFERENT value from the picker is a real edit and must land. Written
  // in the ACTIVE MODE's format (OKLCH by default), because that is what the
  // picker's value field parses — a hex would simply be held as unparseable there.
  valueField.value = '55% 0.13 145';
  valueField.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.equal($('[data-lab-gamut]')!.dataset.gamut, 'srgb', 'a real pick still works');
  assert.match(subjectHex(), /^#[0-9a-f]{6}$/, 'and becomes an sRGB hex');
});

test('each chart panel is named for the channel it sets, and sets it three ways', async () => {
  await mount('?c=' + encodeURIComponent('oklch(70% 0.19 317)'));
  // Panel titles are CHANNELS — the thing the panel's slider and number control —
  // not the plane the chart happens to draw.
  const titles = [...view.querySelectorAll('.lab-chart-title')].map(h => (h.textContent ?? '').trim());
  assert.deepEqual(titles, ['Lightness', 'Chroma', 'Hue']);

  // Each panel has a slider AND a typed input for its own channel.
  for (const plane of ['lc', 'ch', 'lh']) {
    assert.ok($(`[data-lab-slider="${plane}"] [data-gsl-input]`), `${plane} has a slider`);
    assert.ok($(`[data-lab-num="${plane}"]`), `${plane} has a number`);
  }

  // The Hue panel's controls move HUE, not the plane's fixed channel.
  const hueNum = $('[data-lab-num="lh"]') as HTMLInputElement;
  assert.ok(Math.abs(Number(hueNum.value) - 317) < 0.5, `hue input shows the hue: ${hueNum.value}`);
  hueNum.value = '120';
  hueNum.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  const after = subjectOklch();
  assert.ok(Math.abs(after.h - 120) < 1.5, `hue moved to 120, got ${after.h}`);
  assert.ok(Math.abs(after.l - 0.7) < 0.02, 'lightness held');

  // The Lightness panel's number moves lightness.
  const lNum = $('[data-lab-num="lc"]') as HTMLInputElement;
  lNum.value = '0.4';
  lNum.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  assert.ok(Math.abs(subjectOklch().l - 0.4) < 0.02, `lightness moved to 0.4, got ${subjectOklch().l}`);

  // Out-of-range typing is clamped, not obeyed.
  lNum.value = '99';
  lNum.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  assert.ok(subjectOklch().l <= 1.0001, `clamped to 1, got ${subjectOklch().l}`);
});

test('bounds off lets you leave the gamut and marks it; bounds on yields chroma', async () => {
  // The stance, pinned: leaving sRGB is usually the intent, so the default must not
  // prevent it — it marks it. Turning bounds ON then pulls the colour in by giving
  // up CHROMA rather than refusing the axis being dragged, because refusing would
  // trap the thumb inside one segment of a broken track.
  await mount('?c=' + encodeURIComponent('oklch(70% 0.19 317)'));
  const box = $('[data-lab-bounds]') as HTMLInputElement;
  assert.ok(box, 'the toggle exists');
  assert.equal(box.checked, false, 'bounds are OFF by default');

  // Narrow the target to sRGB so a modest chroma is genuinely out.
  $('[data-lab-limit]')!.querySelector<HTMLElement>('[data-val="srgb"]')!
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

  // Push chroma well past what sRGB holds at this lightness and hue.
  const cNum = $('[data-lab-num="ch"]') as HTMLInputElement;
  cNum.value = '0.34';
  cNum.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  const free = subjectOklch();
  assert.ok(free.c > 0.3, `bounds off keeps the requested chroma, got ${free.c}`);
  assert.equal($('[data-lab-gamut]')!.dataset.gamut !== 'srgb', true, 'and it is out of sRGB');
  // …and the slider says so, without having stopped anything.
  assert.ok(view.querySelector('[data-lab-slider="ch"] .gsl.is-out'), 'the out-of-bounds mark is shown');

  // Now hold the bounds: chroma gives, hue and lightness do not.
  box.checked = true;
  box.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  const held = subjectOklch();
  assert.ok(held.c < free.c, `chroma yielded: ${free.c} → ${held.c}`);
  assert.ok(Math.abs(held.h - free.h) < 2, `hue held: ${free.h} → ${held.h}`);
  assert.ok(Math.abs(held.l - free.l) < 0.02, `lightness held: ${free.l} → ${held.l}`);
  assert.equal($('[data-lab-gamut]')!.dataset.gamut, 'srgb', 'and it is back inside sRGB');
  assert.equal(view.querySelector('[data-lab-slider="ch"] .gsl.is-out'), null, 'the mark clears');

  // With bounds on, a fresh out-of-range request is pulled in as it is made.
  cNum.value = '0.39';
  cNum.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  assert.equal($('[data-lab-gamut]')!.dataset.gamut, 'srgb', 'held on the next edit too');
});

// The out-of-bounds MARK itself lives entirely in vendor thumb pseudo-elements that
// jsdom neither applies nor exposes, so the only honest way to pin it is against the
// stylesheet text — the precedent set by color-field.test.ts's dashed-border sweep.
// What matters is the COUPLING: the glyph is baked into an SVG pre-rotated -45deg so
// it lands upright once the thumb's own rotate(45deg) applies. Drop or change either
// rotation and the exclamation mark silently sits on its side.
test('the out-of-bounds diamond carries an upright exclamation mark', () => {
  const css = readFileSync(new URL('../lib/oklch-slice.css', import.meta.url), 'utf8');

  for (const thumb of ['-webkit-slider-thumb', '-moz-range-thumb']) {
    const base = new RegExp(`\\.gsl-input::${thumb} \\{([^}]*)\\}`).exec(css);
    assert.ok(base, `the base ${thumb} rule moved`);
    assert.match(base![1]!, /transform:\s*rotate\(45deg\)/,
      `${thumb} must still rotate 45deg — the glyph's -45deg counter-rotation assumes it`);

    const out = new RegExp(`\\.gsl\\.is-out \\.gsl-input::${thumb} \\{([^}]*)\\}`).exec(css);
    assert.ok(out, `the is-out ${thumb} rule moved`);
    assert.match(out![1]!, /background-image:\s*var\(--gsl-bang\)/, `${thumb} shows the mark`);
    assert.match(out![1]!, /background-position:\s*center/, `${thumb} centres it in the diamond`);
    assert.match(out![1]!, /oklch\(0\.65 0\.19 45\)/, `${thumb} keeps its warning ring`);
  }

  const glyph = /--gsl-bang:\s*url\("([^"]*)"\)/.exec(css);
  assert.ok(glyph, 'the --gsl-bang glyph moved');
  const svg = decodeURIComponent(glyph![1]!.replace(/^data:image\/svg\+xml,/, ''));
  assert.match(svg, /rotate\(-45 6 6\)/, 'the glyph is counter-rotated about the viewBox centre');
  assert.match(svg, /<rect[^>]*\/>[\s\S]*<circle[^>]*\/>/, 'a bar over a dot — an exclamation mark');
  // Sized to the diamond's UPRIGHT inscribed square (0.85rem / √2 ≈ 0.6rem), so the
  // mark cannot overrun the rotated corners.
  assert.match(css, /background-size:\s*0\.6rem 0\.6rem/, 'the mark fits the inscribed square');
});

test('a blend stop copies; a tone step re-seeds', async () => {
  await mount('?c=%23c0392b');
  const before = subjectHex();
  copied.length = 0;

  // A BLEND stop is an output you take away — copying it must not move the subject,
  // which would also destroy the blend it came from (its near end IS the subject).
  const blendStop = view.querySelectorAll<HTMLElement>('[data-lab-blend] [data-lab-step]')[4]!;
  blendStop.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise(r => dom.window.setTimeout(r, 5));
  assert.equal(copied.length, 1, `copied exactly once, got ${copied.length}`);
  assert.match(copied[0]!, /^oklch\(/, `the stop's own notation, not a hex: ${copied[0]}`);
  assert.equal(subjectHex(), before, 'and the subject did NOT move');
  assert.match(blendStop.getAttribute('aria-label') ?? '', /^Copy /, 'it says so to AT');

  // A TONE step is a point on the subject's own ramp, so it re-seeds and copies nothing.
  copied.length = 0;
  const toneStep = view.querySelectorAll<HTMLElement>('[data-lab-ramp] [data-lab-step]')[1]!;
  const toneHex = toneStep.dataset.labStep!;
  toneStep.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.equal(subjectHex(), toneHex.toLowerCase(), 'the tone step re-seeded');
  assert.deepEqual(copied, [], 'and copied nothing');
});

test('you get the notation you clicked, not a canonical one', async () => {
  await mount('?c=%23c0392b');

  // The swatch's leading line is OKLCH, so clicking it copies oklch(...).
  copied.length = 0;
  $('[data-lab-sw-primary]')!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise(r => dom.window.setTimeout(r, 5));
  assert.equal(copied.length, 1);
  assert.match(copied[0]!, /^oklch\(/, `oklch line copies oklch: ${copied[0]}`);

  // Its hex alternate copies the hex.
  copied.length = 0;
  const hexCode = [...view.querySelectorAll<HTMLElement>('[data-lab-sw-alts] .lab-sw-alt')]
    .find(li => (li.querySelector('.lab-sw-alt-space')?.textContent ?? '').trim() === 'hex')!
    .querySelector<HTMLElement>('code')!;
  hexCode.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise(r => dom.window.setTimeout(r, 5));
  assert.deepEqual(copied, ['#C0392B'], `hex line copies hex: ${copied}`);

  // A tone step's hex sub-label copies the hex and does NOT re-seed, because the
  // value you clicked was a value, not the swatch.
  copied.length = 0;
  const before = subjectHex();
  const toneHexLabel = view.querySelector<HTMLElement>('[data-lab-ramp] [data-lab-step] .lab-step-hex')!;
  toneHexLabel.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise(r => dom.window.setTimeout(r, 5));
  assert.equal(copied.length, 1, 'clicking a value copies it');
  assert.equal(subjectHex(), before, 'and does not re-seed');
});

test('the blend target gets the expanded picker, dials included', async () => {
  await mount('?c=%23c0392b');
  const picker = $('[data-lab-blend-picker]')!;
  // The dials are gated on the inline form inside the component, so a float
  // popover can only ever show the hex field, alpha and swatches — which is what
  // this used to be, and why a blend target could not be picked perceptually.
  assert.ok(picker.querySelector('.color-field--inline'), 'mounted inline, not as a popover');
  assert.ok(picker.querySelector('[data-color-modes]'), 'has the space tabs');
  assert.ok(picker.querySelector('.color-lch'), 'has the L/C/H sliders');
  assert.ok(picker.querySelectorAll('.color-dial').length >= 3, 'has the dials');

  // And it still drives the blend.
  const stops = (): string[] => [...view.querySelectorAll<HTMLElement>('[data-lab-blend] [data-lab-step]')]
    .map(b => b.dataset.labStep!);
  const before = stops();
  const raw = $('[data-lab-blend-raw]') as HTMLInputElement;
  raw.value = 'oklch(88% 0.14 120)';
  raw.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  assert.notEqual(stops()[8], before[8], 'the far end moved');
  assert.equal(stops()[0], before[0], 'the near end is still the subject');
});

test('the theme toggle rides the top-right chrome, icon-only, and cycles', async () => {
  // Why it is here at all: this page is about how a colour READS, and a colour reads
  // differently in each screen theme. So the switch belongs next to the report, not
  // three clicks away in a profile menu.
  await mount('?c=%23c0392b');
  const chrome = $('[data-lab-chrome]')!;
  assert.ok(chrome, 'the chrome capsule exists');
  // Opposite the back pill, in the same row — not stacked above the heading.
  assert.ok($('.lab-back .back-pill, .lab-back [data-back-pill]'), 'the back pill shares the row');
  const btn = chrome.querySelector('button')!;
  assert.ok(btn, 'the toggle is mounted');
  assert.ok(btn.querySelector('svg'), 'icon-only — a glyph, not a label');
  assert.equal((btn.textContent ?? '').trim(), '', 'no text beside the glyph');
  // The theme name rides the accessible name instead, since the glyph carries it visually.
  assert.match(btn.getAttribute('aria-label') ?? '', /theme/i);
  assert.equal(btn.getAttribute('aria-label'), btn.title, 'tooltip and accessible name agree');

  const before = document.documentElement.dataset.theme || 'light';
  btn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise(r => setTimeout(r, 0));
  assert.notEqual(document.documentElement.dataset.theme, before, 'a click moves the theme on');
  assert.equal(btn.dataset.theme, document.documentElement.dataset.theme,
    'and the glyph shows the theme now in force');
});

test('the third surface’s picker survives its own change — the card is scored, not rebuilt', async () => {
  // The bug this pins, reported from the browser: "the sliders on the your surface
  // card disappear when clicked, they won't drag". `onChange` re-rendered the card
  // with innerHTML, which destroyed the live popover on its own FIRST input event —
  // so the slider under the pointer vanished and the gesture died with it.
  await mount('?c=%23c0392b');
  const host = $('[data-lab-ink-pick]')!;
  const field = host.querySelector('input[data-color-hex]') as HTMLInputElement;
  const sliders = () => host.querySelectorAll('input[data-mode-ch]').length;
  const before = sliders();
  assert.ok(before > 0, 'the popover mounted its channel sliders');

  // A whole drag's worth of events — a real gesture is many, and the first one is
  // what used to kill it.
  for (const v of ['#111111', '#222222', '#333333']) {
    field.value = v;
    field.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 0));
    assert.equal($('[data-lab-ink-pick]'), host, 'the picker host is the SAME element');
    assert.equal(sliders(), before, `the sliders are still there after ${v}`);
  }
  // And the scoring still happened — in place.
  assert.match(
    view.querySelector('[data-lab-card="ink"] .lab-apca-lc')?.textContent ?? '', /Lc \d/);

  // A subject change must not tear it out either: the whole point of stable markup.
  const step = view.querySelector<HTMLElement>('[data-lab-ramp] [data-lab-step]')!;
  step.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise(r => setTimeout(r, 0));
  assert.equal($('[data-lab-ink-pick]'), host, 'still the same host after a re-seed');
  assert.equal(sliders(), before, 'and still its sliders');
});
