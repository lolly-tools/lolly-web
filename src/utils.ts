// SPDX-License-Identifier: MPL-2.0
export function escape(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' } as Record<string, string>)[c]!);
}

/** Route-change signals the web shell fires (see main.ts) — any one dismisses/tears
 *  down a body-mounted overlay so it never outlives the view that spawned it. The
 *  single source of truth for lang-menu, profile-menu, welcome-dialog and body-popover. */
export const NAV_EVENTS = ['hashchange', 'popstate', 'lolly:navigate'] as const;
