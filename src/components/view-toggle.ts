// SPDX-License-Identifier: MPL-2.0
/**
 * The Tools | Projects | Catalog segmented switch shown atop the gallery, the projects
 * view and the catalog view. Pure markup — navigation is plain hash links (`#` → tools
 * gallery, `#/p` → projects root, `#/c` → catalog), so the router's hashchange listener
 * handles it; no JS wiring.
 *
 * Each tab carries BOTH an icon and a text label. Desktop shows the label; on mobile the
 * label is hidden and only the icon remains (a wrench for Tools, a folder for Projects, a
 * box grid for Catalog), so the toggle stays compact and never collides with the fixed
 * top-right cluster — see the @media block in topbar.css. The `aria-label` carries the
 * name in both modes (the icon is aria-hidden, the label may be display:none).
 *
 * `active` is 'tools', 'projects' or 'catalog'.
 */
export type ViewToggleKey = 'tools' | 'projects' | 'catalog';

// Lucide glyphs — wrench (Tools), folder (Projects), layout-grid (Catalog).
const ICONS: Record<ViewToggleKey, string> = {
  tools: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>',
  projects: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>',
  catalog: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/></svg>',
};

export function viewToggle(active: ViewToggleKey): string {
  const opt = (key: ViewToggleKey, href: string, label: string) =>
    `<a href="${href}" class="view-toggle-opt${active === key ? ' is-active' : ''}"` +
    // The active tab is a no-op navigation → stays silent; the others play the "navigate"
    // swish (data-sfx is read by the app-wide sfx delegation in lib/sfx.ts).
    `${active === key ? ' aria-current="page"' : ' data-sfx="navigate"'} data-vt="${key}" aria-label="${label}">` +
    `<span class="view-toggle-ic" aria-hidden="true">${ICONS[key]}</span>` +
    `<span class="view-toggle-label">${label}</span>` +
    `</a>`;
  return `
    <nav class="view-toggle" aria-label="Switch between tools, projects and catalog">
      ${opt('tools', '#', 'Tools')}
      ${opt('projects', '#/p', 'Projects')}
      ${opt('catalog', '#/c', 'Catalog')}
    </nav>`;
}
