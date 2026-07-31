// SPDX-License-Identifier: MPL-2.0
/**
 * Contract guard: the Share link must carry what the address bar carries.
 *
 * `syncUrl` writes the live export settings into the address bar; `buildShareParams`
 * builds the copied link. They are two independent readers of the same DOM controls,
 * and they had silently drifted: the Share button dropped `hdr`, `imprint=0`,
 * `durable`, `nostage` and every `group:"export"` input while the URL bar was
 * displaying exactly those settings to the user. Someone copying a link got a
 * different file than the one they were looking at, with no indication anything
 * had been lost.
 *
 * A unit test is impractical here — `buildShareParams` is private to a 3k-line
 * DOM-coupled view — so this scans the real source, in the house style of
 * `a11y-prefs-contract.test.ts` (which scans real stylesheets) and
 * `docs-shots-vector.test.ts` (which scans real recipes). It cannot prove the two
 * agree at RUNTIME; it proves neither one grew a parameter the other never heard
 * of, which is the drift that actually happened.
 *
 * When you add an export setting: write it in BOTH places, or add it to
 * SHARE_EXEMPT below with a reason. An exemption is a deliberate product decision
 * ("this must not travel in a link"), never a shortcut.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL_TS = readFileSync(join(HERE, 'tool.ts'), 'utf8');

/**
 * Params the address bar writes but a shared link deliberately must NOT carry.
 * Each needs a reason. Empty today: everything syncUrl writes is shareable, and
 * `password` is intentionally shared (a standard-tier PDF lock travels with the
 * link by design — documented at its call site).
 */
const SHARE_EXEMPT: Record<string, string> = {};

/** The params `syncUrl` writes to the address bar. */
function syncUrlParams(): Set<string> {
  // `dirtyParams.has('x')` gates every branch that writes a param, so it is the
  // most reliable enumeration of what syncUrl can emit.
  const found = [...TOOL_TS.matchAll(/dirtyParams\.has\('([a-z_]+)'\)/g)].map(m => m[1]!);
  return new Set(found);
}

/** The params `buildShareParams` pushes onto the copied link. */
function shareParams(): Set<string> {
  const start = TOOL_TS.indexOf('function buildShareParams(');
  assert.ok(start > 0, 'buildShareParams not found — this guard needs updating');
  // The function ends at the next top-level `\n}` after its start.
  const end = TOOL_TS.indexOf('\n}', start);
  assert.ok(end > start, 'could not find the end of buildShareParams');
  const body = TOOL_TS.slice(start, end);
  const out = new Set<string>();
  // Both encodings used in the body: `parts.push(\`name=...\`)` and the bare
  // presence flag `parts.push('name')` / `parts.push('name=0')`.
  for (const m of body.matchAll(/parts\.push\(`([a-z_]+)=/g)) out.add(m[1]!);
  for (const m of body.matchAll(/parts\.push\('([a-z_]+)(?:=[^']*)?'\)/g)) out.add(m[1]!);
  return out;
}

test('every export setting the address bar writes is also carried by the Share link', () => {
  const bar = syncUrlParams();
  const share = shareParams();
  assert.ok(bar.size >= 10, `expected syncUrl to write many params, found ${bar.size} — the scan probably broke`);

  const missing = [...bar].filter(p => !share.has(p) && !(p in SHARE_EXEMPT)).sort();
  assert.deepEqual(missing, [], `Share link drops ${missing.join(', ')} — settings the address bar shows the user. `
    + 'Add them to buildShareParams, or list them in SHARE_EXEMPT with a reason.');
});

test('the Share link does not invent params the address bar never writes', () => {
  const bar = syncUrlParams();
  const share = shareParams();
  // The reverse direction: a param only the share link knows about is just as much
  // a drift, and means the address bar is the one under-reporting.
  const extra = [...share].filter(p => !bar.has(p)).sort();
  assert.deepEqual(extra, [], `Share link carries ${extra.join(', ')} which syncUrl never writes — `
    + 'the address bar is under-reporting, or the share builder is guessing.');
});

test('group:"export" inputs are not excluded from the Share link', () => {
  const start = TOOL_TS.indexOf('function buildShareParams(');
  const end = TOOL_TS.indexOf('\n}', start);
  const body = TOOL_TS.slice(start, end);
  // The original bug in one line: `if (group === 'export') continue;` skipped every
  // declared export-group input (transparentBg, convertPaths, a tool's own plate or
  // finish switches) even though syncUrl's input loop writes them.
  assert.ok(
    !/if\s*\(\s*group\s*===\s*'export'\s*\)\s*continue/.test(body),
    'buildShareParams skips group:"export" inputs again — those are ordinary declared '
    + 'model values that the address bar writes, so skipping them silently drops settings.',
  );
});

test('each toggle the Share link reads is guarded on the control existing', () => {
  const start = TOOL_TS.indexOf('function buildShareParams(');
  const end = TOOL_TS.indexOf('\n}', start);
  const body = TOOL_TS.slice(start, end);
  // The per-format toggles are rendered only for formats that support them. Reading
  // `.checked` off a missing control yields undefined, which for an ON-BY-DEFAULT
  // setting like imprint looks like a deliberate opt-out — and would stamp
  // `imprint=0` onto every link from a format that has no imprint at all.
  assert.match(body, /const imprintEl = [^;]+;\s*\n\s*if \(imprintEl && !imprintEl\.checked\)/,
    'the imprint opt-out must check the control EXISTS before treating it as unchecked');
});
