// SPDX-License-Identifier: MPL-2.0
/**
 * Unit tests for the colour picker's space registry. DOM-free — the module never
 * touches document, which is the point of splitting it out of color-field.ts.
 * Run directly:  node --test shells/web/src/components/color-spaces.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseColor, convertColor, SRGB_SOURCE } from '@lolly/engine';
import type { GamutSource } from '@lolly/engine';
import {
  colorSpaces, getColorSpace, composeColor, decomposeColor, channelRuns,
  spaceExactness, spaceText, spaceParse, slugMode,
  registerColorProfile, unregisterColorProfile,
  type ChannelSpec,
} from './color-spaces.ts';

/** Max per-component difference between two colours, compared in sRGB. */
function srgbDelta(a: Parameters<typeof convertColor>[0], b: Parameters<typeof convertColor>[0]): number {
  const x = convertColor(a, 'srgb').components;
  const y = convertColor(b, 'srgb').components;
  return Math.max(...x.map((v, i) => Math.abs(v - (y[i] ?? 0))));
}

test('the eleven built-ins register in family order', () => {
  assert.deepEqual(colorSpaces().map(s => s.mode), [
    'oklch', 'oklab', 'lch', 'lab', 'xyz-d65',   // perceptual
    'hex', 'rgb', 'hsl',                          // device
    'display-p3', 'rec2020', 'cmyk',              // output
  ]);
  // The two judgement calls that need to be visible on screen.
  assert.equal(getColorSpace('xyz-d65')!.sub, 'reference');
  assert.equal(getColorSpace('cmyk')!.sub, 'uncalibrated');
});

test('compose(decompose(c)) is the same colour, in every registered space', () => {
  const subject = parseColor('#3c7a9f')!;
  for (const spec of colorSpaces()) {
    const vals = decomposeColor(spec, subject, 200);
    const back = composeColor(spec, vals, subject.alpha);
    assert.ok(srgbDelta(subject, back) < 1e-6, `${spec.mode} round trip drifted`);
  }
});

test('a grey keeps the remembered hue rather than reading one out of noise', () => {
  const grey = parseColor('#808080')!;
  // OKLCH and LCH mark the powerless hue as component 2, HSL as component 0 —
  // decomposeColor derives the flag from the channel's index, so all three work.
  for (const mode of ['oklch', 'lch', 'hsl'] as const) {
    const spec = getColorSpace(mode)!;
    assert.equal(decomposeColor(spec, grey, 217).h, 217, `${mode} lost the hue memory`);
  }
  // A colour that HAS a hue reports its own, never the memory.
  const green = parseColor('#30ba78')!;
  assert.ok(Math.abs(decomposeColor(getColorSpace('oklch')!, green, 217).h! - 217) > 10);
});

test('a chroma track is truncated by the gamut it is measured against', () => {
  const oklch = getColorSpace('oklch')!;
  const chroma = { ...oklch.channels[1]!, stops: 24 };
  const at = { l: 90, c: 0.2, h: 140 };   // a light green — where the gamuts differ most
  const total = (limit: 'srgb' | 'rec2020'): number =>
    channelRuns({ ...oklch, limit }, chroma, at).reduce((t, r) => t + (r.to - r.from), 0);
  const srgb = total('srgb');
  const wide = total('rec2020');
  assert.ok(srgb > 0, 'the grey axis is inside every gamut, so a run must exist');
  assert.ok(srgb < 1, 'a light green cannot hold 0.4 chroma in sRGB');
  assert.ok(wide > srgb, `Rec.2020 must reach further than sRGB (${wide} vs ${srgb})`);
});

test('a run leaves gaps where the axis is not displayable', () => {
  const oklch = getColorSpace('oklch')!;
  const hue = { ...oklch.channels[2]!, stops: 24, hold: undefined };
  // High chroma at mid lightness fits some hues and not others, so the hue track
  // becomes several arcs — the shape that tells you where you can go.
  const runs = channelRuns(oklch, hue, { l: 60, c: 0.15, h: 0 });
  assert.ok(runs.length >= 2, `expected several arcs, got ${runs.length}`);
  assert.ok(runs.every(r => r.stops.length >= 1));
});

