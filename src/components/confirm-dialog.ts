// SPDX-License-Identifier: MPL-2.0
/**
 * confirmDialog — a styled modal confirmation for destructive actions.
 *
 * Returns a Promise<boolean>: true on confirm, false on Cancel / Escape / a
 * backdrop click. One shared component (the Projects view + the profile Storage
 * manager) so every destructive flow looks and behaves identically. Built on
 * mountModal (components/modal.ts) — this file supplies content + wiring only,
 * the open/Escape/backdrop/teardown lifecycle lives there. Reuses the `.modal`
 * <dialog> CSS already in app.css. Escape-to-close is an app-wide convention;
 * the safe Cancel button takes default focus.
 */
import { escape } from '../utils.ts';
import { mountModal } from './modal.ts';

// Open dialogs live on <body>, so a view unmount can't remove them by clearing
// its own container — track them here and tear any down via closeConfirmDialogs().
const openDialogs = new Set<HTMLDialogElement>();

export interface ConfirmDialogOpts {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
}

export function confirmDialog({ title, message, confirmLabel = 'Delete', danger = true }: ConfirmDialogOpts): Promise<boolean> {
  return new Promise((resolve) => {
    const content = `
      <h2 class="modal-title">${escape(title)}</h2>
      <p class="modal-msg">${escape(message)}</p>
      <div class="modal-actions">
        <button type="button" class="btn modal-cancel" data-act="cancel">Cancel</button>
        <button type="button" class="btn${danger ? ' modal-danger' : ''}" data-act="ok">${escape(confirmLabel)}</button>
      </div>`;
    const modal = mountModal<boolean>(content, {
      className: 'modal',
      cancelValue: false,
      initialFocus: (el) => el.querySelector<HTMLElement>('.modal-cancel'), // default focus on the safe choice
      onClose: (result) => { openDialogs.delete(modal.el); resolve(result ?? false); },
    });
    openDialogs.add(modal.el);
    modal.el.addEventListener('click', (e) => {
      const act = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-act]')?.dataset.act : undefined;
      if (act) modal.close(act === 'ok');
    });
  });
}

export interface DialogChoice {
  id: string;
  label: string;
  primary?: boolean;
}

export interface ChoiceDialogOpts {
  title: string;
  message: string;
  choices?: DialogChoice[];
}

/**
 * choiceDialog — the same modal chrome, but a pick-one-of-N decision instead of
 * a yes/no confirm. Resolves the chosen choice id, or null on Cancel / Escape /
 * backdrop. Choices render right-to-left as given, with `primary: true` styled
 * as the brand call-to-action; a Cancel button is always prepended.
 */
export function choiceDialog({ title, message, choices = [] }: ChoiceDialogOpts): Promise<string | null> {
  return new Promise((resolve) => {
    const content = `
      <h2 class="modal-title">${escape(title)}</h2>
      <p class="modal-msg">${escape(message)}</p>
      <div class="modal-actions modal-actions--choices">
        <button type="button" class="btn modal-cancel" data-act="cancel">Cancel</button>
        ${choices.map(c => `<button type="button" class="btn${c.primary ? ' modal-primary' : ''}" data-choice="${escape(c.id)}">${escape(c.label)}</button>`).join('')}
      </div>`;
    const modal = mountModal<string | null>(content, {
      className: 'modal',
      cancelValue: null,
      initialFocus: (el) => el.querySelector<HTMLElement>('.modal-primary, [data-choice]'), // default focus on the lead choice
      onClose: (result) => { openDialogs.delete(modal.el); resolve(result ?? null); },
    });
    openDialogs.add(modal.el);
    modal.el.addEventListener('click', (e) => {
      const chosen = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-choice]') : null;
      if (chosen) { modal.close(chosen.dataset.choice!); return; }
      if (e.target instanceof Element && e.target.closest('[data-act]')) modal.close(null);
    });
  });
}

export interface NoticeDialogOpts {
  title: string;
  /** One paragraph, or several rendered as separate <p>s (each escaped). */
  message: string | string[];
  okLabel?: string;
}

