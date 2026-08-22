// SPDX-License-Identifier: MPL-2.0
/**
 * The Overview room - the studio's hub and its completion state (plan 97 section 5).
 *
 * Two faces of one room, decided by whether a design system is in force here - 
 * this device's own install or a real one shipped by the catalog, either way:
 *
 *  - EMPTY: two doors. "Start from a file" hands off to the source modal the
 *    view already owns; "Start from scratch" walks into Colours. A quiet exit
 *    to the tools sits under them, because leaving is a legitimate answer.
 *  - FURNISHED: what exists, at a glance - the palette, the type families, how
 *    many logo slots are filled, how many tokens there are. Every block is a
 *    door into its room. Counts, never a progress bar: nothing here is owed.
 *
 * The website door (plan 97 section 9) is deliberately absent rather than disabled - 
 * it arrives with M6, gated on a transport that actually works, and a greyed
 * third door would advertise something nobody can use.
 *
 * Reads only. Nothing in this room writes tokens; the rooms it opens do.
 */

import { summarizeTokensDoc, createTokenSet } from '@lolly/engine';
import type { HostV1 } from '@lolly-tools/core/host-v1';
import { listLogos } from '../../brand-logos.ts';
import { primaryFontFamily, displayFontFamily, monoFontFamily, italicFontFamily } from '../../../user-fonts.ts';
import type { BrandEditorHandle } from '../../brand-editor.ts';
import { icon } from '../../icons.ts';
import { escape } from '../../../utils.ts';
import { t } from '../../../i18n.ts';

/** The whole host; the slices this room reads are reached through the same
 *  narrow casts mountBrandEditor uses (they are web-shell extensions absent
 *  from the tool-facing HostV1 type). */
export type OverviewHost = HostV1;

export interface OverviewCtx {
  host: OverviewHost;
  /** The mounted editor, or null when it failed or is still mounting - read
   *  late, because the room outlives any one editor mount. */
  editor: () => BrandEditorHandle | null;
  /** Open a room by its `?area=` key. */
  goto: (area: string) => void;
  /** Open the source modal ("Add from…"). */
  openImport: () => void;
}

export interface OverviewRoom {
  /** Re-read and repaint. Cheap and idempotent; safe to call on room entry. */
  refresh: () => void;
  teardown: () => void;
}

/** What the room shows. Everything is a count or a name - no progress state. */
export interface OverviewModel {
  /** A design system is in force here - this device's own install, or a real
   *  one shipped by the catalog. False only on the starter placeholder. */
  furnished: boolean;
  /** Swatch values for the strip, capped at STRIP_MAX. */
  colors: string[];
  colorCount: number;
  /** Distinct family names across the type roles, in role order. */
  fonts: string[];
  logoCount: number;
  tokenCount: number;
  /** How many of `colorCount` are still the shipped starter ramp, unchanged.
   *  Optional so a caller that has nothing to say about ownership can leave it
   *  out; 0 and absent mean the same thing. */
  starterCount?: number;
}

const STRIP_MAX = 12;

/** The starter catalog's placeholder tokens asset (brands/lolly-start). Matching
 *  it is the shell's existing "unbranded" test - views/gallery.ts gates the
 *  first-run welcome on the same id - and it is the one tokens asset that means
 *  nothing has been furnished yet. Exported because the Colours room needs the
 *  same asset for the same reason (a starter swatch it did not write), and two
 *  copies of a well-known id is how they drift apart. */
export const STARTER_TOKENS_ID = 'lolly/tokens/brand';

const EMPTY_MODEL: OverviewModel = {
  furnished: false, colors: [], colorCount: 0, fonts: [], logoCount: 0, tokenCount: 0, starterCount: 0,
};

/**
 * The shipped starter document (brands/lolly-start's tokens asset), or null.
 *
 * A first write copies that whole ramp into the user's own document, so from
 * then on the user owns 25 colours nobody chose. Reading the SHIPPED bytes back
 * is what lets a caller tell those apart from the ones a person added, by
 * comparing path and value - no schema change, no flag on the token, and
 * nothing to migrate on a document that predates the idea.
 *
 * Null on any brand whose catalog ships no such asset (SUSE's, an ingested
 * pack), and null before boot sync has cached it - both mean "nothing to
 * attribute", which is exactly the behaviour every caller had before.
 */
export async function readStarterDoc(host: OverviewHost): Promise<unknown> {
  const assets = host.assets as unknown as { _getBlob?(id: string): Promise<Blob | null> };
  try {
    const blob = await assets._getBlob?.(STARTER_TOKENS_ID);
    return blob ? JSON.parse(await blob.text()) : null;
  } catch { return null; }
}

