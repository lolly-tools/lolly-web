/**
 * Font upload and management component.
 * Can be mounted in brand config or catalog contexts.
 */

import '../styles/parts/fonts-manager.css';
import { installFontAsset, getInstalledFonts, removeFontAsset, refreshFontRegistry } from '../lib/font-asset-handler.ts';
import { validateFontFile } from '../lib/font-utils.ts';
import { setPrimaryFont, setMonoFont } from '../user-fonts.ts';
import type { HostV1 } from '../../../../engine/src/bridge/host-v1.ts';

export interface FontsManagerOptions {
  host: HostV1;
  showBranding?: boolean;
  onFontInstalled?: (fontFamily: string) => void;
}

export async function mountFontsManager(container: HTMLElement, opts: FontsManagerOptions): Promise<void> {
  const { host, showBranding = false, onFontInstalled } = opts;

  container.innerHTML = `
    <div class="fonts-manager">
      <div class="fonts-upload" role="region" aria-label="Font upload">
        <label class="fonts-upload-drop" data-fonts-drop>
          <input type="file" multiple class="fonts-upload-file visually-hidden" accept=".ttf,.otf,.woff,.woff2"
            aria-label="Upload font files (TTF, OTF, WOFF, WOFF2)">
          <div class="fonts-upload-area">
            <span class="fonts-upload-icon" aria-hidden="true">📤</span>
            <span class="fonts-upload-text">
              <strong>Drag and drop font files here</strong><br>
              or <button type="button" class="fonts-upload-btn">click to browse</button>
            </span>
            <span class="fonts-upload-hint">Supports TTF, OTF, WOFF (max 5MB each)</span>
          </div>
        </label>
      </div>

      <div class="fonts-list" data-fonts-list aria-label="Installed fonts">
        <div class="fonts-loading">Loading fonts…</div>
      </div>
    </div>
  `;

  const dropZone = container.querySelector<HTMLLabelElement>('[data-fonts-drop]')!;
  const fileInput = container.querySelector<HTMLInputElement>('.fonts-upload-file')!;
  const fontsList = container.querySelector<HTMLElement>('[data-fonts-list]')!;
  const browseBtn = container.querySelector<HTMLButtonElement>('.fonts-upload-btn')!;

  // Click to browse button
  browseBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    fileInput.click();
  });

  // Drag and drop
  ['dragenter', 'dragover', 'dragleave', 'drop'].forEach((evt) => {
    dropZone.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
  });

  ['dragenter', 'dragover'].forEach((evt) => {
    dropZone.addEventListener(evt, () => {
      dropZone.classList.add('is-dragging');
    });
  });

  ['dragleave', 'drop'].forEach((evt) => {
    dropZone.addEventListener(evt, () => {
      dropZone.classList.remove('is-dragging');
    });
  });

  // Handle drops and file selection
  const handleFiles = async (files: FileList): Promise<void> => {
    console.log('[fonts-manager] handleFiles called with', files.length, 'file(s)');
    const validFiles = Array.from(files).filter((f) => {
      console.log('[fonts-manager] Validating file:', f.name, f.size, f.type);
      const validation = validateFontFile(f);
      console.log('[fonts-manager] Validation result:', validation);
      if (!validation.valid) {
        console.warn(`[fonts-manager] Skipping ${f.name}: ${validation.error}`);
        return false;
      }
      console.log(`[fonts-manager] File ${f.name} is valid`);
      return true;
    });

    if (!validFiles.length) {
      console.warn('No valid font files selected');
      return;
    }

    // Disable input while uploading
    fileInput.disabled = true;
    dropZone.classList.add('is-uploading');

    for (const file of validFiles) {
      try {
        console.log(`Installing font: ${file.name}`, { size: file.size, type: file.type });
        const result = await installFontAsset(host, file, (percent) => {
          console.debug(`${file.name}: ${percent}%`);
        });

        if (result) {
          console.log(`✓ Font installed: ${result.family} (${result.weight})`);
          onFontInstalled?.(result.family);
        } else {
          console.error(`Failed to install ${file.name}: metadata parsing failed`);
        }
      } catch (e) {
        console.error(`Font installation error for ${file.name}:`, e instanceof Error ? e.message : e);
      }
    }

    // Refresh registry and list
    try {
      await refreshFontRegistry(host);
      await refreshFontList();
    } catch (e) {
      console.error('Font registry refresh error:', e instanceof Error ? e.message : e);
    }

    fileInput.disabled = false;
    dropZone.classList.remove('is-uploading');
    fileInput.value = '';
  };

  fileInput.addEventListener('change', (e) => {
    const input = e.target as HTMLInputElement;
    console.log('[fonts-manager] File input change event', { files: input.files?.length });
    if (input.files && input.files.length > 0) {
      console.log('[fonts-manager] Calling handleFiles with', input.files.length, 'file(s)');
      handleFiles(input.files).catch((err) => {
        console.error('[fonts-manager] handleFiles error:', err instanceof Error ? err.message : err);
      });
    } else {
      console.warn('[fonts-manager] No files selected');
    }
  });

  dropZone.addEventListener('drop', (e) => {
    const dt = (e as DragEvent).dataTransfer;
    if (dt?.files) handleFiles(dt.files);
  });

  // Refresh list of installed fonts
  const refreshFontList = async (): Promise<void> => {
    console.log('[fonts-manager] Refreshing font list...');
    const fonts = await getInstalledFonts(host);
    console.log('[fonts-manager] Got installed fonts:', fonts.length, fonts);

    if (!fonts.length) {
      console.log('[fonts-manager] No fonts installed, showing empty state');
      fontsList.innerHTML = '<div class="fonts-empty">No fonts installed yet</div>';
      return;
    }

    console.log('[fonts-manager] Rendering', fonts.length, 'installed fonts');

    fontsList.innerHTML = `
      <div class="fonts-items">
        ${fonts
          .map(
            (font) => `
          <div class="fonts-item" data-font-id="${font.id}">
            <div class="fonts-item-name">${font.family}</div>
            <div class="fonts-item-meta">
              <span class="fonts-item-weight">${font.weight}</span>
              <span class="fonts-item-style">${font.style}</span>
              <span class="fonts-item-size">${(font.fileSize / 1024).toFixed(1)}KB</span>
            </div>
            <div class="fonts-item-actions">
              <button type="button" class="fonts-item-btn fonts-set-primary" data-set-primary="${font.id}" aria-label="Set as primary font">Primary</button>
              <button type="button" class="fonts-item-btn fonts-set-mono" data-set-mono="${font.id}" aria-label="Set as mono font">Mono</button>
              <button type="button" class="fonts-item-delete" data-delete-font="${font.id}" aria-label="Delete font">×</button>
            </div>
          </div>
        `
          )
          .join('')}
      </div>
    `;

    // Attach action handlers
    fontsList.querySelectorAll<HTMLButtonElement>('[data-set-primary]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const fontId = btn.dataset.setPrimary!;
        const font = fonts.find(f => f.id === fontId);
        if (font) {
          console.log('[fonts-manager] Setting primary font:', font.family);
          try {
            await setPrimaryFont(host as unknown as Parameters<typeof setPrimaryFont>[0], font.family);
            onFontInstalled?.(font.family);
          } catch (e) {
            console.error('[fonts-manager] Failed to set primary font:', e);
          }
        }
      });
    });

    fontsList.querySelectorAll<HTMLButtonElement>('[data-set-mono]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const fontId = btn.dataset.setMono!;
        const font = fonts.find(f => f.id === fontId);
        if (font) {
          console.log('[fonts-manager] Setting mono font:', font.family);
          try {
            await setMonoFont(host as unknown as Parameters<typeof setMonoFont>[0], font.family);
            onFontInstalled?.(font.family);
          } catch (e) {
            console.error('[fonts-manager] Failed to set mono font:', e);
          }
        }
      });
    });

    fontsList.querySelectorAll<HTMLButtonElement>('[data-delete-font]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const fontId = btn.dataset.deleteFont!;
        if (confirm('Delete this font?')) {
          await removeFontAsset(host, fontId);
          await refreshFontRegistry(host);
          await refreshFontList();
        }
      });
    });
  };

  // Initial load
  await refreshFontList();

  // Listen for font changes from other sessions/tabs
  window.addEventListener('lolly:fonts-refreshed', () => {
    refreshFontList();
  });
}
