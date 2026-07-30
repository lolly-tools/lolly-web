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
};
const SHOW_MODAL_ALLOWED: Record<string, number> = {
  'components/modal.ts': 1,  // the primitive itself
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
  'components/music-player.ts': 6,   // play/pause now come from lib/icons.ts (2026-07-29)
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
  'views/catalog.ts': 21,   // 22 → 21: AUDIO_GLYPH retired for lib/audio-thumb.ts (2026-07-28)
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

// ── R7: the component library describes the shell that actually exists ───────
// #/components is HAND-MAINTAINED specimen data (views/components-data.ts), so
// nothing stops it drifting from the code it documents — and it had: five
// selectors named classes deleted in the audit's own rec 13, and 65 of 70
// `defined:` file:line anchors pointed at unrelated lines after the code moved
// under them. The line numbers are gone (a path plus the symbol in the specimen
// name survives refactors; a line number does not). These two rules keep the
// remaining claims honest:
//
//   · every `defined:` path resolves to a real file
//   · every class named in a `css:` list is still live somewhere in the shell
//
// Both are absolute, not ratchets: unlike the primitive rules above there's no
// surveyed backlog to grandfather — a specimen pointing at something that isn't
// there is simply wrong, and cheap to fix the moment it happens.

/** Specimen file paths are written repo-relative ("shells/web/src/lib/seg.ts"),
 *  sometimes as an "a.ts / b.ts" pair whose tail is bare ("lib/seg.ts"), and may
 *  carry a trailing "(symbolName)" note. Reduce one token to a src-relative path. */
function specimenPathCandidates(token: string): string[] {
  const bare = token.replace(/\s*\(.*$/, '').trim();
  if (!bare) return [];
  const stripped = bare.replace(/^shells\/web\/src\//, '');
  // A tail like "lib/seg.ts" is already src-relative; one like "platform.css"
  // continues its partner's directory, so try the known component dirs too.
  return [stripped, ...['lib', 'views', 'components', 'styles/parts', 'pro'].map(d => `${d}/${stripped}`)];
}

test('R7: components-data.ts `defined:` paths point at files that exist', () => {
  const data = ALL.find(f => f.rel === 'views/components-data.ts');
  assert.ok(data, 'views/components-data.ts not found — did the specimen data move?');
  const known = new Set(ALL.map(f => f.rel));

  const problems: string[] = [];
  let checked = 0;
  for (const m of data.text.matchAll(/\{ name: "((?:[^"\\]|\\.)*)"[^\n]*?defined: "([^"]*)"/g)) {
    for (const token of (m[2] ?? '').split('/ ')) {
      const cands = specimenPathCandidates(token);
      if (!cands.length) continue;
      checked++;
      if (!cands.some(c => known.has(c))) {
        problems.push(`"${m[1]}" → defined: "${token.trim()}" doesn't exist. Point it at the file that owns the component now, or drop the specimen if the component is gone.`);
      }
    }
  }
  // Floor so a rotted regex can't pass on nothing-checked (74 at authoring time).
  assert.ok(checked >= 60, `only ${checked} defined: paths parsed — the specimen regex has rotted`);
  assert.equal(problems.length, 0, `\n${problems.join('\n')}\n`);
});

test('R7: components-data.ts `css:` selectors name classes that are still live', () => {
  const data = ALL.find(f => f.rel === 'views/components-data.ts');
  assert.ok(data, 'views/components-data.ts not found — did the specimen data move?');
  // The haystack is the whole shell EXCEPT the specimen file: a class that only
  // this file still mentions is precisely the dead one we're hunting.
  const haystack = ALL.filter(f => f.rel !== 'views/components-data.ts').map(f => f.text).join('\n');

  const problems: string[] = [];
  let checked = 0;
  for (const m of data.text.matchAll(/\{ name: "((?:[^"\\]|\\.)*)"[^\n]*?css: "([^"]*)"/g)) {
    for (const cls of new Set((m[2] ?? '').match(/\.[a-zA-Z][\w-]*/g)?.map(c => c.slice(1)) ?? [])) {
      checked++;
      // Bounded on both sides so `.cat-stat` can't be satisfied by `.cat-stat-tile`.
      if (!new RegExp(`[.'"\`\\s]${cls}(?![\\w-])`).test(haystack)) {
        problems.push(`"${m[1]}" → css: ".${cls}" matches nothing in the shell. Update the selector list to the class that replaced it (or delete the specimen if the component is gone).`);
      }
    }
  }
  assert.ok(checked >= 200, `only ${checked} css: classes parsed — the specimen regex has rotted`);
  assert.equal(problems.length, 0, `\n${problems.join('\n')}\n`);
});

// ── R8: specimen form controls carry a class ─────────────────────────────────
// The #/components stage is a bare `.cl-stage` div. A control whose real styling
// hangs off an ancestor the stage doesn't reproduce — `.tool-actions select`,
// say — renders there as raw UA chrome, so the library shows a square, native
// widget next to a description of the drawn one. That is the exact drift this
// page exists to catch, and it is invisible to R7 (which only asks whether the
// classes in `css:` are still live somewhere).
//
// Rule: every form control in a `markup:` specimen names a class. The allowlist
// is for controls deliberately styled by an ancestor selector INSIDE their own
// specimen markup — those are honest, but only while the sheet that declares the
// ancestor rule is imported by views/components.ts, so each entry records which.
test('R8: form controls in components-data specimens are styled, not raw UA chrome', () => {
  const data = ALL.find(f => f.rel === 'views/components-data.ts');
  assert.ok(data, 'views/components-data.ts not found — did the specimen data move?');

  // Controls styled by an ancestor rule in their own specimen markup.
  // key → number of class-less occurrences permitted.
  const ANCESTOR_STYLED: Record<string, number> = {
    // `.input-row input` — parts/tool.css, imported by views/components.ts
    'input type="text" data-input-id="headline" value="Hello"': 1,
    // `.export-dims input[type="number"]` — parts/tool-chrome.css, ditto
    'input type="number" data-action="export-width" data-scrub value="800"': 1,
  };

  const actual = new Map<string, number[]>();
  const problems: string[] = [];
  let checked = 0;

  for (const m of data.text.matchAll(/markup: `([^`]*)`/g)) {
    const markup = m[1] ?? '';
    const at = lineOf(data.text, m.index ?? 0);
    for (const tag of markup.match(/<(?:select|textarea|input)\b[^>]*>/g) ?? []) {
      checked++;
      if (/\bclass=/.test(tag)) continue;
      const key = tag.replace(/^</, '').replace(/\s*\/?>$/, '').replace(/\s+/g, ' ');
      const bucket = actual.get(key) ?? [];
      bucket.push(at);
      actual.set(key, bucket);
      if (!(key in ANCESTOR_STYLED)) {
        problems.push(
          `views/components-data.ts:${at} — specimen control <${key}> has no class, so it renders as raw UA chrome on the .cl-stage checkerboard. ` +
          `Give it the shared primitive (.field-input / .field-select / .field-check / .field-radio / .field-range), or add it to R8's ANCESTOR_STYLED allowlist naming the sheet that styles it.`,
        );
      }
    }
  }

  assert.ok(checked >= 20, `only ${checked} specimen form controls parsed — the R8 regex has rotted`);
  assert.equal(problems.length, 0, `\n${problems.join('\n')}\n`);
  checkRatchet(actual, ANCESTOR_STYLED, 'Style it with the shared field primitive instead.');
});

