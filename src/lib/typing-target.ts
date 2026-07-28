// SPDX-License-Identifier: MPL-2.0
/**
 * typing-target — "is the user typing right now?", answered through shadow roots.
 *
 * Every keyboard shortcut in the shell has to bail while focus sits in a field,
 * or the keystroke gets eaten. The classic test — `document.activeElement.tagName
 * === 'INPUT'` — silently stopped working once the sidebar's text fields became
 * <jelly-input> custom elements: the real <input> lives in the host's shadow root,
 * so `document.activeElement` reports the HOST (`JELLY-INPUT`), which is neither
 * an INPUT nor contentEditable. Result: single-key shortcuts fired mid-typing —
 * the stage's `0` (fit) and `1` (100%) meant those two digits could never be
 * typed into a text field at all.
 *
 * `deepActiveElement()` walks the `shadowRoot.activeElement` chain to the real
 * focused node, and `isTypingTarget()` classifies it. Both are shadow-agnostic,
 * so they keep working for native controls and for any future custom element.
 */

/** The genuinely focused element, descending through open shadow roots. */
export function deepActiveElement(doc: Document = document): Element | null {
  let el: Element | null = doc.activeElement;
  // Bounded walk: each hop descends one shadow root, and the chain is shallow.
  // Closed shadow roots report `shadowRoot === null`, so the walk stops at the
  // host — the best answer available, and the same one the old test gave.
  while (el) {
    const inner = (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot?.activeElement;
    if (!inner || inner === el) return el;
    el = inner;
  }
  return null;
}

/**
 * True when `el` is a control the user types (or picks) into, so a single-key
 * shortcut must not fire. Defaults to the deep active element.
 *
 * SELECT is included: it eats type-to-select keystrokes of its own.
 */
export function isTypingTarget(el: Element | null = deepActiveElement()): boolean {
  if (!el) return false;
  if ((el as HTMLElement).isContentEditable) return true;
  return /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName || '');
}

// <input> types that carry a native caret and native per-character undo. A range
// slider / colour swatch / checkbox / number IS an <input> but has neither, so
// callers wanting the narrow test (e.g. "let ⌘Z fall through to the browser")
// use isTextEditingTarget rather than isTypingTarget.
const TEXTUAL_INPUT_TYPES = new Set(['text', 'search', 'url', 'tel', 'email', 'password', '']);

/** True only for a caret-bearing text field — a strict subset of isTypingTarget. */
export function isTextEditingTarget(el: Element | null = deepActiveElement()): boolean {
  if (!el) return false;
  if ((el as HTMLElement).isContentEditable || el.tagName === 'TEXTAREA') return true;
  if (el.tagName !== 'INPUT') return false;
  return TEXTUAL_INPUT_TYPES.has(((el as HTMLInputElement).type || 'text').toLowerCase());
}
