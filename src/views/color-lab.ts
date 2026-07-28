// SPDX-License-Identifier: MPL-2.0
/**
 * Colour Lab (#/lab) — one colour, comprehensively.
 *
 * A single scrolling report rather than a sidebar-and-stage tool: there is no
 * canvas to zoom and nothing to export, so the page IS the document. Every
 * control lives in the flow of the report, next to the thing it changes.
 *
 * ## Why a view and not a tool
 *
 * The interesting controls here are the shell's own: `mountColorField` with the
 * tabbed multi-space picker and the OKLCH rings/sliders. Tools are DATA — they
 * cannot import shell modules — so a tool version would have had to reimplement
 * the picker, which is the one component the component audit went out of its way
 * to unify. Being a view also means the page can simply be tall, which no
 * `render.layout` mode allows (every one of them keeps a fixed zoom-to-fit
 * stage). The cost, accepted deliberately: no CLI render, no URL-mode export.
 *
 * ## The order of the page is the order of the questions
 *
 *   1. **Set a colour** — in any space. The picker, a free-text field, the brand
 *      rail. This is the only thing a first-time visitor has to understand.
 *   2. **The charts** — where it sits, four ways, with the sRGB/P3/Rec.2020
 *      control that governs what they draw. High up, because they are the reason
 *      to open the page.
 *   3. **Every notation** — the same colour written for each space, copyable.
 *   4. **Tones and blends** — ramps out of it: through its own lightness, and
 *      across to a second colour you choose, at a step count you set.
 *   5. **Displayable range and readability** — the verdict and the contrast
 *      scores. Real, but reference: you look them up once you have a candidate,
 *      so they sit at the bottom rather than in front of the charts.
 *
 * Easy at the top, detailed as you go down.
 *
 * Picking happens in five places — the picker, the text field, the brand rail,
 * a drag on any 2D chart, and any ramp step — and all of them funnel through
 * `setSubject`, so no two paths can disagree.
 *
 * ## The subject is never collapsed to sRGB
 *
 * The colour is kept as the string the user authored and described by the
 * engine's `describeColor`, so `color(display-p3 1 0 0)` is reported at its real
 * chroma (0.299) and its real gamut (P3) — not flattened to `#ff0000` and then
 * trivially declared sRGB-safe.
 *
 * It is also PAINTED from the authored value. Every swatch on this page sets the
 * colour as CSS wrote it, so a wide-gamut display shows the real thing and only a
 * narrower one falls back — the browser does that mapping itself, per display,
 * which is strictly better than us deciding in advance that nobody can see it.
 * `srgbHex` is used only where a hex is structurally unavoidable:
 *
 *   - the chart and 3D canvases (a 2D canvas is 8-bit sRGB)
 *   - our colour picker, whose chroma slider gamut-maps
 *
 * Both are labelled where they show, rather than silently standing in for the
 * value. Widening the picker is the next step, and the same work the brand studio
 * needs for wider colour spaces.
 */

import '../styles/parts/color-lab.css';
import '../lib/oklch-slice.css';           // the .okls-* chart rules (see oklch-slice.ts)
import {
  describeColor, contrastVsExtremes, wcagLevel, oklchToHex, rampOklab,
  gamutSolid, projectGamutSolid, projectSolidPoint, contrastRatio, GAMUTS,
} from '@lolly/engine';
import type {
  ColorDescription, ContrastVerdict, GamutName, GamutSolid, SlicePlane,
} from '@lolly/engine';
import {
  renderSliceChart, paintSliceChart, wireSliceChart, updateSliceDot,
  sliceFixedOf, SLICE_AXES, SLICE_C_MAX, formatFixed,
} from '../lib/oklch-slice.ts';
import type { SliceChartState } from '../lib/oklch-slice.ts';
import {
  renderGamutSlider, paintGamutSlider, wireGamutSlider, channelRange,
} from '../lib/gamut-slider.ts';
import type { GamutChannel } from '../lib/gamut-slider.ts';
import { mountColorField } from '../components/color-field.ts';
import { backPillHtml, mountBackPill } from '../components/back-pill.ts';
import { escape } from '../utils.ts';
import { announce } from '../a11y.ts';
import { t } from '../i18n.ts';

/** The host surface this view needs — only the brand palette, and optionally. */
export interface ColorLabHost {
  tokens?: { colors?(): Promise<Array<{ id?: string; name?: string; value?: string }>> | Array<{ id?: string; name?: string; value?: string }> };
}

/** The three 2D planes, in the order they are laid out. */
const PLANES: SlicePlane[] = ['lc', 'ch', 'lh'];

const PLANE_TITLE: Record<SlicePlane, string> = {
  lc: 'Lightness × Chroma',
  ch: 'Chroma × Hue',
  lh: 'Lightness × Hue',
};
const PLANE_WHY: Record<SlicePlane, string> = {
  lc: 'How much punch this hue can take, at every lightness.',
  ch: 'Which hues hold up at this lightness — and which collapse.',
  lh: 'The lightness band that can carry this much chroma.',
};

const GAMUT_TITLE: Record<GamutName, string> = {
  srgb: 'sRGB',
  p3: 'Display-P3',
  rec2020: 'Rec.2020',
  none: 'Beyond every display',
};
const GAMUT_BLURB: Record<GamutName, string> = {
  srgb: 'Every screen, every print pipeline, every browser can show this.',
  p3: 'Needs a wide-gamut screen. Most phones and recent laptops have one; older monitors and CMYK print do not.',
  rec2020: 'Beyond Display-P3. Almost no consumer screen shows this today.',
  none: 'No display can reproduce this colour. It will always be mapped down before it reaches anyone.',
};

/** The alternate notations shown ON the swatch, in order. A short list on
 *  purpose — the full set lives in the notation table. */
const SWATCH_ALT_SPACES: readonly string[] = ['oklch', 'lch', 'display-p3'];

/**
 * Which CSS space each of the picker's tabs speaks, so the swatch can lead with
 * the value in the space the user is actually picking in.
 *
 * `cmyk` maps to null: there is no CSS `cmyk()`, and the picker's own CMYK is an
 * approximate conversion for print rather than a colour notation — so the swatch
 * falls back to hex there rather than inventing a syntax.
 */