// ── R9: every icon glyph is well-formed markup ───────────────────────────────
// lib/icons.ts holds glyph bodies as raw markup STRINGS, so a missing `"/>` is
// not a syntax error in TypeScript — it is a broken attribute that Chromium's
// HTML parser silently recovers from by swallowing the following markup into the
// attribute value. The glyph then does not draw, and anything that RE-SERIALISES
// that DOM (the HTML-to-SVG export walker does, via XMLSerializer) emits invalid
// XML: an attribute whose value contains `</svg><span class=`. That produced a
// 1.1 MB unparseable file with no thrown error and no warning.
//
// `zap` shipped like that. This is the cheap structural check that would have
// caught it: balanced quotes, and one close for every open tag.
test('R9: lib/icons.ts glyph bodies are well-formed (balanced quotes and tags)', () => {
  const f = ALL.find((x) => x.rel === 'lib/icons.ts');
  assert.ok(f, 'lib/icons.ts not found — did the icon registry move?');

  const problems: string[] = [];
  const seen = new Set<string>();
  let scanned = 0;
  // Every shape the registry uses, and both quote styles:
  //   `name: '<path …/>'`            — a PATHS entry
  //   `const SHARED = '<path …/>'`   — a fragment several entries splice in
  //   `name: \`${SHARED}<path …/>\`` — an entry BUILT from one
  //   `name: SHARED`                 — an entry that IS one, verbatim
  // Single-quote-literals-only was the rot: `zoomIn`/`zoomOut` are template literals,
  // `MAGNIFIER` is a bare const and `search` became an alias of it, so four glyphs —
  // one of which used to be covered — fell out of the guard the day they landed.
  // An interpolation is scanned as opaque text; the const it names is scanned on its
  // own line, so nothing goes unchecked.
  const bodies: Array<[string, string, number]> = [];
  const consts = new Map<string, [string, number]>();
  for (const m of f.text.matchAll(/^\s*(?:const\s+)?'?([\w-]+)'?\s*[:=]\s*(['`])((?:[^'`\\]|\\.)*)\2[,;]?\s*$/gm)) {
    bodies.push([m[1]!, m[3]!, m.index ?? 0]);
    if (/^\s*const\s/.test(m[0]!)) consts.set(m[1]!, [m[3]!, m.index ?? 0]);
  }
  for (const m of f.text.matchAll(/^\s*'?([\w-]+)'?\s*:\s*([A-Z][A-Z0-9_]*)\s*,\s*$/gm)) {
    const src = consts.get(m[2]!);
    if (src) bodies.push([m[1]!, src[0], m.index ?? 0]);
  }
  for (const [name, body, index] of bodies) {
    const m = { index };
    if (!body || !body.includes('<')) continue;
    scanned++;
    if (name) seen.add(name);
    const at = lineOf(f.text, m.index ?? 0);
    const quotes = (body.match(/"/g) ?? []).length;
    const opens = (body.match(/<[a-zA-Z]/g) ?? []).length;
    const closes = (body.match(/\/>|<\//g) ?? []).length;
    if (quotes % 2 !== 0) {
      problems.push(`lib/icons.ts:${at} — glyph "${name}" has ${quotes} double quotes (odd, so an attribute is unterminated).`);
    }
    if (opens !== closes) {
      problems.push(`lib/icons.ts:${at} — glyph "${name}" opens ${opens} element(s) but closes ${closes}. Every tag needs \`/>\` or a closing tag.`);
    }
  }

  // Named explicitly, because these four are the ones the old regex silently dropped —
  // if a future refactor takes them back out of range the count floor alone would not say so.
  for (const must of ['MAGNIFIER', 'zoomIn', 'zoomOut', 'search']) {
    assert.ok(seen.has(must), `R9 no longer scans "${must}" — the glyph regex has rotted again.`);
  }
  assert.ok(scanned >= 60, `only ${scanned} markup glyphs parsed — the R9 regex has rotted`);
  assert.equal(problems.length, 0, `\n${problems.join('\n')}\n`);
});

// ── R10 (raw-HTML sinks) ──────────────────────────────────────────────────────
// maintainability-2026-07-29.md item 3: ~461 innerHTML sites following the
// `escape()` discipline by convention, with nothing pinning it. This is that pin.
//
// WHY A COUNT RATCHET AND NOT A CONTENT RULE. The obvious rule — "every ${…} in a
// raw-HTML template must be escaped" — was measured against the tree first: 508
// interpolations, 134 already wrapped in escape(), and of the remaining 374 the
// overwhelming majority are `t('a literal')`, a nested ternary of literals, a
// CONSTANT, or an `xHtml(…)`/`.map(…).join('')` helper that returns composed
// markup. A rule flagging those would be ~374 false positives on day one and
// would be deleted within a week. So the guard pins the INVENTORY instead: a new
// raw-HTML sink cannot appear without a deliberate allowlist bump, which is the
// moment a reviewer looks at whether its interpolations are escaped.
//
// Empty clears (`el.innerHTML = ''`) are excluded — they are teardown and cannot
// inject. Changing one into a real assignment moves it INTO the count, so the
// exclusion cannot be used to smuggle a sink past the ratchet.
//
// Counts are exact in both directions (see checkRatchet), so deleting a sink is
// an attrition win that must be recorded, and the ledger cannot rot.

// The `\s*` belongs INSIDE the empty-clear lookahead, not before it: as
// `\s*(?!…)` the star backtracks to zero-width, the lookahead then sees a space
// instead of the quote, and `el.innerHTML = ''` counts as a sink. That bug was in
// the first draft of this rule and was caught by the attrition mutation test.
const RAW_HTML_SINK = /\.(?:inner|outer)HTML\s*\+?=(?!=)(?!\s*['"]\s*['"]\s*[;,)])|\binsertAdjacentHTML\s*\(/;

const RAW_HTML_ALLOWED: Record<string, number> = {
  'bridge/clipboard.ts': 2,
  'bridge/embed.ts': 1,
  'components/color-field.ts': 5,
  'components/custom-slider.ts': 1,
  'components/featured-row.ts': 2,
  'components/fonts-manager.ts': 3,
  'components/headshot-cropper.ts': 1,
  'components/instance-sheet.ts': 1,
  'components/lang-menu.ts': 2,
  'components/modal.ts': 1,
  'components/music-player.ts': 5,
  'components/neuro-dock.ts': 1,
  'components/profile-menu.ts': 1,
  'components/profiles-manager.ts': 3,
  'components/progress-toast.ts': 2,
  'components/sound-toggle.ts': 2,
  'components/theme-toggle.ts': 1,
  'components/view-toggle.ts': 1,
  'components/viz-overlay.ts': 5,
  'components/welcome-dialog.ts': 2,
  'components/zoom-hud.ts': 1,
  'folder-overlay.ts': 3,
  'lib/audio-coaching.ts': 1,
  'lib/audio-transport.ts': 2,
  'lib/brand-editor.ts': 22,
  'lib/brand-studio-tabs.ts': 9,
  'lib/catalog-summary.ts': 2,
  'lib/float-panel.ts': 2,
  'lib/gamut-slider.ts': 1,
  'lib/page-filmstrip.ts': 1,
  'lib/recent-stack.ts': 1,
  'lib/recording-tips.ts': 2,
  'lib/upload-dropzone.ts': 3,
  'org/approval-dialog.ts': 3,
  'org/banner.ts': 1,
  'org/index.ts': 1,
  'org/share-links.ts': 4,
  'pro/blocks-editor.ts': 4,
  'pro/folder-export.ts': 2,
  'pro/index.ts': 9,
  'pro/render-export.ts': 1,
  'pro/run-overlay.ts': 7,
  'views/catalog.ts': 8,
  'views/color-lab.ts': 18,
  'views/components-data.ts': 1,
  'views/components.ts': 7,
  'views/dashboard.ts': 11,
  'views/deck-editor.ts': 9,
  'views/doc-editor.ts': 1,
  'views/free-canvas.ts': 40,
  'views/gallery.ts': 6,
  'views/multi-edit.ts': 3,
  'views/pdf-extract.ts': 4,
  'views/pdf-import.ts': 1,
  'views/picker.ts': 27,
  'views/profile.ts': 19,
  'views/projects.ts': 10,
  'views/record-control.ts': 6,
  'views/screen-capture-control.ts': 4,
  'views/start.ts': 7,
  'views/timeline-panel.ts': 4,
  'views/tool-actions.ts': 7,
  'views/tool-inputs.ts': 9,
  'views/tool.ts': 16,
  'views/valid.ts': 19,
};

test('R10: raw-HTML sinks are a pinned inventory, not a growing one', () => {
  const found = new Map<string, number[]>();
  for (const f of TS) {
    const hits = hitLines(f.text, RAW_HTML_SINK);
    if (hits.length) found.set(f.rel, hits);
  }
  // Non-vacuity: the regex must still find the tree it was written against.
  const total = [...found.values()].reduce((n, l) => n + l.length, 0);
  assert.ok(total > 300,
    `only ${total} raw-HTML sinks found — RAW_HTML_SINK has rotted and this guard is passing vacuously`);
  checkRatchet(found, RAW_HTML_ALLOWED,
    'A new raw-HTML sink needs review: every interpolated value must be escape()d ' +
    '(utils.ts) or provably safe markup. If it is right, bump this file\'s allowlist entry.');
});

// ── R11 (one escaping implementation) ────────────────────────────────────────
// The reason R10 can be a count ratchet rather than a content rule is that
// `escape` (utils.ts) is a single, correct implementation everyone reaches for.
// That only holds while nobody re-forks it — and forking it is not hypothetical:
// pro/index.ts carried its own `escapeHtml` whose character class was [&<>"],
// missing the SINGLE QUOTE that utils.ts escapes. Every one of its 19 call sites
// happened to sit in a double-quoted attribute, so it was not exploitable — but
// the next `data-x='${escapeHtml(v)}'` would have been. It was deleted on
// 2026-07-30 in favour of the shared escape, which that file already imported.

const ESCAPE_DEF = /\bfunction\s+escape(?:Html|Text|Attr)?\s*\(|\bconst\s+escape(?:Html|Text|Attr)?\s*=\s*\(/;

const ESCAPE_DEF_ALLOWED: Record<string, number> = {
  // The one shared implementation. Everything else must import this.
  'utils.ts': 1,
  // A deliberate zero-import primitive: float-panel.ts imports nothing but its
  // own CSS, so it inlines an escape that is character-for-character equivalent
  // to utils.ts's ([&<>"'] — the single quote included). Verified equivalent, not
  // assumed; if it ever diverges it becomes a fork and should import instead.
  'lib/float-panel.ts': 1,
  // A local alias that immediately DELEGATES to the shared escape
  // (`function escapeHtml(s) { return escape(s); }`), kept because the file's
  // 6.8k lines call it by that name. Not an independent implementation.
  'views/free-canvas.ts': 1,
};

test('R11: HTML escaping is implemented once (utils.ts escape), never re-forked', () => {
  const defs = new Map<string, number[]>();
  for (const f of TS) {
    const hits = hitLines(f.text, ESCAPE_DEF);
    if (hits.length) defs.set(f.rel, hits);
  }
  checkRatchet(defs, ESCAPE_DEF_ALLOWED,
    "Don't re-implement HTML escaping — `import { escape } from '<...>/utils.ts'`. " +
    'A hand-rolled one drifts: the pro/index.ts fork omitted the single quote and ' +
    "would have injected inside any single-quoted attribute.");
});

test('R11: the shared escape covers every character an attribute or text node needs', () => {
  // The ratchet above says "one implementation"; this says that one is correct.
  // & < > " ' — the omission that made the pro/index.ts fork dangerous was "'".
  const src = ALL.find(f => f.rel === 'utils.ts')?.text ?? '';
  assert.ok(src.includes('export function escape'), 'utils.ts no longer exports escape');
  for (const ch of ['&', '<', '>', '"', "'"]) {
    assert.ok(src.includes(`'${ch}'`) || src.includes(`"${ch}"`) || (ch === "'" && src.includes('"\'"')),
      `utils.ts escape does not mention ${ch} — an unescaped ${ch} breaks out of an attribute`);
  }
  assert.match(src, /&#39;|&apos;/, "escape must map the single quote to an entity (the pro/index.ts fork's omission)");
});
