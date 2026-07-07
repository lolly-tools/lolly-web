// SPDX-License-Identifier: MPL-2.0
/**
 * Variable-type demonstrator — a live showcase of the two bundled variable faces,
 * driven by the WEIGHT axis itself:
 *   • SUSE Mono — a faux terminal types a command, an italic comment pops in, and the
 *     whole block animates its weight across its axis. Rendered larger.
 *   • SUSE — a display word + an italic phrase, both animating the same weight axis.
 *
 * Both faces animate by default; each has a slider that scrubs the weight from min to
 * max, and an Auto toggle to hand control back to the animation. Each face scrubs its
 * OWN axis — SUSE spans 100–900, SUSE Mono's variable font tops out at ExtraBold (800),
 * so the mono slider stops there instead of running dead against a clamped top end.
 *
 * The sample text is EDITABLE — the display word, the italic phrase and the terminal
 * command/comment are all contenteditable, so anyone can type their own words and watch
 * them animate. Focusing the terminal settles the typewriter so it can be edited.
 *
 * Motion is JS-started (so it doesn't run before the block is seen) and reduced-motion
 * rests at a mid weight with the slider still live. Nothing here depends on a webfont
 * fetch — both faces are already registered via @font-face.
 */

import './type-demo.css';
import { escapeHtml } from './html.ts';

const TYPED = 'lolly qr-code --url=suse.com';
const ITALIC = '// vector, on-brand, instant';
const SUSE_ROMAN = 'define once,';
const SUSE_ITALIC = 'use everywhere';

type FaceKey = 'mono' | 'suse';

// Each face's usable weight axis. SUSE spans the full 100–900; SUSE Mono's variable font
// tops out at ExtraBold (800), so its slider + auto-sweep stop there — no dead travel at
// the top end where the axis would otherwise clamp.
const AXIS: Record<FaceKey, { min: number; max: number; hi: string }> = {
  mono: { min: 100, max: 800, hi: 'ExtraBold' },
  suse: { min: 100, max: 900, hi: 'Black' },
};
const WSTART = 440; // resting / reduced-motion weight (within every axis)

// Shared attributes for an editable sample field — plaintext-only so pasted markup can't
// break the specimen; the CSS gives it a quiet "click to edit" affordance.
const EDIT_ATTRS = 'contenteditable="plaintext-only" spellcheck="false" data-td-edit role="textbox" title="Click to edit"';

// One weight control: an Auto toggle + a min↔max range slider, sharing one id `key`.
function control(key: FaceKey): string {
  const ax = AXIS[key];
  return `
    <div class="td-ctl" data-td-ctl="${key}">
      <button type="button" class="td-auto is-on" data-td-auto="${key}" aria-pressed="true" aria-label="Animate weight">
        <span class="td-auto-dot" aria-hidden="true"></span>Auto
      </button>
      <span class="td-range-wrap">
        <input type="range" class="td-range" data-td-range="${key}" min="${ax.min}" max="${ax.max}" step="1" value="${WSTART}"
               aria-label="Weight, ${ax.min} to ${ax.max}">
        <span class="td-scale" aria-hidden="true"><i>Thin</i><i>${escapeHtml(ax.hi)}</i></span>
      </span>
    </div>`;
}

