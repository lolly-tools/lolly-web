// SPDX-License-Identifier: MPL-2.0
/**
 * Invisible characters, made visible - the ONE naming + rendering helper for
 * every surface that shows a text extract (the verify panel, the catalog's
 * text preview and read-text extract, the analyse work preview).
 *
 * The byte-level tells the analyser flags (zero-width characters, bidi
 * controls, tag characters, variation selectors, stego spaces) are literally
 * unseeable in a normal render: a zero-width space inside a highlight is a
 * hairline. Every extract therefore replaces each such character with a small
 * NAMED chip (ZWSP, RLO, TAG, VS17...) carrying the codepoint in its tooltip,
 * so what the finding says is right there in the text, glanceable - not an
 * abstract row the reader has to hunt for. Promoted from catalog.ts's local
 * work-preview helper (2026-08-19) so verify and the catalog can never drift.
 *
 * Chips are visual only: copy actions always use the ORIGINAL text, and the
 * chip glyph never enters the string.
 */
import { escape } from '../utils.ts';

// \u-escaped on purpose: raw invisible characters in SOURCE are exactly the
// artifact this module exists to expose.
const INVISIBLE_NAME: Record<string, string> = {
  '\u00A0': 'NBSP', '\u00AD': 'SHY', '\u034F': 'CGJ', '\u061C': 'ALM', '\u180E': 'MVS',
  '\u200B': 'ZWSP', '\u200C': 'ZWNJ', '\u200D': 'ZWJ', '\u200E': 'LRM', '\u200F': 'RLM',
  '\u202A': 'LRE', '\u202B': 'RLE', '\u202C': 'PDF', '\u202D': 'LRO', '\u202E': 'RLO',
  '\u202F': 'NNBSP', '\u2028': 'LS', '\u2029': 'PS', '\u2060': 'WJ',
  '\u2061': 'FA', '\u2062': 'IT', '\u2063': 'IS', '\u2064': 'IP',
  '\u2066': 'LRI', '\u2067': 'RLI', '\u2068': 'FSI', '\u2069': 'PDI',
  '\u3000': 'IDSP', '\uFEFF': 'BOM', '\uFFF9': 'IAA', '\uFFFA': 'IAS', '\uFFFB': 'IAT',
  '\uFFFC': 'OBJ',
};

/** Short display name for an invisible/format character, null for anything a
 *  reader can already see. Covers every range the analyser's byte tier flags. */
export function invisibleCharName(ch: string): string | null {
  const named = INVISIBLE_NAME[ch];
  if (named) return named;
  const cp = ch.codePointAt(0) ?? 0;
  if (cp >= 0x2000 && cp <= 0x200A) return 'SP';       // width-variant spaces
  if (cp >= 0xFE00 && cp <= 0xFE0F) return `VS${cp - 0xFE00 + 1}`;
  if (cp >= 0xE0100 && cp <= 0xE01EF) return `VS${cp - 0xE0100 + 17}`;
  if (cp >= 0xE0000 && cp <= 0xE007F) return 'TAG';    // tag chars - invisible ASCII smuggling
  if (cp >= 0xE000 && cp <= 0xF8FF) return 'PUA';      // private use (leaked model delimiters live here)
  return null;
}

const tooltip = (ch: string, name: string): string => {
  const cp = (ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0');
  return `${name} · U+${cp}`;
};

/** DOM path: append `text` to `parent` with each invisible character rendered
 *  as a titled chip. No markup sink - createElement/textContent only. */
export function appendVisibleText(parent: Node, text: string, chipClass: string): void {
  let plain = '';
  const flush = (): void => { if (plain) { parent.appendChild(document.createTextNode(plain)); plain = ''; } };
  for (const ch of text) {
    const name = invisibleCharName(ch);
    if (!name) { plain += ch; continue; }
    flush();
    const chip = document.createElement('span');
    chip.className = chipClass;
    chip.title = tooltip(ch, name);
    chip.textContent = name;
    parent.appendChild(chip);
  }
  flush();
}

/** String path for the template-literal renderers: `text`, fully escape()d,
 *  with each invisible character as a titled chip span. Safe for the existing
 *  reviewed innerHTML sinks - every interpolated value is escaped here. */
export function visibleTextHtml(text: string, chipClass: string): string {
  let out = '';
  let plain = '';
  const flush = (): void => { if (plain) { out += escape(plain); plain = ''; } };
  for (const ch of text) {
    const name = invisibleCharName(ch);
    if (!name) { plain += ch; continue; }
    flush();
    out += `<span class="${chipClass}" title="${escape(tooltip(ch, name))}">${escape(name)}</span>`;
  }
  flush();
  return out;
}
