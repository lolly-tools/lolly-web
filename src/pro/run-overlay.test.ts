// SPDX-License-Identifier: MPL-2.0
/**
 * The run overlay's ROW IDENTITY - the number it puts in front of a person.
 * Run directly:  node --test --import ./tests/css-stub.mjs shells/web/src/pro/run-overlay.test.ts
 *
 * `planBatch` compacts, so three index spaces exist for one row (see pro/manifest.ts).
 * The overlay is the only one of the three reports the user can act on WHILE the run is
 * happening, and it used to be the one that disagreed: it named a failed row by its
 * queue position ("2 of 4") while lolly.txt called the same row "row 3" and
 * preflight.json called it `{"row":3,"runIndex":1}`. These cases pin the overlay to the
 * SOURCE number - the same one `collectUnmade` produces - for both a failed row and a
 * skipped one.
 *
 * jsdom supplies the DOM. No catalog and no tool loader is wired, so every render fails,
 * which is exactly the path under test: the failure log line.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body><div id="mount"></div></body></html>', {
  url: 'http://localhost/#/pro',
});
globalThis.window = dom.window as unknown as typeof globalThis.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;

const { runBatchWithProgress, isBatchRunActive } = await import('./run-overlay.ts');
const { collectUnmade } = await import('./manifest.ts');

/** A grid of 5 rows where row 1 has no template: planBatch would yield these four. */
const rows = [
  { toolId: 'qr-code', values: {}, uid: 'r2' },
  { toolId: 'qr-code', values: {}, uid: 'r3' },
  { toolId: 'qr-code', values: {}, uid: 'r4' },
  { toolId: 'qr-code', values: {}, uid: 'r5' },
];
const SRC = [1, 2, 3, 4];   // planBatch's mapping back to the grid

const freshMount = (): HTMLElement => {
  const el = dom.window.document.getElementById('mount')!;
  el.innerHTML = '';
  return el as unknown as HTMLElement;
};

const host = { log: () => {}, export: { download: () => {} } } as never;

test('a failed row is logged by its SOURCE number, and the queue position is labelled', async () => {
  const mount = freshMount();
  const out = await runBatchWithProgress(host, rows, {
    mount, zipBaseName: 'batch', srcIndex: SRC,
  });
  const log = mount.querySelector('.pro-log')!.textContent!;

  // Runner index 1 is grid row 3 - the number the user counted to.
  assert.match(log, /✕ row 3 qr-code:/);
  // …and the queue position survives only as labelled context, never bare.
  assert.match(log, /\[queued 2\/4\]/);
  assert.doesNotMatch(log, /\(2 of 4\)/);

  // The same row, in the record that leaves the building. One number, three reports.
  const unmade = collectUnmade({ rows, srcIndex: SRC, results: out.results });
  assert.deepEqual(unmade.map(u => u.row), [2, 3, 4, 5]);
  assert.equal(unmade.find(u => u.runIndex === 1)!.row, 3);
});

test('a skipped row is listed by its source number and its label, never by a uid', async () => {
  const mount = freshMount();
  await runBatchWithProgress(host, rows, {
    mount, zipBaseName: 'batch', srcIndex: SRC,
    // What planBatch drops for a template-less grid row: no filename, no toolId, and a
    // uid that is a per-page-load counter.
    skipped: [{ reason: 'No template selected', row: { toolId: '', values: {}, uid: 'r7' }, srcIndex: 0, uid: 'r7' }],
  });
  const skipList = mount.querySelector('.pro-log-skiplist')!.textContent!;
  assert.match(skipList, /row 1 — \(no template\) — No template selected/);
  assert.doesNotMatch(skipList, /r7/);   // an internal id must never reach the UI
});

test('the run lock is released, and a second concurrent run is refused, not raced', async () => {
  assert.equal(isBatchRunActive(), false);   // released by the runs above
  const mount = freshMount();
  const first = runBatchWithProgress(host, rows, { mount, zipBaseName: 'batch', srcIndex: SRC });
  await assert.rejects(
    () => runBatchWithProgress(host, rows, { mount: freshMount(), zipBaseName: 'other' }),
    /already in progress/,
  );
  await first;
  assert.equal(isBatchRunActive(), false);
});
