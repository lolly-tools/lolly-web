// SPDX-License-Identifier: MPL-2.0
/**
 * "Add a colour" - the Colours room's level-0 control (plan 97 section 7.1).
 *
 * Two halves, deliberately separable:
 *
 *  - `parseColorEntries` is pure and DOM-free: it reads EVERY colour it can find
 *    in arbitrary pasted text - a hex list, a CSS blob, a paragraph out of a
 *    style guide - and hands back the notation as typed alongside a resolved
 *    `#rrggbb`. The scan is deliberately in the spirit of `engine/svg-colors.ts`:
 *    regex over raw text, no parser, never throws, every candidate gated before
 *    it is trusted. Hostile input is expected - this reads the clipboard.
 *  - `mountAddColor` renders one input row over it. Nothing it parses reaches
 *    the design system on its own: a single colour needs Enter or Add, several
 *    need an explicit "Add all" / "Add selected". Principle 1 - additive, never
 *    imposed. The caller decides what an add MEANS (`addSwatch`, a tray drop);
 *    this control only ever reports entries.
 *
 * The module takes `t` as an argument rather than importing i18n, so the pure
 * half stays importable from a test with no shell boot behind it.
 *
 * WHAT IS NOT MERGED: dedupe keys on the resolved colour INCLUDING alpha, so a
 * translucent value and its opaque twin both survive as separate entries (they
 * are separate swatches; a palette that silently ate one would be lying). Their
 * `hex` field is the same opaque `#rrggbb` - it is the resolved colour, not an
 * identity.
 */

import { parseColorToSrgb8, isNamedColor } from '@lolly/engine';
import { escape } from '../../utils.ts';
import { icon } from '../icons.ts';

// ── Pure core ────────────────────────────────────────────────────────────────

/** One colour found in pasted text: the spelling as typed, and what it resolves to. */
export interface ColorEntry {
  /** Verbatim as it appeared in the text - `#7C3AED`, `rgb(124, 58, 237)`, `Tomato`. */
  value: string;
  /** The resolved colour as `#rrggbb`, gamut-mapped, alpha dropped. */
  hex: string;
}

/** Upper bound on entries returned from one scan. A style-guide paste that finds
 *  more than this is a scan, not an add - the tray is where that belongs. */
export const MAX_ENTRIES = 64;

/** Upper bound on regex matches examined per call, so a pathological paste can't
 *  spin (the guard-counter convention from `engine/svg-colors.ts`). */
const SCAN_CAP = 20_000;

/** Text beyond this is not scanned. A cut token at the boundary is possible and
 *  simply fails to parse; MAX_ENTRIES normally ends the walk long before here. */
const MAX_TEXT = 1_000_000;

/**
 * The one scanner. Four alternatives, tried in this order at each position:
 *
 *  1. A `url(…)`, matched only to be THROWN AWAY - consuming it is what stops
 *     `url(red.png)` from reporting red. Same call as `svg-colors.ts`, which
 *     refuses a paint-server reference outright. Both QUOTED forms are spelled
 *     out, because they are how CSS ordinarily writes one: a charset that
 *     excludes the quote cannot span `url("red.png")`, so the filename survived
 *     into the bare-word alternative and reported a colour that is not there.
 *     The quote stays banned inside the UNQUOTED form, and `;{}<>\` stay banned
 *     in all three, so a truncated `url(` cannot swallow the declarations after
 *     it looking for a closing paren.
 *  2. A colour FUNCTION with non-nested arguments. The argument charset is the
 *     CSS-injection shape gate the colour field and `svg-colors.ts` already use
 *     (no parens, quotes, semicolons, braces, angle brackets or backslashes) and
 *     is length-BOUNDED: an unterminated `oklch(` at every position would
 *     otherwise scan to end-of-text each time, which is the quadratic case.
 *  3. A `#hex`, with a lookahead that refuses a run of hex-ish characters longer
 *     than 8 rather than reading a prefix out of it (`#ff0000abc` is garbage,
 *     not `#ff0000ab`).
 *  4. A bare word, which is only trusted after `isNamedColor` says so.
 *
 * Case-insensitive, because CSS function names and named colours both are.
 */
const TOKEN_RE = /url\(\s*(?:"[^"()\n]{0,200}"|'[^'()\n]{0,200}'|[^()"';{}<>\\]{0,200})\s*\)|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^()"';{}<>\\]{0,120}\)|#[0-9a-fA-F]{3,8}(?![0-9a-zA-Z])|[a-zA-Z]{3,20}(?![A-Za-z0-9_-])/gi;

/** Characters that, immediately before a bare word, mean the word is part of
 *  something else: an identifier, a CSS selector or custom property, a URL, a
 *  number. `--brand-red`, `.red`, `http://red.example`, `12red` all read as a
 *  colour without this, and none of them is one. */