const PICKER_MODE_SPACE: Record<string, string | null> = {
  oklch: 'oklch',
  hsl: 'hsl',
  rgb: 'srgb',
  hex: null,
  cmyk: null,
};

/** A colour to seed with when nothing else is available. Written in oklch() on
 *  purpose: the report is an OKLCH instrument, and opening on a hex would put the
 *  least informative notation in the field the user is most likely to edit. */
const FALLBACK = 'oklch(62% 0.19 260)';

export async function mountColorLab(view: HTMLElement, host: ColorLabHost, params = ''): Promise<void> {
  document.title = 'Colour Lab · Lolly';

  // ── State ────────────────────────────────────────────────────────────────
  /** The colour as AUTHORED — any CSS colour, not necessarily inside sRGB. */
  let subject = seedFrom(params) ?? FALLBACK;
  let desc = describeColor(subject) ?? describeColor(FALLBACK)!;
  /** Which gamut the charts and the solid extend to. */
  let limit: Exclude<GamutName, 'none'> = 'rec2020';
  /** The far end of the blend ramp, and how many stops both ramps carry. */
  let other = 'oklch(85% 0.13 85)';
  let steps = 9;
  /** The 3D view angles, and the solid meshes (cached — each costs a build). */
  const solidView = { yaw: 28, pitch: 18, scale: 0.92 };
  const solidCache = new Map<string, GamutSolid>();

  const cleanups: Array<() => void> = [];

  view.innerHTML = shellHtml();
  mountBackPill(view);

  const $ = <T extends HTMLElement = HTMLElement>(sel: string): T | null =>
    view.querySelector<T>(sel);

  // ── The subject block ────────────────────────────────────────────────────
  const swatch = $('[data-lab-swatch]')!;
  const rawInput = $<HTMLInputElement>('[data-lab-raw]')!;
  const rawErr = $('[data-lab-raw-err]')!;
  const pickerMount = $('[data-lab-picker]')!;
  const clampNote = $('[data-lab-clamp]')!;

  /** True while the picker is being re-seeded, so its own onChange is ignored. */
  let seeding = false;

  /** The picker's active space tab ('oklch' by default). */
  const pickerMode = (): string =>
    pickerMount.querySelector<HTMLElement>('[data-color-modes]')?.dataset.activeMode ?? 'oklch';

  // Switching the picker's space re-titles the swatch, so the value on it always
  // matches the space being edited. Delegated, because the picker is re-mounted.
  pickerMount.addEventListener('click', (e) => {
    if (!(e.target as HTMLElement).closest('[data-color-modes]')) return;
    // After the picker's own handler has moved data-active-mode.
    requestAnimationFrame(() => renderReadouts());
  });

  // Through the same seeding-guarded path as every later re-seed. Mounting it
  // inline here instead is what made EVERY colour report "sRGB": the picker emits
  // an onChange while it wires up, and with no guard that echo overwrote the
  // authored subject with the picker's sRGB hex before the first paint. jsdom
  // never fires that event, so the test suite was blind to it.
  reseedPicker();

  const onRaw = (): void => {
    const next = describeColor(rawInput.value);
    if (!next) {
      rawErr.textContent = t('Not a colour I can read. Try a hex, oklch(), lab(), or color(display-p3 …).');
      rawErr.hidden = false;
      return;
    }
    rawErr.hidden = true;
    setSubject(rawInput.value);
  };
  rawInput.addEventListener('change', onRaw);
  rawInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') onRaw(); });
  cleanups.push(() => {
    rawInput.removeEventListener('change', onRaw);
  });

  // ── The gamut-limit control ──────────────────────────────────────────────
  const limitSeg = $('[data-lab-limit]')!;
  limitSeg.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-val]');
    if (!btn) return;
    const next = btn.dataset.val as Exclude<GamutName, 'none'>;
    if (next === limit) return;
    limit = next;
    limitSeg.querySelectorAll<HTMLElement>('[data-val]')
      .forEach(b => b.setAttribute('aria-pressed', String(b === btn)));
    // The legend keys are part of the chart's markup, so the limit change needs a
    // rebuild, not just a repaint.
    buildCharts();
    paintCharts();
    paintSolid();
  });

  // ── The 2D charts ────────────────────────────────────────────────────────
  /** Per-plane chart state, all three sliced through the subject. */
  const chartState = new Map<SlicePlane, SliceChartState>();
  const chartTeardowns: Array<() => void> = [];

  function chartStateFor(plane: SlicePlane): SliceChartState {
    const st = chartState.get(plane)
      ?? { plane, fixed: 0, cMax: SLICE_C_MAX } as SliceChartState;
    // Every plane is sliced AT the subject, so the three of them are three
    // orthogonal cuts through one colour rather than three unrelated views.
    st.fixed = sliceFixedOf(plane, desc.oklch);
    st.limit = limit;
    chartState.set(plane, st);
    return st;
  }

  function buildCharts(): void {
    for (const fn of chartTeardowns.splice(0)) fn();
    for (const plane of PLANES) {
      const mount = $(`[data-lab-chart="${plane}"]`);
      if (!mount) continue;
      const st = chartStateFor(plane);
      mount.innerHTML = renderSliceChart(st, [
        { idx: 0, hex: desc.srgbHex, label: t('This colour') },
      ], { editable: true });
      chartTeardowns.push(wireSliceChart(mount, {
        stateOf: () => chartStateFor(plane),
        hexOf: () => desc.srgbHex,
        // Dragging the dot or clicking empty space both pick — on a report,
        // every chart is an input as well as a readout.
        onRecolor: (_idx, o) => setSubject(oklchToHex(o), { silent: true, live: true }),
        onCommit: () => {
          // The one full-fidelity pass per gesture: re-seed the picker, repaint
          // the charts sharp, and write the URL.
          reseedPicker();
          paintCharts('full');
          syncUrl();
          announce(t('Colour set to {c}', { c: desc.srgbHex }));
        },
        onPick: () => {},
        onAdd: (seed) => setSubject(oklchToHex(seed)),
      }));
      const label = $(`[data-lab-slice-at="${plane}"]`);
      if (label) label.textContent = formatFixed(plane, st.fixed);

      // The slider for this plane's fixed channel.
      const sliderMount = $(`[data-lab-slider="${plane}"]`);
      if (sliderMount) {
        const ch = SLICE_AXES[plane].fixed as GamutChannel;
        sliderMount.innerHTML = renderGamutSlider(plane, sliderState(ch), desc.oklch[ch]);
        chartTeardowns.push(wireGamutSlider(sliderMount, {
          // Continuous: move the colour and repaint at draft quality.
          onInput: (v) => setSubject(oklchToHex({ ...desc.oklch, [ch]: v }), { silent: true, live: true }),
          onChange: (v) => {
            setSubject(oklchToHex({ ...desc.oklch, [ch]: v }));
            announce(t('Colour set to {c}', { c: desc.srgbHex }));
          },
        }));
      }
    }
  }

  /** The slider's world: the other two channels held at the subject, at the
   *  gamut the charts are currently drawn to. */
  function sliderState(ch: GamutChannel) {
    return { channel: ch, base: desc.oklch, limit, cMax: SLICE_C_MAX };
  }

  /** Repaint the broken tracks — their segments depend on the OTHER two channels,
   *  so every one of them changes whenever the colour does. */
  function paintSliders(): void {
    for (const plane of PLANES) {
      const mount = $(`[data-lab-slider="${plane}"]`);
      if (!mount) continue;
      const ch = SLICE_AXES[plane].fixed as GamutChannel;
      paintGamutSlider(mount, sliderState(ch), desc.oklch[ch]);
    }
  }

  function paintCharts(quality: 'full' | 'draft' = 'full'): void {
    for (const plane of PLANES) {
      const mount = $(`[data-lab-chart="${plane}"]`);
      if (!mount) continue;
      const st = chartStateFor(plane);
      paintSliceChart(mount, st, { quality });
      updateSliceDot(mount, 0, desc.srgbHex, st);
      const label = $(`[data-lab-slice-at="${plane}"]`);
      if (label) label.textContent = formatFixed(plane, st.fixed);
    }
    paintSliders();
  }

  // ── The 3D solid ─────────────────────────────────────────────────────────
  const solidCanvas = $<HTMLCanvasElement>('[data-lab-solid]');
  let solidFrame = 0;

  function solidFor(l: Exclude<GamutName, 'none'>): GamutSolid {
    let s = solidCache.get(l);
    // 'landscape': hue laid out flat, lightness in depth, chroma standing up.
    // The peaks and troughs per hue are then directly comparable — on a cylinder
    // half of them are round the back.
    // 192x80 ≈ 15k quads. The ridges are where the mesh shows, and they run along
    // hue, so hue gets the higher count. Built once per gamut and cached (~50ms),
    // then only projected + filled per frame.
    if (!s) { s = gamutSolid(l, 192, 80, 'landscape'); solidCache.set(l, s); }
    return s;
  }

  function paintSolid(): void {
    if (!solidCanvas) return;
    const box = solidCanvas.getBoundingClientRect();
    if (box.width < 2) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(box.width * dpr), h = Math.round(box.height * dpr);
    if (solidCanvas.width !== w || solidCanvas.height !== h) {
      solidCanvas.width = w; solidCanvas.height = h;
    }
    const ctx = solidCanvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);

    const solid = solidFor(limit);
    const quads = projectGamutSolid(solid, solidView);
    // Painter's algorithm, already sorted far-to-near by the engine.
    //
    // A quad is stroked in its own colour as well as filled, to close the hairline
    // antialiasing gap between abutting fills that otherwise makes a mesh read as
    // chicken wire. But stroking doubles the path work, and on a dense mesh each
    // quad is only a few pixels across — the gaps are then sub-pixel and the
    // stroke buys nothing. So it is spent only where it shows.
    const areaPerQuad = (w * h) / Math.max(1, quads.length);
    const seal = areaPerQuad > 24; // ≈ 5px per side
    for (const q of quads) {
      const [p0, ...rest] = q.points;
      if (!p0) continue;
      ctx.beginPath();
      ctx.moveTo(p0.x * w, p0.y * h);
      for (const p of rest) ctx.lineTo(p.x * w, p.y * h);
      ctx.closePath();
      const rgb = shade(q.hex, q.shade);
      ctx.fillStyle = rgb;
      ctx.fill();
      if (seal) { ctx.strokeStyle = rgb; ctx.lineWidth = 1; ctx.stroke(); }
    }

    // "You are here". Drawn hollow when the subject is outside the solid being
    // shown, since a filled dot floating off the surface reads as a glitch.
    const m = projectSolidPoint(solid, desc.oklch, solidView);
    ctx.beginPath();
    ctx.arc(m.x * w, m.y * h, 6 * dpr, 0, Math.PI * 2);
    if (m.inside) {
      ctx.fillStyle = desc.srgbHex;
      ctx.fill();
    }
    ctx.lineWidth = 2.5 * dpr;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
    ctx.lineWidth = 1 * dpr;
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.stroke();

    const note = $('[data-lab-solid-note]');
    if (note) {
      note.textContent = m.inside
        ? t('{deg}° · drag to turn', { deg: String(Math.round(((solidView.yaw % 360) + 360) % 360)) })
        : t('Outside {g} — the marker sits off the surface', { g: GAMUT_TITLE[limit] });
    }
  }

  const scheduleSolid = (): void => {
    if (solidFrame) return;
    solidFrame = requestAnimationFrame(() => { solidFrame = 0; paintSolid(); });
  };
  cleanups.push(() => { if (solidFrame) cancelAnimationFrame(solidFrame); });

  if (solidCanvas) {
    let dragging = -1;
    let lastX = 0, lastY = 0;
    const onDown = (e: PointerEvent): void => {
      dragging = e.pointerId; lastX = e.clientX; lastY = e.clientY;
      solidCanvas.setPointerCapture(e.pointerId);
      solidCanvas.classList.add('is-turning');
      e.preventDefault();
    };
    const onMove = (e: PointerEvent): void => {
      if (dragging !== e.pointerId) return;
      solidView.yaw += (e.clientX - lastX) * 0.5;
      // Pitch is clamped by the engine, but clamp here too so the gesture stops
      // accumulating invisible travel the user then has to undo.
      solidView.pitch = Math.max(-89, Math.min(89, solidView.pitch - (e.clientY - lastY) * 0.4));
      lastX = e.clientX; lastY = e.clientY;
      scheduleSolid();
    };
    const onUp = (e: PointerEvent): void => {
      if (dragging !== e.pointerId) return;
      if (solidCanvas.hasPointerCapture(e.pointerId)) solidCanvas.releasePointerCapture(e.pointerId);
      dragging = -1;
      solidCanvas.classList.remove('is-turning');
    };
    // Keyboard equivalent: a drag-only control is unusable without one.
    const onKey = (e: KeyboardEvent): void => {
      const step = e.shiftKey ? 15 : 5;
      if (e.key === 'ArrowLeft') solidView.yaw -= step;
      else if (e.key === 'ArrowRight') solidView.yaw += step;
      else if (e.key === 'ArrowUp') solidView.pitch = Math.min(89, solidView.pitch + step);
      else if (e.key === 'ArrowDown') solidView.pitch = Math.max(-89, solidView.pitch - step);
      else return;
      e.preventDefault();
      scheduleSolid();
    };
    solidCanvas.addEventListener('pointerdown', onDown);
    solidCanvas.addEventListener('pointermove', onMove);
    solidCanvas.addEventListener('pointerup', onUp);
    solidCanvas.addEventListener('pointercancel', onUp);
    solidCanvas.addEventListener('keydown', onKey);
    cleanups.push(() => {
      solidCanvas.removeEventListener('pointerdown', onDown);
      solidCanvas.removeEventListener('pointermove', onMove);
      solidCanvas.removeEventListener('pointerup', onUp);
      solidCanvas.removeEventListener('pointercancel', onUp);
      solidCanvas.removeEventListener('keydown', onKey);
    });
  }

  // ── Ramps: tones, and a blend to a second colour ─────────────────────────
  const rampMount = $('[data-lab-ramp]');
  // Both ramps delegate to the same handler — a step is a step wherever it sits.
  view.addEventListener('click', (e) => {
    const step = (e.target as HTMLElement).closest<HTMLElement>('[data-lab-step]');
    if (step?.dataset.labStep) setSubject(step.dataset.labStep);
  });

  const stepsInput = $<HTMLInputElement>('[data-lab-steps]');
  if (stepsInput) {
    const onSteps = (): void => {
      steps = Math.max(2, Math.min(24, Math.round(Number(stepsInput.value) || 9)));
      const out = $('[data-lab-steps-out]');
      if (out) out.textContent = String(steps);
      renderRamp();
    };
    stepsInput.addEventListener('input', onSteps);
    cleanups.push(() => stepsInput.removeEventListener('input', onSteps));
  }

  const blendPicker = $('[data-lab-blend-picker]');
  if (blendPicker) {
    // A compact float picker, not the full inline one: this is the SECOND colour,
    // and giving it the same weight as the subject would flatten the hierarchy the
    // page is built on.
    mountColorField(blendPicker, 'lab-other', {
      value: describeColor(other)?.srgbHex ?? '#e0b64d',
      float: true,
      onChange: (value) => { other = value; renderRamp(); },
    });
  }
  const blendRaw = $<HTMLInputElement>('[data-lab-blend-raw]');
  if (blendRaw) {
    blendRaw.value = other;
    const onBlendRaw = (): void => {
      if (!describeColor(blendRaw.value)) { blendRaw.setAttribute('aria-invalid', 'true'); return; }
      blendRaw.removeAttribute('aria-invalid');
      other = blendRaw.value.trim();
      renderRamp();
    };
    blendRaw.addEventListener('change', onBlendRaw);
    blendRaw.addEventListener('keydown', (e) => { if (e.key === 'Enter') onBlendRaw(); });
    cleanups.push(() => blendRaw.removeEventListener('change', onBlendRaw));
  }

  // ── The one place the subject changes ────────────────────────────────────
  /**
   * Adopt a new subject and refresh every panel.
   *
   * `fromPicker` skips re-seeding the picker (it already holds the value, and
   * writing back mid-drag fights the user's slider). `silent` suppresses the
   * screen-reader announcement for continuous gestures — a chart drag would
   * otherwise announce on every frame.
   */
  function setSubject(
    next: string,
    opts: { fromPicker?: boolean; silent?: boolean; live?: boolean } = {},
  ): void {
    const parsed = describeColor(next);
    if (!parsed) return;
    subject = next.trim();
    desc = parsed;

    // Re-mounting the picker replaces its markup and re-wires it — far too heavy
    // to run on every frame of a chart drag, and most of what made dragging feel
    // laggy. Skip it while a gesture is live; catch up on release.
    if (!opts.fromPicker && !opts.live) reseedPicker();

    renderReadouts();
    // Draft quality during a gesture. Three engine slices per chart at full
    // resolution is ~50ms a frame across the three charts; at half resolution
    // it's about a quarter of that, and the sharp repaint lands on release.
    paintCharts(opts.live ? 'draft' : 'full');
    scheduleSolid();
    if (!opts.silent) announce(t('{c} — {g}', { c: desc.srgbHex, g: GAMUT_TITLE[desc.gamut] }));
    if (!opts.live) syncUrl();
  }

  /** Rebuild the picker so it shows the current subject, mapped into sRGB. */
  function reseedPicker(): void {
    seeding = true;
    mountColorField(pickerMount, 'lab-color', {
      value: desc.srgbHex,
      inline: true,   // the always-open editor form: rings + sliders shown
      modes: true,    // the tabbed multi-space picker
      onChange: (value) => {
        // Two guards, because one is not enough. `seeding` catches the emit that
        // happens synchronously during wiring; the echo check catches one that
        // arrives later, after the flag has been cleared. Either way, a value the
        // picker was just HANDED must not come back as a user edit — that would
        // replace the authored colour with its sRGB approximation.
        if (seeding) return;
        if (value.toLowerCase() === desc.srgbHex.toLowerCase()) return;
        // Past those, this is a real interaction. The picker is sRGB-bounded, so
        // what it emits genuinely becomes the subject.
        setSubject(value, { fromPicker: true });
      },
    });
    seeding = false;
  }

  /** Keep the URL shareable, without a history entry per change. */
  function syncUrl(): void {
    const url = `#/lab?c=${encodeURIComponent(subject)}`;
    if (window.location.hash !== url) window.history.replaceState(null, '', url);
  }

  /** Everything that is text or a swatch, rebuilt from `desc`. */
  function renderReadouts(): void {
    // Echo the authored value back, unless the user is mid-edit — this runs on
    // the first paint too, so the field is never blank on arrival.
    if (document.activeElement !== rawInput) rawInput.value = subject;

    paintSwatch(swatch, desc);
    // The swatch leads with the value in the space the PICKER is set to — OKLCH by
    // default — so the number on the swatch and the number under your hands are
    // the same number. The authored form is never lost: it stays in the entry
    // field, in the alternates below, and in the notation table.
    const mode = pickerMode();
    const leadSpace = PICKER_MODE_SPACE[mode] ?? null;
    const lead = leadSpace ? desc.notations.find(n => n.space === leadSpace)?.css : null;
    const primary = $('[data-lab-sw-primary]');
    if (primary) primary.textContent = lead ?? desc.srgbHex.toUpperCase();
    const swSpace = $('[data-lab-sw-space]');
    if (swSpace) {
      const shown = leadSpace ?? 'hex';
      // Name the space being shown AND the authored one when they differ, so the
      // swatch never quietly reads as if the colour were authored in this space.
      const from = desc.parsed.space !== shown ? ` · set in ${desc.parsed.space}` : '';
      swSpace.textContent = `${shown}${from} · ${GAMUT_TITLE[desc.gamut]}`;
    }

    // …then the handful of forms people actually reach for, so the common
    // translation is on the swatch and not only in the table further down. The
    // authored space is skipped, since it is already the line above.
    const alts = $('[data-lab-sw-alts]');
    if (alts) {
      const want: Array<[string, string]> = [];
      // The authored space first when the swatch is leading with a different one —
      // it is the most relevant alternate, being what the user actually typed.
      const spaces = desc.parsed.space !== leadSpace
        ? [desc.parsed.space, ...SWATCH_ALT_SPACES]
        : [...SWATCH_ALT_SPACES];
      for (const space of spaces) {
        if (space === leadSpace || want.some(([s2]) => s2 === space)) continue;
        const n = desc.notations.find(x => x.space === space);
        if (n) want.push([space, n.css]);
      }
      // Hex last and always: sRGB-only, so it is the fallback expression rather
      // than a peer — but it is still the one most tools demand.
      if (leadSpace) want.push(['hex', desc.srgbHex.toUpperCase()]);
      alts.innerHTML = want.map(([space, css]) =>
        `<li class="lab-sw-alt"><span class="lab-sw-alt-space">${escape(space)}</span><code>${escape(css)}</code></li>`,
      ).join('');
    }

    clampNote.hidden = desc.inSrgb;
    if (!desc.inSrgb) {
      clampNote.innerHTML = t(
        'Outside sRGB. The swatches on this page ask your browser for the real colour, so a wide-gamut display shows it — a narrower one falls back to <strong>{hex}</strong>. The charts are drawn on an 8-bit canvas and always show the fallback.',
        { hex: escape(desc.srgbHex.toUpperCase()) },
      );
    }

    // Gamut verdict.
    const g = $('[data-lab-gamut]')!;
    g.dataset.gamut = desc.gamut;
    g.querySelector('[data-lab-gamut-name]')!.textContent = GAMUT_TITLE[desc.gamut];
    g.querySelector('[data-lab-gamut-blurb]')!.textContent = GAMUT_BLURB[desc.gamut];

    // Headroom + per-gamut ceilings.
    const head = $('[data-lab-headroom]')!;
    const over = desc.headroom < 0;
    head.dataset.state = over ? 'over' : 'under';
    head.querySelector('[data-lab-headroom-val]')!.textContent =
      `${over ? '' : '+'}${desc.headroom.toFixed(3)}`;
    head.querySelector('[data-lab-headroom-note]')!.textContent = over
      ? t('past the sRGB ceiling of {max} at this lightness and hue', { max: desc.ceiling.srgb.toFixed(3) })
      : t('of chroma still available before sRGB runs out (ceiling {max})', { max: desc.ceiling.srgb.toFixed(3) });

    const ceils = $('[data-lab-ceilings]')!;
    ceils.innerHTML = GAMUTS.map((lim) => {
      const c = desc.ceiling[lim];
      const gain = lim === 'srgb' ? '' :
        ` <span class="lab-ceil-gain">+${Math.round((c / (desc.ceiling.srgb || 1) - 1) * 100)}%</span>`;
      const reached = desc.oklch.c <= c;
      return `<li class="lab-ceil${reached ? '' : ' is-past'}">
        <span class="lab-ceil-name">${escape(GAMUT_TITLE[lim])}</span>
        <span class="lab-ceil-val">${c.toFixed(3)}${gain}</span>
      </li>`;
    }).join('');

    renderContrast();
    renderNotations();
    renderRamp();
  }

  function renderContrast(): void {
    const mount = $('[data-lab-contrast]');
    if (!mount) return;
    const v = contrastVsExtremes(subject);
    if (!v) { mount.innerHTML = ''; return; }
    mount.innerHTML = `
      ${contrastCard(t('White text'), '#ffffff', v.onWhite, v.against === '#ffffff')}
      ${contrastCard(t('Black text'), '#000000', v.onBlack, v.against === '#000000')}`;
    // The cards carry the authored colour as their background, with the hex as a
    // CSS fallback for displays that can't reach it.
    for (const el of mount.querySelectorAll<HTMLElement>('.lab-contrast-card')) {
      el.style.background = desc.srgbHex;
      el.style.background = subject;
    }
    const floor = $('[data-lab-contrast-note]');
    if (floor) {
      floor.textContent = t(
        'Best pairing: {ink} at {ratio}:1 — {level} for body text, {large} for large text.',
        {
          ink: v.against === '#ffffff' ? t('white') : t('black'),
          ratio: v.ratio.toFixed(2),
          level: v.level === 'fail' ? t('below AA') : v.level,
          large: v.largeLevel === 'fail' ? t('below AA') : v.largeLevel,
        },
      );
    }
  }

  /** One text-on-colour card. The background is applied by the caller, so this
   *  stays a pure string builder. */
  function contrastCard(label: string, ink: string, ratio: number, best: boolean): string {
    const body = wcagLevel(ratio);
    const large = wcagLevel(ratio, { large: true });
    const badge = (name: string, level: string): string =>
      `<span class="lab-wcag" data-level="${escape(level)}">${escape(name)} ${escape(level === 'fail' ? '✗' : level)}</span>`;
    return `
      <div class="lab-contrast-card${best ? ' is-best' : ''}" style="color:${escape(ink)}">
        <p class="lab-contrast-sample">${escape(label)}${best ? ` <span class="lab-best">${escape(t('best'))}</span>` : ''}</p>
        <p class="lab-contrast-ratio">${ratio.toFixed(2)}:1</p>
        <p class="lab-contrast-badges">${badge(t('Body'), body)} ${badge(t('Large'), large)}</p>
      </div>`;
  }

  function renderNotations(): void {
    const mount = $('[data-lab-notations]');
    if (!mount) return;
    mount.innerHTML = desc.notations.map(n => `
      <tr${n.exact ? '' : ' class="is-inexact"'}>
        <th scope="row">${escape(n.space)}</th>
        <td><code>${escape(n.css)}</code></td>
        <td class="lab-note-fit">${n.exact ? '' : `<span title="${escape(t('This space cannot hold the colour — CSS would clamp these numbers.'))}">${escape(t('clamped'))}</span>`}</td>
        <td><button type="button" class="lab-copy" data-lab-copy="${escape(n.css)}">${escape(t('Copy'))}</button></td>
      </tr>`).join('');
  }

  /**
   * One clickable ramp step. Every step is also a way to SET the colour.
   *
   * Labelled in OKLCH, with the hex demoted to the second line. Hex is sRGB-only,
   * which makes it the weakest expression of a colour on a page about colour
   * spaces — useful to have, wrong to lead with. The step's own OKLCH says what it
   * IS; the hex is what you paste into something that can't take better.
   */
  function stepHtml(hex: string): string {
    const o = describeColor(hex)?.oklch;
    const ink = contrastRatio(hex, '#ffffff') >= 4.5 ? '#ffffff' : '#111111';
    const label = o
      ? `${Math.round(o.l * 100)}% ${o.c.toFixed(3)} ${Math.round(o.h)}`
      : hex.toUpperCase();
    return `<button type="button" class="lab-step" data-lab-step="${escape(hex)}"
      style="background:${escape(hex)};color:${escape(ink)}"
      aria-label="${escape(t('Use oklch({v})', { v: label }))}">
      <span class="lab-step-oklch">${escape(label)}</span>
      <span class="lab-step-hex">${escape(hex.toUpperCase())}</span>
    </button>`;
  }

  function renderRamp(): void {
    if (rampMount) {
      const o = desc.oklch;
      // Through the colour's own hue, from near-white to near-black. The chroma is
      // pulled in at the pale end and pushed out at the dark end because that is
      // what keeps a tint ramp from looking chalky at the top and muddy at the
      // bottom; `correctLightness` then evens the perceptual spacing.
      const tones = rampOklab(
        [oklchToHex({ l: 0.97, c: o.c * 0.22, h: o.h }), desc.srgbHex, oklchToHex({ l: 0.13, c: o.c * 0.5, h: o.h })],
        steps, { correctLightness: true },
      );
      rampMount.innerHTML = tones.map(stepHtml).join('');
    }
    const blendMount = $('[data-lab-blend]');
    if (blendMount) {
      const far = describeColor(other);
      // Interpolated in OKLab, so the midpoint is the colour halfway between as
      // the eye reads it — an sRGB lerp between complements goes grey through the
      // middle, which is the classic muddy-gradient problem.
      const blend = far
        ? rampOklab([desc.srgbHex, far.srgbHex], steps, { correctLightness: false })
        : [];
      blendMount.innerHTML = blend.map(stepHtml).join('');
      const preview = $('[data-lab-blend-preview]');
      if (preview && far) {
        // A real CSS gradient beside the discrete stops: same two ends, so you can
        // see what the steps are sampling.
        preview.style.background =
          `linear-gradient(90deg in oklab, ${desc.srgbHex}, ${far.srgbHex})`;
        preview.style.background =
          `linear-gradient(90deg in oklab, ${subject}, ${other})`;
      }
    }
  }

  // Copy buttons, delegated once.
  view.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-lab-copy]');
    if (!btn?.dataset.labCopy) return;
    void navigator.clipboard?.writeText(btn.dataset.labCopy).then(() => {
      announce(t('Copied {v}', { v: btn.dataset.labCopy! }));
      btn.classList.add('is-copied');
      setTimeout(() => btn.classList.remove('is-copied'), 1200);
    }).catch(() => announce(t('Copy failed')));
  });

  // ── Brand swatches, when there is a brand ────────────────────────────────
  try {
    const colors = await host.tokens?.colors?.();
    const list = Array.isArray(colors) ? colors : [];
    const mount = $('[data-lab-brand]');
    const section = $('[data-lab-brand-section]');
    if (mount && list.length) {
      mount.innerHTML = list.slice(0, 64).map((c) => {
        const hex = describeColor(String(c.value ?? ''))?.srgbHex;
        if (!hex) return '';
        const name = String(c.name ?? c.id ?? hex);
        // --sw carries the hex; --sw-real the authored token value, which the CSS
        // layers on top so a wide-gamut brand colour shows as itself.
        return `<button type="button" class="lab-brand-sw" data-lab-brand-pick="${escape(String(c.value))}"
          style="--sw:${escape(hex)};--sw-real:${escape(String(c.value))}" title="${escape(`${name} ${hex}`)}" aria-label="${escape(t('Inspect {name}', { name }))}"></button>`;
      }).join('');
      mount.addEventListener('click', (e) => {
        const b = (e.target as HTMLElement).closest<HTMLElement>('[data-lab-brand-pick]');
        if (b?.dataset.labBrandPick) setSubject(b.dataset.labBrandPick);
      });
    } else if (section) {
      section.hidden = true; // no brand mounted — say nothing rather than show an empty rail
    }
  } catch { /* a brandless build simply has no rail */ }

  // ── First paint ──────────────────────────────────────────────────────────
  buildCharts();
  renderReadouts();
  paintCharts();
  paintSolid();

  // Charts and the solid are sized by the page, which reflows on resize.
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => { paintCharts(); scheduleSolid(); });
    const grid = $('[data-lab-charts]');
    if (grid) ro.observe(grid);
    cleanups.push(() => ro.disconnect());
  }

  // The view element is replaced on navigation; run teardown when it goes.
  const mo = new MutationObserver(() => {
    if (!view.isConnected) { for (const fn of cleanups) fn(); mo.disconnect(); }
  });
  mo.observe(document.body, { childList: true, subtree: true });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** `?c=<any css colour>` from the route params. */
