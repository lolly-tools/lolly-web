// SPDX-License-Identifier: MPL-2.0
/**
 * Jelly effects — the flag-gated soft-body chrome controls (vendored Jelly UI,
 * `src/vendor/jelly/`). One entry point: `ensureJelly()` lazily imports the
 * bundle (defining every <jelly-*> element) the first time a surface wants it,
 * so users who turn the flag off never pay for the chunk.
 *
 * Theming: Jelly UI resolves every color through `--jelly-color-*` custom
 * properties re-read from computed style on each repaint, with its own oklch
 * defaults injected under `@layer jelly`. The bridge below is UNLAYERED (like
 * tokens.css), so it outranks those defaults and maps the shell's semantic
 * triples onto them — theme cycling and runtime brand re-injection
 * (brand-vars.ts rewriting --primary) flow through with no further wiring.
 * Named-palette entries (rose/amber/azure/mint/white) and the shadow triple are
 * deliberately left to Jelly's own light/dark defaults, keyed by the
 * [data-jelly-mode] attribute that theme.ts stamps alongside [data-theme].
 */

import { flagEnabledSync, JELLY_FLAG } from '../feature-flags.ts';

const BRIDGE_ID = 'jelly-token-bridge';

// Shell semantic tokens (shadcn HSL triples, consumed as hsl(var(--x))) mapped
// onto Jelly UI's token vocabulary. Fonts ride along so jelly labels match chrome.
const BRIDGE_CSS = `:root {
  --jelly-color-background-accent: hsl(var(--primary));
  --jelly-color-foreground-on-accent: hsl(var(--primary-foreground));
  --jelly-color-background-default: hsl(var(--background));
  --jelly-color-background-surface: hsl(var(--card));
  --jelly-color-background-muted: hsl(var(--muted));
  --jelly-color-background-neutral: hsl(var(--muted));
  --jelly-color-background-neutral-emphasis: hsl(var(--secondary));
  --jelly-color-foreground-default: hsl(var(--foreground));
  --jelly-color-foreground-muted: hsl(var(--muted-foreground));
  --jelly-color-foreground-on-neutral: hsl(var(--foreground));
  --jelly-color-border-default: hsl(var(--border));
  --jelly-color-border-focus: hsl(var(--ring));
  --jelly-color-background-rose: hsl(var(--destructive));
  --jelly-font-display: var(--font-brand);
  --jelly-font-text: var(--font-brand);
  --jelly-font-mono: var(--font-mono);
}
/* Chrome-wide scale: jelly's size tables suit marketing pages; Lolly's chrome
   runs denser. Page-level rules beat shadow :host size tables, so this is the
   one knob for every surface (dialogs, action rows, forms). */
jelly-button {
  --jelly-button-font-size: .85rem;
  --jelly-button-height: 2.35rem;
  --jelly-button-min-width: 0;
}
jelly-input {
  --jelly-input-font-size: .9rem;
  --jelly-input-padding-inline: .65rem;
}`;

let loading: Promise<void> | null = null;
let ready = false;

/** Whether the Jelly effects flag is on (sync read of the boot-hydrated mirror). */
export function jellyEnabled(): boolean {
  return flagEnabledSync(JELLY_FLAG.id);
}

/**
 * Flag on AND bundle loaded — the synchronous gate for surfaces that build
 * markup in one pass (dialogs, topbars, sidebars) and can't await a chunk.
 * main.ts idle-preloads the bundle when the flag is on, so by interaction time
 * this is effectively `jellyEnabled()`; before that the surface renders its
 * plain CSS control and simply looks pre-jelly for a moment.
 */
export function jellyActive(): boolean {
  return ready && jellyEnabled();
}

/**
 * Load the Jelly UI bundle and install the token bridge if (and only if) the
 * flag is on. Resolves `true` when <jelly-*> elements are ready to render.
 * Safe to call from any surface on every mount — the import happens once.
 * A caller holding the canonical profile can pass the flag state itself
 * (e.g. right after a toggle, when the sync mirror hasn't been written yet).
 */
export async function ensureJelly(on: boolean = jellyEnabled()): Promise<boolean> {
  if (!on) return false;
  if (!loading) {
    loading = import('../vendor/jelly/jelly.mjs').then(() => {
      if (!document.getElementById(BRIDGE_ID)) {
        const style = document.createElement('style');
        style.id = BRIDGE_ID;
        style.textContent = BRIDGE_CSS;
        document.head.appendChild(style);
      }
      // The import injected @layer jelly defaults keyed off [data-jelly-mode];
      // theme.ts stamps it on every applyTheme, but the first load can happen
      // after the last theme apply — sync it now so unbridged defaults match.
      syncJellyMode();
      installLabelForwarder();
      ready = true;
    });
  }
  try {
    await loading;
    return true;
  } catch (err) {
    loading = null; // a failed chunk load may be transient — allow a retry
    console.warn('jelly: bundle failed to load', err);
    return false;
  }
}

/**
 * One app-wide fix for label-wrapped jelly toggles: a native `<label>` can't
 * activate a control whose real checkbox lives in shadow DOM (the browser's
 * synthesized click lands on the inert host), so clicks on a label's text are
 * forwarded to the jelly control inside it. Direct hits on the control (its own
 * pointer handling toggles), or on interactive elements like the (i) help tips,
 * are left alone — mirroring how a native label ignores nested interactives.
 * Installed once when the bundle loads; delegated, so it covers every surface.
 */
function installLabelForwarder(): void {
  document.addEventListener('click', (e) => {
    if (!(e.target instanceof Element)) return;
    if (e.target.closest('jelly-switch, jelly-checkbox, button, a, input, select, textarea')) return;
    const sw = e.target.closest('label')?.querySelector<HTMLElement & {
      checked: boolean;
      setChecked?: (on: boolean, animate?: boolean) => void;
    }>('jelly-switch, jelly-checkbox');
    if (!sw) return;
    e.preventDefault();
    // jelly-switch exposes setChecked (its shadow checkbox swallows clicks);
    // jelly-checkbox's shadow checkbox is a real one — click it so the toggle
    // takes the same pop-and-emit path as a direct hit.
    if (typeof sw.setChecked === 'function') sw.setChecked(!sw.checked, true);
    else sw.shadowRoot?.querySelector('input')?.click();
  });
}

/**
 * Pin Jelly's light/dark mode to the shell theme (brand chrome is dark-surfaced,
 * see tokens.css). Attribute-only — no import, so theme.ts can call this
 * unconditionally; it is inert until the bundle's stylesheet exists.
 */
export function syncJellyMode(theme?: string): void {
  const t = theme ?? document.documentElement.dataset.theme ?? 'light';
  document.documentElement.setAttribute('data-jelly-mode', t === 'light' ? 'light' : 'dark');
}
