// SPDX-License-Identifier: MPL-2.0
/**
 * THE TEMPLATE CHOOSER IS NOT IN THE MOUNT PATH.
 *
 * A tool that ships `templates/` (today: Design, four of them) used to open like
 * this: `views/tool.ts` awaited `openTemplateChooser`, and `createRuntime` — the whole
 * mount — could not begin until a human clicked a tile. In that same window the chooser
 * eagerly rendered a live preview per template, each one a real off-screen tool mount +
 * walker export. Measured on a cache-cold first open: ~1 s per template, 3972 / 3999 /
 * 4355 ms for the four, main-thread, before the editor had drawn a single pixel. Layout
 * Studio and Sequence Studio are within noise of each other at every engine phase; this
 * was the difference a user could feel.
 *
 * The fix is structural, so the guard is structural: the chooser is STARTED where it
 * always was (the modal appears just as early) but never awaited, and the pick lands
 * afterwards as an `applyPatch` seed on the already-mounted runtime. Three properties
 * have to hold together, and any one of them regressing silently restores the stall:
 *
 *   1. nothing awaits the chooser before `createRuntime`;
 *   2. the chooser is still started BEFORE it, or the modal arrives late instead;
 *   3. the pick is applied through `applyPatch`, not `setInput` — `setInput` is
 *      mountTool's undo-history wrapper (and collab's op wrapper), so seeding through it
 *      would make ⌘Z erase the template the user just chose.
 *
 * WHY A SOURCE SCAN: `mountTool` cannot be imported outside Vite — it imports
 * stylesheets and reaches `tool-inputs.ts`, whose sibling imports use the `.js` specifier
 * convention Node cannot resolve. `views/tool-collab-mount.test.ts`, `views/block-row-id
 * .test.ts` and `views/multi-edit-crash-guard.test.ts` all scan for the same reason; this
 * file follows them. The chooser's own runtime behaviour is covered by
 * `views/template-chooser.test.ts`.
 *
 * Run directly:  node --test shells/web/src/views/tool-template-mount.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Source with comments removed, so "is this awaited?" cannot be answered by prose that
 * merely says it isn't. Line comments are cut at a `//` that is not part of a `://`
 * scheme; block comments are dropped wholesale. (Same helper, same reasoning, as
 * views/tool-collab-mount.test.ts — duplicated rather than exported, so neither file's
 * guard can be weakened by an edit made for the other.)
 */