/** Every starter COLOUR as `token path -> resolved value`. Both halves matter:
 *  a Replace-palette writes the user's own ramps over the very same paths, so
 *  path alone would keep calling them starter colours forever. */
async function starterColors(host: OverviewHost): Promise<Map<string, string>> {
  const doc = await readStarterDoc(host);
  if (!doc) return new Map();
  try {
    return new Map(createTokenSet(doc).colors().map(c => [c.path, c.value]));
  } catch { return new Map(); }
}

/**
 * Collect what the design system currently holds.
 *
 * Reads `host.tokens.colors()` directly rather than lib/live-palette.ts, whose
 * per-host cache never busts: this room repaints after an install, and a cached
 * palette would show the colours the page opened with.
 */
export async function readOverview(host: OverviewHost): Promise<OverviewModel> {
  const assets = host.assets as unknown as { _findMetaByType?(type: string): Promise<{ id: string } | null> };
  const tokens = host.tokens as unknown as {
    colors?(opts?: { theme?: string }): Promise<Array<{ value: string; path?: string }>>;
    raw?(): Promise<unknown>;
  } | undefined;

  // "Furnished" is about whether a design system EXISTS here, not about who
  // installed it. bridge/tokens.ts resolves an unlocked catalog's own tokens doc
  // when there is no user install, so host.tokens below would answer with that
  // pack's full palette - and an "Nothing here yet" empty state over a painted
  // Colours room is simply false. The one genuinely empty case is the starter
  // placeholder, which is also the shell's own unbranded signal.
  let tokensId = '';
  try { tokensId = (await assets._findMetaByType?.('tokens'))?.id ?? ''; }
  catch { /* discovery unavailable - treat as not installed here */ }
  if (!tokensId || tokensId === STARTER_TOKENS_ID) return EMPTY_MODEL;

  const swatches = await tokens?.colors?.().catch(() => []) ?? [];
  const doc = await tokens?.raw?.().catch(() => null) ?? null;
  let tokenCount = 0;
  try { tokenCount = doc ? summarizeTokensDoc(doc).tokenCount : 0; }
  catch { /* an unreadable doc still shows its palette */ }

  const families = await Promise.all([
    primaryFontFamily(host as unknown as Parameters<typeof primaryFontFamily>[0]).catch(() => ''),
    displayFontFamily(host as unknown as Parameters<typeof displayFontFamily>[0]).catch(() => ''),
    monoFontFamily(host as unknown as Parameters<typeof monoFontFamily>[0]).catch(() => ''),
    italicFontFamily(host as unknown as Parameters<typeof italicFontFamily>[0]).catch(() => ''),
  ]);

  // listLogos mints an object URL per slot for its previews; this room only
  // counts them, so hand every one straight back rather than leaking it.
  const logos = await listLogos(host as unknown as Parameters<typeof listLogos>[0]).catch(() => []);
  for (const logo of logos) {
    try { URL.revokeObjectURL(logo.url); } catch { /* no blob-URL support - nothing to release */ }
  }

  const starter = await starterColors(host);
  return {
    furnished: true,
    colors: swatches.slice(0, STRIP_MAX).map(s => s.value),
    colorCount: swatches.length,
    fonts: [...new Set(families.filter(Boolean))],
    logoCount: logos.length,
    tokenCount,
    starterCount: starter.size
      ? swatches.filter(s => !!s.path && starter.get(s.path) === s.value).length
      : 0,
  };
}

// ── Markup ───────────────────────────────────────────────────────────────────

const countLabels = {
  colors: (n: number): string => t(n === 1 ? '{n} colour' : '{n} colours', { n }),
  logos: (n: number): string => t(n === 1 ? '{n} logo' : '{n} logos', { n }),
  tokens: (n: number): string => t(n === 1 ? '{n} token' : '{n} tokens', { n }),
};

/**
 * The Colours card's value: a plain count, or the ownership split while the
 * shipped starter ramp is still most of the palette.
 *
 * A blank brand hands over 25 colours on the first write, so "26 colours" after
 * one add reads as a system somebody built. Splitting the number is the whole
 * point - it says which part is theirs - and it stops as soon as their own
 * colours are the majority, because by then the count is true again.
 */
function colorsValue(model: OverviewModel): string {
  const starter = model.starterCount ?? 0;
  const yours = model.colorCount - starter;
  if (starter <= 0 || starter <= yours) return countLabels.colors(model.colorCount);
  return t('{n} yours - {m} starter', { n: Math.max(0, yours), m: starter });
}