function seedFrom(params: string): string | null {
  try {
    const q = new URLSearchParams(params.startsWith('?') ? params.slice(1) : params);
    const c = q.get('c');
    return c && describeColor(c) ? c : null;
  } catch { return null; }
}

/**
 * Paint an element with the colour as AUTHORED, falling back to its sRGB
 * approximation only where the browser can't take the authored form.
 *
 * Two assignments on purpose: the first is a value every browser understands, the
 * second is the real thing. A browser that can't parse `color(display-p3 …)`
 * ignores the second and keeps the first; one that can uses the real colour and
 * does its own per-display mapping — which beats us deciding up front that
 * nobody can see it.
 */
function paintSwatch(el: HTMLElement, d: ColorDescription): void {
  el.style.background = d.srgbHex;
  el.style.background = d.input;
  // Ink is chosen against the RENDERED fallback: it has to be readable on the
  // narrow-gamut result too, and the two are close enough that one choice serves.
  el.style.color = contrastRatio(d.srgbHex, '#ffffff') >= 4.5 ? '#ffffff' : '#111111';
}

/** Multiply a hex toward black by `k` — the solid's soft top-light. */
function shade(hex: string, k: number): string {
  const n = (i: number): number =>
    Math.round(Math.min(255, Math.max(0, parseInt(hex.slice(i, i + 2), 16) * k)));
  return `rgb(${n(1)} ${n(3)} ${n(5)})`;
}