function stripComments(src: string): string {
  const noBlocks = src.replace(/\/\*[\s\S]*?\*\//g, '');
  return noBlocks
    .split('\n')
    .map((line) => {
      const at = line.search(/(^|[^:])\/\//);
      return at === -1 ? line : line.slice(0, at === 0 ? 0 : at + 1);
    })
    .join('\n');
}

/** The `{ … }` body that follows `head`, extracted by brace matching. */
function bodyAfter(src: string, head: string): string {
  const at = src.indexOf(head);
  assert.notEqual(at, -1, `expected to find \`${head}\` in tool.ts`);
  const open = src.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  assert.fail(`unbalanced braces while extracting \`${head}\``);
}

const CODE = stripComments(readFileSync(join(HERE, 'tool.ts'), 'utf8'));
const CHOOSER = stripComments(readFileSync(join(HERE, 'template-chooser.ts'), 'utf8'));

test('nothing awaits the template chooser — the mount is never gated on a human click', () => {
  assert.match(CODE, /openTemplateChooser\s*\(/, 'the chooser is still opened from mountTool');
  assert.ok(
    !/\bawait\s+openTemplateChooser\s*\(/.test(CODE),
    'the chooser is never awaited — anywhere, handle included. Awaiting it puts ' +
      'createRuntime behind a human click, which IS the open delay this guards',
  );
  assert.ok(
    !/\bawait\s+templatePick\b/.test(CODE),
    'awaiting the pick promise anywhere in the mount is the same stall by another name',
  );
  assert.ok(
    !/\bawait\s*\(\s*async/.test(CODE),
    'the chooser IIFE must stay un-awaited (its lazy import + CSS chunk are on it)',
  );
});

test('the chooser is still STARTED before the mount, and only APPLIED after it', () => {
  const start = CODE.indexOf('templatePick = (async');
  const create = CODE.indexOf('await createRuntime(');
  const apply = CODE.indexOf('if (templatePick) {');
  assert.notEqual(start, -1, 'the chooser is started via a `templatePick = (async …)()` handle');
  assert.notEqual(create, -1, 'mountTool still awaits createRuntime');
  assert.notEqual(apply, -1, 'the pick is applied from a `if (templatePick)` block');
  assert.ok(start < create, 'the modal must open BEFORE the mount work, or it arrives late');
  assert.ok(create < apply, 'the seed can only be applied once the runtime exists');
});

test('the pick is seeded with applyPatch — no undo step, no collab echo, one render', () => {
  const block = bodyAfter(CODE, 'if (templatePick) {');
  assert.match(block, /runtime\.applyPatch\(/, 'the seed goes through the engine atomic apply');
  assert.match(block, /migrateBlockRowIds\(runtime\)/,
    'rows arriving after the mount-time migration still need their stable ids');
  assert.ok(
    !/setInput/.test(block),
    'setInput is the undo-history wrapper — seeding through it makes ⌘Z erase the template',
  );
  // Precedence must match the pre-mount merge it replaced (`{...chosen, ...initialValues}`):
  // a key the URL/profile already supplied wins, so it never reaches the patch.
  assert.match(block, /!\(k in initialValues\)/,
    'a profile/URL-supplied key must still win over the template, as it did pre-mount');
});

test('the deterministic `?template=` seed stays awaited — export remounts depend on it', () => {
  // No human in the loop there: an off-screen scene/export remount re-parses the URL and
  // must have the values in the model before the first hydrate, or it renders blank.
  assert.match(CODE, /await\s+fetchTemplateValues\(/,
    '?template= must remain a pre-createRuntime seed, unlike the chooser');
  const named = CODE.indexOf('await fetchTemplateValues(');
  assert.ok(named < CODE.indexOf('await createRuntime('), '…and it must resolve before the mount');
});

test('the chooser yields the main thread around every preview render', () => {
  // Each tile preview is a real off-screen mount + walker export (~1 s). With the tool now
  // mounting UNDERNEATH the modal, running them back-to-back would starve exactly the paint
  // this change exists to let through, and hold a tile click behind the whole queue.
  assert.match(CHOOSER, /function whenIdle\(/, 'the yield helper exists');
  const drain = bodyAfter(CHOOSER, 'const drain = async ()');
  assert.match(drain, /await whenIdle\(\)[\s\S]*await import\('\.\.\/lib\/featured-render\.ts'\)/,
    'yield BEFORE the render-engine chunk is even requested');
  assert.equal((drain.match(/await whenIdle\(\)/g) ?? []).length, 2,
    'exactly two yields: once before the chunk, once between renders');
});

// ── Navigate-away guard ──────────────────────────────────────────────────────
// The chooser is un-awaited and outlives nothing else in this mount, so leaving the
// tool before a tile is picked must not (a) leave the modal floating over whatever view
// loads next, or (b) let a late resolution (Escape armed by the close below, or a tile
// click already in flight) run `applyPatch`/`migrateBlockRowIds` against a runtime
// `_cleanup` already tore down. Same shape as the collab `aborted` latch pinned by
// `tool-collab-mount.test.ts`'s "a navigation DURING the import cannot leak a live
// transport" — a holder armed before the awaits it needs to survive, checked on both
// sides of the one await (`applyPatch`) a navigation can straddle.

test('a navigate-away before the pick lands cannot patch a torn-down runtime', () => {
  assert.match(CODE, /let templatePickTornDown = false;/,
    'the latch — set once by _cleanup, read by both the open path and the pick handler');
  assert.match(CODE, /let templatePickClose: \(\(\) => void\) \| null = null;/,
    'the modal-close handle, armed once the chooser actually opens (onOpen, below)');

  // Opening: a navigate-away while the chunk was still loading must not open the modal
  // at all (nothing would ever call the close it would hand back); one that lands after
  // the modal exists is closed immediately instead of stored, so it can never point at a
  // reference nobody will call.
  const openCall = bodyAfter(CODE, 'templatePick = (async () => {');
  assert.match(openCall, /if \(templatePickTornDown\) return \{\};/,
    'a navigate-away during the chunk load must skip opening the chooser entirely');
  assert.match(
    openCall,
    /onOpen: close => \{ if \(templatePickTornDown\) close\(\); else templatePickClose = close; \}/,
    'the close handle is armed onto the holder — or fired immediately if teardown already landed',
  );

  // Applying: the SAME latch is checked before the patch (skips it outright) and again
  // after (skips the row-id re-stamp) — `applyPatch` is the one await a navigation can
  // land in the middle of.
  const pickBlock = bodyAfter(CODE, 'if (templatePick) {');
  const applyAt = pickBlock.indexOf('runtime.applyPatch(');
  assert.notEqual(applyAt, -1);
  assert.match(pickBlock.slice(0, applyAt), /if \(templatePickTornDown\) return;/,
    'must not seed a patch onto a runtime this mount already tore down');
  assert.match(pickBlock.slice(applyAt), /if \(templatePickTornDown\) return;/,
    'must not re-stamp row ids if a navigation landed while applyPatch was in flight');

  // Tearing down: _cleanup is what makes the latch true and takes the modal, which lives
  // outside viewEl's own subtree (template-chooser.ts appends to document.body), down
  // with the view — nothing else here would otherwise touch it.
  const cleanup = bodyAfter(CODE, 'viewEl._cleanup = () => {');
  assert.match(cleanup, /templatePickTornDown = true;/);
  assert.match(cleanup, /templatePickClose\?\.\(\); templatePickClose = null;/);
});

test('the chooser hands back a working close only once the modal is real', () => {
  // onOpen must fire after `finish` is defined (the close it hands back closes over it)
  // — a close handle that could throw or close nothing would defeat the whole guard.
  const finishAt = CHOOSER.indexOf('const finish = (values');
  const onOpenAt = CHOOSER.indexOf('opts.onOpen?.(');
  assert.notEqual(finishAt, -1);
  assert.notEqual(onOpenAt, -1);
  assert.ok(finishAt < onOpenAt, 'onOpen must fire after `finish` exists, since it closes over it');
  assert.match(CHOOSER, /opts\.onOpen\?\.\(\(\) => finish\(\{\}\)\);/,
    'closing resolves blank — identical to Escape / backdrop / ×, and idempotent (settled guard)');
});