/** Markup for the demonstrator. `wireTypeDemo` starts the motion. */
export function renderTypeDemo(): string {
  return `
    <div class="type-demo" data-type-demo>
      <div class="td-half td-half--mono">
        <div class="td-head">
          <span class="td-dots" aria-hidden="true"><i></i><i></i><i></i></span>
          <span class="td-face">SUSE&nbsp;Mono</span>
          <span class="td-axis">wght&nbsp;<b data-td-val="mono">${WSTART}</b></span>
        </div>
        <div class="td-term" data-td-face="mono" style="--td-w-mono:${WSTART}">
          <code class="td-line"><span class="td-prompt">$</span> <span class="td-typed" data-td-typed ${EDIT_ATTRS} aria-label="Terminal command"></span><span class="td-caret" data-td-caret aria-hidden="true"></span></code>
          <code class="td-italic" data-td-italic ${EDIT_ATTRS} aria-label="Terminal comment">${escapeHtml(ITALIC)}</code>
        </div>
        ${control('mono')}
      </div>
      <div class="td-divider" aria-hidden="true"></div>
      <div class="td-half td-half--suse">
        <div class="td-head">
          <span class="td-face">SUSE</span>
          <span class="td-axis">wght&nbsp;<b data-td-val="suse">${WSTART}</b></span>
        </div>
        <div class="td-sample" data-td-face="suse" style="--td-w-suse:${WSTART}">
          <span class="td-roman" ${EDIT_ATTRS} aria-label="Display word">${escapeHtml(SUSE_ROMAN)}</span>
          <span class="td-ital" ${EDIT_ATTRS} aria-label="Italic phrase">${escapeHtml(SUSE_ITALIC)}</span>
        </div>
        ${control('suse')}
      </div>
    </div>`;
}

interface FaceCtl {
  key: FaceKey;
  el: HTMLElement;          // the sample block whose --td-w-<key> we set
  prop: string;            // the CSS var name
  min: number;             // this face's axis floor
  max: number;             // this face's axis ceiling
  range: HTMLInputElement | null;
  val: HTMLElement | null;
  auto: HTMLButtonElement | null;
  animating: boolean;
  phase: number;           // radians, so the two faces don't move in lockstep
}