function shellHtml(): string {
  const seg = (): string => `
    <div class="view-seg lab-limit" role="group" aria-label="${escape(t('See it against'))}" data-lab-limit>
      ${GAMUTS.map(g => `<button type="button" class="view-seg-btn" data-val="${g}" aria-pressed="${g === 'rec2020'}">${escape(GAMUT_TITLE[g])}</button>`).join('')}
    </div>`;

  // Plot first, caption under it — a figure/figcaption, so "this text describes
  // the thing above" is in the markup and not just in the CSS order.
  const chart = (plane: SlicePlane): string => `
    <figure class="lab-chart">
      <div data-lab-chart="${plane}"></div>
      ${/* The axis this plane is sliced along, as a broken track: the solid runs
            are the values that stay displayable, the gaps are the ones that do
            not. Complements dragging INSIDE the chart — the slider moves the
            slice, the drag moves the colour within it. */''}
      <div class="lab-chart-slider" data-lab-slider="${plane}"></div>
      <figcaption class="lab-chart-head">
        <h3>${escape(PLANE_TITLE[plane])}</h3>
        <p class="lab-chart-why">${escape(PLANE_WHY[plane])}</p>
        <p class="lab-chart-at">${escape(t('sliced at'))} <strong data-lab-slice-at="${plane}"></strong>
          <span class="lab-chart-hint">${escape(t('· click or drag to pick'))}</span></p>
      </figcaption>
    </figure>`;

  // The page reads top to bottom as one narrowing sequence — see the module
  // header. Each numbered step below is one of those questions.
  return `
  <div class="lab">
    <div class="lab-back">${backPillHtml()}</div>

    <header class="lab-head">
      <h1>${escape(t('Colour Lab'))}</h1>
      <p class="lab-sub">${escape(t('Everything about one colour: where it sits in perceptual space, which displays can show it, how much room is left, and what it is called in every notation.'))}</p>
    </header>

    <!-- 1 · SET A COLOUR. Three ways in, none of them in a sidebar. -->
    <section class="lab-step-block">
      <h2 class="lab-h2 lab-step-h">
        <span class="lab-step-n" aria-hidden="true">1</span>${escape(t('Set a colour'))}
      </h2>
      <div class="lab-subject">
        <div class="lab-swatch" data-lab-swatch>
          <div class="lab-sw-vals">
            <code class="lab-sw-primary" data-lab-sw-primary></code>
            <span class="lab-sw-space" data-lab-sw-space></span>
            <ul class="lab-sw-alts" data-lab-sw-alts></ul>
          </div>
        </div>

        <div class="lab-entry">
          ${/* One unlabelled entry, not a titled block: the picker beside it is the
                main way in, so this is the overflow for values the picker cannot
                take — anything in a space it has no tab for. It stays until the
                picker gains those tabs, because it is currently the ONLY way to
                enter a wide-gamut colour (the picker's own field parses a hex or
                the active mode's triple, and resolves to sRGB either way). */''}
          <input type="text" class="field-input lab-raw" data-lab-raw spellcheck="false"
            autocapitalize="off" autocomplete="off"
            aria-label="${escape(t('Paste a colour in any CSS space'))}"
            placeholder="${escape(t('Paste any CSS colour — oklch(), lab(), color(display-p3 …)'))}">
          <p class="lab-err" data-lab-raw-err hidden></p>
          <p class="lab-clamp" data-lab-clamp hidden></p>
          <div class="lab-brand-rail" data-lab-brand-section>
            <span class="lab-field-label">${escape(t('Or from your brand'))}</span>
            <div class="lab-brand" data-lab-brand></div>
          </div>
        </div>

        <div class="lab-picker" data-lab-picker></div>
      </div>
    </section>

    <!-- 2 · THE CHARTS. High up: they are what the page is for, and the gamut
         control comes with them because it governs what they draw. -->
    <section class="lab-step-block">
      <h2 class="lab-h2 lab-step-h">
        <span class="lab-step-n" aria-hidden="true">2</span>${escape(t('Where it sits'))}
      </h2>
      ${/* Full width, directly above the charts: it governs all four of them, so
            it reads as a control over the whole row rather than a setting tucked
            beside the heading. */''}
      ${seg()}
      <div class="lab-charts" data-lab-charts>
        ${PLANES.map(chart).join('')}
        <figure class="lab-chart lab-chart--solid">
          <canvas class="lab-solid" data-lab-solid tabindex="0"
            role="img" aria-label="${escape(t('The displayable colour volume in OKLCH. Drag or use the arrow keys to turn it.'))}"></canvas>
          <figcaption class="lab-chart-head">
            <h3>${escape(t('The whole gamut'))}</h3>
            <p class="lab-chart-why">${escape(t('The shape the three flat charts are slicing. Turn it once and their curves stop looking arbitrary.'))}</p>
            <p class="lab-chart-at"><strong data-lab-solid-note></strong></p>
          </figcaption>
        </figure>
      </div>
    </section>

    <!-- 3 · EVERY NOTATION. -->
    <section class="lab-step-block">
      <h2 class="lab-h2 lab-step-h">
        <span class="lab-step-n" aria-hidden="true">3</span>${escape(t('Every notation'))}
      </h2>
      <p class="lab-section-note">${escape(t('The same colour, written for each space. A row marked “clamped” names a space too narrow to hold it — CSS would round those numbers into range.'))}</p>
      <table class="lab-notations">
        <thead><tr>
          <th scope="col">${escape(t('Space'))}</th>
          <th scope="col">${escape(t('Value'))}</th>
          <th scope="col">${escape(t('Fit'))}</th>
          <th scope="col"><span class="sr-only">${escape(t('Copy'))}</span></th>
        </tr></thead>
        <tbody data-lab-notations></tbody>
      </table>
    </section>

    <!-- 4 · TONES AND BLENDS. What you build out of the colour. -->
    <section class="lab-step-block">
      <div class="lab-step-head">
        <h2 class="lab-h2 lab-step-h">
          <span class="lab-step-n" aria-hidden="true">4</span>${escape(t('Tones and blends'))}
        </h2>
        <label class="lab-steps">
          <span class="lab-field-label">${escape(t('Stops'))}</span>
          <input type="range" class="lab-steps-range" data-lab-steps min="2" max="24" step="1" value="9"
            aria-label="${escape(t('Number of ramp stops'))}">
          <output class="lab-steps-out" data-lab-steps-out>9</output>
        </label>
      </div>
      <p class="lab-section-note">${escape(t('Click any step to make it the colour under inspection.'))}</p>

      <h3 class="lab-h3">${escape(t('Tones'))}</h3>
      <p class="lab-section-note">${escape(t('A perceptually even ramp through this colour, pale to dark.'))}</p>
      <div class="lab-ramp" data-lab-ramp></div>

      <h3 class="lab-h3">${escape(t('Blend to another colour'))}</h3>
      <div class="lab-blend-head">
        <p class="lab-section-note">${escape(t('Interpolated in OKLab, so the middle stays colourful instead of going grey.'))}</p>
        <div class="lab-blend-to">
          <span class="lab-field-label">${escape(t('To'))}</span>
          <div class="lab-blend-picker" data-lab-blend-picker></div>
          <input type="text" class="field-input lab-blend-raw" data-lab-blend-raw spellcheck="false"
            autocapitalize="off" autocomplete="off"
            aria-label="${escape(t('The far end of the blend, in any colour space'))}">
        </div>
      </div>
      <div class="lab-blend-preview" data-lab-blend-preview aria-hidden="true"></div>
      <div class="lab-ramp" data-lab-blend></div>
    </section>
    <!-- 5 · WHAT IT COSTS YOU. The verdict and the readability scores: real, but
         reference material rather than the reason you opened the page — so they
         sit under the charts and the ramps instead of in front of them. -->
    <section class="lab-step-block">
      <h2 class="lab-h2 lab-step-h">
        <span class="lab-step-n" aria-hidden="true">5</span>${escape(t('Displayable range and readability'))}
      </h2>
      <div class="lab-verdict">
        <div class="lab-card lab-gamut" data-lab-gamut>
          <p class="lab-card-label">${escape(t('Displayable in'))}</p>
          <p class="lab-card-value" data-lab-gamut-name></p>
          <p class="lab-card-note" data-lab-gamut-blurb></p>
        </div>
        <div class="lab-card lab-headroom" data-lab-headroom>
          <p class="lab-card-label">${escape(t('Chroma headroom'))}</p>
          <p class="lab-card-value" data-lab-headroom-val></p>
          <p class="lab-card-note" data-lab-headroom-note></p>
        </div>
        <div class="lab-card">
          <p class="lab-card-label">${escape(t('Chroma ceiling here'))}</p>
          <ul class="lab-ceilings" data-lab-ceilings></ul>
          <p class="lab-card-note">${escape(t('The most chroma each gamut allows at this lightness and hue.'))}</p>
        </div>
      </div>
      <h3 class="lab-h3">${escape(t('Readability'))}</h3>
      <p class="lab-section-note">${escape(t('Scored against black and white — the two extremes, so this is the ceiling on what the colour can carry. A real surface will do worse.'))}</p>
      <div class="lab-contrast" data-lab-contrast></div>
      <p class="lab-contrast-note" data-lab-contrast-note></p>
    </section>

  </div>`;
}
