// SPDX-License-Identifier: MPL-2.0
/**
 * "Save as…" in a browser (File System Access) - plans/202 WP4.3.
 *
 * The desktop shell answers the export panel's Save As button with a native
 * dialog, through its own export override's __LOLLY_DESKTOP_EXPORT__ seam. A
 * Chromium browser can put the same dialog up with showSaveFilePicker, so the
 * panel offers the button there too - behind the probe below, so a browser
 * without the API renders no control it cannot honour. One-shot by construction,
 * exactly like the desktop seam: an ordinary Download after a cancelled Save As
 * must never surprise the user with a dialog.
 *
 * Its own module rather than a block inside bridge/export.ts: the arming flag and
 * the picker call are one small state machine with one caller in the web export
 * bridge (consumeSaveAsNext, from download()) and one in the export panel.
 */

type SaveFilePicker = (opts: {
  suggestedName?: string;
  types?: Array<{ description?: string; accept: Record<string, string[]> }>;
}) => Promise<{ createWritable(): Promise<{ write(data: Blob): Promise<void>; close(): Promise<void> }> }>;

let saveAsNext = false;

/** Can this browser put a real save dialog up? Chromium-family only today. */
export function saveFilePickerSupported(): boolean {
  return typeof window !== 'undefined'
    && typeof (window as Window & { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker === 'function';
}

/** Send the NEXT download through the save dialog. No-op where unsupported, so a
 *  caller that skipped the probe still cannot arm a dialog that cannot open. */
export function requestSaveAsNext(): void { saveAsNext = saveFilePickerSupported(); }

/** Disarm it (the export panel calls this when its Save As is dismissed). */
export function cancelSaveAsNext(): void { saveAsNext = false; }

/**
 * Write `blob` through the browser's save dialog. Returns whether the delivery is
 * settled: a written file and a cancelled dialog both are (a cancel is an answer,
 * and quietly dropping the file into Downloads afterwards would contradict it).
 * False means the API refused the call - most often because a long render used up
 * the click's transient activation - and the caller should deliver the ordinary
 * way rather than leave the user with no file at all.
 */
async function saveWithPicker(blob: Blob, filename: string): Promise<boolean> {
  const picker = (window as Window & { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker;
  if (typeof picker !== 'function') return false;
  const ext = /\.[a-z0-9]+$/i.exec(filename)?.[0];
  try {
    const handle = await picker({
      suggestedName: filename,
      ...(ext && blob.type
        ? { types: [{ description: `${ext.slice(1).toUpperCase()} file`, accept: { [blob.type]: [ext] } }] }
        : {}),
    });
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    return true;
  } catch (err) {
    return (err as { name?: string })?.name === 'AbortError';
  }
}

/**
 * The web export bridge's download() calls this first. Disarms whatever the Save
 * As button armed (one delivery only) and reports whether the dialog settled the
 * file. False - not armed, or the picker refused - means deliver the ordinary
 * anchor way, so a refused picker still saves the file.
 */
export async function consumeSaveAsNext(blob: Blob, filename: string): Promise<boolean> {
  if (!saveAsNext) return false;
  saveAsNext = false;
  return saveWithPicker(blob, filename);
}