const IDENT_BLOCKED_BEFORE = /[A-Za-z0-9_\-#.%$@\\/]/;

/** Hex digit counts CSS actually defines. 5 and 7 are typos, not colours. */
const HEX_LENGTHS = new Set([3, 4, 6, 8]);

const hexByte = (n: number): string => n.toString(16).padStart(2, '0');

/**
 * Every colour that can be read out of `text`, in first-seen order.
 *
 * Deduplicated on the resolved colour (alpha included - see the module note),
 * capped at `MAX_ENTRIES`, and tolerant of anything: prose, minified CSS, a
 * truncated file, an empty string, a non-string. Nothing it cannot resolve
 * through the engine's own parser is reported.
 */
export function parseColorEntries(text: string): ColorEntry[] {
  const out: ColorEntry[] = [];
  if (typeof text !== 'string' || text.length === 0) return out;

  const src = text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text;
  const seen = new Set<string>();
  let scanned = 0;

  TOKEN_RE.lastIndex = 0;
  for (let m = TOKEN_RE.exec(src); m !== null; m = TOKEN_RE.exec(src)) {
    if (++scanned > SCAN_CAP) break;
    const raw = m[0];

    if (/^url\(/i.test(raw)) continue;   // consumed so its interior is never scanned
    if (raw.startsWith('#')) {
      if (!HEX_LENGTHS.has(raw.length - 1)) continue;
    } else if (!raw.endsWith(')')) {
      // A bare word. Reject it if it is a fragment of something larger, then
      // require the engine's own table to know it as a CSS named colour - a
      // lowercase word alone proves nothing.
      const before = m.index > 0 ? src[m.index - 1] ?? '' : '';
      if (before !== '' && IDENT_BLOCKED_BEFORE.test(before)) continue;
      if (!isNamedColor(raw.toLowerCase())) continue;
    }

    // The engine is the arbiter of what parses. `transparent`, `none` and every
    // fully-transparent value come back null here and are simply not colours to
    // add to a palette.
    const rgba = parseColorToSrgb8(raw);
    if (!rgba) continue;

    const [r, g, b, a] = rgba;
    const hex = `#${hexByte(r)}${hexByte(g)}${hexByte(b)}`;
    const key = `${hex}${hexByte(Math.round(a * 255))}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ value: raw, hex });
    if (out.length >= MAX_ENTRIES) break;
  }

  return out;
}

// ── Mount ────────────────────────────────────────────────────────────────────

/** Chromium's screen sampler. Absent in Firefox, Safari and the Tauri WebViews,
 *  which is why the button is feature-detected into existence rather than
 *  rendered and disabled (the precedent is `components/color-field.ts`). */
type EyeDropperCtor = new () => { open(): Promise<{ sRGBHex: string }> };

export interface AddColorOpts {
  /** Called only from an explicit press: Enter/Add on a single colour, or
   *  "Add all" / "Add selected" on a group. Never from typing or the picker. */
  onAdd: (entries: ColorEntry[]) => void;
  /** The shell's `t` - passed in so this module has no i18n import. Params are
   *  escaped by `t` itself; the raw source string is trusted markup, as usual. */
  t: (source: string, params?: Record<string, string | number>) => string;
}

/** Example notations, shown as the placeholder. Values, not prose - untranslated
 *  on purpose (the `PANTONE 186 C` precedent in the brand editor), so the row
 *  demonstrates the same thing in every locale. */
const PLACEHOLDER = '#7c3aed, rgb(124 58 237), oklch(55% .24 292)';

/**
 * Render the add-a-colour row into `el` and wire it. Returns a teardown.
 *
 * Behaviour, in one paragraph because it is one control: typing parses live. One
 * colour arms Add (and Enter). Several colours open a chips row - every chip
 * starts picked, tapping one toggles it, and only "Add all" or "Add selected"
 * commits. The eyedropper fills the field, it does not add. Escape clears the
 * row, and only swallows the key when there was something to clear.
 */
export function mountAddColor(el: HTMLElement, opts: AddColorOpts): () => void {
  const { t } = opts;
  const EyeDropper = typeof window === 'undefined'
    ? undefined
    : (window as { EyeDropper?: EyeDropperCtor }).EyeDropper;

  el.innerHTML = `
    <div class="ds-addc">
      <div class="ds-addc-row">
        <input type="text" class="field-input ds-addc-input" data-ds-addc-input
          placeholder="${escape(PLACEHOLDER)}"
          aria-label="${escape(t('Colour value, or paste several'))}"
          autocomplete="off" autocapitalize="off" spellcheck="false">
        ${EyeDropper
          ? `<button type="button" class="ds-addc-drop" data-ds-addc-drop
              aria-label="${escape(t('Pick a colour from the screen'))}"
              title="${escape(t('Pick a colour from the screen'))}">${icon('droplet')}</button>`
          : ''}
        <button type="button" class="be-btn ds-addc-add" data-ds-addc-add disabled>${t('Add')}</button>
      </div>
      <div class="ds-addc-found" data-ds-addc-found hidden>
        <p class="ds-addc-count" data-ds-addc-count aria-live="polite"></p>
        <div class="ds-addc-chips" data-ds-addc-chips role="group"
          aria-label="${escape(t('Colours found in the text'))}"></div>
        <div class="ds-addc-acts">
          <button type="button" class="be-btn ds-addc-all" data-ds-addc-all>${t('Add all')}</button>
          <button type="button" class="be-btn ds-addc-sel" data-ds-addc-sel>${t('Add selected')}</button>
        </div>
      </div>
    </div>`;

  const input = el.querySelector<HTMLInputElement>('[data-ds-addc-input]');
  const found = el.querySelector<HTMLElement>('[data-ds-addc-found]');
  const count = el.querySelector<HTMLElement>('[data-ds-addc-count]');
  const chips = el.querySelector<HTMLElement>('[data-ds-addc-chips]');
  const addBtn = el.querySelector<HTMLButtonElement>('[data-ds-addc-add]');
  const allBtn = el.querySelector<HTMLButtonElement>('[data-ds-addc-all]');
  const selBtn = el.querySelector<HTMLButtonElement>('[data-ds-addc-sel]');
  if (!input || !found || !count || !chips || !addBtn || !allBtn || !selBtn) {
    return (): void => { el.innerHTML = ''; };
  }

  let entries: ColorEntry[] = [];
  let picked: boolean[] = [];

  const paint = (): void => {
    const many = entries.length > 1;
    addBtn.disabled = entries.length !== 1;
    found.hidden = !many;
    if (!many) { chips.innerHTML = ''; count.textContent = ''; return; }

    count.textContent = t('Found {n} colours', { n: entries.length });
    chips.innerHTML = entries.map((e, i) => `
      <button type="button" class="ds-addc-chip" data-ds-addc-chip="${i}"
        aria-pressed="${picked[i] ? 'true' : 'false'}">
        <span class="ds-addc-chip-dot" aria-hidden="true" style="background:${escape(e.hex)}"></span>
        <span class="ds-addc-chip-v">${escape(e.value)}</span>
      </button>`).join('');
    selBtn.disabled = !picked.some(Boolean);
  };

  /** Re-read the field. Every chip a scan produces starts picked, so "Add all"
   *  and "Add selected" agree until the person disagrees with one of them. */
  const sync = (): void => {
    entries = parseColorEntries(input.value);
    picked = entries.map(() => true);
    paint();
  };

  /**
   * Empty the row.
   *
   * The field is re-focused ONLY when focus is still inside the row - Escape, or
   * a press of Add / Add all / Add selected that left it here. `onAdd` is
   * entitled to take focus somewhere better (adding one colour opens the swatch
   * popover on it and focuses the name field, which is the point of the flow),
   * and clearing the row afterwards must not drag focus back out of it.
   */
  const reset = (): void => {
    const keep = el.contains(el.ownerDocument.activeElement);
    input.value = '';
    entries = [];
    picked = [];
    paint();
    if (keep) input.focus();
  };

  const commit = (list: ColorEntry[]): void => {
    if (list.length === 0) return;
    opts.onAdd(list);
    reset();
  };

  const onInput = (): void => { sync(); };

  /** The single entry an Enter/Add press commits, or null when the field holds
   *  nothing or holds a group (a group needs one of the explicit group buttons). */
  const lone = (): ColorEntry | null => (entries.length === 1 ? entries[0] ?? null : null);

  const onKeydown = (e: KeyboardEvent): void => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const one = lone();
      if (one) commit([one]);
      else if (entries.length > 1) allBtn.focus();
      return;
    }
    if (e.key === 'Escape' && (input.value !== '' || entries.length > 0)) {
      // Only swallow Escape when it did something here - otherwise it belongs to
      // whatever sheet or popover is hosting this row.
      e.preventDefault();
      e.stopPropagation();
      reset();
    }
  };

  const onClick = (e: Event): void => {
    const target = e.target as HTMLElement;

    const chip = target.closest<HTMLElement>('[data-ds-addc-chip]');
    if (chip) {
      const i = Number(chip.dataset.dsAddcChip);
      if (Number.isInteger(i) && i >= 0 && i < picked.length) {
        picked[i] = !picked[i];
        chip.setAttribute('aria-pressed', picked[i] ? 'true' : 'false');
        selBtn.disabled = !picked.some(Boolean);
      }
      return;
    }
    if (target.closest('[data-ds-addc-add]')) { const one = lone(); if (one) commit([one]); return; }
    if (target.closest('[data-ds-addc-all]')) { commit(entries.slice()); return; }
    if (target.closest('[data-ds-addc-sel]')) { commit(entries.filter((_, i) => picked[i])); return; }

    if (target.closest('[data-ds-addc-drop]') && EyeDropper) {
      // The OS overlay samples anywhere on screen and swallows pointer events.
      // A dismissal (Escape) rejects, and picking nothing is a normal outcome - 
      // hence the empty catch. The result FILLS the field; adding stays explicit.
      void new EyeDropper().open()
        .then(res => { input.value = res.sRGBHex; sync(); input.focus(); })
        .catch(() => { /* dismissed — nothing picked */ });
    }
  };

  input.addEventListener('input', onInput);
  input.addEventListener('keydown', onKeydown);
  el.addEventListener('click', onClick);

  return (): void => {
    input.removeEventListener('input', onInput);
    input.removeEventListener('keydown', onKeydown);
    el.removeEventListener('click', onClick);
    el.innerHTML = '';
  };
}