test('exactness is a bounded-space question, not a gamut one', () => {
  const p3red = parseColor('color(display-p3 1 0 0)')!;
  assert.equal(spaceExactness(getColorSpace('hex')!, p3red), 'approx');
  assert.equal(spaceExactness(getColorSpace('rgb')!, p3red), 'approx');
  assert.equal(spaceExactness(getColorSpace('hsl')!, p3red), 'approx');
  assert.equal(spaceExactness(getColorSpace('display-p3')!, p3red), 'exact');
  // The perceptual spaces are unbounded, so they can always state it exactly —
  // which is why the picker's canonical value can now be a P3 colour at all.
  for (const mode of ['oklch', 'oklab', 'lch', 'lab', 'xyz-d65'] as const) {
    assert.equal(spaceExactness(getColorSpace(mode)!, p3red), 'exact', mode);
  }
});

test('the value field accepts any CSS colour, whatever space is active', () => {
  const oklch = getColorSpace('oklch')!;
  // A hex pasted while OKLCH is active used to be silently held as unparseable.
  assert.equal(spaceText(getColorSpace('hex')!, spaceParse(oklch, '#30ba78')!), '#30ba78');
  // Wide-gamut and perceptual notations land in their authored space.
  assert.equal(spaceParse(getColorSpace('hex')!, 'color(display-p3 1 0 0)')!.space, 'display-p3');
  assert.equal(spaceParse(getColorSpace('rgb')!, 'oklch(62% 0.11 250)')!.space, 'oklch');
  assert.equal(spaceParse(oklch, 'rebeccapurple')!.space, 'srgb');
  // The bare component list the picker used to speak still works, per space.
  assert.deepEqual(spaceParse(oklch, '62% 0.11 250')!.components, [0.62, 0.11, 250]);
  assert.deepEqual(spaceParse(getColorSpace('rgb')!, '255, 0, 0')!.components, [1, 0, 0]);
  // Alpha rides along.
  assert.equal(spaceParse(oklch, '62% 0.11 250 / 0.5')!.alpha, 0.5);
  // CMYK has no CSS notation, so it reads back its own.
  const cmyk = getColorSpace('cmyk')!;
  assert.equal(spaceText(cmyk, spaceParse(cmyk, 'cmyk(40% 0% 30% 10%)')!), 'cmyk(40% 0% 30% 10%)');
  assert.equal(spaceParse(oklch, ''), null);
  assert.equal(spaceParse(oklch, 'not a colour'), null);
});

test('a profile x intent is one registry entry, added and removed at runtime', () => {
  const inks: ChannelSpec[] = ['c', 'm', 'y', 'k'].map(ch => ({
    ch, label: ch.toUpperCase(), aria: ch, min: 0, max: 100, step: 1,
    fmt: (v: number) => `${Math.round(v)}%`, stops: 7,
  }));
  // A stand-in source: the id carries the intent, which is what makes profile x
  // intent naturally one key rather than an enum edit.
  const src: GamutSource = {
    id: 'icc:ab12cd:perceptual',
    label: 'Coated FOGRA39 (perceptual)',
    contains: (l, c, h) => SRGB_SOURCE.contains(l, c, h),
    inkCoverage: () => 2.4,
  };
  const before = colorSpaces().length;
  registerColorProfile(src, inks);
  const spaces = colorSpaces();
  assert.equal(spaces.length, before + 1);
  const spec = spaces[spaces.length - 1]!;
  assert.equal(spec.mode, 'icc:ab12cd:perceptual');
  assert.equal(spec.family, 'output', 'a profile lands in the Output family, last');
  assert.equal(spec.label, 'CMYK');
  assert.equal(spec.sub, 'Coated FOGRA39 · perceptual');
  assert.equal(spec.limit, src, 'the limit IS the source, so inGamut works on the press');
  assert.equal(spec.channels.length, 4);
  // The broken-track machinery needs no extra code path for a press profile.
  assert.ok(channelRuns(spec, spec.channels[0]!, { c: 0, m: 0, y: 0, k: 0 }).length >= 1);
  // Selector-hostile colons become dashes for the tab/panel ids.
  assert.equal(slugMode(spec.mode), 'icc-ab12cd-perceptual');

  unregisterColorProfile(src.id);
  assert.equal(colorSpaces().length, before);
  assert.equal(getColorSpace(src.id), undefined);
  // Built-ins are not removable through the profile door.
  unregisterColorProfile('cmyk');
  assert.ok(getColorSpace('cmyk'), 'cmyk survived');
});
