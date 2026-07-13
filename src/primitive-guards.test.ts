// SPDX-License-Identifier: MPL-2.0
/**
 * Primitive-drift guards — static scans that make regressions against the shared
 * primitive layer (plans/component-audit.md, repo root) fail loudly instead of
 * silently re-forking atoms. Each rule names the audit rec it protects.
 *
 * These are ratchets, not aspirations: the allowlists encode the SURVEYED state
 * of 2026-07-13 (every entry carries the reason it is allowed to exist). A new
 * hit outside the allowlist fails with the primitive to use instead; a count
 * DROPPING below its allowlist entry also fails, with a "ratchet down" message,
 * so the ledger can never rot into silently re-permitting old debt.
 *
 * Run directly:  node --test shells/web/src/primitive-guards.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── File inventory (one read, shared by every rule) ──────────────────────────

const SRC_DIR = dirname(fileURLToPath(import.meta.url)); // this file lives at src/

interface SrcFile { rel: string; text: string }

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'vendor') continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (/\.(ts|css)$/.test(entry.name)) out.push(p);
  }
  return out;
}

const ALL = walk(SRC_DIR).map((p): SrcFile => ({
  rel: relative(SRC_DIR, p).split(sep).join('/'),
  text: readFileSync(p, 'utf8'),
}));
// Product surface only: test files aren't shipped markup (and this file quotes
// the very patterns it hunts, so it must not scan itself).
const TS = ALL.filter(f => f.rel.endsWith('.ts') && !f.rel.endsWith('.test.ts') && !f.rel.endsWith('.d.ts'));
const CSS = ALL.filter(f => f.rel.endsWith('.css'));

test('sanity: the scan actually found the tree (a broken walk must not vacuously pass)', () => {
  assert.ok(TS.length > 100, `only ${TS.length} .ts files found under ${SRC_DIR}`);
  assert.ok(CSS.length > 20, `only ${CSS.length} .css files found under ${SRC_DIR}`);
});

// ── Shared helpers ────────────────────────────────────────────────────────────

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** Every match of `re` in `text`, as 1-indexed line numbers. */
function hitLines(text: string, re: RegExp): number[] {
  const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  const out: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = r.exec(text))) {
    out.push(lineOf(text, m.index));
    if (r.lastIndex === m.index) r.lastIndex++;
  }
  return out;
}

/** Blank out CSS comments, preserving offsets so line numbers stay true. */
function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
}

/**
 * Exact-count ratchet: `actual` (key → hit lines) must equal `allowed`
 * (key → permitted count). Over → violation with the remedy; under → a
 * "ratchet the allowlist down" failure so the ledger stays honest.
 */
function checkRatchet(actual: Map<string, number[]>, allowed: Record<string, number>, remedy: string): void {
  const problems: string[] = [];
  for (const [key, lines] of actual) {
    const max = allowed[key] ?? 0;
    if (lines.length > max) {
      problems.push(`${key} (line${lines.length > 1 ? 's' : ''} ${lines.join(', ')}): ${lines.length} hit(s), allowlist permits ${max}. ${remedy}`);
    } else if (lines.length < max) {
      problems.push(`${key}: allowlist permits ${max} hit(s) but only ${lines.length} remain — attrition win! Ratchet its entry down in primitive-guards.test.ts.`);
    }
  }
  for (const [key, max] of Object.entries(allowed)) {
    if (max > 0 && !actual.has(key)) {
      problems.push(`${key}: allowlisted for ${max} hit(s) but has none (fixed or file gone) — remove its entry from primitive-guards.test.ts.`);
    }
  }
  assert.equal(problems.length, 0, `\n${problems.join('\n')}\n`);
}

// ── R1 (rec 4 — one dialog lifecycle) ────────────────────────────────────────
// mountModal (components/modal.ts) is the ONE <dialog> lifecycle: open, Escape,
// backdrop hit-test, body-mount, focus-first, teardown. Hand-rolling any of it
// re-forks the primitive rec 4 spent the whole migration deleting.