/**
 * noticeDialog — the same modal chrome, but a purely informational notice with a
 * single acknowledge button (no yes/no, no Cancel). Escape / backdrop / the button
 * all dismiss. Used for friendly one-shot nudges (e.g. asset-library milestones).
 */
export function noticeDialog({ title, message, okLabel = 'Got it' }: NoticeDialogOpts): Promise<void> {
  return new Promise((resolve) => {
    const paras = (Array.isArray(message) ? message : [message])
      .map(m => `<p class="modal-msg">${escape(m)}</p>`).join('');
    const content = `
      <h2 class="modal-title">${escape(title)}</h2>
      ${paras}
      <div class="modal-actions">
        <button type="button" class="btn modal-primary" data-act="ok">${escape(okLabel)}</button>
      </div>`;
    const modal = mountModal<void>(content, {
      className: 'modal',
      initialFocus: (el) => el.querySelector<HTMLElement>('[data-act="ok"]'),
      onClose: () => { openDialogs.delete(modal.el); resolve(); },
    });
    openDialogs.add(modal.el);
    modal.el.addEventListener('click', (e) => {
      if (e.target instanceof Element && e.target.closest('[data-act]')) modal.close();
    });
  });
}

export interface PromptDialogOpts {
  title: string;
  message: string;
  confirmLabel?: string;
  placeholder?: string;
  /** Pre-fill the field (and select it) — for editing an existing value, e.g. a rename. */
  value?: string;
  inputType?: 'text' | 'password';
  /** Shown in destructive colour above the field (e.g. "Incorrect password"). */
  error?: string;
}

/**
 * promptDialog — the same modal chrome with a single text/password field. Resolves
 * the typed string on OK / Enter, or null on Cancel / Escape / backdrop. Used for
 * the client-side password prompt on an encrypted (`zx`) share link.
 */
export function promptDialog({ title, message, confirmLabel = 'OK', placeholder = '', value = '', inputType = 'text', error }: PromptDialogOpts): Promise<string | null> {
  return new Promise((resolve) => {
    const errHtml = error ? `<p class="modal-msg" style="color:hsl(var(--destructive));font-weight:600">${escape(error)}</p>` : '';
    const content = `
      <h2 class="modal-title">${escape(title)}</h2>
      <p class="modal-msg">${escape(message)}</p>
      ${errHtml}
      <input type="${inputType === 'password' ? 'password' : 'text'}" class="modal-input"
             aria-label="${escape(message)}"
             autocomplete="${inputType === 'password' ? 'off' : 'on'}" spellcheck="false" placeholder="${escape(placeholder)}"
             style="width:100%;box-sizing:border-box;padding:9px 12px;margin:.1rem 0 .3rem;font-size:14px;border:1px solid hsl(var(--input));border-radius:var(--radius);background:hsl(var(--background));color:hsl(var(--foreground))">
      <div class="modal-actions">
        <button type="button" class="btn modal-cancel" data-act="cancel">Cancel</button>
        <button type="button" class="btn modal-primary" data-act="ok">${escape(confirmLabel)}</button>
      </div>`;
    const modal = mountModal<string | null>(content, {
      className: 'modal',
      cancelValue: null,
      initialFocus: (el) => el.querySelector<HTMLElement>('.modal-input'),
      onClose: (result) => { openDialogs.delete(modal.el); resolve(result ?? null); },
    });
    openDialogs.add(modal.el);
    const input = modal.el.querySelector<HTMLInputElement>('.modal-input')!;
    modal.el.addEventListener('click', (e) => {
      const act = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-act]')?.dataset.act : undefined;
      if (act === 'ok') { modal.close(input.value); return; }
      if (act === 'cancel') modal.close(null);
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); modal.close(input.value); } });
    if (value) { input.value = value; input.select(); }
  });
}

/** Tear down any still-open confirm dialogs — call on view unmount. */
export function closeConfirmDialogs(): void {
  for (const dlg of openDialogs) { if (dlg.open) dlg.close(); dlg.remove(); }
  openDialogs.clear();
}
