// SPDX-License-Identifier: MPL-2.0
/**
 * SURFACE 3 (part 2) - the "Create a tool" card in the Save dialog. save-dialog.ts is pure
 * DOM + injected deps (its own header), so it is headless-testable: no host bridge, no
 * runtime, no store shapes. We stub the native <dialog> methods jsdom does not implement
 * (showModal/close), then drive the card the way a user would.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { openSaveDialog, type SaveDialogDeps } from './save-dialog.ts';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
globalThis.window = dom.window as unknown as typeof globalThis.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
// jsdom 25 ships no showModal/close on <dialog> - stub them to the minimum mountModal needs
// (an `open` attribute it toggles, then removes the node on close).
const Dlg = dom.window.HTMLDialogElement.prototype as unknown as { showModal(): void; close(): void };
Dlg.showModal = function (this: HTMLElement) { this.setAttribute('open', ''); };
Dlg.close = function (this: HTMLElement) { this.removeAttribute('open'); };

function baseDeps(over: Partial<SaveDialogDeps>): SaveDialogDeps {
  return {
    toolName: 'Design',
    hasTemplates: false,
    bases: [],
    listFolders: async () => [],
    createFolder: async (name) => ({ id: 'f', name }),
    saveToLibrary: async () => true,
    saveTemplate: async () => {},
    ...over,
  };
}

const q = <T extends HTMLElement>(sel: string): T | null => document.querySelector<T>(sel);
const cleanup = (): void => { document.querySelectorAll('dialog.save-dialog').forEach(d => d.remove()); };

test('the Create a tool card appears only with canCreateTool AND createTool', () => {
  openSaveDialog(baseDeps({}));
  assert.equal(q('[data-card="tool"]'), null, 'absent by default');
  cleanup();

  openSaveDialog(baseDeps({ canCreateTool: true })); // flag but no impl → still hidden
  assert.equal(q('[data-card="tool"]'), null, 'the flag alone does not show it');
  cleanup();

  openSaveDialog(baseDeps({ canCreateTool: true, createTool: async () => {} }));
  assert.ok(q('[data-card="tool"]'), 'shown when both are present');
  cleanup();
});

test('Create a tool: renders a pre-checked box per base format and creates from the captured fields', async () => {
  const created: Array<{ title: string; description: string; icon: string; formats: string[] }> = [];
  openSaveDialog(baseDeps({
    canCreateTool: true,
    toolFormats: ['png', 'svg', 'pdf'],
    createTool: async (meta) => { created.push(meta); },
  }));
  const boxes = Array.from(document.querySelectorAll<HTMLInputElement>('[data-tool-format]'));
  assert.equal(boxes.length, 3, 'one checkbox per base-tool format');
  assert.ok(boxes.every(b => b.checked), 'every format is pre-selected');

  boxes.find(b => b.value === 'pdf')!.checked = false;              // drop pdf
  q<HTMLInputElement>('[data-tool-title]')!.value = '  My Poster Maker  '; // trimmed
  q<HTMLInputElement>('[data-tool-desc]')!.value = 'Square posters';
  q<HTMLInputElement>('[data-tool-icon]')!.value = '🎨';
  q<HTMLButtonElement>('[data-act="create-tool"]')!.click();
  await new Promise(r => setTimeout(r, 0));

  assert.equal(created.length, 1, 'createTool called once');
  assert.deepEqual(created[0], {
    title: 'My Poster Maker', description: 'Square posters', icon: '🎨', formats: ['png', 'svg'],
  }, 'captured the trimmed title, description, icon, and the selected formats only');
  assert.equal(q('dialog.save-dialog'), null, 'the dialog closes once the tool is created');
  cleanup();
});

test('Create a tool: a blank name surfaces an inline error and never calls createTool', async () => {
  let calls = 0;
  openSaveDialog(baseDeps({ canCreateTool: true, toolFormats: ['png'], createTool: async () => { calls++; } }));
  q<HTMLButtonElement>('[data-act="create-tool"]')!.click();
  await new Promise(r => setTimeout(r, 0));
  assert.equal(calls, 0, 'no create on an empty name');
  const err = q<HTMLElement>('[data-err="tool"]');
  assert.ok(err && !err.hidden && (err.textContent ?? '').length > 0, 'an inline error is shown beside the card');
  cleanup();
});