/** Start the demonstrator's animations inside `root`. Safe to call once per mount. */
export function wireTypeDemo(root: HTMLElement): () => void {
  const demo = root.querySelector<HTMLElement>('[data-type-demo]');
  if (!demo) return () => {};
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

  // ── Weight controls (both faces) ──────────────────────────────────────────
  const faces: FaceCtl[] = [];
  (['mono', 'suse'] as const).forEach((key, i) => {
    const el = demo.querySelector<HTMLElement>(`[data-td-face="${key}"]`);
    if (!el) return;
    faces.push({
      key,
      el,
      prop: `--td-w-${key}`,
      min: AXIS[key].min,
      max: AXIS[key].max,
      range: demo.querySelector<HTMLInputElement>(`[data-td-range="${key}"]`),
      val: demo.querySelector<HTMLElement>(`[data-td-val="${key}"]`),
      auto: demo.querySelector<HTMLButtonElement>(`[data-td-auto="${key}"]`),
      animating: !reduce,          // animated by default; reduced-motion starts manual
      phase: i * Math.PI,          // opposite phase → the faces counter-breathe
    });
  });

  const setWeight = (f: FaceCtl, w: number): void => {
    const v = Math.round(w);
    f.el.style.setProperty(f.prop, String(v));
    if (f.range && !f.range.matches(':active')) f.range.value = String(v);
    if (f.val) f.val.textContent = String(v);
  };

  const setAuto = (f: FaceCtl, on: boolean): void => {
    f.animating = on && !reduce;
    f.auto?.classList.toggle('is-on', f.animating);
    f.auto?.setAttribute('aria-pressed', String(f.animating));
  };

  for (const f of faces) {
    // Grabbing the slider hands control to the user (pauses that face's animation).
    f.range?.addEventListener('input', () => {
      if (f.animating) setAuto(f, false);
      setWeight(f, Number(f.range!.value));
    });
    // The Auto pill toggles the animation back on (or pauses it, freezing the weight).
    f.auto?.addEventListener('click', () => setAuto(f, !f.animating));
    if (reduce) setAuto(f, false); // no toggle affordance under reduced motion
  }

  // One rAF loop drives every face still in Auto. Weight sweeps its own min↔max on a slow
  // cosine (starts near the resting weight); the slider + readout track it live.
  const PERIOD = 5200; // ms for a full min→max→min sweep
  let raf = 0;
  let onScreen = true;                 // flipped false by the IntersectionObserver when scrolled away
  const tick = (t: number): void => {
    // Park fully when scrolled out of view — the observer re-pumps us on re-entry — so an
    // off-screen dashboard doesn't keep forcing a style recalc every frame by writing
    // font-variation-settings. When the tab is hidden the browser pauses rAF for us, so we
    // stay scheduled and just skip the work.
    if (!onScreen) { raf = 0; return; }
    raf = requestAnimationFrame(tick);
    if (document.hidden) return;
    for (const f of faces) {
      if (!f.animating) continue;
      const a = (t / PERIOD) * Math.PI * 2 + f.phase;
      const w = f.min + (f.max - f.min) * (0.5 - 0.5 * Math.cos(a));
      setWeight(f, w);
    }
  };
  const startRaf = (): void => { if (!raf && !reduce) raf = requestAnimationFrame(tick); };
  if (!reduce) raf = requestAnimationFrame(tick);

  // Pause the sweep while the specimen is off-screen and resume on re-entry — matches the
  // gallery / featured-row tickers. rootMargin keeps it running through small scroll jitters.
  let vizObserver: IntersectionObserver | undefined;
  if (!reduce && typeof IntersectionObserver === 'function') {
    vizObserver = new IntersectionObserver((entries) => {
      const nowOn = entries[entries.length - 1]!.isIntersecting;
      if (nowOn === onScreen) return;
      onScreen = nowOn;
      if (nowOn) startRaf();
    }, { rootMargin: '200px' });
    vizObserver.observe(demo);
  }

  // ── SUSE Mono terminal: faux typing → italic comment pops → loop ───────────
  const typed = demo.querySelector<HTMLElement>('[data-td-typed]');
  const caret = demo.querySelector<HTMLElement>('[data-td-caret]');
  const italic = demo.querySelector<HTMLElement>('[data-td-italic]');
  const term = demo.querySelector<HTMLElement>('.td-term');
  let typeTimer = 0;
  let frozen = false;   // the user has taken over the terminal to edit it

  // Settle the terminal to its finished state and stop the typewriter — called the moment
  // the user focuses the command or comment to edit it, so their caret isn't overwritten.
  const freezeTerminal = (): void => {
    if (frozen) return;
    frozen = true;
    window.clearTimeout(typeTimer);
    if (typed && typed.textContent !== TYPED && !typed.dataset.edited) typed.textContent = TYPED;
    if (caret) caret.style.display = 'none';
    demo.classList.add('is-typed');
    italic?.classList.add('is-shown');
  };
  // Mark a field edited so a later re-focus won't reset it to the default command.
  term?.addEventListener('focusin', freezeTerminal);
  [typed, italic].forEach((el) => el?.addEventListener('input', () => { el.dataset.edited = '1'; }));

  if (reduce) {
    if (typed) typed.textContent = TYPED;
    if (caret) caret.style.display = 'none';
    italic?.classList.add('is-shown');
  } else {
    const run = (): void => {
      if (!typed || frozen) return;
      typed.textContent = '';
      italic?.classList.remove('is-shown');
      demo.classList.remove('is-typed');
      let i = 0;
      const step = (): void => {
        if (frozen) return;
        typed.textContent = TYPED.slice(0, i);
        i += 1;
        if (i <= TYPED.length) {
          typeTimer = window.setTimeout(step, 34 + Math.random() * 46); // human-ish cadence
        } else {
          demo.classList.add('is-typed');
          window.setTimeout(() => { if (!frozen) italic?.classList.add('is-shown'); }, 260);
          typeTimer = window.setTimeout(run, 4200);                     // hold, then retype
        }
      };
      step();
    };
    run();
  }

  // Teardown is driven by the dashboard's `view._cleanup` chain (mountDashboard calls it
  // before the next view's innerHTML swap). This replaces an app-wide MutationObserver on
  // document.body whose callback fired on EVERY DOM mutation just to notice this node's
  // own removal.
  return (): void => {
    onScreen = false;
    cancelAnimationFrame(raf);
    raf = 0;
    window.clearTimeout(typeTimer);
    vizObserver?.disconnect();
  };
}