const DIALOG_CREATE = /createElement\(\s*['"`]dialog['"`]\s*\)/;
const SHOW_MODAL = /\.showModal\(/;

// Allowlist reasons (counts are exact — a second hit in an allowed file still fails):
const DIALOG_CREATE_ALLOWED: Record<string, number> = {
  'components/modal.ts': 1,  // the primitive itself — the one place allowed to mint a <dialog>
  // Known pre-mountModal holdout: local openDialog()/closeDialog() lifecycle whose
  // inner item context-menu teardown couples to the dialog's 'close' event (see the
  // comment above its dialog.addEventListener('close', …)). Migration is a follow-up;
  // frozen at one instance until then.
  'folder-overlay.ts': 1,
};
const SHOW_MODAL_ALLOWED: Record<string, number> = {
  'components/modal.ts': 1,  // the primitive itself
  'folder-overlay.ts': 1,    // same holdout as above — its openDialog() calls showModal()
  // Progressive-enhancement open of a STATIC markup dialog (<dialog class="dash-cap-modal">
  // in the view template) with a setAttribute('open') fallback for no-dialog engines.
  // It doesn't mint a dialog or re-implement focus/teardown, so it isn't a lifecycle fork.
  'views/dashboard.ts': 1,
};

test('R1 (rec 4): the <dialog> lifecycle is minted only by components/modal.ts (mountModal)', () => {
  const creates = new Map<string, number[]>();
  const shows = new Map<string, number[]>();
  for (const f of TS) {
    const c = hitLines(f.text, DIALOG_CREATE);
    if (c.length) creates.set(f.rel, c);
    const s = hitLines(f.text, SHOW_MODAL);
    if (s.length) shows.set(f.rel, s);
  }
  checkRatchet(creates, DIALOG_CREATE_ALLOWED,
    "Don't hand-roll a <dialog> — use mountModal(content, opts) from components/modal.ts (the one lifecycle: open/Escape/backdrop/focus/teardown).");
  checkRatchet(shows, SHOW_MODAL_ALLOWED,
    "Don't call showModal() yourself — mountModal (components/modal.ts) owns opening; for a confirm/notice/prompt use confirm-dialog.ts's wrappers.");
});

// ── R2 (rec 2 — one primary fill) ────────────────────────────────────────────
// The primary-fill button recipe — background:hsl(var(--primary)) PLUS
// color:hsl(var(--primary-foreground)) in one rule — is textually declared once,
// in styles/parts/buttons.css (.btn--primary and its alias selector-list). Rec 2's
// documented attrition policy froze the legacy restatements below: no new members.
// Note the regex deliberately does NOT match `background: var(--brand-primary,
// hsl(var(--primary)))` — that brand-var indirection (e.g. .dash-hero-cta) is a
// documented, deliberate delta, not a fork of the recipe.

const PRIMARY_BG = /(?:^|[;\s])background(?:-color)?:\s*hsl\(var\(--primary\)\)/;
const PRIMARY_FG = /(?:^|[;\s])color:\s*hsl\(var\(--primary-foreground\)\)/;

// Frozen legacy fills (surveyed 2026-07-13) — rec 2's remainder: renaming these is
// "markup-rename churn with real regression risk"; the policy is attrition, so each
// stays until its view is rewritten. Keyed "file → selector", each permitted once.
const PRIMARY_FILL_ALLOWED: Record<string, number> = {
  'pro/pro.css → .pro-fill-btn:hover': 1,                              // pro fill-tool hover state
  'styles/parts/editor.css → .fc-btn.is-armed': 1,                     // flow-chart editor armed state
  'styles/parts/editor.css → .fc-btn.fc-action-primary': 1,            // flow-chart editor primary action
  'styles/parts/featured.css → .ftile-badge': 1,                       // featured-tile count badge
  'styles/parts/gallery.css → .personalize-nudge-cta': 1,              // personalize nudge CTA
  'styles/parts/gallery.css → .gtile-continue': 1,                     // gallery tile continue pill
  'styles/parts/gallery.css → .gtile-newbadge': 1,                     // gallery tile "new" badge
  'styles/parts/profile.css → .profile-view .profile-theme-pill': 1,   // Appearance theme pill active
  'styles/parts/start.css → .start-tab.is-active': 1,                  // studio tab active state
  'styles/parts/storage.css → .clear-dialog-actions .btn.btn-go': 1,   // clear-gate go button
  'styles/parts/tool-chrome.css → .scrub-readout': 1,                  // select-scrub readout bubble
  'styles/parts/tool-chrome.css → .audio-preview.is-playing': 1,       // audio preview playing state
  'styles/parts/tool.css → .render-pill': 1,                           // the Get|Save render pill
  'styles/parts/tool.css → .flatpickr-day.selected, .flatpickr-day.selected:hover': 1, // vendored flatpickr theme
  'styles/parts/tool.css → .block-add--prominent': 1,                  // blocks-input add button
  'styles/parts/tool.css → .embed-editor-actions .ee-apply': 1,        // embed editor apply button
  'styles/parts/topbar.css → .profile-menu-count': 1,                  // profile menu count bubble
  'styles/parts/topbar.css → .history-fab-count': 1,                   // history FAB count bubble
  'styles/parts/welcome.css → .welcome-lang.is-active': 1,             // welcome language pill active
  'styles/picker.css → .tc-render': 1,                                 // picker tool-card render button
  'styles/picker.css → .asset-picker-toolcard-actions .tc-use': 1,     // picker tool-card use button
  'styles/picker.css → .webcam-capture-actions .webcam-capture-shoot': 1, // webcam shoot button
  'styles/picker.css → .pdfpick-btn--primary': 1,                      // PDF page-picker primary button
};

test('R2 (rec 2): the primary-fill button recipe is declared once, in buttons.css', () => {
  const found = new Map<string, number[]>();
  for (const f of CSS) {
    if (f.rel === 'styles/parts/buttons.css') continue; // the canonical home
    const css = stripCssComments(f.text);
    const rule = /([^{}]+)\{([^{}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = rule.exec(css))) {
      const decls = m[2] ?? '';
      if (!PRIMARY_BG.test(decls) || !PRIMARY_FG.test(decls)) continue;
      const selector = (m[1] ?? '').trim().replace(/\s+/g, ' ');
      const key = `${f.rel} → ${selector}`;
      const lines = found.get(key) ?? [];
      lines.push(lineOf(css, m.index + (m[1]?.length ?? 0)));
      found.set(key, lines);
    }
  }
  checkRatchet(found, PRIMARY_FILL_ALLOWED,
    "New primary-fill button: use class=\"btn btn--primary\" (styles/parts/buttons.css), or add your selector to its alias selector-list — never restate the fill pair.");
});

// ── R3 (rec 5 — one icon registry) ───────────────────────────────────────────
// lib/icons.ts's PATHS registry + icon(name, opts) is the one home for Lucide
// glyphs (the 24×24 viewBox is their signature). Rec 5 deleted the seven named
// per-file icon maps; the files below still carry inline one-off glyphs that were
// never in that rec's scope — frozen at their surveyed counts so the backlog can
// only shrink. A NEW inline 24×24 SVG anywhere fails.

const LUCIDE_VIEWBOX = 'viewBox="0 0 24 24"';

const INLINE_GLYPH_ALLOWED: Record<string, number> = {
  'lib/icons.ts': 1,             // the registry itself — icon()'s one <svg viewBox…> template
  'views/components-data.ts': 2, // #/components static specimen markup demonstrating icon output
  // Frozen legacy inline glyphs, pre-dating lib/icons.ts (rec 5 migrated only the seven
  // named maps; these were never in scope). Counts surveyed 2026-07-13 — down only.
  'components/color-field.ts': 2,
  'components/help-tip.ts': 1,
  'components/music-player.ts': 8,
  'components/profile-menu.ts': 2,
  'components/view-toggle.ts': 3,
  'lib/audio-coaching.ts': 1,
  'lib/brand-editor.ts': 5,
  'lib/brand-seal.ts': 1,
  'lib/capabilities-data.ts': 1,
  'lib/device-info.ts': 18,      // TITLE_ICONS map — the known landmine, biggest holdout after doc-editor/catalog
  'lib/genai-pill.ts': 1,
  'lib/lolly-badge.ts': 1,
  'lib/recording-tips.ts': 1,
  'lib/upload-dropzone.ts': 1,
  'pro/blocks-editor.ts': 3,
  'pro/grid.ts': 5,
  'pro/run-overlay.ts': 1,
  'theme.ts': 3,
  'views/catalog.ts': 22,
  'views/dashboard.ts': 5,
  'views/doc-editor.ts': 23,
  'views/free-canvas.ts': 1,
  'views/multi-edit.ts': 1,
  'views/personalize-nudge.ts': 1,
  'views/picker.ts': 3,
  'views/record-control.ts': 1,
  'views/tool-actions.ts': 13,
  'views/tool.ts': 6,
};

test('R3 (rec 5): inline 24×24 Lucide glyphs only shrink — new icons go through lib/icons.ts', () => {
  const found = new Map<string, number[]>();
  for (const f of TS) {
    const lines: number[] = [];
    let idx = f.text.indexOf(LUCIDE_VIEWBOX);
    while (idx !== -1) {
      lines.push(lineOf(f.text, idx));
      idx = f.text.indexOf(LUCIDE_VIEWBOX, idx + LUCIDE_VIEWBOX.length);
    }
    if (lines.length) found.set(f.rel, lines);
  }
  checkRatchet(found, INLINE_GLYPH_ALLOWED,
    "Don't inline a 24×24 SVG — render it via icon(name, opts) from lib/icons.ts (add the glyph's path to its PATHS registry if it's missing).");
});

// ── R4 (contract sync) — #/components stays the browsable contract ───────────
// Every `live: "<key>"` in views/components-data.ts must have a renderer in
// views/components.ts's LIVE map, and every LIVE renderer must be reachable from
// a specimen. A one-sided add means either a dead renderer or a specimen whose
// stage silently falls back to source view.

/** Skip a '…' / "…" string literal; returns the index just past the close quote. */
function skipString(src: string, i: number): number {
  const q = src[i];
  i++;
  while (i < src.length) {
    if (src[i] === '\\') i += 2;
    else if (src[i] === q) return i + 1;
    else i++;
  }
  return i;
}

/** Skip a `…` template literal, including nested ${ … } holes; returns index past the close. */
function skipTemplate(src: string, i: number): number {
  i++; // past the opening backtick
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '`') return i + 1;
    if (c === '$' && src[i + 1] === '{') {
      i += 2;
      let d = 1;
      while (i < src.length && d > 0) {
        const h = src[i];
        if (h === "'" || h === '"') i = skipString(src, i);
        else if (h === '`') i = skipTemplate(src, i);
        else { if (h === '{') d++; else if (h === '}') d--; i++; }
      }
      continue;
    }
    i++;
  }
  return i;
}

/** Top-level `key:` names of the object literal opening at src[openIdx] === '{'. */
function topLevelObjectKeys(src: string, openIdx: number): string[] {
  const keys: string[] = [];
  let i = openIdx + 1;
  let depth = 1;
  let expectKey = true; // true right after '{' or a depth-1 ','
  while (i < src.length && depth > 0) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { const nl = src.indexOf('\n', i); i = nl === -1 ? src.length : nl; continue; }
    if (c === '/' && src[i + 1] === '*') { const end = src.indexOf('*/', i); i = end === -1 ? src.length : end + 2; continue; }
    if (c === "'" || c === '"') { i = skipString(src, i); continue; }
    if (c === '`') { i = skipTemplate(src, i); continue; }
    if (c === '{') { depth++; i++; continue; }
    if (c === '}') { depth--; i++; expectKey = false; continue; }
    if (depth === 1) {
      if (c === ',') { expectKey = true; i++; continue; }
      if (expectKey && c !== undefined && /[A-Za-z_$]/.test(c)) {
        let j = i + 1;
        while (j < src.length && /[\w$]/.test(src[j] ?? '')) j++;
        let k = j;
        while (k < src.length && /\s/.test(src[k] ?? '')) k++;
        if (src[k] === ':') keys.push(src.slice(i, j));
        expectKey = false;
        i = j;
        continue;
      }
    }
    i++;
  }
  return keys;
}

test('R4: components-data.ts specimen live-keys ≡ components.ts LIVE renderer keys', () => {
  const dataFile = TS.find(f => f.rel === 'views/components-data.ts');
  const viewFile = TS.find(f => f.rel === 'views/components.ts');
  assert.ok(dataFile, 'views/components-data.ts not found — did the contract move?');
  assert.ok(viewFile, 'views/components.ts not found — did the contract move?');

  const specimenKeys = new Set<string>();
  for (const m of dataFile.text.matchAll(/\blive:\s*["']([$\w]+)["']/g)) specimenKeys.add(m[1] ?? '');

  const open = /const LIVE\b[\s\S]*?=\s*\{/.exec(viewFile.text);
  assert.ok(open, "couldn't locate `const LIVE … = {` in views/components.ts — update this parser alongside the map");
  const liveKeys = new Set(topLevelObjectKeys(viewFile.text, open.index + open[0].length - 1));

  // Floor so a rotted regex can't pass on empty == empty (27 = 27 at authoring time).
  assert.ok(specimenKeys.size >= 20, `only ${specimenKeys.size} live: specimen keys parsed — the live: regex has rotted`);
  assert.ok(liveKeys.size >= 20, `only ${liveKeys.size} LIVE map keys parsed — the object-key parser has rotted`);

  const onlyData = [...specimenKeys].filter(k => !liveKeys.has(k)).sort();
  const onlyLive = [...liveKeys].filter(k => !specimenKeys.has(k)).sort();
  const problems: string[] = [];
  if (onlyData.length) problems.push(`specimens reference LIVE renderers that don't exist (stage falls back to source view): ${onlyData.join(', ')} — add renderers to views/components.ts's LIVE map or fix the key.`);
  if (onlyLive.length) problems.push(`LIVE renderers with no specimen (unreachable in #/components): ${onlyLive.join(', ')} — add a components-data.ts entry with live: "<key>".`);
  assert.equal(problems.length, 0, `\n${problems.join('\n')}\n`);
});

// ── R5 (rec 9 — one NAV_EVENTS) ──────────────────────────────────────────────
// The hashchange/popstate/lolly:navigate triple lives once, in utils.ts. Rec 9
// deleted the redeclarations in lang-menu/profile-menu; importing is fine anywhere.

test('R5 (rec 9): NAV_EVENTS is declared only in utils.ts', () => {
  const found = new Map<string, number[]>();
  for (const f of TS) {
    const lines = hitLines(f.text, /\bNAV_EVENTS\s*=(?!=)/);
    if (lines.length) found.set(f.rel, lines);
  }
  checkRatchet(found, { 'utils.ts': 1 /* the one home */ },
    "Don't redeclare the nav-event triple — import { NAV_EVENTS } from utils.ts.");
});

// ── R6 (recs 1/4/13 — deleted names stay dead) ───────────────────────────────
// Classes the audit deleted or renamed must never come back as live selectors or
// markup. Prose is fine (CSS comments are stripped; TS matching is scoped to
// class-usage positions — class="…", classList.*, querySelector/closest/matches
// selector strings, className assignment — so components-data.ts's rename notes
// and storage.css's tombstone comments don't trip it).

const DEAD_NAMES: Record<string, string> = {
  'segmented-control': 'deleted by rec 1 — build segmented controls with segHtml() / .view-seg (lib/seg.ts)',
  'projects-toast': 'renamed by rec 13 — use .pro-toast with a positioning modifier (--bar or --top)',
  'clear-dialog-overlay': 'deleted by rec 4 — the clear/hoard/import gates are native <dialog class="clear-dialog"> on mountModal, no overlay wrapper',
  'userimg-lightbox-overlay': 'deleted by rec 4 — the lightbox is a native <dialog class="userimg-lightbox"> on mountModal, no overlay wrapper',
};

function deadNameTsPatterns(name: string): RegExp[] {
  return [
    new RegExp(`class\\s*=\\s*["'][^"'\\n]*(?<![\\w-])${name}(?![\\w-])`),                    // class="… name …" in markup
    new RegExp(`classList\\.(?:add|remove|toggle|contains|replace)\\([^)]*["'\`]${name}["'\`]`), // classList ops
    new RegExp(`(?:querySelector(?:All)?|closest|matches)\\(\\s*["'\`][^"'\`\\n]*\\.${name}(?![\\w-])`), // selector strings
    new RegExp(`className\\s*\\+?=[^;\\n]*(?<![\\w-])${name}(?![\\w-])`),                     // className assignment
  ];
}

test('R6 (recs 1/4/13): deleted class names stay dead in selectors and markup', () => {
  const problems: string[] = [];
  for (const [name, why] of Object.entries(DEAD_NAMES)) {
    const cssRe = new RegExp(`\\.${name}(?![\\w-])`);
    for (const f of CSS) {
      for (const line of hitLines(stripCssComments(f.text), cssRe)) {
        problems.push(`${f.rel}:${line} — .${name} selector resurrected; ${why}.`);
      }
    }
    for (const f of TS) {
      for (const re of deadNameTsPatterns(name)) {
        for (const line of hitLines(f.text, re)) {
          problems.push(`${f.rel}:${line} — "${name}" used as a live class; ${why}.`);
        }
      }
    }
  }
  assert.equal(problems.length, 0, `\n${problems.join('\n')}\n`);
});
