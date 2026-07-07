// SPDX-License-Identifier: MPL-2.0
export function escape(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' } as Record<string, string>)[c]!);
}
