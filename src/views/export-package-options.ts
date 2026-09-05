// SPDX-License-Identifier: MPL-2.0

import { t } from '../i18n.ts';
import { jellyActive } from '../lib/jelly.ts';
import { escape } from '../utils.ts';
import { cancelSaveAsNext, requestSaveAsNext, saveFilePickerSupported } from '../bridge/export.ts';

const PACKAGE_INNER_FORMATS = ['svg', 'png', 'jpg', 'jpeg', 'webp'];

export interface PackageFormatChoice {
  formats: string[];
  innerFormat: string;
  enabled: boolean;
}

/** Add package containers only when the tool can produce a useful inner render. */
export function packageFormatChoice(baseFormats: string[]): PackageFormatChoice {
  const innerFormat = baseFormats.find((format) => format === 'svg')
    ?? baseFormats.find((format) => PACKAGE_INNER_FORMATS.includes(format))
    ?? '';
  const enabled = Boolean(innerFormat) && !baseFormats.includes('rpm');
  return {
    formats: enabled ? [...baseFormats, 'rpm', 'tar.gz'] : baseFormats,
    innerFormat,
    enabled,
  };
}

/** Keep MP4 ahead of WebM when both survive capability filtering. */
export function mp4BeforeWebm(formats: string[]): string[] {
  const mp4 = formats.indexOf('mp4');
  const webm = formats.indexOf('webm');
  if (mp4 === -1 || webm === -1 || mp4 < webm) return formats;
  const ordered = formats.filter((format) => format !== 'mp4');
  ordered.splice(ordered.indexOf('webm'), 0, 'mp4');
  return ordered;
}

/** Package metadata controls, isolated from the already concentrated action view. */
export function packageOptionsHtml(enabled: boolean, initialFormat: string | undefined, toolId: string): string {
  if (!enabled) return '';
  const id = escape(toolId);
  const visible = initialFormat === 'rpm' || initialFormat === 'tar.gz';
  return `
    <div class="section-card export-pkg" data-rpm-only style="display:${visible ? 'flex' : 'none'};flex-direction:column;gap:6px">
      <label style="display:flex;flex-direction:column;gap:2px;font-size:12px">Package name
        <input type="text" data-action="pkg-name" value="${id}" spellcheck="false" style="width:100%"></label>
      <div style="display:flex;gap:6px">
        <label style="display:flex;flex-direction:column;gap:2px;font-size:12px;flex:1">Version
          <input type="text" data-action="pkg-version" value="1.0" spellcheck="false" style="width:100%"></label>
        <label style="display:flex;flex-direction:column;gap:2px;font-size:12px;flex:2">Licence (SPDX)
          <input type="text" data-action="pkg-license" placeholder="e.g. CC-BY-4.0, MIT, OFL-1.1" spellcheck="false" style="width:100%"></label>
      </div>
      <label style="display:flex;flex-direction:column;gap:2px;font-size:12px">Install path
        <input type="text" data-action="pkg-dest" value="/usr/share/${id}" spellcheck="false" style="width:100%"></label>
      <p class="pdfpass-hint">An installable RPM of the render (or a no-root .tar.gz). The install path is where it lands on the system.</p>
    </div>`;
}

export interface DesktopExportBridge {
  requestSaveAs(): void;
  cancelSaveAs(): void;
}

export function desktopExportBridge(): DesktopExportBridge | undefined {
  return (window as Window & { __LOLLY_DESKTOP_EXPORT__?: DesktopExportBridge }).__LOLLY_DESKTOP_EXPORT__;
}

/**
 * Who answers "Save as…" here. The desktop shell registers its own native-dialog
 * seam; a browser with the File System Access API can put up the same dialog
 * (bridge/export.ts requestSaveAsNext), so it gets the button too. Neither ⇒
 * undefined, and saveAsButtonHtml renders nothing - the button is a probe, never a
 * control that does the plain download while claiming to do something else.
 */
export function saveAsBridge(): DesktopExportBridge | undefined {
  const desktop = desktopExportBridge();
  if (desktop) return desktop;
  if (!saveFilePickerSupported()) return undefined;
  return { requestSaveAs: requestSaveAsNext, cancelSaveAs: cancelSaveAsNext };
}

export function saveAsButtonHtml(show: boolean): string {
  if (!show) return '';
  const label = `${escape(t('Save as'))}…`;
  return jellyActive()
    ? `<jelly-button variant="platinum" data-action="save-as" class="save-as-btn">${label}</jelly-button>`
    : `<button type="button" data-action="save-as" class="save-as-btn">${label}</button>`;
}
