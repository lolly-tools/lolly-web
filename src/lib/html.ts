// SPDX-License-Identifier: MPL-2.0
// Shared HTML-escape helper for the web shell. Escapes the five characters that
// are unsafe in HTML text content and single/double-quoted attributes, with a
// null/undefined guard. Consolidates the many byte-identical per-file copies
// across src/views, src/lib and src/components. (The /pro subtree keeps its own
// isolated copies by design and must not import from here.)
const HTML_ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => HTML_ESC[c]!);
}