function doorHtml(door: string, glyph: string, name: string, note: string): string {
  return `
    <button type="button" class="ds-ov-door" data-ds-door="${escape(door)}">
      <span class="ds-ov-door-ic" aria-hidden="true">${glyph}</span>
      <span class="ds-ov-door-name">${escape(name)}</span>
      <span class="ds-ov-door-note">${escape(note)}</span>
    </button>`;
}

function cardHtml(area: string, label: string, value: string, body = ''): string {
  return `
    <button type="button" class="ds-ov-card" data-ds-goto="${escape(area)}">
      <span class="ds-ov-card-label">${escape(label)}</span>
      <span class="ds-ov-card-value">${escape(value)}</span>
      ${body}
    </button>`;
}

/** The room's markup for a model, or the resting line while the read runs. */
export function overviewHtml(model: OverviewModel | null): string {
  if (!model) return `<p class="ds-ov-loading">${t('Reading the design system…')}</p>`;

  if (!model.furnished) {
    return `
      <div class="ds-ov ds-ov--empty">
        <h2 class="ds-ov-title">${t('Nothing here yet')}</h2>
        <p class="ds-ov-sub">${t('Bring across what already exists, or add one thing at a time. Everything stays on this device.')}</p>
        <div class="ds-ov-doors">
          ${doorHtml('file', icon('upload'), t('Start from a file'),
            t('Design tokens, a Penpot project, a design system pack or an SVG.'))}
          ${doorHtml('scratch', icon('palette'), t('Start from scratch'),
            t('Add one colour, then keep going whenever you like.'))}
        </div>
        <a class="ds-ov-exit" href="#/">${t('Explore the tools')}</a>
      </div>`;
  }

  const strip = model.colors.length
    ? `<span class="ds-ov-strip" aria-hidden="true">${model.colors
        .map(hex => `<span class="ds-ov-chip" style="background:${escape(hex)}"></span>`).join('')}</span>`
    : '';
  const fonts = model.fonts.length ? model.fonts.join(', ') : t('Not set');

  return `
    <div class="ds-ov">
      <h2 class="ds-ov-title">${t('The design system')}</h2>
      <p class="ds-ov-sub">${t('This is live. Every tool, page and export follows it. Open a room to change anything.')}</p>
      <div class="ds-ov-cards">
        ${cardHtml('color', t('Colours'), colorsValue(model), strip)}
        ${cardHtml('type', t('Type'), fonts)}
        ${cardHtml('logos', t('Logos'), countLabels.logos(model.logoCount))}
        ${cardHtml('tokens', t('Tokens'), countLabels.tokens(model.tokenCount))}
        ${cardHtml('catalogue', t('Files'), t('Uploads and downloads'))}
      </div>
      <div class="ds-ov-more">
        <button type="button" class="be-btn" data-ds-door="file">${t('Add from a file')}</button>
        <a class="ds-ov-exit" href="#/">${t('Explore the tools')}</a>
      </div>
    </div>`;
}

// ── Mount ────────────────────────────────────────────────────────────────────

/**
 * Render the room into `el` and wire its doors. `el`'s `hidden` state is the
 * view's to set, and it is also what the palette subscription reads: a hidden
 * room skips the repaint (the view refreshes it on entry) rather than re-reading
 * the whole design system on every frame of a colour-wheel drag.
 */
export function mountOverviewRoom(el: HTMLElement, ctx: OverviewCtx): OverviewRoom {
  let alive = true;
  let seq = 0;

  const paint = (model: OverviewModel | null): void => { el.innerHTML = overviewHtml(model); };

  const refresh = (): void => {
    const mine = ++seq;
    void readOverview(ctx.host)
      .catch(() => EMPTY_MODEL)
      // A slower earlier read must not repaint over a newer one.
      .then(model => { if (alive && mine === seq && el.isConnected) paint(model); });
  };

  const onClick = (e: Event): void => {
    const target = e.target as HTMLElement;
    const goto = target.closest<HTMLElement>('[data-ds-goto]');
    if (goto?.dataset.dsGoto) { ctx.goto(goto.dataset.dsGoto); return; }
    const door = target.closest<HTMLElement>('[data-ds-door]')?.dataset.dsDoor;
    if (door === 'file') ctx.openImport();
    else if (door === 'scratch') ctx.goto('color');
  };

  paint(null);
  el.addEventListener('click', onClick);
  // A palette change lands here from anywhere in the studio, including rooms
  // that repaint on every frame of a wheel drag - so only a VISIBLE overview
  // re-reads. A hidden one is caught by the refresh() the view runs on entry.
  const unsubscribe = ctx.editor()?.onPalette(() => { if (!el.hidden) refresh(); }) ?? ((): void => {});
  refresh();

  return {
    refresh,
    teardown: () => {
      alive = false;
      unsubscribe();
      el.removeEventListener('click', onClick);
    },
  };
}
