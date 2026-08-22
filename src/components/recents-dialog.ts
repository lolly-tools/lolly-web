// SPDX-License-Identifier: MPL-2.0
/**
 * The thin recents dialog (plans/133 WP-10) - what the gallery's history fab
 * opens now that Projects is the ONE folder manager. It shows the downloads
 * log's reopen rail (lib/export-history.ts, the same tiles the /p root rail
 * renders) over a single "Manage in Projects" hand-off, and manages nothing
 * itself: no folders, no delete, no move. The full manager UI lives in /p;
 * the batch view keeps folder-overlay.ts for its functional open-a-folder-
 * into-the-grid workflow, which is a different job.
 */
import { escape } from '../utils.ts';
import { t, tRaw } from '../i18n.ts';
import { mountModal } from './modal.ts';

export async function openRecentsDialog(opts: { savedCount?: number } = {}): Promise<void> {
  let rail = '';
  try {
    const { listExports, exportReopenHref } = await import('../lib/export-history.ts');
    const recents = (await listExports(12))
      .filter(x => x.thumb)
      .map(x => ({ href: exportReopenHref(x), thumb: x.thumb!, caption: x.filename || x.label, at: x.at }));
    rail = recents.length ? `
      <div class="folder-exports">
        <h3 class="folder-exports-title">${t('Recent exports')}</h3>
        <div class="folder-exports-rail">
          ${recents.map(x => `
            ${/* nosemgrep: lolly-href-escape-is-not-scheme-validation - exportReopenHref() builds a fixed '#/tool/<id>' hash route */ ''}
            <a class="folder-export-tile" href="${escape(x.href)}" data-open-export
               title="${escape(x.caption)} · ${escape(new Date(x.at).toLocaleDateString())}">
              <img src="${escape(x.thumb)}" alt="${escape(x.caption)}" loading="lazy">
            </a>`).join('')}
        </div>
      </div>` : '';
  } catch { /* history is best-effort - the hand-off below still stands */ }

  const saved = opts.savedCount ?? 0;
  const modal = mountModal(`
    <div class="recents-dialog">
      <div class="recents-dialog-head">
        <h2 class="recents-dialog-title">${t('Your recent work')}</h2>
        <button type="button" class="recents-dialog-close" data-recents-close
          aria-label="${escape(t('Close'))}">&#x2715;</button>
      </div>
      ${rail || `<p class="recents-dialog-empty">${t('Exports you download will show here for quick reopening.')}</p>`}
      <a class="btn recents-dialog-go" href="#/p">${saved
        ? tRaw('Manage {n} saved sessions in Projects', { n: saved })
        : t('Open Projects')}</a>
    </div>`,
  { className: 'tool-meta-dialog recents-modal' });
  // Any navigation out of the dialog (a reopen tile, the Projects hand-off)
  // closes it - the destination view takes over.
  modal.el.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('a[href]')) modal.close();
  });
  modal.el.querySelector('[data-recents-close]')?.addEventListener('click', () => modal.close());
}
