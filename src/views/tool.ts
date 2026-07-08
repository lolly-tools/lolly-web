// SPDX-License-Identifier: MPL-2.0
/**
 * Tool view — mounts one tool.
 *
 * Lifecycle:
 *   1. loadTool() fetches manifest + template + hooks from the catalog
 *   2. createRuntime() spins up the engine with the host bridge
 *   3. We render input controls from runtime.getModel() and the template
 *      output from runtime.getHydrated()
 *   4. Input changes → runtime.setInput() → subscribed callback re-renders
 *   5. Action buttons call runtime.export() / host.clipboard / host.state
 */

// View-scoped stylesheets — Vite emits these as async CSS chunks loaded WITH this
// lazy view, instead of render-blocking the gallery/catalog landing (see app.css).
import '../styles/parts/tool.css';
import '../styles/parts/editor.css';
import '../styles/parts/document.css';
import '../styles/parts/tool-chrome.css';
import { loadTool, createRuntime, parseUrlState, annotateTemplate, toCssPx, DEFAULT_CMYK_CONDITION, isTokenValue, packQuery, expandQuery, hasPackedState, isPackAvailable, PACK_PARAM, hasEncryptedState, unpackEncrypted, ENC_PARAM, C2PA_FORMATS } from '@lolly/engine';
import { promptDialog } from '../components/confirm-dialog.ts';

// Above this readable-query length the address bar and the Share dialog switch to
// the packed `z=` form (when it's actually shorter). Kept well under the ~2000-char
// ceiling that pasted links, social crawlers and some servers still enforce, while
// leaving simple/typical links in their hand-editable readable form.
const AUTO_PACK_MIN = 1800;
import { escape } from '../utils.ts';
import { navigateTo } from '../nav.ts';
import { toolSupport, capabilityLabel, CAPTURE_EXTENSION_URL } from '../capabilities.ts';
import { announce } from '../a11y.ts';
import { setupRecordControl } from './record-control.ts';
import { PALETTE } from '../palette.ts';
import { setSwatches } from '../components/color-field.ts';
import { createThemeToggle } from '../components/theme-toggle.ts';
import { createSoundToggle } from '../components/sound-toggle.ts';
import { scopeCss } from '../lib/scope-css.ts';
import { runTemplateScripts, waitForQuiescence } from '../lib/render-lifecycle.ts';
import { playSfx } from '../lib/sfx.ts';
import { exportSizeDriver } from './export-size.ts';
import { neutralizeEmbeds, hydrateEmbeds } from '../bridge/embed.ts';
import { openShareDialog } from '../components/share-dialog.ts';
import 'flatpickr/dist/flatpickr.min.css';

// Type-only imports (erased at build). The `@lolly/engine` barrel re-exports
// values but not these type-only names, so they come straight from the engine
// internals — resolved by the bundler through the `.js` specifier convention.
import type { HostV1, AssetRef, ComposeAPI, ClipboardAPI, StateAPI, Profile } from '../../../../engine/src/bridge/host-v1.js';
import type { InputModelItem, InputValue, InputSpec, BlockFieldSpec } from '../../../../engine/src/inputs.js';
import type { LoadedTool, ToolManifest } from '../../../../engine/src/loader.js';
import type { Runtime } from '../../../../engine/src/runtime.js';
import type { Unit } from '../../../../engine/src/units.js';

// The input + actions subsystems live in sibling modules (verbatim split of this
// file). They only `import type` back from here, so these value imports don't cycle.
import { asRow } from './tool-types.ts';
import { setupStageNav, type StageNav } from './tool-stage-nav.ts';
import {
  syncInputs, openEmbedEditor, scrollToControl, focusSidebarBlock,
  fileToRef, fmtBytes, makeBlocksDropper, _sliderDragging,
} from './tool-inputs.ts';
import {
  renderActions, captureThumbnail, extFor, isCmykFmt, isPrintFmt,
  printEnabled, marksToCsv, c2paDefaultOn, readBleed, readMarks,
} from './tool-actions.ts';

// ── Shell-side type aliases (all erased at build; no runtime effect) ──────────

/** The view root; the router reads back a `_cleanup` teardown hook off it. */
type ViewEl = HTMLElement & { _cleanup?: () => void };

/** Content Credentials device-identity status (a web-only host helper). */
export interface IdentityStatus {
  enrolled?: boolean;
  expired?: boolean;
  notAfter?: string;
  daysLeft?: number;
  identity?: { email?: string } | null;
}

/** The picker's "detected tool" description (compose._describeUrl). */
export interface EmbedDescribe {
  name: string;
  formats: string[];
  format: string;
  width?: number;
  height?: number;
  unit?: string;
  dpi?: number;
}

/**
 * The web shell's host as this view consumes it: the tool-facing HostV1 plus the
 * web-only helpers tool.js reaches for directly — clipboard.writeHtml, state.save's
 * thumbnail arg, identity (Content Credentials device cert) and compose._describeUrl
 * (the embed editor). WebHost in bridge/index.ts isn't exported, so we describe just
 * the members used here (each is a real member of the assembled bridge).
 */
export type WebToolHost = HostV1 & {
  clipboard: ClipboardAPI & { writeHtml(html: string): Promise<void> };
  state: StateAPI & { save(slot: string, data: object, thumb?: string | null): Promise<void> };
  identity?: { status(): Promise<IdentityStatus> };
  compose?: ComposeAPI & { _describeUrl(url: string): Promise<EmbedDescribe | null> };
};

/**
 * The runtime plus the un-historied setter mountTool bolts on so renderActions'
 * programmatic px-sync can set inputs without the change landing in undo history.
 */
export type ToolRuntime = Runtime & { setInputNoHistory?: Runtime['setInput'] };

/** One recorded undo/redo step. */
interface HistoryEntry { id: string; label: string; before: InputValue; after: InputValue; }
/** The header (or editor-rail) ↶/↷ pair the history helpers drive. */
interface HistoryControls { sync(canUndo: boolean, canRedo: boolean): void; }

/** The sidebar/actions panel element with the document-level dismissers renderInputs parks on it. */
export interface PanelEl extends HTMLElement {
  _colorPopoverDismiss?: (e: MouseEvent) => void;
  _blockMenuDismiss?: (e: MouseEvent) => void;
  _helpTipDismiss?: (e: MouseEvent) => void;
}
/** A flatpickr-enhanced input carries its instance for teardown. */
export interface FlatpickrHost extends HTMLInputElement { _flatpickr?: { destroy(): void; altInput?: HTMLInputElement }; }



/** The print-mark toggle map carried on the export bar and in the `marks` param. */
export interface PrintMarks { crop: boolean; registration: boolean; bleed: boolean; colorBars: boolean; provenance: boolean; }

/** Export defaults restored from the URL / a saved session (see mountTool). */
export interface ExportDefaults {
  filename?: string;
  format?: string;
  width?: number;
  height?: number;
  unit?: string;
  dpi?: number;
  profile?: string;
  password?: string;
  bleed?: string;
  marks?: PrintMarks | null;
  nostage?: boolean;
  c2pa?: { on: boolean; days?: number | null };
  /** Pixel-watermark opt-in from ?imprint= — applied to raster exports. */
  imprint?: boolean;
}

/** mountTool's strip-scale → export → reapply wrapper (injected into renderActions). */
export type ExportUnscaled = <T>(fn: () => Promise<T>, opts?: { shutter?: boolean }) => Promise<T>;

/** What renderActions hands back for programmatic triggering (`?copy`, Save & leave…). */
export interface ActionsApi {
  copy?: (fmtOverride?: string) => Promise<{ method: string } | void>;
  preview?: () => Promise<void>;
  save?: (btn?: HTMLElement | null) => Promise<boolean>;
  setDims?: (dims?: { width?: number; height?: number; unit?: string }) => void;
  stopAudioPreview?: () => void;
}

/** A shared monotonic bar-write guard (a holder object so shrinkUrl can share it). */
interface BarSeq { v: number; }

/** The lottie-mount module, loaded lazily and kept for reaping. */
type LottieModule = typeof import('./lottie-mount.ts');
/** The video-mount module, loaded lazily the first paint that emits a keyed <video>. */
type VideoModule = typeof import('./video-mount.ts');

/**
 * The superset of export options this view assembles and hands to runtime.export —
 * the engine's ExportOpts plus the web-shell timing/print/provenance extensions the
 * export bridge reads. Permissive on purpose so the spread/assignment builders below
 * typecheck without changing what's passed at runtime.
 */
export interface RunExportOpts {
  width?: number | string;
  height?: number | string;
  dpi?: number;
  scale?: number;
  embedMeta?: boolean;
  thumbnail?: boolean;
  colorProfile?: string;
  palette?: unknown;
  fullPage?: boolean;
  password?: string;
  strongPassword?: string;
  c2pa?: boolean;
  c2paDays?: number;
  imprint?: boolean;
  bleed?: string;
  cropMarks?: boolean;
  registrationMarks?: boolean;
  bleedMarks?: boolean;
  colorBars?: boolean;
  provenance?: boolean;
  dither?: boolean;
  fps?: number;
  wait?: number;
  duration?: number;
  audio?: { id?: string; url: string; fadeIn?: number; fadeOut?: number; volume?: number; duck?: number };
  filename?: string;
  bundleFormats?: string[];
  convertPaths?: boolean;
  /** Progress callback for slow exports (CMYK TIFF pass, SVG/PDF vector walk).
   *  The engine/bridge emit it; the export UI uses it to update the button label. */
  onProgress?: (done: number, total: number) => void;
}

function marksFromCsv(csv: string | null | undefined): PrintMarks | null {
  if (!csv) return null;
  const s = new Set(String(csv).split(',').map(x => x.trim().toLowerCase()).filter(Boolean));
  return { crop: s.has('crop'), registration: s.has('reg') || s.has('registration'), bleed: s.has('bleed'), colorBars: s.has('bars') || s.has('colorbars'), provenance: s.has('prov') || s.has('provenance') };
}

// Undo/redo glyphs for the history toast (Lucide undo-2 / redo-2). App chrome,
// not exported, so currentColor is safe here (unlike tool-template SVGs).
const ICON_UNDO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5 5.5 5.5 0 0 1-5.5 5.5H11"/></svg>';
const ICON_REDO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="m15 14 5-5-5-5"/><path d="M20 9H9.5A5.5 5.5 0 0 0 4 14.5 5.5 5.5 0 0 0 9.5 20H13"/></svg>';

// Prompt (client-side, no server) for the password on an encrypted `zx` link and
// return the decrypted READABLE query. Loops on a wrong password; on cancel returns
// the original query unchanged (zx is reserved → parseUrlState ignores it → the tool
// loads at defaults). Readable params riding alongside zx (on-visit flags) are
// re-appended after the decoded state so they still apply — mirroring expandQuery.
// One navigation can mount twice (popstate + hashchange), so the prompt is shared
// per token via this in-flight map — the user never sees two stacked dialogs.
const zxInFlight = new Map<string, Promise<string>>();
async function decryptEncryptedLink(query: string): Promise<string> {
  const params = new URLSearchParams(query);
  const token = params.get(ENC_PARAM);
  if (!token) return query;
  const inFlight = zxInFlight.get(token);
  if (inFlight) return inFlight;
  const run = (async (): Promise<string> => {
    let error: string | undefined;
    for (;;) {
      const pw = await promptDialog({
        title: 'Password-protected link',
        message: 'This Lolly link is locked. Enter its password to open it here — nothing is sent to a server.',
        confirmLabel: 'Open',
        inputType: 'password',
        placeholder: 'Password',
        error,
      });
      if (pw == null) return query;                     // cancelled → load at defaults
      const decoded = await unpackEncrypted(token, pw);
      if (decoded != null) {
        const extras: string[] = [];
        params.forEach((v, k) => {
          if (k === ENC_PARAM) return;
          extras.push(v === '' ? encodeURIComponent(k) : `${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
        });
        return extras.length ? `${decoded}&${extras.join('&')}` : decoded;
      }
      error = 'Incorrect password — try again.';         // wrong → re-prompt
    }
  })();
  zxInFlight.set(token, run);
  try { return await run; } finally { zxInFlight.delete(token); }
}

export async function mountTool(viewEl: ViewEl, host: WebToolHost, toolId: string, urlParams: string | null | undefined): Promise<void> {
  // If the catalog is loaded, do a fast existence check before fetching anything.
  const catalog = (window as Window & { __toolIndex?: { tools?: { id: string }[] } }).__toolIndex;
  if (catalog?.tools && !catalog.tools.some(t => t.id === toolId)) {
    mount404(viewEl, toolId);
    return;
  }

  const fetchFile = makeFetchFile(toolId);

  // Defer the loading screen so prefetched tools don't flash the gallery out.
  // The gallery stays visible until the tool is ready (or 400ms passes).
  const loadingTimer = setTimeout(() => {
    viewEl.innerHTML = `<p class="loading">Loading…</p>`;
  }, 400);

  let tool: LoadedTool;
  try {
    // The loader takes a plain fetchFile with no abort handle, so a hung request
    // would leave an infinite "Loading…". Guard the whole load with a timeout that
    // rejects with a network-shaped error, so it flows through the SAME offline /
    // recoverable branch below (the Retry + "Browse all tools" card) as any other
    // fetch failure — no separate error path.
    const LOAD_TIMEOUT_MS = 15000;
    let loadTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      loadTimer = setTimeout(() => reject(new Error('Failed to fetch tool — network timeout')), LOAD_TIMEOUT_MS);
    });
    try {
      tool = await Promise.race([loadTool(toolId, fetchFile), timeout]);
    } finally {
      clearTimeout(loadTimer);
    }
    clearTimeout(loadingTimer);
  } catch (e) {
    clearTimeout(loadingTimer);
    const err = e as { message?: string; validationErrors?: { path: string; message: string }[] };
    if (err.message === 'tool-not-found') {
      mount404(viewEl, toolId);
      return;
    }
    const errs = err.validationErrors?.length
      ? `<ul class="error-list">${err.validationErrors.map(ve =>
          `<li><code>${escape(ve.path)}</code> — ${escape(ve.message)}</li>`
        ).join('')}</ul>`
      : '';
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    if (!err.validationErrors?.length && (offline || /fetch|network|load|failed to fetch/i.test(String(err.message || '')))) {
      // Offline-first PWA: a network load failure should be recoverable, not a raw dead-end.
      viewEl.innerHTML =
        `<div class="error"><strong>${offline ? 'You’re offline' : 'Couldn’t load this tool'}</strong>` +
        `<p>${offline ? 'Reconnect, then try again.' : 'Check your connection, then retry.'}</p>` +
        `<div class="error-actions" style="margin-top:12px;display:flex;gap:8px;justify-content:center">` +
        `<button class="btn" data-retry>Retry</button><a class="btn" href="#/">Browse all tools</a></div></div>`;
      viewEl.querySelector('[data-retry]')?.addEventListener('click', () => location.reload());
      return;
    }
    viewEl.innerHTML = `<div class="error"><strong>${escape(err.message)}</strong>${errs}</div>`;
    return;
  }

  // Guard direct links: if the tool needs a capability this shell can't fulfil,
  // show the right panel instead of mounting it into a broken state — on a
  // Chromium browser a capture tool offers the extension ('install'); otherwise
  // "desktop only" ('unavailable').
  const sup = toolSupport(tool.manifest, host.capabilities);
  if (sup.status === 'install') { mountInstallPrompt(viewEl, tool.manifest); return; }
  if (sup.status === 'unavailable') { mountUnavailable(viewEl, tool.manifest, sup.unmet); return; }

  // Source the colour picker's swatches from design tokens (the canonical brand
  // colours), so choosing one keeps the value linked to the token. Falls back to
  // the built-in palette if tokens aren't available (offline first load, or a
  // shell without host.tokens). Best-effort — never blocks mounting the tool.
  try {
    const swatches = await host.tokens?.colors?.();
    if (swatches?.length) {
      setSwatches(swatches.map(s => ({ value: s.value, label: s.name, group: s.group, ref: s.ref })));
    }
  } catch { /* keep the built-in palette */ }

  // Annotate the template once so rendered nodes carry data-canvas-input attrs
  // for click-to-focus. This is purely a shell-side concern; the engine just
  // stores the modified source and hydrates it like any other template.
  const inputIds = (tool.manifest.inputs ?? []).map(i => i.id);
  tool.template = annotateTemplate(tool.template, inputIds);
  document.title = `${tool.manifest.name} — Lolly`;

  // A password-gated link (`?zx=…`) carries the whole state ENCRYPTED. Prompt for
  // the password client-side (no server), decrypt to the readable query, and carry
  // on. Cancel or give up → leave it (zx is reserved, so parseUrlState ignores it
  // and the tool loads at defaults). Runs before expandQuery so the rest is unchanged.
  // If it decrypts, remember the ORIGINAL encrypted query so the address bar keeps
  // showing a protected link (see syncUrl) until the user edits — otherwise the first
  // auto-sync would rewrite the bar to the cleartext state, silently downgrading the
  // shared link to an unprotected one.
  let encLinkQuery: string | null = null;
  if (hasEncryptedState(urlParams)) {
    const original = urlParams!;
    urlParams = await decryptEncryptedLink(urlParams!);
    if (!hasEncryptedState(urlParams)) encLinkQuery = original;
  }

  // A packed link (`?z=…`) carries the whole state compressed; expand it back into a
  // plain query BEFORE anything reads it (parse, flag detection, dirty-param seed).
  // A no-op for ordinary readable links. Done once so every consumer below agrees.
  urlParams = await expandQuery(urlParams ?? '');

  const { values, format: urlFormat, export: autoExport, copy: autoCopy, slot, filename: urlFilename, width: urlWidth, height: urlHeight, unit: urlUnit, dpi: urlDpi, profile: urlProfile, password: urlPassword, bleed: urlBleed, marks: urlMarks, c2pa: urlC2pa, imprint: urlImprint } = parseUrlState(urlParams, tool.manifest);
  const urlFlags = new URLSearchParams(urlParams || '');
  const isFull = urlFlags.has('full');
  // `?nostage` pre-checks the export panel's "Full page" toggle (HTML export only):
  // the saved page drops the fixed-size canvas frame and fills the whole window.
  const urlNostage = urlFlags.has('nostage');
  // `?options` lands the recipient on the export-settings panel expanded (instead
  // of the collapsed Render button). `full` collapses ALL chrome to the bare
  // preview — the opposite intent — so it wins when both are present, matching the
  // CSS, which hides the export panel whenever its host sidebar is collapsed.
  const showExportPanel = !isFull && urlFlags.has('options');

  let initialValues: Record<string, InputValue> = values;
  if (slot) {
    const saved = await host.state.load(slot);
    if (saved) initialValues = { ...saved, ...values };
  }

  // "+ New tool" from the Projects view leaves a sessionStorage marker so the first
  // FRESH session saved here files into the folder it launched from. Read it ONLY on a
  // fresh open (no resume `slot`) — otherwise a diverted "open the gallery, resume an
  // unrelated old session, save it" flow would capture it and misfile that session.
  // We READ (not remove) the marker: a hash navigation can mount the tool twice (a
  // browser fires popstate AND hashchange, which the router debounce can't fully
  // collapse), and a consume-on-mount would let the first mount swallow the marker
  // while the SECOND mount owns the live Save button. The marker is cleared instead
  // when the user lands on any non-tool view (main.js navigate). Used in performSave.
  let fileIntoFolder: string | null = null;
  if (!slot) {
    try {
      const into = sessionStorage.getItem('lolly:fileInto');
      if (into !== null) fileIntoFolder = into || null;
    } catch (e) { /* sessionStorage unavailable (private mode) */ }
  }

  // Where the tool returns to when it leaves. The Projects view arms a marker (the
  // folder it launched from, e.g. `/#/p/<folderId>`) so a tool opened or resumed from a
  // folder saves and lands BACK in that folder; opening straight from the gallery leaves
  // no marker, so we fall back to '/' (the gallery). Read (not removed) here for the same
  // double-mount reason as fileIntoFolder above; cleared on the next non-tool mount.
  let returnTo = '/';
  try {
    const back = sessionStorage.getItem('lolly:returnTo');
    if (back) returnTo = back;
  } catch (e) { /* sessionStorage unavailable (private mode) */ }

  // The back link follows that same marker: a tool launched from a folder reads "Back"
  // and returns to the folder; from the gallery it reads "Tools" and returns there. This
  // keeps the editing session a round-trip — add/resume a tool in a folder, then step
  // straight back into it — instead of dumping the user in the gallery.
  const fromFolder = returnTo !== '/';
  const backHref = fromFolder ? returnTo : '/';
  const backLabel = fromFolder ? 'Back' : 'Tools';

  // Populate inputs from user profile if they match profile field names
  const profile = await host.profile.get();
  const profileInputIds = (tool.manifest.inputs ?? []).map(i => i.id);
  for (const inputId of profileInputIds) {
    if (inputId in profile && !(inputId in initialValues)) {
      initialValues[inputId] = (profile as Record<string, InputValue>)[inputId]!;
    }
  }

  const runtime: ToolRuntime = await createRuntime(tool, host, initialValues);
  // A NEW session appears — the soft "twinkle bloom". Only a fresh open (no resume
  // slot); resuming a saved session is not "making" one. Audible when opened via a
  // click (audio is gesture-gated); a cold direct-URL load stays silent until a gesture.
  if (!slot) playSfx('newSession');

  // ── Undo / redo (Cmd+Z / Cmd+Shift+Z / Cmd+Y) ──────────────────────────────
  // Lets an accidental slider nudge — or any control edit — be reverted. There's
  // no shell-level chokepoint for edits: every control calls runtime.setInput
  // directly, so we wrap it once here to record before/after values. A slider
  // drag fires 'input' on every pixel, so rapid same-input changes coalesce (by
  // id + time) into a single step — one gesture, one undo. Restoring just replays
  // setInput, so the existing subscriber refreshes the sidebar + canvas for free
  // and the onInput hook re-derives any computed inputs (we never store those).
  const HISTORY_LIMIT = 100;
  const COALESCE_MS = 500;
  const undoStack: HistoryEntry[] = [];   // { id, label, before, after }
  const redoStack: HistoryEntry[] = [];
  let applyingHistory = false;
  let historyControls: HistoryControls | null = null;   // ↶/↷ buttons — header pair, or the editor's toolbar pair (set on mount)
  let historyToastEl: HTMLElement | null = null, historyToastTimer = 0;
  // Gesture continuity for coalescing, tracked SEPARATELY from stack entries: an
  // undo/redo leaves an old entry on top still carrying its original time, so if we
  // keyed coalescing off the entry the next edit could wrongly merge into it (losing
  // a state). applyHistory resets this, so a post-undo edit always starts fresh.
  let lastRecordId: string | null = null, lastRecordTime = 0;
  const refreshHistoryUI = () => historyControls?.sync(undoStack.length > 0, redoStack.length > 0);

  const cloneValue = (v: InputValue): InputValue => { try { return structuredClone(v); } catch { return v; } };
  const sameValue = (a: InputValue, b: InputValue): boolean => {
    if (a === b) return true;
    try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
  };
  // A value carrying raw file bytes (a `file` input's in-memory ref). We DON'T
  // record these: the ref's object URL is revoked when the input is replaced or
  // cleared and there's no durable id to re-resolve from, so a restored entry
  // would point at a dead URL — and deep-cloning megabytes per entry is
  // wasteful. A blob:/data: URL WITHOUT bytes is fine to record: asset refs
  // ({source, id, url}) re-derive their URL from the durable source+id, so
  // history stays live for asset picks and canvas boxes with images (the old
  // blob:-URL test here silently disabled ALL undo in Layout Studio once any
  // box image resolved through the asset-blob cache).
  const carriesBytes = (v: InputValue): boolean => {
    if (!v || typeof v !== 'object') return false;
    const rec = v as { bytes?: unknown };
    if (rec.bytes instanceof Uint8Array || rec.bytes instanceof ArrayBuffer) return true;
    return (Array.isArray(v) ? v : Object.values(v)).some(c => carriesBytes(c as InputValue));
  };

  const baseSetInput = runtime.setInput.bind(runtime);
  // Expose the UNWRAPPED setter on the runtime so other scopes (notably renderActions'
  // programmatic width/height px-sync) can set inputs without the change landing in the
  // undo history. baseSetInput itself is local to mountTool; this is the shared handle.
  runtime.setInputNoHistory = baseSetInput;
  runtime.setInput = (id: string, value: InputValue) => {
    if (!applyingHistory) {
      const cur = runtime.getModel().find(i => i.id === id);
      if (cur && !sameValue(cur.value, value) && !carriesBytes(value) && !carriesBytes(cur.value)) {
        const now = Date.now();
        const last = undoStack[undoStack.length - 1];
        if (last && lastRecordId === id && now - lastRecordTime < COALESCE_MS) {
          last.after = cloneValue(value);   // extend the gesture, keep its original `before`
        } else {
          // `label` (the input's human name) is what the toast shows on undo/redo.
          undoStack.push({ id, label: cur.label || cur.id, before: cloneValue(cur.value), after: cloneValue(value) });
          if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
        }
        lastRecordId = id; lastRecordTime = now;
        redoStack.length = 0;   // a fresh edit breaks the redo chain
        historyToastEl?.classList.remove('is-visible');   // dismiss a now-stale undo/redo toast
        refreshHistoryUI();
      }
    }
    return baseSetInput(id, value);
  };

  const applyHistory = (id: string, value: InputValue) => {
    applyingHistory = true;
    lastRecordId = null;   // an undo/redo ends any gesture — the next edit starts a new step
    try { runtime.setInput(id, cloneValue(value)); }
    finally { applyingHistory = false; }
  };
  const undoHistory = () => {
    const entry = undoStack[undoStack.length - 1];
    if (!entry) { showHistoryToast({ empty: 'undo' }); return; }
    undoStack.pop();
    redoStack.push(entry);
    applyHistory(entry.id, entry.before);
    showHistoryToast({ kind: 'undo', label: entry.label });
    refreshHistoryUI();
  };
  const redoHistory = () => {
    const entry = redoStack[redoStack.length - 1];
    if (!entry) { showHistoryToast({ empty: 'redo' }); return; }
    redoStack.pop();
    undoStack.push(entry);
    applyHistory(entry.id, entry.after);
    showHistoryToast({ kind: 'redo', label: entry.label });
    refreshHistoryUI();
  };

  // Transient bottom-centre toast confirming what was undone/redone, with a
  // one-tap counter-action (Redo after an undo, and vice-versa) — that button
  // doubles as the redo path on touch, where there's no keyboard. Reuses
  // announce() for the screen-reader side (the toast itself is aria-hidden to
  // avoid a double read). A single reused element; the timer resets on each call.
  const showHistoryToast = ({ kind, label, empty }: { kind?: 'undo' | 'redo'; label?: string; empty?: 'undo' | 'redo' }) => {
    if (!historyToastEl) {
      historyToastEl = document.createElement('div');
      historyToastEl.className = 'toast';
      historyToastEl.setAttribute('aria-hidden', 'true');
      document.body.appendChild(historyToastEl);
    }
    const el = historyToastEl;
    const wasVisible = el.classList.contains('is-visible');
    clearTimeout(historyToastTimer);
    if (empty) {
      el.classList.add('is-muted');
      el.innerHTML = `<span class="toast-message">Nothing to ${empty}</span>`;
      announce(`Nothing to ${empty}`);
    } else {
      el.classList.remove('is-muted');
      const verb = kind === 'undo' ? 'Undid' : 'Redid';
      const counter = kind === 'undo' ? 'Redo' : 'Undo';
      el.innerHTML =
        `<span class="toast-icon" aria-hidden="true">${kind === 'undo' ? ICON_UNDO : ICON_REDO}</span>` +
        `<span class="toast-message">${verb}<span class="toast-label"> ${escape(String(label))}</span></span>` +
        // tabindex=-1: the toast is aria-hidden (announce() drives SR) so this button
        // must not become a phantom tab stop; it stays pointer-clickable for touch/mouse.
        `<button type="button" class="toast-action" tabindex="-1">${counter}</button>`;
      el.querySelector('.toast-action')!.addEventListener('click', () => {
        kind === 'undo' ? redoHistory() : undoHistory();
      });
      announce(`${verb} ${label}`);
    }
    // Animate the slide-in only when coming from hidden; if it's already showing
    // (rapid undo/redo), just swap the content and reset the timer — no flicker.
    if (!wasVisible) void el.offsetWidth;   // flush the base state so the transition plays
    el.classList.add('is-visible');
    historyToastTimer = setTimeout(() => el.classList.remove('is-visible'), empty ? 1400 : 2200);
  };

  const onHistoryKey = (e: KeyboardEvent) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    const k = e.key.toLowerCase();
    const redo = k === 'y' || (k === 'z' && e.shiftKey);
    const undo = k === 'z' && !e.shiftKey;
    if (!undo && !redo) return;
    // Free-text fields keep their own per-character undo; sliders, selects,
    // colours and checkboxes have no useful native undo, so we own those.
    if (isTextEditing()) return;
    e.preventDefault();
    redo ? redoHistory() : undoHistory();
  };
  window.addEventListener('keydown', onHistoryKey);

  const nativeW     = tool.manifest.render.width;
  const nativeH     = tool.manifest.render.height;
  const hasInputs   = (tool.manifest.inputs?.length ?? 0) > 0;
  const noExport    = tool.manifest.render.export === false;
  // Whether this tool persists a saved session — drives the Save half of the
  // render pill. Mirrors renderActions: the default action set includes 'save',
  // and an explicit empty actions list (opted-out file utilities) excludes it.
  const canSaveSession = (tool.manifest.render.actions ?? ['copy', 'download', 'save']).includes('save');
  const canvasLayout = tool.manifest.render.layout === 'canvas';
  // The WYSIWYG "editor" layout: a chromeless full-canvas surface (no input
  // sidebar) that KEEPS the fixed render canvas + the full render/export
  // scaffolding, so it exports like a normal tool. The direct-manipulation overlay
  // (select / drag / resize / rotate / z-order / align) is mounted below.
  const editorLayout = tool.manifest.render.layout === 'editor';
  // The blocks input the editor manipulates directly (carries the `canvas` flag).
  const canvasEditInput = editorLayout
    ? tool.manifest.inputs?.find(i => i.type === 'blocks' && i.canvas)
    : null;
  // Multi-page ("carousel") editor: an editor-layout tool whose canvas is a horizontal
  // strip of N same-size [data-pdf-page] frames (render.pages). The overlay places boxes
  // across all frames; export fans out to a multi-page PDF or one still image per page.
  const pagesCfg = (editorLayout && canvasEditInput) ? tool.manifest.render.pages : undefined;
  const pagesMode = !!pagesCfg;
  // A fixed-size editor canvas (no resize control): the canvas input opts in via
  // canvas.fixedCanvas. Connector tools (Org Chart) set this so their rendered
  // connector <svg>'s viewBox stays 1:1 with box coordinates (a resized canvas would
  // scale the lines away from the boxes). Treated like carousel mode for sizing.
  const fixedCanvasMode = !!(canvasEditInput && (canvasEditInput as { canvas?: { fixedCanvas?: boolean } }).canvas?.fixedCanvas);
  // The multi-page rich-text document layout (render.layout:'document', e.g. Doc
  // Studio): chromeless like 'editor', but mounts a TipTap rich-document editor
  // (doc-editor.js) over the tool's `content` input, which stores the document as
  // portable ProseMirror JSON. The engine hook renders that JSON into paged
  // [data-pdf-page] boxes, so export / CLI / previews work without the editor.
  const documentLayout = tool.manifest.render.layout === 'document';
  const docEditInput = documentLayout
    ? (tool.manifest.inputs?.find(i => i.id === 'content') ?? tool.manifest.inputs?.find(i => i.type === 'blocks'))
    : null;
  // Both chromeless full-canvas layouts drop the input aside but keep the fixed render
  // canvas + export controls; the on-canvas overlay replaces the sidebar.
  const chromeless = editorLayout || documentLayout;
  // Hide the sidebar for pure-canvas utilities: either no inputs at all, or an
  // explicit canvas layout — where the tool's single file input becomes a
  // drag-and-drop / click-to-pick zone on the canvas itself (setupCanvasFileDrop).
  // NOTE: editorLayout is deliberately NOT hideSidebar — it needs the live canvas
  // node + export UI. It only removes the input aside (via showAside below).
  const hideSidebar = (noExport && !hasInputs) || canvasLayout;
  // A standard sidebar tool whose template stacks several [data-pdf-page] boxes
  // (render.paged — e.g. multi-page-pdf). Unlike the editorLayout carousel (pagesMode,
  // pages side-by-side) it renders through the ordinary render path; the difference is
  // purely how the STAGE presents it — the whole document laid out at full length in a
  // vertical scroll surface, rather than one page's worth clipped with an inner scroll.
  // The one-page sizing of each box is kept (that's what export reads); it just stops
  // bounding what the editor shows. Excludes the chromeless editor/document layouts,
  // which own their own canvas presentation.
  const pagedDoc = tool.manifest.render.paged === true && !chromeless && !hideSidebar;
  // Whether the input aside is present. Chromeless modes drop it but aren't hideSidebar.
  const showAside = !hideSidebar && !chromeless;
  const noAside   = !showAside;   // no visible input aside (hidden-canvas OR editor)
  // The one declared file input a canvas-layout tool presents as that drop zone.
  const canvasFileInput = canvasLayout ? tool.manifest.inputs?.find(i => i.type === 'file') : null;
  // A sidebar tool with a `dropToAdd` blocks input (e.g. logo-wall) also turns its
  // canvas into a drop zone, so a pile of images can be dropped straight onto the
  // (usually empty) preview — not only onto the sidebar list. Canvas-layout file
  // utilities use canvasFileInput above instead, so they're excluded here.
  const canvasDropInput = !canvasFileInput
    ? tool.manifest.inputs?.find(i => i.type === 'blocks' && i.dropToAdd?.field
        && (i.fields ?? []).some(f => f.id === i.dropToAdd!.field && f.type === 'asset'))
    : null;

  // On-device utilities (privacy:'on-device') carry an honest, prominent badge —
  // the user's content is processed locally and never uploaded. It's the single
  // most reassuring thing on screen for someone used to handing files to strangers.
  const onDevice = tool.manifest.privacy === 'on-device';
  const privacyBadge = onDevice
    ? `<div class="on-device-badge" title="This tool runs entirely in your browser. Your file is never uploaded.">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
        <span>Runs on your device — nothing is uploaded</span>
      </div>`
    : '';

  // The canvas is the visual OUTPUT (the editable interface is the sidebar), so
  // it's exposed to screen readers as a single role="img" with a text summary.
  // Authors can declare a live Handlebars summary (manifest.a11yLabel); otherwise
  // it's "<name> preview". Kept current in the render subscriber below.
  const canvasLabel = (): string => {
    if (!tool.manifest.a11yLabel) return `${tool.manifest.name} preview`;
    // Handlebars HTML-escapes {{values}}; an aria-label is plain text, so decode
    // the entities back (it's set via setAttribute, not innerHTML).
    const custom = runtime.getHydratedString(tool.manifest.a11yLabel)
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#(?:39|x27);/g, "'").trim();
    return custom || `${tool.manifest.name} preview`;
  };

  const SIDEBAR_DEFAULT = 272;
  const SIDEBAR_MIN     = 40;
  const savedWidth  = Number(localStorage.getItem('sidebarWidth') ?? SIDEBAR_DEFAULT);
  // The desktop export panel anchors to the sidebar's bottom edge, so ?options
  // needs the sidebar open even if this device last left it collapsed (width 0).
  const sidebarOpen = (isFull || hideSidebar || chromeless) ? false : (showExportPanel || savedWidth > 0);
  const openWidth   = savedWidth > 0 ? savedWidth : SIDEBAR_DEFAULT;

  // A saved design (or a shared URL) can reference an image the user has since
  // deleted from their device library. The runtime resolves those to null and
  // reports them here; tell the user the field was left blank rather than leaving
  // a silent gap.
  const dropped = runtime.droppedAssets ?? [];
  const droppedLabels = dropped.map(d => d.label).join(', ');
  const droppedNotice = dropped.length ? `
    <div class="tool-notice" role="status" id="dropped-assets-notice">
      <span class="tool-notice-text">An image used in this saved design is no longer available, so the <strong>${escape(droppedLabels)}</strong> ${dropped.length > 1 ? 'fields were' : 'field was'} left blank.</span>
      <button type="button" class="tool-notice-close" id="dropped-assets-dismiss" aria-label="Dismiss this message">✕</button>
    </div>` : '';

  viewEl.innerHTML = `
    ${noAside ? `<a href="${escape(backHref)}" class="tools-home home-full">${backLabel}</a>` : ''}
    <div class="tool-layout${chromeless ? ' is-editor' : ''}${documentLayout ? ' is-document' : ''}${pagedDoc ? ' is-paged' : ''}" id="tool-layout"${documentLayout ? ' data-theme="light"' : ''} data-sidebar="${noAside ? 'hidden' : (sidebarOpen ? 'open' : 'closed')}">
      ${showAside ? `
        <aside class="sidebar" id="tool-sidebar">
          <div class="sidebar-header">
            <div class="sidebar-back-row">
              <a href="${escape(backHref)}" class="tools-home sidebar-back">${backLabel}</a>
            </div>
            <div class="sidebar-header-row">
              <span class="sidebar-title">${escape(tool.manifest.name)}</span>
              <button class="fullscreen-toggle" id="fullscreen-toggle" ${sidebarOpen ? 'open' : ''} aria-label="${sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}"></button>
            </div>
          </div>
          <div class="sidebar-body">
            ${privacyBadge}
            ${droppedNotice}
            <div id="tool-inputs" class="tool-inputs"></div>
            ${hasInputs ? `
              <div class="sidebar-utils" id="sidebar-utils">
                <button type="button" id="clear-inputs-btn" class="clear-inputs-btn" title="Reset all inputs to defaults">Clear changes</button>
              </div>
            ` : ''}
            <div class="tool-actions" id="tool-actions"></div>
          </div>
          <div class="sidebar-drag-handle" id="sidebar-drag-handle"></div>
        </aside>
        <!-- Grip lives OUTSIDE the sheet (it's position:fixed): keeps it from being
             clipped by the sheet's overflow, which must stay hidden so the form
             can't spill past the sheet's rounded edge. -->
        <button type="button" class="sheet-grip" id="sheet-grip" aria-label="Drag to resize controls, tap to expand"></button>
      ` : (chromeless ? `<div class="tool-actions" id="tool-actions"></div>` : '')}
      <div class="tool-stage" id="tool-stage">
        ${showAside ? `<button class="fullscreen-toggle-float" id="fullscreen-toggle-float" aria-label="Expand sidebar"></button>` : ''}
        ${hideSidebar && onDevice ? `<div class="on-device-badge on-device-badge--float" title="This tool runs entirely in your browser. Your file is never uploaded.">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
          <span>Runs on your device — nothing is uploaded</span>
        </div>` : ''}
        ${hideSidebar ? `<div id="tool-content" role="img" aria-label="${escape(canvasLabel())}"></div>` : `
        <div class="tool-canvas-outer" id="tool-canvas-outer">
          <div class="tool-canvas" id="tool-canvas" role="img" aria-label="${escape(canvasLabel())}"
               style="width: ${nativeW}px; height: ${nativeH}px;"></div>
        </div>`}
      </div>
      ${!hideSidebar ? `
        <div class="render-pill" id="render-pill" role="group" aria-label="Export and save">
          <button type="button" class="render-pill-btn render-pill-get" id="render-fab" data-sfx="hydraulicOpen" aria-label="Export options">
            <svg class="render-pill-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>
            <span>Export</span>
          </button>
          ${canSaveSession ? `
          <span class="render-pill-sep" aria-hidden="true"></span>
          <button type="button" class="render-pill-btn render-pill-save" id="render-save" data-sfx="save" aria-label="Save to your library" title="Save to your library">
            <svg class="render-pill-icon render-pill-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
            <span data-save-label>Save</span>
          </button>` : ''}
        </div>
        <div class="export-overlay" id="export-overlay">
          <div class="export-overlay-scrim" data-export-close></div>
          <div class="export-popup" role="dialog" aria-modal="true" aria-label="Export">
            <div class="export-popup-head">
              <span class="export-popup-title">Export</span>
              <button type="button" class="export-popup-close" data-export-close aria-label="Close">&#x2715;</button>
            </div>
            <div class="export-popup-body" id="export-popup-body"></div>
          </div>
        </div>
      ` : ''}
    </div>
  `;

  const canvasScope = hideSidebar ? '#tool-content' : '#tool-canvas';

  const styleEl = document.createElement('style');
  {
    const toolCss = tool.styles ? scopeCss(tool.styles, canvasScope) : '';
    // The chromeless editors own their own on-canvas affordances (free-canvas.js /
    // doc-editor.js), so skip the generic click-to-focus hover outline.
    const focusHint = chromeless ? '' : `
${canvasScope} [data-canvas-input] { cursor: pointer; }
${canvasScope} [data-canvas-input]:hover { outline: 2px dashed rgba(128,128,128,0.35); outline-offset: 3px; border-radius: 2px; }`;
    styleEl.textContent = `${toolCss}${focusHint}`;
    document.head.appendChild(styleEl);
  }

  const layout    = viewEl.querySelector<HTMLElement>('#tool-layout')!;
  const inputsEl  = viewEl.querySelector<PanelEl>('#tool-inputs');
  const canvasEl  = hideSidebar ? null : viewEl.querySelector<HTMLElement>('#tool-canvas');
  const outerEl   = hideSidebar ? null : viewEl.querySelector<HTMLElement>('#tool-canvas-outer');
  const contentEl = (hideSidebar ? viewEl.querySelector<HTMLElement>('#tool-content') : canvasEl)!;
  // Always present in the template (both layouts render #tool-stage), so treat it
  // as non-null — mirrors mountTool's unguarded uses (ro.observe, fitCanvas, …).
  const stageEl   = viewEl.querySelector<HTMLElement>('#tool-stage')!;

  // Undo / redo buttons in the header — the tappable counterpart to Cmd+Z/Cmd+Y,
  // and the primary way to trigger history on touch (no keyboard). Sit at the
  // right of the back-row, opposite the Tools pill. Each button stays
  // disabled while its stack is empty (refreshHistoryUI), and clicks route through
  // the same undoHistory/redoHistory the keyboard uses (so they show the toast too).
  // Only sidebar tools get the header pair. Editor-layout tools have no back-row —
  // their buttons live in the free-canvas toolbar rail instead (see the history
  // option passed to initFreeCanvas below). Plain hideSidebar tools (file
  // utilities with minimal inputs) stay keyboard-only.
  const backRow = viewEl.querySelector<HTMLElement>('.sidebar-back-row');
  if (backRow) {
    const group = document.createElement('div');
    group.className = 'history-controls';
    const mkBtn = (label: string, icon: string, onClick: () => void): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'history-btn';
      b.setAttribute('aria-label', label);
      b.title = label;
      b.innerHTML = icon;
      b.addEventListener('click', onClick);
      group.appendChild(b);
      return b;
    };
    const undoBtn = mkBtn('Undo', ICON_UNDO, undoHistory);
    const redoBtn = mkBtn('Redo', ICON_REDO, redoHistory);
    historyControls = {
      sync: (canUndo: boolean, canRedo: boolean) => {
        // If the button that ran the action is about to disable itself (e.g. the
        // last undo via keyboard), hand focus to its now-enabled sibling so a
        // disabled button doesn't drop focus to <body>.
        const active = document.activeElement;
        if (active === undoBtn && !canUndo && canRedo) redoBtn.focus();
        else if (active === redoBtn && !canRedo && canUndo) undoBtn.focus();
        undoBtn.disabled = !canUndo;
        redoBtn.disabled = !canRedo;
      },
    };
    backRow.appendChild(group);
    refreshHistoryUI();   // start disabled (empty history)
  }

  // Theme cycle toggle now lives in the canvas zoom HUD (setupStageNav below), not
  // the sidebar header — so it's shared by every canvas tool (including the
  // chromeless editor/Layout Studio, which has no sidebar) and the header stays
  // uncluttered. Built once here so setupStageNav can dock it into the HUD.
  const themeToggle = createThemeToggle(host as unknown as Parameters<typeof createThemeToggle>[0]);
  // The interface-sound (sfx) toggle rides the same HUD, right after the theme toggle, so
  // the editor/Layout Studio (which has no sidebar) can mute/unmute sounds from the canvas.
  const soundToggle = createSoundToggle(host as unknown as Parameters<typeof createSoundToggle>[0]);

  // Removed-image notice: announce it (live region) and let the user dismiss it.
  if (dropped.length) {
    announce(`An image used in this saved design is no longer available; the ${droppedLabels} ${dropped.length > 1 ? 'fields were' : 'field was'} left blank.`, { assertive: true });
    viewEl.querySelector('#dropped-assets-dismiss')
      ?.addEventListener('click', () => viewEl.querySelector('#dropped-assets-notice')?.remove());
  }

  // Export shutter: a camera-iris that closes over the whole stage so the brief
  // full-res resize during export (the "shake") is never seen, then opens.
  const SHUTTER_FLAPS = 6;
  let shutterEl: HTMLDivElement | null = null;
  if (stageEl) {
    shutterEl = document.createElement('div');
    shutterEl.className = 'export-shutter';
    shutterEl.setAttribute('aria-hidden', 'true');
    shutterEl.innerHTML = Array.from({ length: SHUTTER_FLAPS },
      (_, i) => `<span class="flap" style="--i:${i}"></span>`).join('');
    stageEl.appendChild(shutterEl);
  }
  const SHUTTER_MS = 430; // ≥ the .flap transition (0.42s) so it's fully closed/open
  const shutterFullscreen = (): boolean => window.matchMedia('(max-width: 640px)').matches;
  function closeShutter(): Promise<void> {
    if (!shutterEl) return Promise.resolve();
    // Mobile: lift the shutter out of the stage so it covers the WHOLE screen —
    // over the sidebar sheet and export controls — for a more engaging capture.
    // (An ancestor's backdrop-filter is a fixed-positioning containing block, so
    // moving to <body> is what actually reaches the viewport.) Desktop: unchanged,
    // the shutter stays scoped to the stage.
    if (shutterFullscreen()) {
      document.body.appendChild(shutterEl);
      shutterEl.classList.add('export-shutter--fullscreen');
    }
    shutterEl.classList.add('is-active');
    void shutterEl.offsetWidth;          // reflow so the transition starts from "open"
    shutterEl.classList.add('is-closed');
    playSfx('shutter');                  // the satisfying ka-chunk, synced to the iris closing
    return new Promise(r => setTimeout(r, SHUTTER_MS));
  }
  function openShutter(): void {
    if (!shutterEl) return;
    shutterEl.classList.remove('is-closed');                          // sweep back out
    setTimeout(() => {
      shutterEl!.classList.remove('is-active');                       // then unmount
      if (shutterEl!.classList.contains('export-shutter--fullscreen')) {
        shutterEl!.classList.remove('export-shutter--fullscreen');
        stageEl?.appendChild(shutterEl!);                             // back into the stage
      }
    }, SHUTTER_MS);
  }
  // Standalone visual (no export gating) — used by Copy, whose clipboard write
  // must stay in the user-gesture context, so we can't await the shutter first.
  function playShutter(): void { closeShutter().then(openShutter); }
  const actionsEl  = viewEl.querySelector<PanelEl>('#tool-actions');
  const sidebarEl  = viewEl.querySelector<HTMLElement>('#tool-sidebar');

  // ── Sidebar ──────────────────────────────────────────────────────────────

  const fullscreenToggle      = viewEl.querySelector<HTMLButtonElement>('#fullscreen-toggle');
  const fullscreenToggleFloat = viewEl.querySelector<HTMLButtonElement>('#fullscreen-toggle-float');
  const dragHandle            = viewEl.querySelector<HTMLElement>('#sidebar-drag-handle');
  const sheetGrip             = viewEl.querySelector<HTMLElement>('#sheet-grip');

  function setSidebarWidth(w: number, save = true): void {
    if (!sidebarEl) return;
    const snapped = w < SIDEBAR_MIN ? 0 : w;
    sidebarEl.style.width = snapped + 'px';
    // Freeze the content width at the open size so collapsing to 0 clips rather
    // than reflows (kept on collapse — only updated while the panel is open).
    if (snapped > 0) sidebarEl.style.setProperty('--sb-open-w', snapped + 'px');
    // Publish the open width so the desktop export panel can match the sidebar.
    if (snapped > 0) layout.style.setProperty('--sidebar-w', snapped + 'px');
    const isOpen = snapped > 0;
    layout.dataset.sidebar = isOpen ? 'open' : 'closed';
    if (fullscreenToggle) {
      fullscreenToggle.toggleAttribute('open', isOpen);
      fullscreenToggle.setAttribute('aria-label', isOpen ? 'Collapse sidebar' : 'Expand sidebar');
    }
    if (save) localStorage.setItem('sidebarWidth', String(snapped));
  }

  // Canonical address-bar URL for this open tool: the path form /t/<id> (so a copied
  // link carries the per-tool OG preview — see scripts/build-tool-og.ts). All in-tool
  // URL writers (syncUrl, updateFullParam) build on this; the bar is rewritten from
  // the boot-time #/tool/<id> hash to this on the first syncUrl.
  const TOOL_URL_BASE = `/t/${toolId}`;

  // The live param string, whichever URL form the bar is in: the path's ?search once
  // syncUrl has prettified it, or the hash's #…?query in the instant after boot.
  function currentQuery(): string {
    if (window.location.search) return window.location.search.slice(1);
    const qi = window.location.hash.indexOf('?');
    return qi >= 0 ? window.location.hash.slice(qi + 1) : '';
  }

  function getRestoreWidth(): number {
    const v = Number(localStorage.getItem('sidebarWidth'));
    return v > SIDEBAR_MIN ? v : SIDEBAR_DEFAULT;
  }

  function updateFullParam(shouldBeFull: boolean): void {
    const sp = new URLSearchParams(currentQuery());
    if (shouldBeFull) sp.set('full', ''); else sp.delete('full');
    const parts: string[] = [];
    for (const [k, v] of sp.entries()) parts.push(v ? `${k}=${encodeURIComponent(v)}` : k);
    const q = parts.join('&');
    history.replaceState(null, '', q ? `${TOOL_URL_BASE}?${q}` : TOOL_URL_BASE);
  }

  // Canvas pan/zoom handle for the stage, assigned once the canvas is wired
  // (see setupStageNav below). Reset whenever the stage is resized by a
  // sidebar toggle so the preview returns to a clean fit.
  let stageZoom: StageNav | null = null;

  if (showAside) {
    fullscreenToggle!.addEventListener('click', () => {
      const opening = layout.dataset.sidebar !== 'open';
      setSidebarWidth(opening ? getRestoreWidth() : 0);
      updateFullParam(!opening);
      stageZoom?.reset();
      setTimeout(fitCanvas, 220);
    });

    fullscreenToggleFloat!.addEventListener('click', () => {
      setSidebarWidth(getRestoreWidth());
      updateFullParam(false);
      stageZoom?.reset();
      setTimeout(fitCanvas, 220);
    });

    // Drag to resize
    {
      let dragging = false;
      let startX = 0;
      let startW = 0;

      dragHandle!.addEventListener('pointerdown', e => {
        dragging = true;
        startX = e.clientX;
        startW = sidebarEl!.getBoundingClientRect().width;
        sidebarEl!.classList.add('is-dragging');
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        dragHandle!.setPointerCapture(e.pointerId);
      });

      dragHandle!.addEventListener('pointermove', e => {
        if (!dragging) return;
        const w = Math.min(600, Math.max(0, startW + (e.clientX - startX)));
        setSidebarWidth(w, false);
      });

      dragHandle!.addEventListener('pointerup', () => {
        if (!dragging) return;
        dragging = false;
        sidebarEl!.classList.remove('is-dragging');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        setSidebarWidth(sidebarEl!.getBoundingClientRect().width);
        fitCanvas();
      });
    }

    // Apply saved/initial width without triggering a save
    setSidebarWidth(sidebarOpen ? openWidth : 0, false);
  }

  // ── Responsive canvas ─────────────────────────────────────────────────────
  //
  // The canvas stays at its DOM-declared pixel dimensions so that CSS
  // getComputedStyle and exports work correctly. A CSS transform scales it
  // visually to fit the available stage width. The outer wrapper is sized to
  // the visual (scaled) dimensions so the layout doesn't leave a gap.

  function fitCanvas(): void {
    if (!canvasEl || !outerEl) return;
    if (stageZoom?.isZoomed()) return; // preserve pan/zoom across window/sidebar resize
    if (pagesMode) { fitPages(); return; } // carousel: fit the page strip, not one page
    if (pagedDoc) { fitPagedDoc(); return; } // multi-page doc: fit one page's width; the stage scrolls
    const canvasW   = parseInt(canvasEl.style.width,  10) || nativeW;
    const canvasH   = parseInt(canvasEl.style.height, 10) || nativeH;
    const stageRect = stageEl.getBoundingClientRect();

    // On mobile the controls sheet overlaps the top of the (static) preview stage.
    // Pad the stage down by however much the sheet currently covers it, so Fit
    // sizes AND centres the canvas within the area the sheet leaves visible — not
    // behind it. getBoundingClientRect is the border-box (padding-independent), so
    // the scale math stays stable as we set the padding.
    let topPad = 0;
    if (sidebarEl && window.matchMedia('(max-width: 640px)').matches) {
      const sheetBottom = sidebarEl.getBoundingClientRect().bottom;
      topPad = Math.max(0, Math.min(stageRect.height, sheetBottom - stageRect.top));
    }
    const padPx = topPad ? `${topPad}px` : '';
    if (stageEl.style.paddingTop !== padPx) stageEl.style.paddingTop = padPx; // guard the ResizeObserver

    const availW    = Math.max(40, stageRect.width  - 32);
    const availH    = Math.max(40, stageRect.height - topPad - 32);
    const scale     = Math.min(1, availW / canvasW, availH / canvasH);
    canvasEl.style.transform = scale < 1 ? `scale(${scale.toFixed(4)})` : '';
    outerEl.style.width  = Math.round(canvasW * scale) + 'px';
    outerEl.style.height = Math.round(canvasH * scale) + 'px';
    stageZoom?.sync(); // refresh the zoom % readout after a re-fit
  }

  // Reset pan/zoom and re-fit. Passed to renderActions so a dimension change always
  // returns to a clean fitted view rather than leaving a panned/zoomed canvas.
  function resetView(): void {
    stageZoom?.reset();
    fitCanvas();
  }

  // ── Multi-page document canvas (render.paged) ──────────────────────────────
  // A paged tool stacks its [data-pdf-page] boxes vertically and the STAGE scrolls the
  // whole document — every page visible at full length, not one page clipped with an
  // inner scroll (the old behaviour where pages "appeared out of nowhere"). We fit ONE
  // page's width to the surface with `zoom` (not a transform: zoom shrinks the layout
  // box too, so the scroll surface measures the pages at their on-screen size and scrolls
  // correctly). Height grows via CSS (#tool-canvas + its root are height:auto here), so
  // adding a page just makes the surface taller. `zoom` is neutralised during export
  // (exportUnscaled) so each page still prints at its true, unscaled page size.
  function fitPagedDoc(): void {
    if (!canvasEl) return;
    const stageRect = stageEl.getBoundingClientRect();
    // Leave the surface's side padding (24px each) PLUS room for each page's drop-shadow,
    // so the left/right shadows aren't clipped by the scroll surface.
    const availW = Math.max(40, stageRect.width - 96);
    const zoom = Math.min(1, availW / nativeW);          // never upscale past 1:1
    canvasEl.style.zoom = zoom < 1 ? String(Number(zoom.toFixed(4))) : '';
    stageZoom?.sync();
  }

  // ── Multi-page (carousel) canvas ──────────────────────────────────────────
  // The editor canvas is a horizontal strip of N same-size page frames. render.width/
  // height stay ONE page's size (each [data-pdf-page] frame + PDF page is page-sized);
  // the STRIP width is derived from the live page-count + page-size inputs and applied
  // to #tool-canvas so the free-canvas overlay's coordinate math (which reads
  // canvasEl.style.width) stays correct. Fit shows up to three pages at a workable size
  // (fit-to-single-page is off) — the zoom/pan HUD reaches the rest.
  function pageGeom(): { count: number; pw: number; ph: number; gap: number; stripW: number } {
    const cfg = pagesCfg!;
    const gap = cfg.gap ?? 56;
    const min = cfg.min ?? 1, max = cfg.max ?? 6;
    const read = (id: string, dflt: number): number => {
      const v = runtime.getModel().find(i => i.id === id)?.value;
      const n = typeof v === 'number' ? v : parseFloat(v as string);
      return Number.isFinite(n) ? n : dflt;
    };
    const count = Math.max(min, Math.min(max, Math.round(read(cfg.count, 3))));
    const pw = Math.max(1, Math.round(read(cfg.width, nativeW)));
    const ph = Math.max(1, Math.round(read(cfg.height, nativeH)));
    return { count, pw, ph, gap, stripW: count * pw + (count - 1) * gap };
  }
  function fitPages(): void {
    if (!canvasEl || !outerEl || !pagesCfg) return;
    const g = pageGeom();
    const stageRect = stageEl.getBoundingClientRect();
    const availW = Math.max(40, stageRect.width - 32);
    const availH = Math.max(40, stageRect.height - 32);
    // Fit up to three pages wide (identical to the whole strip when count ≤ 3); the
    // strip scales as one unit (transform-origin: top left) so overlay geometry holds.
    const shown = Math.min(g.count, 3);
    const viewW = shown * g.pw + (shown - 1) * g.gap;
    const scale = Math.min(1, availW / viewW, availH / g.ph);
    canvasEl.style.transform = scale !== 1 ? `scale(${scale.toFixed(4)})` : '';
    outerEl.style.width  = Math.round(g.stripW * scale) + 'px';
    outerEl.style.height = Math.round(g.ph * scale) + 'px';
    stageZoom?.sync();
  }
  // (Re)size #tool-canvas to the current page strip and re-fit. Only fires when the
  // strip dimensions actually change (page count / size), so an ordinary box edit
  // never resets the view.
  let prevStripKey = '';
  function syncStrip(): void {
    if (!pagesMode || !canvasEl) return;
    const g = pageGeom();
    const key = g.stripW + 'x' + g.ph;
    if (key === prevStripKey) return;
    prevStripKey = key;
    canvasEl.style.width  = g.stripW + 'px';
    canvasEl.style.height = g.ph + 'px';
    stageZoom?.reset();
    fitPages();
  }
  if (pagesMode) syncStrip();   // size the strip before the first fit

  const ro = new ResizeObserver(fitCanvas);
  ro.observe(stageEl);
  fitCanvas();
  if (canvasEl) canvasEl.addEventListener('canvas-resize', fitCanvas);

  // Canvas navigation — one module for both pointer types. Touch gets pinch-zoom +
  // drag-pan; desktop gets trackpad-native zoom/pan (Cmd/Ctrl-wheel & pinch zoom
  // about the cursor, Space/middle-drag pan, 0/1/+/- keys) plus a Fit/% HUD.
  if (stageEl && !hideSidebar && outerEl && canvasEl && !pagedDoc) {
    // Pass fitCanvas as the "fit" action so the HUD's Fit button re-fits to the
    // CURRENT layout (e.g. the area left by the mobile sheet), not just the
    // stale fit that reset() restores. themeToggle docks into the HUD (its icon
    // sits alongside the zoom controls; see setupStageNav).
    stageZoom = setupStageNav(stageEl, outerEl, canvasEl, nativeW, fitCanvas, themeToggle, soundToggle);
  } else if (stageEl && pagedDoc && (themeToggle || soundToggle)) {
    // Paged docs navigate by NATIVE scroll of the canvas surface (no pan/zoom transform),
    // so there's no zoom HUD — but the theme / sound toggles still dock in the same
    // bottom-right cluster every canvas tool carries.
    const hud = document.createElement('div');
    hud.className = 'stage-nav stage-nav--chrome';
    if (themeToggle) hud.append(themeToggle);
    if (soundToggle) hud.append(soundToggle);
    stageEl.appendChild(hud);
  }

  // Mobile (≤640px): the sidebar becomes a top-anchored controls panel with the
  // grip on its bottom edge; the preview fills below. Dragging the grip down grows
  // the controls (grip tracks the finger), releasing snaps to peek/half/full, and
  // the preview re-fits to whatever space the panel leaves.
  if (!hideSidebar && sheetGrip && sidebarEl) {
    // The preview is a static backdrop the sheet slides over, so half/full snaps
    // leave it untouched. But collapsing to peek (grip dragged to the top) vacates
    // most of the screen — re-fit there so the canvas grows into the freed space.
    // fitCanvas no-ops if the user has zoomed/panned, so this only fires at Fit.
    // Wait out the 0.34s height settle so it measures the final sheet position.
    setupMobileSheet(layout, sidebarEl, sheetGrip, (snap) => {
      if (snap === 'peek') setTimeout(fitCanvas, 360);
    });
  }

  // Collapse the export/actions panel behind a "Render" button on BOTH mobile and
  // desktop: the wired #tool-actions node moves into the popup (its listeners
  // survive the move). Mobile presents it as a full-screen sheet; desktop as a
  // non-modal panel anchored to the sidebar bottom — pure CSS difference (app.css).
  let exportTeardown: (() => void) | null = null;
  // The "Save" half of the render pill — assigned just below, but declared out here
  // so the dirty-state helpers (markSessionDirty / markSessionSaved, defined later)
  // can flash and clear it from the input-change chokepoint.
  let renderSaveBtn: HTMLButtonElement | null = null;
  const renderPill    = viewEl.querySelector<HTMLElement>('#render-pill');
  const renderFab     = viewEl.querySelector<HTMLButtonElement>('#render-fab');   // the "Export" half (opens export)
  renderSaveBtn       = viewEl.querySelector<HTMLButtonElement>('#render-save');  // the "Save" half (outer-scoped)
  const exportOverlay = viewEl.querySelector<HTMLElement>('#export-overlay');
  const exportBody    = viewEl.querySelector<HTMLElement>('#export-popup-body');
  if (!hideSidebar && renderFab && exportOverlay && exportBody && actionsEl && renderPill) {
    const mqMobile    = window.matchMedia('(max-width: 640px)');
    const exportPopup = exportOverlay.querySelector<HTMLElement>('.export-popup')!;
    // The export panel is modal ONLY on mobile, where it's a full bottom sheet over a
    // scrim. On desktop it's a NON-modal panel anchored to the sidebar bottom — the
    // inputs above and the resize handle must stay live (users routinely open Export,
    // then go back to editing before downloading), so we neither inert the background
    // nor trap Tab there. The markup hard-codes aria-modal; we correct it per
    // breakpoint here. applyModality reconciles inert + aria-modal with both the open
    // state and the current breakpoint, so it's safe to re-run on resize too.
    const isModal = (): boolean => mqMobile.matches;
    const applyModality = (): void => {
      const modal = layout.classList.contains('export-open') && isModal();
      for (const child of layout.children) {
        if (child !== exportOverlay) (child as HTMLElement).inert = modal;   // pointer + Tab blocked behind the sheet
      }
      exportPopup.setAttribute('aria-modal', modal ? 'true' : 'false');
    };
    const closeExport = (): void => {
      const wasOpen = layout.classList.contains('export-open');
      layout.classList.remove('export-open');
      renderFab.setAttribute('aria-expanded', 'false');
      actionsApi?.stopAudioPreview?.(); // silence any audio audition when the popup closes
      // The pneumatic 'pushhh' as the door seals shut — here (not on the close controls)
      // so every dismissal path (✕, scrim, Escape, flick-down) sounds it exactly once, and
      // only when a panel was actually open (defensive/duplicate closes stay silent). The
      // matching 'shhhht' open rides the trigger's data-sfx, which every open path clicks.
      if (wasOpen) playSfx('hydraulicClose');
      applyModality();                 // un-inert before returning focus to the trigger
      // Return focus to the trigger. In editor mode the render pill is hidden, so
      // the rail Export icon (which opened the popup) is the real trigger.
      const focusTarget = (chromeless ? viewEl.querySelector<HTMLElement>('.fc-action-primary') : null) ?? renderFab;
      focusTarget.focus();
    };
    const openExport = ({ focus = true }: { focus?: boolean } = {}): void => {
      layout.classList.add('export-open');
      renderFab.setAttribute('aria-expanded', 'true');
      applyModality();
      // Move focus into the dialog (its close button) for keyboard/SR users — but
      // not when auto-opened from ?options on load, where grabbing focus is jarring.
      if (focus) exportOverlay.querySelector<HTMLElement>('.export-popup-close')?.focus();
    };
    // Actions live in the Render popup on every breakpoint. The Get|Save pill
    // lives INSIDE the sidebar on desktop (a centred footer) but must sit OUTSIDE
    // it on mobile, where it's a viewport FAB the sheet's overflow would clip.
    const placeActions = (): void => {
      if (actionsEl.parentElement !== exportBody) exportBody.appendChild(actionsEl);
      // No sidebar in chromeless modes → the pill floats over the stage (like mobile).
      const fabDest = (mqMobile.matches || chromeless || !sidebarEl) ? layout : sidebarEl;
      if (renderPill.parentElement !== fabDest) fabDest.appendChild(renderPill);
    };
    renderFab.setAttribute('aria-haspopup', 'dialog');
    renderFab.setAttribute('aria-expanded', 'false');
    renderFab.addEventListener('click', () => openExport());
    exportOverlay.querySelectorAll('[data-export-close]')
      .forEach(el => el.addEventListener('click', closeExport));
    // Escape closes the export popup; Tab is wrapped so focus stays within the
    // sheet (a belt-and-braces companion to the inert background above — inert
    // alone can let Tab graze the browser chrome between the last and first stop).
    const onExportKey = (e: KeyboardEvent): void => {
      if (!layout.classList.contains('export-open')) return;
      if (e.key === 'Escape') { closeExport(); return; }
      if (e.key !== 'Tab' || !isModal()) return;   // only trap Tab in the modal (mobile) sheet
      const focusables = [...exportOverlay.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )].filter(el => el.offsetParent !== null || el === document.activeElement);
      if (focusables.length === 0) return;
      const first = focusables[0]!, last = focusables[focusables.length - 1]!;
      // Only wrap when focus is already at an edge of the popup — if it's elsewhere
      // (e.g. an auto-opened panel the user hasn't tabbed into yet) leave Tab alone.
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onExportKey);

    // Flick-down to dismiss the export popup — the same instinct as swiping a
    // bottom sheet away. The popup follows the finger; release past a threshold
    // (or a fast flick) closes it, otherwise it springs back. Drags from the
    // (scrollable) body only engage at the top, so the list still scrolls.
    let py = 0, pt = 0, pdrag = false;
    const popupStart = (e: TouchEvent): void => {
      pdrag = mqMobile.matches && e.touches.length === 1;
      // Never engage the flick-to-dismiss when the touch lands on a scrubbable
      // control — the export-size fields own the full horizontal drag of their
      // value, so a diagonal scrub must not also drag the sheet down.
      if (pdrag && (e.target as HTMLElement).closest?.('[data-scrub]')) pdrag = false;
      if (pdrag && exportBody.contains(e.target as Node) && exportBody.scrollTop > 0) pdrag = false;
      if (!pdrag) return;
      py = e.touches[0]!.clientY;
      pt = e.timeStamp;
    };
    const popupMove = (e: TouchEvent): void => {
      if (!pdrag) return;
      const dy = e.touches[0]!.clientY - py;
      if (dy <= 0) { exportPopup.style.transform = ''; return; } // upward → ignore
      e.preventDefault();                       // claim the gesture from scroll
      exportPopup.classList.add('is-popup-dragging');
      exportPopup.style.transform = `translateY(${dy}px)`;
    };
    const popupEnd = (e: TouchEvent): void => {
      if (!pdrag) return;
      pdrag = false;
      const dy = (e.changedTouches[0]?.clientY ?? py) - py;
      exportPopup.classList.remove('is-popup-dragging');
      exportPopup.style.transform = '';          // hand back to the CSS transition
      if (dy > 0 && flickDirection(dy, e.timeStamp - pt) === 1) closeExport();
    };
    exportPopup.addEventListener('touchstart', popupStart, { passive: true });
    exportPopup.addEventListener('touchmove', popupMove, { passive: false });
    exportPopup.addEventListener('touchend', popupEnd, { passive: true });
    exportPopup.addEventListener('touchcancel', popupEnd, { passive: true });

    placeActions();
    // ?options share-links land with the export panel already open (no focus grab).
    if (showExportPanel) openExport({ focus: false });
    const onBreakpoint = (): void => { placeActions(); applyModality(); };
    mqMobile.addEventListener('change', onBreakpoint);
    exportTeardown = () => { mqMobile.removeEventListener('change', onBreakpoint); document.removeEventListener('keydown', onExportKey); };
  }

  // Cleanup: remove injected <style>, disconnect observer, tear down canvas nav + export.
  viewEl._cleanup = () => {
    runtime.stopLive?.(); // release the camera if a live session is running
    runtime.stopMeter?.(); runtime.cancelRecording?.(); // release the mic / abort any take
    (stageEl as (HTMLElement & { _recordCleanup?: () => void }) | null)?._recordCleanup?.(); // viewfinder + timers
    actionsApi?.stopAudioPreview?.(); // a detached <audio> keeps playing — stop it on navigation
    lottieModule?.destroyLottiePlayers(); // else animationManager ticks detached trees
    videoModule?.destroyVideoPlayers();   // drop remembered <video> positions
    styleEl.remove(); shutterEl?.remove(); ro.disconnect(); stageZoom?.destroy(); exportTeardown?.();
    window.removeEventListener('keydown', onHistoryKey);
    clearTimeout(historyToastTimer); historyToastEl?.remove();
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    // Document-level capture listeners added per renderInputs — drop them so a
    // detached sidebar tree isn't pinned alive across tool navigation.
    if (inputsEl?._colorPopoverDismiss) document.removeEventListener('click', inputsEl._colorPopoverDismiss, true);
    if (inputsEl?._blockMenuDismiss)    document.removeEventListener('click', inputsEl._blockMenuDismiss, true);
    if (inputsEl?._helpTipDismiss)      document.removeEventListener('click', inputsEl._helpTipDismiss, true);
    // The export popup (actionsEl) wires its own help tip for the C2PA card.
    if (actionsEl?._helpTipDismiss)     document.removeEventListener('click', actionsEl._helpTipDismiss, true);
    // A datetime input's flatpickr appends its calendar to <body> and registers its own
    // document/window listeners, released only by destroy() — orphaned otherwise (the
    // datetime tools would leak a body-level calendar + listener roots every navigation).
    inputsEl?.querySelectorAll<FlatpickrHost>('.fp-datetime').forEach(c => c._flatpickr?.destroy());
  };

  // Temporarily remove the CSS scale so dom-to-image sees native dimensions.
  // Also strips data-canvas-input attrs so they don't appear in exported files,
  // restoring them after so click-to-focus keeps working post-export.
  // Serialized behind exportChain: overlapping exports (e.g. a Download click while
  // the fire-and-forget history thumbnail captures) would otherwise both read
  // prevTransform and the later one restore a stale '', leaving the canvas unscaled.
  let exportChain: Promise<unknown> = Promise.resolve();
  function exportUnscaled<T>(fn: () => Promise<T>, opts: { shutter?: boolean } = {}): Promise<T> {
    const run = exportChain.catch(() => {}).then(() => exportUnscaledRaw(fn, opts));
    exportChain = run.catch(() => {});
    return run;
  }
  async function exportUnscaledRaw<T>(fn: () => Promise<T>, { shutter = false }: { shutter?: boolean } = {}): Promise<T> {
    // Renders are coalesced behind rAF (see the subscriber below); an export reads
    // the canvas DOM directly, so force any pending paint to land first — otherwise
    // we'd capture the frame before the latest keystroke.
    flushRender();
    // Embeds (lolly.tools/tool/… URLs) hydrate fire-and-forget on each render;
    // wait for the latest pass so export reads resolved blobs, not the placeholder.
    await embedsPending;
    // Same for lottie players — a first-paint/deep-link export must not capture
    // an unmounted [data-lottie-src] container.
    await lottiePending;
    // And for video: snapshotMotion (export.js) needs a decoded frame or it skips
    // the <video> and exports blank — videoPending resolves once frames are ready.
    await videoPending;
    // Full-bleed tools (hideSidebar: export:false utilities and canvas-layout tools) have
    // no fixed-size artboard scaled-to-fit — canvasEl/outerEl are null — so there's no
    // transform to un-scale. Run the export directly (still behind the shutter). This is the
    // path the preview generator's __lollyCaptureThumb hook takes to vector-capture them.
    if (!canvasEl || !outerEl) {
      if (shutter) await closeShutter();
      try { return await fn(); }
      finally { if (shutter) openShutter(); }
    }
    const annotated = [...canvasEl.querySelectorAll<HTMLElement>('[data-canvas-input]')];
    const saved = annotated.map(el => ({ el, id: el.dataset.canvasInput }));
    annotated.forEach(el => el.removeAttribute('data-canvas-input'));

    // Close the shutter BEFORE the resize so the shake happens fully hidden.
    if (shutter) await closeShutter();

    const prevTransform = canvasEl!.style.transform;
    const prevZoom = canvasEl!.style.zoom;                 // paged docs fit-to-width via zoom
    const prevW = outerEl!.style.width;
    const prevH = outerEl!.style.height;
    canvasEl!.style.transform = '';
    canvasEl!.style.zoom = '';                             // export reads pages at true page size
    outerEl!.style.width  = canvasEl!.style.width;
    outerEl!.style.height = canvasEl!.style.height;
    try {
      return await fn();
    } finally {
      canvasEl!.style.transform = prevTransform;
      canvasEl!.style.zoom = prevZoom;
      outerEl!.style.width  = prevW;
      outerEl!.style.height = prevH;
      saved.forEach(({ el, id }) => { if (el.isConnected && id != null) el.dataset.canvasInput = id; });
      if (shutter) openShutter();
    }
  }

  // ── Wire up ───────────────────────────────────────────────────────────────

  // A size-style select (its options carry width/height) sets the export size, so
  // the chosen badge/page size actually prints at that size. Seed the export-bar
  // defaults from the initially-selected option (URL / saved state still win).
  const sizeDriver = exportSizeDriver(tool.manifest);
  const sizeDims = sizeDriver
    ? sizeDriver.dims[String(runtime.getModel().find(i => i.id === sizeDriver.id)?.value)]
    : null;

  const exportDefaults: ExportDefaults = {
    filename: urlFilename || (initialValues.__export_filename as string | undefined),
    format:   urlFormat || (initialValues.__export_format as string | undefined),
    width:    urlWidth  || Number(initialValues.__export_width)  || sizeDims?.width  || undefined,
    height:   urlHeight || Number(initialValues.__export_height) || sizeDims?.height || undefined,
    unit:     urlUnit || (initialValues.__export_unit as string | undefined) || sizeDims?.unit || 'px',
    dpi:      urlDpi || Number(initialValues.__export_dpi) || 300,
    profile:  urlProfile || (initialValues.__export_profile as string | undefined) || undefined,
    // Password comes from the URL only — never restored from saved state (we don't
    // persist passwords at rest in the library; see performSave's __export_* snapshot).
    password: urlPassword || undefined,
    // Print prep (pdf / pdf-cmyk / cmyk-tiff): bleed dimension string + a marks toggle map.
    // Present (from URL or saved state) ⇒ the Print marks card opens pre-filled.
    bleed:    urlBleed || (initialValues.__export_bleed as string | undefined) || undefined,
    marks:    (urlMarks || marksFromCsv(initialValues.__export_marks as string | null | undefined)) as PrintMarks | null,
    // Full-page HTML export ("no stage"). URL-driven — like `password`, it isn't
    // persisted to the library at rest, only round-tripped through the URL.
    nostage:  urlNostage || undefined,
    // Content Credentials from ?c2pa= ({ on, days } or undefined) — an explicit
    // link setting beats the tool's render.c2pa default in the popup.
    c2pa:     urlC2pa || undefined,
    // Pixel watermark from ?imprint= — a raster-export opt-in (off by default).
    imprint:  urlImprint || undefined,
  };
  // Rewrite the URL hash query string to reflect the current tool state so the
  // page is shareable and bookmarkable. Uses replaceState — no history entry.
  // Params the user has explicitly touched — only these are written to the URL.
  // Pre-seeded from any params already in the URL so shared/bookmarked links
  // are preserved across the first subscribe callback.
  let userHasMadeChanges = false;
  // The render pill's Save half goes amber (with a one-shot flash) the moment the
  // first un-saved edit lands, and reverts to its resting state on save. We flash
  // only on the clean→dirty edge so it's an attention cue, not a strobe; the
  // animation is restarted by removing+re-adding the class (a no-op re-add wouldn't
  // replay it), so it fires again after each subsequent save→edit cycle.
  function markSessionDirty(): void {
    if (userHasMadeChanges) return;          // already dirty — keep the resting amber
    userHasMadeChanges = true;
    if (renderSaveBtn) {
      renderSaveBtn.classList.remove('is-unsaved');
      void renderSaveBtn.offsetWidth;        // force reflow so the flash animation restarts
      renderSaveBtn.classList.add('is-unsaved');
    }
  }
  function markSessionSaved(): void {
    userHasMadeChanges = false;
    renderSaveBtn?.classList.remove('is-unsaved');
  }
  // Seed from the params this mount was routed with (form-agnostic — works whether the
  // bar arrived as /t/<id>?… or #/tool/<id>?…) so shared/bookmarked links survive the
  // first subscribe callback.
  const dirtyParams = new Set(new URLSearchParams(urlParams || '').keys());
  // Monotonic guard shared by every address-bar writer (syncUrl AND shrinkUrl). It's
  // bumped on EVERY bar write, so any later write invalidates an in-flight async pack
  // — a stale pack from an earlier (larger) state can never clobber a newer bar. A
  // holder object (not a bare `let`) so the module-level shrinkUrl can share it.
  const barSeq: BarSeq = { v: 0 };

  function syncUrl(dirtyId?: string): void {
    if (dirtyId) dirtyParams.add(dirtyId);

    // A password-protected (`zx`) link stays ENCRYPTED in the address bar until the
    // user actually changes something — otherwise this first auto-sync would rewrite
    // the bar to the cleartext state, so copying it would re-share an UNPROTECTED link
    // and a refresh would skip the password prompt. After the first edit the new state
    // can't be the original token, so we fall through to the normal (cleartext) write.
    if (encLinkQuery && !userHasMadeChanges) {
      history.replaceState(null, '', `${TOOL_URL_BASE}?${encLinkQuery}`);
      return;
    }

    const params = new URLSearchParams();

    for (const entry of runtime.getModel()) {
      const { id, type, value } = entry;
      if (!dirtyParams.has(id)) continue;
      // A picked file is binary, in-memory, device-local content — it has no
      // shareable URL form. Never write it (would otherwise serialise to junk).
      if (type === 'file') continue;
      if (type === 'asset') {
        // Library assets are shareable by ID; user uploads are device-local.
        const assetId = (value as AssetRef | null)?.id;
        if (assetId && !assetId.startsWith('user/')) params.set(id, assetId);
        continue;
      }
      if (type === 'blocks') {
        if (Array.isArray(value) && value.length > 0) {
          const json = JSON.stringify(value);
          if (json.length <= 8000) params.set(id, json);
        }
        continue;
      }
      if (type === 'vector') {
        // One flat param per field: "<inputId>.<fieldId>" (e.g. transform.zoom=200).
        if (value && typeof value === 'object') {
          const vv = asRow(value);
          for (const f of entry.fields ?? []) {
            if (vv[f.id] !== undefined && vv[f.id] !== null) params.set(`${id}.${f.id}`, String(vv[f.id]));
          }
        }
        continue;
      }
      if (value == null || value === '') continue;
      if (typeof value === 'boolean' && !value) continue;
      // A token-backed colour ({ ref, value }) serialises to its canonical token ref
      // (mirrors the engine's coerceToString) — never String()'d into the URL as
      // "[object Object]", which would then ride into a lolly-URL embed of this tool.
      const str = type === 'color' && isTokenValue(value) ? value.ref : String(value);
      if (str.length > 150) continue;
      params.set(id, str);
    }

    if (dirtyParams.has('w')) {
      const w = parseInt(actionsEl?.querySelector<HTMLInputElement>('[data-action="export-width"]')?.value ?? '', 10);
      if (w > 0) params.set('w', String(w));
    }
    if (dirtyParams.has('h')) {
      const h = parseInt(actionsEl?.querySelector<HTMLInputElement>('[data-action="export-height"]')?.value ?? '', 10);
      if (h > 0) params.set('h', String(h));
    }
    if (dirtyParams.has('unit')) {
      const u = actionsEl?.querySelector<HTMLSelectElement>('[data-action="export-unit"]')?.value;
      if (u && u !== 'px') params.set('unit', u);
    }
    if (dirtyParams.has('dpi')) {
      const d = parseInt(actionsEl?.querySelector<HTMLInputElement>('[data-action="export-dpi"]')?.value ?? '', 10);
      const u = actionsEl?.querySelector<HTMLSelectElement>('[data-action="export-unit"]')?.value;
      if (d > 0 && u && u !== 'px') params.set('dpi', String(d));
    }
    if (dirtyParams.has('format')) {
      const fmt = actionsEl?.querySelector<HTMLSelectElement>('[data-action="format"]')?.value;
      if (fmt) params.set('format', fmt);
    }
    if (dirtyParams.has('filename')) {
      const filename = actionsEl?.querySelector<HTMLInputElement>('[data-action="filename"]')?.value?.trim();
      if (filename) params.set('filename', filename);
    }
    if (dirtyParams.has('profile')) {
      // Meaningful for the CMYK print formats (Print PDF / Print TIFF); share it only
      // when one is selected and it isn't the default condition (keeps links clean).
      const fmt = actionsEl?.querySelector<HTMLSelectElement>('[data-action="format"]')?.value;
      const prof = actionsEl?.querySelector<HTMLSelectElement>('[data-action="cmyk-profile"]')?.value;
      if (isCmykFmt(fmt) && prof && prof !== DEFAULT_CMYK_CONDITION) params.set('profile', prof);
    }
    if (dirtyParams.has('password')) {
      // Open-password for the standard-tier lock only (PDF 40-bit RC4 or the ZIP
      // ZipCrypto bundle); carried clear-text by design (a basic lock for short-lived
      // transactional material). Empty value → omitted.
      const fmt = actionsEl?.querySelector<HTMLSelectElement>('[data-action="format"]')?.value;
      const pw = actionsEl?.querySelector<HTMLInputElement>('[data-action="pdf-password"]')?.value;
      const strong = actionsEl?.querySelector<HTMLSelectElement>('[data-action="pdf-lock-tier"]')?.value === 'strong';
      // Only the standard lock rides in the URL. The strong (AES-256) tier is never
      // serialized — its password is typed at export/open only.
      if ((fmt === 'pdf' || fmt === 'zip') && pw && !strong) params.set('password', pw);
    }
    if (dirtyParams.has('bleed') || dirtyParams.has('marks')) {
      // Print marks & bleed — print formats (pdf / pdf-cmyk / cmyk-tiff) only, and
      // only when the card is on.
      const fmt = actionsEl?.querySelector<HTMLSelectElement>('[data-action="format"]')?.value;
      const on  = actionsEl?.querySelector<HTMLInputElement>('[data-action="print-enable"]')?.checked;
      if (isPrintFmt(fmt) && on) {
        const mm = parseFloat(actionsEl?.querySelector<HTMLInputElement>('[data-action="print-bleed"]')?.value ?? '');
        if (mm > 0) params.set('bleed', `${mm}mm`);
        const csv = marksToCsv({
          crop:         actionsEl?.querySelector<HTMLInputElement>('[data-action="mark-crop"]')?.checked,
          registration: actionsEl?.querySelector<HTMLInputElement>('[data-action="mark-reg"]')?.checked,
          bleed:        actionsEl?.querySelector<HTMLInputElement>('[data-action="mark-bleed"]')?.checked,
          colorBars:    actionsEl?.querySelector<HTMLInputElement>('[data-action="mark-bars"]')?.checked,
          provenance:   actionsEl?.querySelector<HTMLInputElement>('[data-action="mark-prov"]')?.checked,
        });
        if (csv) params.set('marks', csv);
      }
    }
    if (dirtyParams.has('nostage')) {
      // Full-page HTML export — a presence flag, written only while HTML is the
      // selected format and the toggle is on (so it drops off other formats).
      const fmt = actionsEl?.querySelector<HTMLSelectElement>('[data-action="format"]')?.value;
      const on  = actionsEl?.querySelector<HTMLInputElement>('[data-action="full-page"]')?.checked;
      if (fmt === 'html' && on) params.set('nostage', '');
    }

    const qs = params.toString();
    // Bump the shared guard on EVERY write (not just when we pack) so a later,
    // possibly sub-threshold, syncUrl invalidates any pack still in flight from an
    // earlier large state — otherwise that stale pack could resolve afterward and
    // overwrite this bar with the old state.
    const seq = ++barSeq.v;
    history.replaceState(null, '', qs ? `${TOOL_URL_BASE}?${qs}` : TOOL_URL_BASE);

    // Auto-switch to the packed form once the readable query gets long enough to
    // risk the ~2000-char URL ceiling. The readable write above already landed, so
    // simple links stay readable/editable and only large states get compressed —
    // and only if packing is available AND genuinely shorter. Async + seq-guarded so
    // a slow pack from an older keystroke can never clobber a newer bar.
    if (qs.length >= AUTO_PACK_MIN && isPackAvailable()) {
      packQuery(qs).then(token => {
        if (token == null || seq !== barSeq.v) return;      // unavailable, or superseded
        const packed = `${PACK_PARAM}=${token}`;
        if (packed.length >= qs.length) return;             // packing didn't help — keep readable
        history.replaceState(null, '', `${TOOL_URL_BASE}?${packed}`);
      }).catch(() => { /* keep the readable URL already written */ });
    }
  }

  function markUserDirty(id?: string): void {
    markSessionDirty();   // sets userHasMadeChanges + flashes the Save pill on the first edit
    // Just record the param as dirty — the coalesced render's syncUrl() (folded
    // into the rAF below) writes the URL for every dirty param, so calling it here
    // too would replaceState twice per keystroke for no benefit.
    if (id) dirtyParams.add(id);
  }

  const actionsApi = renderActions(actionsEl, tool.manifest, runtime, canvasEl, host, resetView, exportUnscaled, exportDefaults, syncUrl, playShutter, fileIntoFolder, returnTo, slot);

  // Preview-generation hook — scripts/build-previews.ts calls this to grab a VECTOR
  // SCREENSHOT (SVG) of the mounted canvas for ANY tool, even an export:false utility
  // (colour browser, countdown timer) that has no Save button and would otherwise fall
  // back to a raster page screenshot. It's the app's own captureThumbnail — text outlined
  // to paths, blob-URLs inlined — so the SVG is self-contained and crisp at any tile size.
  // A benign single function ref no in-app UI calls; re-bound to the live canvas each mount.
  // Uses contentEl (the universal canvas node) rather than canvasEl — the latter is null for
  // hideSidebar/full-bleed tools (export:false utilities, editor layouts), which are exactly
  // the ones without a Save button that this hook exists to cover.
  (globalThis as { __lollyCaptureThumb?: (fmt?: string) => Promise<string | null> }).__lollyCaptureThumb =
    (fmt = 'svg') => captureThumbnail(tool.manifest, contentEl, runtime, exportUnscaled, fmt);

  // Motion preview-generation hook — scripts/build-animated-previews.ts calls this to
  // export the LIVE animating canvas as a short, small looping clip (apng/gif) for an
  // animated tool's gallery tile / example look. Like __lollyCaptureThumb it reuses the
  // app's OWN export path (runtime.export → the shell's renderApng/renderGif), so a
  // generated APNG is byte-faithful to a real user export — no second capture path to drift.
  // Returns a base64 data-URL, or null on failure. Build-tool only; no in-app UI calls it.
  type MotionCaptureOpts = { width?: number; height?: number; duration?: number; wait?: number; repeat?: number; fps?: number };
  (globalThis as { __lollyCaptureMotion?: (fmt?: string, opts?: MotionCaptureOpts) => Promise<string | null> }).__lollyCaptureMotion =
    async (fmt = 'apng', opts = {}) => {
      try {
        const nw = opts.width  ?? tool.manifest.render.width  ?? 600;
        const nh = opts.height ?? tool.manifest.render.height ?? 600;
        // wait/duration/fps/repeat are the de-facto motion-timing opts the engine passes
        // through untouched (not in RuntimeExportOpts, like render-export.ts's exportOpts) —
        // build a typed local so the excess-property check doesn't trip at the call site.
        const exportOpts: { width: number; height: number; embedMeta: boolean; watermark: boolean; thumbnail: boolean; duration?: number; wait?: number; repeat?: number; fps?: number } =
          { width: nw, height: nh, embedMeta: false, watermark: false, thumbnail: true };
        if (opts.duration !== undefined) exportOpts.duration = opts.duration;
        if (opts.wait     !== undefined) exportOpts.wait     = opts.wait;
        if (opts.repeat   !== undefined) exportOpts.repeat   = opts.repeat;
        if (opts.fps      !== undefined) exportOpts.fps      = opts.fps;
        const blob = await exportUnscaled(() => runtime.export(contentEl, fmt, exportOpts), { shutter: false });
        return await new Promise<string | null>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload  = () => resolve(reader.result as string);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
      } catch { return null; }
    };

  // Copy-URL now lives in the actions bar (renderActions), alongside the export
  // buttons — its format/filename/dimension inputs are in the same element.
  if (actionsEl) wireUpCopyUrl(actionsEl, runtime, actionsEl, tool.manifest);

  // The render pill's Save half: an in-place quick-save. It reuses the exact same
  // export-aware save routine as the popup's Save button (performSave), but unlike
  // that button it does NOT navigate away — it's a checkpoint affordance. performSave
  // leaves the button disabled with a "Saved" label for its own navigate-away caller,
  // so we restore it here and clear the unsaved cue, briefly holding "Saved" as
  // confirmation before reverting to "Save".
  if (renderSaveBtn && actionsApi?.save) {
    const saveLabel = renderSaveBtn.querySelector<HTMLElement>('[data-save-label]');
    renderSaveBtn.addEventListener('click', async () => {
      if (renderSaveBtn!.dataset.saving) return;          // guard double-taps mid-save
      const ok = await actionsApi!.save!(renderSaveBtn);   // performSave handles the label/disabled swap
      if (!ok) return;                                    // failure path already reverted the button
      delete renderSaveBtn!.dataset.saving;
      renderSaveBtn!.disabled = false;
      markSessionSaved();                                 // drop the amber unsaved cue
      renderSaveBtn!.classList.add('is-just-saved');
      setTimeout(() => {
        if (saveLabel) saveLabel.textContent = 'Save';
        renderSaveBtn!.classList.remove('is-just-saved');
      }, 1500);
    });
  }

  // Wire up the remaining sidebar utility buttons (Shrink URL, Clear changes).
  const sidebarUtilsEl = viewEl.querySelector<HTMLElement>('#sidebar-utils');
  if (sidebarUtilsEl) {
    sidebarUtilsEl.querySelector<HTMLButtonElement>('#shrink-url-btn')?.addEventListener('click', function (this: HTMLButtonElement) {
      shrinkUrl(runtime, tool.manifest, barSeq);
      const prev = this.textContent;
      this.textContent = 'Shrunk!';
      setTimeout(() => { this.textContent = prev; }, 1500);
    });
  }

  // WYSIWYG editor overlay (render.layout:'editor'): mount the direct-manipulation
  // layer over the live canvas. Dynamically imported (gated, never static) so it's
  // only pulled in for editor-layout tools — the engine and every other tool are
  // untouched. It reads/writes the flat `boxes` array through runtime.setInput.
  if (editorLayout && canvasEditInput && canvasEl && stageEl) {
    // The artboard is a resizable document. Restore its size from the URL's
    // reserved width/height (px) if present, then re-fit. Skipped in carousel mode —
    // the strip size is owned by syncStrip (from the page count/size inputs), and a
    // reserved ?width/?height must not overwrite it.
    if (!pagesMode && !fixedCanvasMode) {
      if ((urlWidth ?? 0) > 0) canvasEl.style.width = urlWidth + 'px';
      if ((urlHeight ?? 0) > 0) canvasEl.style.height = urlHeight + 'px';
      if ((urlWidth ?? 0) > 0 || (urlHeight ?? 0) > 0) resetView();
    }
    // Resize the document: keep box coordinates fixed (they don't scatter), resize
    // the canvas, mirror it to the export dimensions so output matches, and re-fit.
    const setCanvasSize = (w: number, h: number, unit = 'px'): void => {
      // w/h are in `unit`; the artboard DOM is always px (a physical unit maps at the
      // 96-DPI CSS convention), while the export bar carries the physical size so the
      // output renders at the chosen DPI.
      const pxW = Math.round(unit === 'px' ? w : toCssPx({ value: w, unit: unit as Unit }));
      const pxH = Math.round(unit === 'px' ? h : toCssPx({ value: h, unit: unit as Unit }));
      canvasEl.style.width = pxW + 'px';
      canvasEl.style.height = pxH + 'px';
      actionsApi?.setDims?.({ width: w, height: h, unit });
      markUserDirty('w'); markUserDirty('h');
      resetView();
    };
    import('./free-canvas.ts').then(({ initFreeCanvas }) => {
      if (!viewEl.isConnected) return;   // navigated away before the chunk loaded
      // The host-UI profile setter is a web-shell extension (WebProfileAPI), not on
      // the engine's read-only ProfileAPI — surface it via a narrow cast so the
      // Document-info panel can toggle the provenance opt-in.
      const profileApi = host.profile as (typeof host.profile) & { set?: (p: Profile) => Promise<void> };
      const fc = initFreeCanvas({
        viewEl, stageEl, canvasEl, outerEl, runtime, host,
        input: canvasEditInput, nativeW, nativeH,
        onDirty: markUserDirty,
        // In carousel mode the strip size is owned by syncStrip (page count/size inputs);
        // withholding setCanvasSize stops the artboard-resize + design-import paths from
        // clobbering the strip. (The rail's size control is the page-size picker instead.)
        setCanvasSize: (pagesMode || fixedCanvasMode) ? undefined : setCanvasSize,
        // Multi-page (carousel) mode: gives the overlay the page-count + page-size input
        // ids so its rail exposes a page stepper / size picker, and so it translates box
        // gestures by each frame's offset. Absent for single-page editors.
        pages: pagesCfg ? {
          countField: pagesCfg.count, widthField: pagesCfg.width, heightField: pagesCfg.height,
          min: pagesCfg.min ?? 1, max: pagesCfg.max ?? 6,
        } : undefined,
        // Document-info panel: read/write the export/save name, plus at-a-glance
        // details. Name binds to the export bar's filename field (the canonical
        // save name); last-edited reads the resumed session's timestamp if any.
        info: {
          name: tool.manifest.name,
          version: tool.manifest.version,
          status: tool.manifest.status,
          formats: tool.manifest.render.formats,
          getFilename: () => viewEl.querySelector<HTMLInputElement>('[data-action="filename"]')?.value || '',
          setFilename: (v: string) => {
            const fn = viewEl.querySelector<HTMLInputElement>('[data-action="filename"]');
            if (fn) { fn.value = v; fn.dispatchEvent(new Event('input', { bubbles: true })); }
          },
          lastEdited: (async () => {
            if (!slot) return null;
            try { return (await host.state.list()).find(s => s.slot === slot)?.updatedAt || null; }
            catch { return null; }
          }) as () => string | Promise<string> | null | undefined,
          // Export provenance — a read-only view of the name/contact baked into the
          // file's metadata (see engine metadata.ts buildExportMeta) + the opt in/out
          // toggle. Only offered where the shell can persist the profile (host.profile.set).
          provenance: typeof profileApi.set === 'function' ? {
            editHref: '#/profile?focus=use-details',
            get: async () => {
              const pr = await host.profile.get();
              const join = (a?: string, b?: string, sep = ' '): string =>
                [a, b].map(s => (s ?? '').trim()).filter(Boolean).join(sep);
              return {
                optedIn: pr.useDetails === true,
                author: join(pr.firstname, pr.lastname),
                contact: join(pr.email, pr.phone, ' · '),
              };
            },
            setOptIn: async (on: boolean) => {
              const cur = await host.profile.get();
              await profileApi.set!({ ...cur, useDetails: on });
            },
          } : undefined,
        },
        // Picking a Lolly link / saved session for a box image opens its inputs
        // first (configure → insert), same as the sidebar asset slots. The picker
        // passes mode 'edit' when re-opening the box's current Lolly render.
        editTool: (toolUrl: string, mode = 'insert') => openEmbedEditor(host, { editUrl: toolUrl, slotLabel: 'image', mode }),
        // The editor is chromeless (no sidebar header), so the free-canvas rail
        // hosts the visible undo/redo buttons — the only touch trigger for
        // history here. register() adopts them as THE history controls (the
        // header pair can't exist in this layout, so no conflict).
        history: {
          undo: undoHistory,
          redo: redoHistory,
          register: (sync: (canUndo: boolean, canRedo: boolean) => void) => { historyControls = { sync }; refreshHistoryUI(); },
        },
        // Primary actions as prominent rail icons (the chromeless editor has no
        // bottom pill). Each delegates to the tool's existing handler/button so
        // the export/save/copy/share logic isn't duplicated: Export opens the
        // export popup, Save is the in-place checkpoint save, Copy writes the
        // rendered output, Share copies a shareable link. dirtyRef lets the rail
        // Save icon mirror the render pill's amber "unsaved" cue.
        actions: {
          export: () => renderFab?.click(),
          save: () => renderSaveBtn?.click(),
          copy: () => viewEl.querySelector<HTMLButtonElement>('[data-action="copy"]')?.click(),
          share: () => viewEl.querySelector<HTMLButtonElement>('[data-action="copy-url"]')?.click(),
          canSave: canSaveSession,
          dirtyRef: renderSaveBtn,
        },
      } as Parameters<typeof initFreeCanvas>[0]);
      const prevCleanup = viewEl._cleanup;
      viewEl._cleanup = () => { try { fc.destroy(); } catch (e) { console.error(e); } prevCleanup?.(); };
    }).catch((err: unknown) => console.error('[layout-studio] editor overlay failed to load:', err));
  }

  // Multi-page rich-text document editor (render.layout:'document'). Mounts the
  // document overlay over the live canvas, reading/writing the flat `content` blocks
  // array through runtime.setInput — the same chromeless-canvas + export scaffolding as
  // the editor layout, but a word-processor UI instead of the free-canvas overlay.
  if (documentLayout && docEditInput && canvasEl && stageEl) {
    if ((urlWidth ?? 0) > 0) canvasEl.style.width = urlWidth + 'px';
    if ((urlHeight ?? 0) > 0) canvasEl.style.height = urlHeight + 'px';
    if ((urlWidth ?? 0) > 0 || (urlHeight ?? 0) > 0) resetView();
    const setCanvasSize = (w: number, h: number, unit = 'px'): void => {
      const pxW = Math.round(unit === 'px' ? w : toCssPx({ value: w, unit: unit as Unit }));
      const pxH = Math.round(unit === 'px' ? h : toCssPx({ value: h, unit: unit as Unit }));
      canvasEl.style.width = pxW + 'px';
      canvasEl.style.height = pxH + 'px';
      actionsApi?.setDims?.({ width: w, height: h, unit });
      markUserDirty('w'); markUserDirty('h');
      resetView();
    };
    import('./doc-editor.ts').then(({ initDocEditor }) => {
      if (!viewEl.isConnected) return;   // navigated away before the chunk loaded
      const dc = initDocEditor({
        viewEl, stageEl, canvasEl, runtime, host,
        input: docEditInput, inputs: tool.manifest.inputs ?? [],
        nativeW, nativeH,
        onDirty: markUserDirty,
        setCanvasSize,
        editTool: (toolUrl: string, mode = 'insert') => openEmbedEditor(host, { editUrl: toolUrl, slotLabel: 'image', mode }),
        history: {
          undo: undoHistory,
          redo: redoHistory,
          register: (sync: (canUndo: boolean, canRedo: boolean) => void) => { historyControls = { sync }; refreshHistoryUI(); },
        },
        actions: {
          export: () => renderFab?.click(),
          save: () => renderSaveBtn?.click(),
          canSave: canSaveSession,
          dirtyRef: renderSaveBtn,
        },
      } as Parameters<typeof initDocEditor>[0]);
      const prevCleanup = viewEl._cleanup;
      viewEl._cleanup = () => { try { dc.destroy(); } catch (e) { console.error(e); } prevCleanup?.(); };
    }).catch((err: unknown) => console.error('[doc-studio] document editor failed to load:', err));
  }

  // Intercept back / home nav clicks — offer save dialog if inputs have changed. Leaving
  // routes to backHref (the launch folder when the session came from one, else the
  // gallery), matching the back link's label and the Save button's return target.
  if (hasInputs) {
    viewEl.querySelectorAll('.tools-home').forEach(link => {
      link.addEventListener('click', e => {
        if (!userHasMadeChanges) return;
        e.preventDefault();
        // Offer "Save & leave" only when the tool actually has a save action.
        const canSave = !!actionsEl?.querySelector('[data-action="save"]') && !!actionsApi?.save;
        // If the session carries heavy embedded bytes (a recorded clip stamps meta.bytes),
        // tell the user how big the save is — the recording is what makes a Record session
        // large, and it's stored on-device.
        const heavy = runtime.getModel()
          .map(i => (i.value as { meta?: { bytes?: number } } | undefined)?.meta?.bytes)
          .find((b): b is number => typeof b === 'number' && b > 0);
        const detail = heavy ? `Includes a ${fmtBytes(heavy)} video clip, stored on this device.` : undefined;
        showUnsavedDialog(
          canSave ? async () => { if (await actionsApi!.save!()) navigateTo(backHref); } : null,
          () => { navigateTo(backHref); },
          detail,
        );
      });
    });
  }

  // Mark model inputs dirty the first time the user touches them.
  // The listener lives on the container so it survives renderInputs re-renders.
  (['change', 'input'] as const).forEach(evt =>
    inputsEl?.addEventListener(evt, e => {
      const id = (e.target as HTMLElement).closest<HTMLElement>('[data-input-id]')?.dataset.inputId;
      if (id) markUserDirty(id);
    })
  );

  // QOL: step a focused <select> with ↑/↓ and apply each value instantly, without
  // opening the dropdown. macOS opens the native menu on Arrow keys (Windows/Linux
  // cycle the value); intercepting it makes the behaviour consistent and lets the user
  // tab to a select and audition options one keypress at a time. Delegated on the
  // container so it covers top-level AND block-field selects and survives re-renders;
  // while the native menu is open the element doesn't receive these keydowns.
  inputsEl?.addEventListener('keydown', e => {
    if ((e.key !== 'ArrowDown' && e.key !== 'ArrowUp') || e.metaKey || e.ctrlKey || e.altKey) return;
    const sel = e.target as HTMLSelectElement;
    if (!sel || sel.tagName !== 'SELECT' || sel.disabled) return;
    e.preventDefault(); // stop macOS popping the native menu on Arrow
    const opts = sel.options, dir = e.key === 'ArrowDown' ? 1 : -1;
    let next = sel.selectedIndex + dir;
    while (next >= 0 && next < opts.length && opts[next]!.disabled) next += dir; // skip disabled
    if (next < 0 || next >= opts.length || next === sel.selectedIndex) return;  // clamp at the ends
    sel.selectedIndex = next;
    sel.dispatchEvent(new Event('input', { bubbles: true }));
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });

  // Click-to-focus: clicking a rendered canvas element that represents an input
  // focuses the corresponding sidebar control. Tools can suppress this per-element
  // with pointer-events:none. The handler is added once; annotations are re-applied
  // via resolveCanvasAnnotations() after each innerHTML update.
  if (canvasEl) canvasEl.addEventListener('click', e => {
    if (hideSidebar || !inputsEl) return;
    const target = (e.target as HTMLElement).closest<HTMLElement>('[data-canvas-input]');
    if (!target) return;
    const id = target.dataset.canvasInput!;

    // Most ids map straight to a sidebar row. A "<blocksInputId>:<index>" id
    // (emitted per rendered block, e.g. data-canvas-input="blocks:0") points at
    // one block inside a blocks input — focus that block and fold the rest.
    let control = inputsEl.querySelector<HTMLElement>(`[data-input-id="${id}"]`);
    let blockIndex: string | null = null;
    const blockRef = !control && id.match(/^(.+):(\d+)$/);
    if (blockRef) {
      const blocksEl = inputsEl.querySelector<HTMLElement>(`.blocks-input[data-input-id="${blockRef[1]}"]`);
      if (blocksEl) { control = blocksEl; blockIndex = blockRef[2]!; }
    }
    if (!control) return;

    const focus = () => {
      // Reveal the control if it lives inside a collapsed section (mirrors the
      // scrollToInput path), so the focused input is actually visible.
      control!.closest('details.input-section')?.setAttribute('open', '');
      if (blockIndex != null) {
        focusSidebarBlock(control!, blockIndex);
      } else {
        control!.focus();              // lights the CSS :focus-within spotlight
        scrollToControl(control!);     // header-aware, reduce-motion-safe, with arrival pulse
      }
    };
    if (layout.dataset.sidebar === 'closed') {
      setSidebarWidth(getRestoreWidth());
      requestAnimationFrame(focus);
    } else {
      focus();
    }
  });

  // Deferred-preview tools (manifest.render.preview): the live canvas is only a
  // placeholder until an explicit, expensive render runs — e.g. url-shot, which
  // screenshots a real page in beforeExport. The template supplies a [data-preview]
  // control; here we drive it (busy/error state) and run the render into the frame.
  // Wired by delegation on the canvas so it survives the innerHTML rebuild that the
  // runtime subscriber does on every input change.
  const previewCfg = tool.manifest.render.preview as { auto?: boolean; format?: string } | undefined;
  async function runPreview(): Promise<void> {
    const btn = contentEl.querySelector<HTMLElement>('[data-preview]');
    if (btn) {
      if (btn.dataset.busy) return;                  // re-entrancy guard
      btn.dataset.busy = '1';
      btn.dataset.idleLabel ??= (btn.textContent ?? '').trim();
      btn.classList.remove('is-error');
      btn.classList.add('is-busy');
      btn.textContent = btn.dataset.busyLabel || 'Rendering…';
    }
    try {
      await actionsApi!.preview!();
      // Success: the hook painted the capture and hid the placeholder (button
      // included), so there's nothing to reset — it's gone from the DOM.
    } catch (err) {
      // Surface the failure in place; the placeholder stays so the user can retry.
      // The next input change rebuilds a fresh button with its idle label.
      const b = contentEl.querySelector<HTMLElement>('[data-preview]');
      if (b) {
        b.classList.remove('is-busy');
        b.classList.add('is-error');
        b.textContent = (err as { message?: string })?.message || 'Preview failed — tap to retry';
        delete b.dataset.busy;
      }
      throw err;
    }
  }
  if (previewCfg && canvasEl) {
    canvasEl.addEventListener('click', e => {
      if (!(e.target as HTMLElement).closest('[data-preview]')) return;
      runPreview().catch(err => console.error('Preview failed:', err));
    });
  }

  // File-utility download: a template [data-export-file] button asks the tool's
  // exportFile hook to produce the transformed bytes (the file in → file out
  // shape — EXIF strip, redact, compress, …), then delivers them via
  // host.export.file (no watermark, no provenance — it's the user's own file).
  // Delegated on the persistent content container so it survives the innerHTML
  // rebuild the runtime subscriber does on every input change.
  if (runtime.hasExportFile && contentEl) {
    contentEl.addEventListener('click', async (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-export-file]');
      if (!btn || btn.dataset.busy) return;
      btn.dataset.busy = '1';
      btn.dataset.idleLabel ??= (btn.textContent ?? '').trim();
      btn.classList.remove('is-error');
      btn.classList.add('is-busy');
      btn.textContent = btn.dataset.busyLabel || 'Working…';
      try {
        const { bytes, mime, filename } = await runtime.exportFile();
        const blob = new Blob([bytes as BlobPart], { type: mime || 'application/octet-stream' });
        await host.export.file(blob, { filename: filename || 'file' });
        btn.classList.remove('is-busy');
        btn.textContent = btn.dataset.idleLabel!;
        delete btn.dataset.busy;
      } catch (err) {
        console.error('exportFile failed:', err);
        btn.classList.remove('is-busy');
        btn.classList.add('is-error');
        btn.textContent = (err as { message?: string })?.message || 'Export failed — try again';
        delete btn.dataset.busy;
      }
    });
  }

  // Scripts in template HTML don't execute when set via innerHTML (browser security).
  // Run them once on first render; subsequent renders update data but keep the
  // same script context alive.
  let pendingAutoExport = autoExport;
  let pendingAutoCopy = autoCopy;
  // Auto-generate a preview once the tool settles, so the user lands on a rendered
  // frame rather than the placeholder. Once only (never on every input change — a
  // deferred render must stay deliberate), and skipped when a ?export is already
  // queued so we don't capture the same page twice on load.
  let pendingAutoPreview = Boolean(previewCfg?.auto) && !autoExport;
  // The model the sidebar DOM was last built/synced against. syncInputs uses it to
  // skip the full panel rebuild on a keystroke when the edited field already shows
  // the new value (see syncInputs). Null until the first render.
  let prevInputsModel: InputModelItem[] | null = null;
  // Track the size-driving select's value so a change pushes the option's physical
  // dimensions to the export bar (see exportSizeDriver / actionsApi.setDims).
  let lastDimsSizeVal: InputValue | null | undefined = sizeDriver ? runtime.getModel().find(i => i.id === sizeDriver.id)?.value : null;

  // Inline canvas error, shown when a template script throws mid-render. Lives on
  // the stage as a sibling of the canvas, so the per-render innerHTML rebuild
  // doesn't wipe it; cleared on the next successful render.
  function showCanvasError(): void {
    const stage = stageEl || contentEl?.parentElement;
    if (!stage || stage.querySelector(':scope > .canvas-error')) return;
    const box = document.createElement('div');
    box.className = 'canvas-error';
    box.setAttribute('role', 'alert');
    box.textContent = "Couldn't render this preview — check your inputs.";
    stage.appendChild(box);
  }
  function clearCanvasError(): void {
    (stageEl || contentEl?.parentElement)?.querySelector(':scope > .canvas-error')?.remove();
  }

  let renderGen = 0;
  // Latest embed-hydration promise; exportUnscaled awaits it so an export reads
  // resolved blob URLs rather than the neutralised 1×1 placeholder.
  let embedsPending: Promise<unknown> = Promise.resolve();
  // Latest lottie-mount pass (same contract); the module is loaded lazily the
  // first time a paint emits a [data-lottie-src] marker and kept for reaping.
  let lottiePending: Promise<unknown> = Promise.resolve();
  let lottieModule: LottieModule | null = null;
  // Same contract for the video position-keeper (see video-mount.js): loaded the
  // first paint that emits a keyed <video>, awaited before export so a snapshot
  // reads a decoded frame rather than a blank one.
  let videoPending: Promise<unknown> = Promise.resolve();
  let videoModule: VideoModule | null = null;

  // The RENDER half of the subscriber is coalesced behind requestAnimationFrame:
  // a full canvas rebuild swaps innerHTML, re-walks annotations, and re-executes
  // every template <script> (chart/QR/map libs re-instantiate), so doing it per
  // keystroke is wasteful. We stash the latest emit and paint at most once per
  // frame — the sidebar sync (below) stays synchronous so typed values echo with
  // no lag. The trailing emit is always the one we paint, so the final keystroke
  // never gets dropped; flushRender() forces it out synchronously before exports.
  let rafId = 0;
  let pendingFrame: { model: InputModelItem[]; hydrated: string } | null = null;   // latest { model, hydrated } awaiting paint
  let lastPainted: string | null = null;   // hydrated source of the last CLEAN paint — skip an identical canvas rebuild

  function paint(): void {
    rafId = 0;
    if (!pendingFrame) return;
    const { model, hydrated } = pendingFrame;
    pendingFrame = null;
    // Skip the expensive canvas rebuild when the hydrated output is byte-identical to
    // the last clean paint. refresh() and the coalesced double-emit re-emit unchanged
    // HTML, and a live camera/audio frame often traces to the same output — a full
    // innerHTML swap + <script> re-exec (chart/QR/map libs re-instantiate, resolved
    // embeds get wiped and re-fetched) per frame is pure waste. The MODEL can still
    // have moved on an input that doesn't touch the template (e.g. an export-dimension
    // select), so URL sync / size-driver / auto-export below always run. lastPainted
    // is recorded only after a CLEAN paint, so a throwing render retries next emit.
    if (hydrated !== lastPainted) {
      const gen = ++renderGen;
      // Paged docs scroll the whole document in the canvas surface; a full innerHTML
      // rebuild would otherwise snap the view back to the cover on every keystroke.
      // Capture the surface's scroll offset and restore it after the swap.
      const prevScrollTop = pagedDoc && outerEl ? outerEl.scrollTop : 0;
      try {
        // Neutralise any lolly.tools embed URLs BEFORE insertion so the editor never
        // fires a network request for them; they're resolved to local composed
        // renders (blob URLs) just after the template's own scripts run. The
        // generation guard stops a slow embed render from overwriting a newer one.
        contentEl.innerHTML = neutralizeEmbeds(hydrated);
        if (!hideSidebar) resolveCanvasAnnotations(contentEl);
        // Keep the canvas's accessible summary current when it's a live a11yLabel.
        if (tool.manifest.a11yLabel) contentEl.setAttribute('aria-label', canvasLabel());
        runTemplateScripts(contentEl);
        embedsPending = hydrateEmbeds(contentEl, { host, isCurrent: () => gen === renderGen });
        // Lottie markers are mounted by the shell, not the template (tools stay
        // data-only). Once the module has loaded, run the pass even on marker-less
        // paints so players orphaned by the innerHTML swap get reaped.
        if (lottieModule || contentEl.querySelector('[data-lottie-src]')) {
          lottiePending = (lottieModule
            ? Promise.resolve(lottieModule)
            : import('./lottie-mount.ts').then(m => (lottieModule = m)))
            .then(m => m.mountLottiePlayers(contentEl, { isCurrent: () => gen === renderGen }))
            .catch(err => console.warn('lottie mount failed:', err));
        }
        // Video position-keeper: restore each placed clip to where it was before this
        // rebuild (so it doesn't restart at 0), and settle once frames have decoded so
        // an export reads a real frame. Only paints with a keyed <video> load it.
        if (videoModule || contentEl.querySelector('video[data-video-key]')) {
          videoPending = (videoModule
            ? Promise.resolve(videoModule)
            : import('./video-mount.ts').then(m => (videoModule = m)))
            .then(m => m.mountVideoPlayers(contentEl, { isCurrent: () => gen === renderGen }))
            .catch(err => console.warn('video mount failed:', err));
        }
        clearCanvasError();
        lastPainted = hydrated;
        // Keep the reader where they were scrolled to (paged docs only).
        if (pagedDoc && outerEl && prevScrollTop) outerEl.scrollTop = prevScrollTop;
      } catch (err) {
        // A throwing template script (charts, QR, fetch-backed tools run in page
        // context — unlike the sandboxed hooks) would otherwise leave a stale or
        // half-built canvas with no signal. Surface it; the sidebar stays editable.
        console.error('Render failed:', err);
        showCanvasError();
      }
    }
    syncUrl();

    // When a size-driving select changes, set the export dimensions to the chosen
    // option — so picking "A6 landscape" actually exports an A6-landscape page.
    if (sizeDriver) {
      const v = model.find(i => i.id === sizeDriver.id)?.value;
      if (v !== lastDimsSizeVal) {
        lastDimsSizeVal = v;
        const d = sizeDriver.dims[String(v)];
        if (d) actionsApi?.setDims?.(d);
      }
    }

    if (pendingAutoExport) {
      pendingAutoExport = false;
      const fmt = urlFormat || tool.manifest.render.formats[0]!;
      waitForQuiescence(contentEl).then(() => {
        const name = urlFilename || tool.manifest.id;
        // Honour ?unit=/?dpi= so a deep link (or CLI) renders the right physical size.
        const u = urlUnit || 'px';
        const dim = (v: number | null, native: number): string | number => ((v ?? 0) > 0 ? (u !== 'px' ? `${v}${u}` : v!) : native);
        const expOpts: RunExportOpts = { width: dim(urlWidth, nativeW), height: dim(urlHeight, nativeH) };
        if (u !== 'px') expOpts.dpi = urlDpi || 300;
        // CMYK print formats: carry the chosen press condition (recorded in the
        // PDF's output intent / the TIFF's metadata). The Print PDF also carries the
        // brand palette for exact ink matches; the TIFF does a flat per-pixel pass.
        if (isCmykFmt(fmt)) {
          expOpts.colorProfile = urlProfile || DEFAULT_CMYK_CONDITION;
          if (fmt === 'pdf-cmyk') expOpts.palette = PALETTE;
        }
        // HTML: honour ?nostage so a deep link auto-exports the full-page document
        // (no fixed-size canvas frame) — mirrors the panel's "Full page" toggle.
        if (fmt === 'html' && urlNostage) expOpts.fullPage = true;
        // Standard lock: honour ?password= so a deep link can auto-export a locked
        // PDF or ZIP bundle (basic lock; clear-text in the URL by design — see pdfPassRow).
        if ((fmt === 'pdf' || fmt === 'zip') && urlPassword) expOpts.password = urlPassword;
        // Content Credentials: ?c2pa= wins (on/off + ephemeral-cert lifetime,
        // e.g. c2pa=90 or c2pa=off — see url-mode.js); absent it falls back to
        // a render.c2pa tool's popup default. Never stamped alongside a
        // password (the same exclusion the popup enforces; the bridge would
        // skip it anyway).
        const wantC2pa = urlC2pa ? urlC2pa.on : c2paDefaultOn(tool.manifest);
        if (wantC2pa && C2PA_FORMATS.includes(fmt) && !expOpts.password) {
          expOpts.c2pa = true;
          if (urlC2pa?.days) expOpts.c2paDays = urlC2pa.days;
        }
        // Pixel watermark (?imprint=): a raster-export opt-in, independent of C2PA.
        if (urlImprint && ['png', 'jpg', 'jpeg', 'webp', 'avif'].includes(fmt)) expOpts.imprint = true;
        // Print prep: honour ?bleed= / ?marks= so a deep link auto-exports a
        // print-ready file. Applied only when the link asks for it (never default).
        if (isPrintFmt(fmt) && (urlBleed || urlMarks)) {
          if (urlBleed) expOpts.bleed = urlBleed;
          if (urlMarks) {
            expOpts.cropMarks = urlMarks.crop;
            expOpts.registrationMarks = urlMarks.registration;
            expOpts.bleedMarks = urlMarks.bleed;
            expOpts.colorBars = urlMarks.colorBars;
            expOpts.provenance = urlMarks.provenance;
          }
        }
        exportUnscaled(() =>
          runtime.export(canvasEl, fmt, expOpts)
            .then(blob => host.export.download(blob, `${name}.${extFor(fmt, blob)}`))
            .catch(err => console.error('Auto-export failed:', err))
        );
      });
    }

    if (pendingAutoCopy) {
      pendingAutoCopy = false;
      waitForQuiescence(contentEl).then(() => armAutoCopy(actionsEl, actionsApi, urlFormat || undefined));
    }

    if (pendingAutoPreview) {
      pendingAutoPreview = false;
      waitForQuiescence(contentEl).then(() =>
        runPreview().catch(err => console.error('Auto-preview failed:', err))
      );
    }
  }

  // Paint any queued frame right now (cancelling the scheduled rAF). Used by
  // exportUnscaled so a capture reads the latest keystroke, and harmless if no
  // frame is pending.
  function flushRender(): void {
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; paint(); }
  }

  runtime.subscribe(({ model, hydrated }) => {
    // Sidebar sync is cheap and must stay responsive, so it runs synchronously on
    // every emit; only the expensive canvas rebuild is deferred to the next frame.
    if (inputsEl && !_sliderDragging) {
      prevInputsModel = syncInputs(inputsEl, model, prevInputsModel, runtime, host, markUserDirty);
    }
    pendingFrame = { model, hydrated };
    if (!rafId) rafId = requestAnimationFrame(paint);
    // Carousel: a change to the page count / page size reshapes the editing strip.
    // syncStrip no-ops unless the strip dimensions actually changed, so ordinary box
    // edits don't reset the view.
    if (pagesMode) syncStrip();
  });

  // Live camera (engine v1.4): a tool that declares an `onFrame` hook can react to a
  // live camera stream. Pure progressive enhancement — the toggle appears only when
  // the tool has the hook AND this shell exposes a camera (host.media); otherwise the
  // tool just runs as a still-image tool. The runtime owns the frame→onFrame→repaint
  // loop; here we only drive the toggle and surface permission errors.
  if (stageEl && runtime.hasFrameHook && host.media?.isAvailable?.()) {
    const liveBtn = document.createElement('button');
    liveBtn.type = 'button';
    liveBtn.className = 'canvas-live-toggle';
    liveBtn.setAttribute('aria-pressed', 'false');
    liveBtn.title = 'React to your camera in real time';
    liveBtn.innerHTML = '<span class="canvas-live-dot" aria-hidden="true"></span><span class="canvas-live-label">Go live</span>';
    stageEl.appendChild(liveBtn);
    const setLiveUi = (on: boolean): void => {
      liveBtn.classList.toggle('is-live', on);
      liveBtn.setAttribute('aria-pressed', String(on));
      liveBtn.querySelector('.canvas-live-label')!.textContent = on ? 'Live' : 'Go live';
    };
    liveBtn.addEventListener('click', async () => {
      if (runtime.isLive()) { runtime.stopLive(); setLiveUi(false); announce('Live camera stopped'); return; }
      liveBtn.disabled = true;
      try {
        await runtime.startLive();
        setLiveUi(true);
        announce('Live camera started — the canvas now reacts to your camera');
      } catch (e) {
        announce((e as { name?: string })?.name === 'NotAllowedError' ? 'Camera permission was declined.' : 'Couldn’t start the camera.', { assertive: true });
        host.log('warn', 'startLive failed', { error: String(e) });
      } finally {
        liveBtn.disabled = false;
      }
    });
  }

  // Device recording (engine v1.17): a tool declaring render.capture gets a Record
  // affordance where this shell exposes host.recorder. Audio tools also surface a live
  // level meter + coaching through their onLevel hook (the runtime drives it); video
  // tools get a host.media framing viewfinder, then the clip feeds the top-&-tail
  // compositor. The runtime owns startMeter/startRecording/stopRecording; here we only
  // drive the UI and route the finished blob.
  const captureMode = (runtime.manifest.render as { capture?: 'audio' | 'video' | 'av' } | undefined)?.capture;
  if (stageEl && captureMode && host.recorder?.isAvailable?.(captureMode === 'audio' ? 'audio' : 'video')) {
    setupRecordControl({ stageEl, runtime, host, mode: captureMode, markSessionDirty });
  }

  // Canvas-layout file utilities (render.layout:"canvas"): the whole canvas IS
  // the file control — drag-and-drop or click anywhere to pick. The picked file
  // still flows through the normal input model + exportFile hook, so CLI/URL mode
  // are unaffected; only the presentation moves from the sidebar onto the canvas.
  if (canvasLayout && canvasFileInput && contentEl) {
    setupCanvasFileDrop({ viewEl, contentEl, runtime, input: canvasFileInput, onDirty: markUserDirty });
  }
  if (canvasDropInput && contentEl) {
    setupCanvasBlocksDrop({ viewEl, contentEl, runtime, host, input: canvasDropInput, onDirty: markUserDirty });
  }

  // Canvas tools can also expose interactive SETTINGS in the template (e.g. a
  // compression level) as ordinary declared inputs. The sidebar — which normally
  // binds inputs to the model — is hidden in canvas layout, so wire any in-canvas
  // control carrying [data-input-id] straight back to runtime.setInput. The values
  // are declared inputs, so URL/CLI parity is automatic (syncUrl writes the dirty
  // param). Bind 'change' (not 'input') so the per-render innerHTML rebuild doesn't
  // fight focus mid-interaction; the template reflects each value so a repaint keeps it.
  if (canvasLayout && contentEl) {
    contentEl.addEventListener('change', (e) => {
      const ctl = (e.target as HTMLElement).closest<HTMLInputElement>('[data-input-id]');
      if (!ctl) return;
      const id = ctl.dataset.inputId;
      if (!id) return;
      const value = ctl.type === 'checkbox' ? ctl.checked
        : ctl.type === 'number' ? Number(ctl.value)
          : ctl.value;
      runtime.setInput(id, value);
      markUserDirty(id);
    });
  }

  const clearBtn = viewEl.querySelector<HTMLButtonElement>('#clear-inputs-btn');
  const utils = viewEl.querySelector<HTMLElement>('#sidebar-utils');
  if (clearBtn && utils) {
    const resetToDefaults = async () => {
      dirtyParams.clear();
      markSessionDirty();   // clearing is an edit — flag unsaved + flash the Save pill
      for (const input of runtime.getModel()) {
        // Revoke a picked file's preview URL before clearing it (avoid a leak).
        const prevUrl = asRow(input.value).url;
        if (input.type === 'file' && prevUrl) URL.revokeObjectURL(prevUrl as string);
        // Reset to the tool's DECLARED default — a real "reset to defaults", so a
        // boolean default:true, default `blocks` rows, a default select/colour/asset
        // all come back. Only fall back to a type-appropriate empty when there is no
        // declared default (files never have one). Previously every non-scalar was
        // forced blank regardless of its default.
        const dflt = input.default as InputValue | undefined;
        const value: InputValue = dflt !== undefined && dflt !== null ? dflt
          : input.type === 'boolean' ? false
          : input.type === 'asset' ? null
          : input.type === 'file' ? null
          : input.type === 'blocks' ? []
          : '';
        await runtime.setInput(input.id, value);
      }
    };
    // Two-step confirm INLINE + full-width in the sidebar (no centred modal). The
    // #sidebar-utils grid is one column, so the confirm/cancel buttons each span the
    // full width; swapping the button's own container in place moves nothing else.
    // The armed confirm is destructive AND persists (its #sidebar-utils host isn't
    // re-rendered by edits), so it must be dismissible passively — Escape, an outside
    // click, or a timeout — mirroring the block-remove two-step confirm's disarm.
    let disarmTimer: ReturnType<typeof setTimeout> | undefined;
    const restore = (): void => {
      utils.classList.remove('is-confirming');
      document.removeEventListener('pointerdown', onOutside, true);
      document.removeEventListener('keydown', onKey, true);
      if (disarmTimer) clearTimeout(disarmTimer);
      utils.replaceChildren(clearBtn);
    };
    const onOutside = (e: PointerEvent) => { if (!utils.contains(e.target as Node | null)) restore(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); restore(); } };
    clearBtn.addEventListener('click', () => {
      utils.classList.add('is-confirming');
      utils.innerHTML =
        '<button type="button" class="clear-inputs-confirm">Reset to defaults</button>' +
        '<button type="button" class="clear-inputs-cancel">Cancel</button>';
      utils.querySelector('.clear-inputs-confirm')!.addEventListener('click', async () => { restore(); await resetToDefaults(); });
      utils.querySelector('.clear-inputs-cancel')!.addEventListener('click', restore);
      (utils.querySelector('.clear-inputs-cancel') as HTMLElement | null)?.focus();
      setTimeout(() => document.addEventListener('pointerdown', onOutside, true), 0); // skip the arming click
      document.addEventListener('keydown', onKey, true);
      disarmTimer = setTimeout(restore, 6000);
    });
  }
}



/**
 * Canvas-as-drop-zone for render.layout:"canvas" file utilities. The whole canvas
 * accepts a drag-and-drop file; a click opens the native picker only via an explicit
 * [data-file-pick] affordance (the empty-state drop zone and the Replace button both
 * carry it). Listeners live on the stable contentEl container and a hidden <input>
 * parked in viewEl, so they survive the per-render innerHTML swaps of the canvas
 * content. The picked file is written straight into the normal input model — no
 * special-casing downstream.
 */
function setupCanvasFileDrop({ viewEl, contentEl, runtime, input, onDirty }: {
  viewEl: HTMLElement; contentEl: HTMLElement; runtime: Runtime; input: InputSpec; onDirty?: (id: string) => void;
}): void {
  const id = input.id;
  const accept = Array.isArray(input.accept) ? input.accept.join(',') : '';

  const native = document.createElement('input');
  native.type = 'file';
  if (accept) native.accept = accept;
  native.style.display = 'none';
  viewEl.appendChild(native);

  const revokePrev = () => {
    const prev = runtime.getModel().find(i => i.id === id)?.value;
    const prevUrl = asRow(prev).url;
    if (prevUrl) URL.revokeObjectURL(prevUrl as string);
  };
  const load = async (file: File | null | undefined) => {
    if (!file) return;
    if (input.maxSize && file.size > input.maxSize) {
      announce(`That file is too large (max ${fmtBytes(input.maxSize)}).`, { assertive: true });
      return;
    }
    const ref = await fileToRef(file);
    revokePrev();
    runtime.setInput(id, ref);
    onDirty?.(id);
  };

  native.addEventListener('change', () => { load(native.files && native.files[0]); native.value = ''; });

  // Click to pick: only an explicit [data-file-pick] affordance opens the picker (the
  // empty-state drop zone and the Replace button both carry it). We deliberately do
  // NOT treat a click on bare canvas as a pick — the canvas is full-bleed, so the dead
  // space around the centred drop zone would swallow stray clicks (including near-misses
  // on the fixed "Tools" return button in the corner) and surprise the user with a file
  // dialog. Drag-and-drop still covers the whole canvas.
  contentEl.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('[data-file-pick]')) native.click();
  });

  // Drag-and-drop over the whole canvas. A depth counter tracks enter/leave across
  // child nodes so the highlight doesn't flicker as the pointer crosses them.
  let depth = 0;
  const setDrag = (on: boolean) => contentEl.classList.toggle('is-file-dragover', on);
  contentEl.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; setDrag(true); });
  contentEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });
  contentEl.addEventListener('dragleave', (e) => {
    e.preventDefault();
    if (--depth <= 0) { depth = 0; setDrag(false); }
  });
  contentEl.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    setDrag(false);
    load(e.dataTransfer?.files && e.dataTransfer.files[0]);
  });
}

/**
 * Canvas-as-drop-zone for a sidebar tool that declares a `dropToAdd` blocks input
 * (e.g. logo-wall). The whole canvas — most usefully its empty state — accepts a
 * drag-and-drop of several files and appends one block per file, exactly like
 * dropping onto the sidebar list (shared committer + _dropChains serialisation), so
 * the template's "Drop your logos here" invite actually works and a populated wall
 * still grows by dropping more. A click on an explicit [data-file-pick] affordance
 * (the empty-state invite carries one) opens the multi-file native picker. Bare-canvas
 * clicks are left alone so the full-bleed dead space can't surprise the user with a
 * file dialog, and so per-cell click-to-focus (data-canvas-input) keeps working.
 * Listeners live on the stable contentEl, so they survive the per-render innerHTML
 * swaps of the canvas content.
 */
function setupCanvasBlocksDrop({ viewEl, contentEl, runtime, host, input, onDirty }: {
  viewEl: HTMLElement; contentEl: HTMLElement; runtime: Runtime; host: WebToolHost; input: InputSpec; onDirty?: (id: string) => void;
}): void {
  const { accept, addFiles } = makeBlocksDropper({ runtime, host, input, onDirty });

  const native = document.createElement('input');
  native.type = 'file';
  native.multiple = true;
  if (accept) native.accept = accept;
  native.style.display = 'none';
  viewEl.appendChild(native);
  native.addEventListener('change', () => { addFiles(native.files); native.value = ''; });

  contentEl.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('[data-file-pick]')) native.click();
  });
  contentEl.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && (e.target as HTMLElement).closest('[data-file-pick]')) {
      e.preventDefault();
      // Stop Space from also reaching setupStageNav's window-level keydown, which
      // would arm Space-to-pan; the file dialog steals focus before the keyup, so
      // it'd otherwise stay stuck on.
      e.stopPropagation();
      native.click();
    }
  });

  let depth = 0;
  const setDrag = (on: boolean) => contentEl.classList.toggle('is-file-dragover', on);
  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types || []).includes('Files');
  contentEl.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; setDrag(true); });
  contentEl.addEventListener('dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; });
  contentEl.addEventListener('dragleave', (e) => { e.preventDefault(); if (--depth <= 0) { depth = 0; setDrag(false); } });
  contentEl.addEventListener('drop', (e) => { e.preventDefault(); depth = 0; setDrag(false); addFiles(e.dataTransfer?.files); });
}

// True only when focus is in a genuinely text-editable field (so Cmd+Z falls
// through to the browser's per-character undo). Deliberately NARROWER than
// isTyping: a focused range slider / colour / checkbox / number IS an <input>
// but has no native undo, so our input-history undo should still fire there.
function isTextEditing(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  if ((el as HTMLElement).isContentEditable || el.tagName === 'TEXTAREA') return true;
  if (el.tagName !== 'INPUT') return false;
  return ['text', 'search', 'url', 'tel', 'email', 'password'].includes(((el as HTMLInputElement).type || 'text').toLowerCase());
}

// Mobile only: drive the top-anchored controls panel via the grip on its bottom
// edge. Dragging sets an inline --sheet-h on the layout (the panel height + grip
// position read it live); the preview is a static full-screen backdrop the panel
// slides over. Releasing snaps to the nearest of peek/half/full. A plain tap on the
// grip steps through the stops with a bounce (peek↔half↔full), so half — both the
// controls and the preview in view — is always one tap from either extreme.
// Optional `onChange` fires on each move/snap (unused while the preview is static).
// Classify a vertical swipe as a flick. A flick is either fast (high velocity)
// or a long, decisive drag; small/slow moves are taps or jitter. Returns
// 1 (down), -1 (up), or 0 (neither). Shared by the controls sheet and the
// export popup so both surfaces feel the same.
function flickDirection(dy: number, dt: number): number {
  const FAST = 0.35; // px/ms — a quick flick
  const FAR  = 48;   // px — a slow but decisive drag still counts
  if (Math.abs(dy) < 18) return 0;
  const v = dt > 0 ? Math.abs(dy) / dt : Infinity;
  if (v < FAST && Math.abs(dy) < FAR) return 0;
  return dy > 0 ? 1 : -1;
}

type SheetState = 'peek' | 'half' | 'full';

function setupMobileSheet(layoutEl: HTMLElement, sidebarEl: HTMLElement, gripEl: HTMLElement, onChange: ((state?: SheetState) => void) | null | undefined): void {
  const SNAPS: readonly SheetState[] = ['peek', 'half', 'full'];
  const mq = window.matchMedia('(max-width: 640px)');
  let state: SheetState = 'half';
  let dragging = false, moved = false, tapMode = false, tapDir = 1, startY = 0, startH = 0;

  const vh = () => window.innerHeight;
  // Peek = the sheet's minimized height, which must equal the real header height
  // so the whole header (centered Tools pill + title row) shows, not just row 1.
  // Measured from headerEl below (it varies — e.g. 44px tap targets on touch);
  // 56 is only the pre-measurement fallback.
  let PEEK = 56;

  function setState(s: SheetState): void {
    state = s;
    layoutEl.style.removeProperty('--sheet-h'); // drop any drag override; the per-state var animates in
    layoutEl.dataset.sheet = s;
    onChange?.(s);
  }

  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    layoutEl.classList.remove('is-sheet-dragging');
    // We just dropped `transition: none` (used for 1:1 tracking). Flush layout so
    // the restored height/top transition is live at the CURRENT height before
    // setState changes it — otherwise the class-removal + height change batch into
    // one recalc and the snap jumps instead of animating.
    void sidebarEl.offsetHeight;
    if (!moved) {                                   // a press, not a drag
      if (tapMode) {
        // Tap walks the sheet through its stops with a bounce (peek↔half↔full),
        // reversing at the ends. So half — both the controls AND the preview
        // visible — is always one tap from either extreme, and you can always
        // recentre the divider after moving it; the sheet never jumps the full
        // span in a single tap.
        const idx = Math.max(0, SNAPS.indexOf(state));
        if (idx === 0) tapDir = 1;
        else if (idx === SNAPS.length - 1) tapDir = -1;
        setState(SNAPS[idx + tapDir]!);
      } else {
        layoutEl.style.removeProperty('--sheet-h'); // header tap: no-op
      }
      return;
    }
    // Positional zones, no velocity: where the divider comes to rest decides the
    // dock. The screen splits into equal thirds and the divider's resting Y picks
    // the stop — release in the TOP third → dock to the top (peek, controls
    // minimised), the BOTTOM third → dock to the bottom (full, controls maximised),
    // the MIDDLE third → the 50/50 split (half). So a drag to the middle from
    // either extreme always lands on split, and a drag to the top stays at the top.
    const dividerY = sidebarEl.getBoundingClientRect().bottom; // grip rides the sheet's bottom edge
    const third = vh() / 3;
    if (dividerY < third)     return setState('peek');
    if (dividerY > third * 2) return setState('full');
    setState('half');
  };

  // Turn an element into a drag handle: the sheet follows the finger and snaps on
  // release. `tapToggles` gives the grip its tap-to-toggle; `guard` lets the
  // header ignore presses that land on a real control (its Tools link / toggle).
  function addDragHandle(handleEl: HTMLElement, { tapToggles = false, guard = null }: { tapToggles?: boolean; guard?: ((e: PointerEvent) => boolean) | null } = {}): void {
    handleEl.addEventListener('pointerdown', e => {
      if (!mq.matches || (guard && !guard(e))) return;
      dragging = true; moved = false; tapMode = tapToggles;
      startY = e.clientY;
      startH = sidebarEl.getBoundingClientRect().height;
      layoutEl.classList.add('is-sheet-dragging');
      handleEl.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    handleEl.addEventListener('pointermove', e => {
      if (!dragging) return;
      if (Math.abs(e.clientY - startY) > 4) moved = true;
      const h = Math.min(vh() * 0.92, Math.max(PEEK, startH + (e.clientY - startY))); // never below peek → grip stays visible
      layoutEl.style.setProperty('--sheet-h', h + 'px');
      onChange?.();
    });
    handleEl.addEventListener('pointerup', endDrag);
    handleEl.addEventListener('pointercancel', endDrag);
  }

  // The grip is the obvious handle; the header is the "wide blank area" the panel
  // wanted — grab anywhere on the title bar that isn't an actual control and drag
  // the sheet through its three stops.
  addDragHandle(gripEl, { tapToggles: true });
  const headerEl = sidebarEl.querySelector<HTMLElement>('.sidebar-header');
  if (headerEl) {
    addDragHandle(headerEl, {
      guard: e => !(e.target as HTMLElement).closest('a, button, input, select, textarea, label'),
    });
    // Drive the peek height from the header's real height so the minimized sheet
    // shows the full two-row header (pill + title). Header height is content-based
    // and effectively constant per device, so a one-time measure suffices; --peek-h
    // feeds the CSS peek/preview-top vars (see the mobile sheet block).
    const h = Math.ceil(headerEl.getBoundingClientRect().height);
    if (h > 0) { PEEK = h; layoutEl.style.setProperty('--peek-h', h + 'px'); }
  }

  // The body is for scrolling the controls — nothing else. It deliberately has NO
  // drag/flick handler: a touch that lands on the inputs (or the gaps between them)
  // must only ever scroll the list, never resize or dock the sheet. The grip and
  // the header are the sole handles, so scrolling the controls can't collapse the
  // split view out from under you. Resizing happens by dragging the grip/header.

  layoutEl.dataset.sheet = state; // define the var; only consumed under the mobile media query
}

function makeFetchFile(toolId: string): (path: string) => Promise<string> {
  return async (path: string) => {
    const resp = await fetch(`/tools/${path}`);
    if (resp.status === 404) throw new Error('tool-not-found');
    // SPA servers return index.html for unknown paths with a 200. Detect that.
    const ct = resp.headers.get('content-type') ?? '';
    // SPA fallback check — but skip for .html files since template.html legitimately returns text/html.
    if (!resp.ok || (ct.includes('text/html') && !path.endsWith('.html'))) throw new Error('tool-not-found');
    return await resp.text();
  };
}

function mount404(viewEl: HTMLElement, toolId: string): void {
  document.title = 'Not Found — Lolly';
  viewEl.innerHTML = `
    <div class="not-found">
      <div class="not-found-inner">
        <p class="not-found-code">404</p>
        <h1 class="not-found-title">Tool not found</h1>
        <p class="not-found-desc">There's no tool at <code>${escape(toolId)}</code>.</p>
        <a href="/" class="not-found-home">Browse all tools</a>
      </div>
    </div>
  `;
}

// Shown when a tool is opened in a shell that can't fulfil its capabilities
// (e.g. a 'capture' tool in the web PWA). Mirrors the 404 layout.
function mountUnavailable(viewEl: HTMLElement, manifest: ToolManifest, unmet: readonly string[]): void {
  document.title = `${manifest.name} — Desktop only`;
  const why = unmet.map(capabilityLabel).join(', ');
  viewEl.innerHTML = `
    <div class="not-found">
      <div class="not-found-inner">
        <p class="not-found-code">Desktop</p>
        <h1 class="not-found-title">${escape(manifest.name)} needs the desktop app</h1>
        <p class="not-found-desc">This tool uses <strong>${escape(why)}</strong>, which the web app can’t provide — a browser can’t screenshot cross-origin pages. Open it in the Lolly desktop app.</p>
        <a href="/" class="not-found-home">Browse all tools</a>
      </div>
    </div>
  `;
}

// Shown on a Chromium browser for a capture tool when the extension isn't
// installed — the tool CAN run here once the free extension is added.
function mountInstallPrompt(viewEl: HTMLElement, manifest: ToolManifest): void {
  document.title = `${manifest.name} — Add the extension`;
  viewEl.innerHTML = `
    <div class="not-found">
      <div class="not-found-inner">
        <p class="not-found-code">Add&#8209;on</p>
        <h1 class="not-found-title">Enable ${escape(manifest.name)} in your browser</h1>
        <p class="not-found-desc">Add the free Lolly screenshot extension and this tool captures pages right here — no desktop app needed. Install it, then reload this page.</p>
        <a href="${escape(CAPTURE_EXTENSION_URL)}" class="not-found-home" target="_blank" rel="noopener">Get the extension</a>
        <a href="#/" class="not-found-back">Back to all tools</a>
      </div>
    </div>
  `;
}

// Arms the `?copy` URL action. Clipboard writes require a user gesture
// (navigator.clipboard.write rejects otherwise, and the image path would fall
// back to a surprise download), so we can't copy silently on load. Instead we
// highlight the Copy button and perform the copy on the user's first click —
// which carries the transient activation the clipboard API needs.
function armAutoCopy(actionsEl: HTMLElement | null, actionsApi: ActionsApi | undefined, fmt?: string): void {
  const copyBtn = actionsEl?.querySelector<HTMLElement>('[data-action="copy"]');
  if (!copyBtn || !actionsApi?.copy) {
    console.warn('[copy] ?copy requested but this tool has no copy action');
    return;
  }

  const disarm = () => {
    document.removeEventListener('pointerdown', onGesture, true);
    copyBtn.classList.remove('copy-armed');
  };

  const onGesture = (e: PointerEvent) => {
    disarm();
    // If the click landed on the Copy button, its own handler runs the copy —
    // don't double up. Any other first interaction triggers it here.
    if (copyBtn.contains(e.target as Node)) return;
    actionsApi!.copy!(fmt).catch(err => console.error('Auto-copy failed:', err));
  };

  document.addEventListener('pointerdown', onGesture, true);
  copyBtn.classList.add('copy-armed');
}


function matchesDefault(input: { default?: InputValue; type: string }, paramVal: string): boolean {
  const def = input.default;
  if (def == null) return false;
  if (input.type === 'blocks') return false;
  if (input.type === 'boolean') return (paramVal === '1' || paramVal === 'true') === !!def;
  if (input.type === 'number')  return Number(paramVal) === Number(def);
  if (input.type === 'color')   return paramVal.replace(/^#/, '').toLowerCase() === String(def).replace(/^#/, '').toLowerCase();
  return paramVal === String(def);
}

/**
 * Remove URL params from the live address bar that already equal the tool's defaults.
 * Operates on the raw query string to preserve compact encodings (e.g. ~,).
 */
async function shrinkUrl(runtime: Runtime, manifest: ToolManifest, barSeq: BarSeq | null): Promise<void> {
  // The bar is normally the path form /t/<id>?… by now; tolerate the boot-time hash
  // form too. Keep the route part, rewrite only the query.
  const hashQ = window.location.hash.indexOf('?');
  const rawQs = window.location.search ? window.location.search.slice(1)
           : (hashQ >= 0 ? window.location.hash.slice(hashQ + 1) : '');
  if (!rawQs) return;
  const base = window.location.pathname + window.location.hash.split('?')[0]!;

  // If the bar is already packed, expand it back to the readable query so the
  // default-stripping below can see individual params (it operates per-key).
  const qs = hasPackedState(rawQs) ? await expandQuery(rawQs) : rawQs;

  const model = runtime.getModel();
  const inputsByKey: Record<string, InputModelItem> = {};
  for (const input of model) {
    inputsByKey[input.id] = input;
    if (input.urlKey) inputsByKey[input.urlKey] = input;
  }

  const RESERVED_KEEP = new Set(['format', 'export', 'copy', 'slot', 'output', 'full', '_v', 'nostage']);

  const kept: string[] = [];
  for (const part of qs.split('&')) {
    if (!part) continue;
    const eqIdx  = part.indexOf('=');
    const key    = eqIdx < 0 ? part : part.slice(0, eqIdx);
    const rawVal = eqIdx < 0 ? '' : part.slice(eqIdx + 1);
    const val    = decodeURIComponent(rawVal.replace(/\+/g, ' '));

    if (RESERVED_KEEP.has(key)) { kept.push(part); continue; }

    if (key === 'w' || key === 'width') {
      if (parseInt(val, 10) !== manifest.render.width) kept.push(part);
      continue;
    }
    if (key === 'h' || key === 'height') {
      if (parseInt(val, 10) !== manifest.render.height) kept.push(part);
      continue;
    }
    if (key === 'filename') {
      if (val !== manifest.name) kept.push(part);
      continue;
    }

    const input = inputsByKey[key];
    if (!input || !matchesDefault(input, val)) kept.push(part);
  }

  const newQs = kept.join('&');
  // Bump the shared guard so an in-flight syncUrl pack can't resolve later and clobber
  // this shrunk bar with the pre-shrink state (barSeq is the same holder syncUrl uses).
  const seq = barSeq ? ++barSeq.v : 0;
  // Re-pack if the shrunk-but-still-large query would still risk the URL ceiling and
  // packing actually wins; otherwise leave the readable form (shorter and editable).
  if (newQs.length >= AUTO_PACK_MIN && isPackAvailable()) {
    const token = await packQuery(newQs);
    if (barSeq && seq !== barSeq.v) return;             // a newer bar write happened mid-pack
    const packed = token && `${PACK_PARAM}=${token}`;
    if (packed && packed.length < newQs.length) {
      history.replaceState(null, '', `${base}?${packed}`);
      return;
    }
  }
  history.replaceState(null, '', newQs ? `${base}?${newQs}` : base);
}

/**
 * Encode a blocks array into the compact tilde-delimited URL format.
 * Each item's fields are comma-separated; items are tilde-separated.
 * Field values are encodeURIComponent'd so commas inside values become %2C
 * and are safe to split on. Color fields have their # stripped.
 * Returns null if encoding isn't possible (no fields defined).
 */
function encodeBlocksCompact(items: InputValue, fields: BlockFieldSpec[]): string | null {
  if (!Array.isArray(items) || !items.length || !fields.length) return null;
  // Raw (pre-encoding) value of each field, for the separator-safety check below.
  const rowVals = items.map(item =>
    fields.map(f => {
      const raw = asRow(item)[f.id];
      // Asset sub-fields hold an AssetRef object — its id (library assets only;
      // uploaded user/ refs aren't shareable, same as top-level assets).
      if (f.type === 'asset') {
        const id = raw && typeof raw === 'object' ? asRow(raw).id : '';
        return id && !String(id).startsWith('user/') ? String(id) : '';
      }
      const v = String(raw ?? '');
      return f.type === 'color' ? v.replace(/^#/, '') : v;
    })
  );
  // The record ('~') and field (',') separators can't be escaped inside a value:
  // the compact string is pushed into the share URL raw, and on parse
  // URLSearchParams percent-DECODES the whole value (%7E→'~', %2C→',') BEFORE the
  // block splitter runs — so an escaped separator collapses back into a real one
  // and one row splits into several with shifted fields. A '~' or ',' is easy to
  // inject via CSV/JSON import (or by typing one into a label). When any value
  // carries either separator, bail: return null so the caller falls back to the
  // lossless JSON block form (which round-trips cleanly through URLSearchParams).
  if (rowVals.some(r => r.some(v => v.includes('~') || v.includes(',')))) return null;
  return rowVals.map(r => r.map(encodeURIComponent).join(',')).join('~');
}

// btnScopeEl — element containing the copy-url button (the actions bar)
// exportScopeEl — element containing format/filename/w/h inputs (actionsEl); optional
function wireUpCopyUrl(btnScopeEl: HTMLElement, runtime: Runtime, exportScopeEl: HTMLElement | null, manifest: ToolManifest): void {
  btnScopeEl.querySelector<HTMLButtonElement>('[data-action="copy-url"]')?.addEventListener('click', () => {
    showShareDialog(runtime, exportScopeEl ?? btnScopeEl, manifest);
  });
}

// Builds the base share-link query parts (tool inputs + the chosen export
// settings) — WITHOUT the on-visit behaviour flags (full/options/export/copy/_v),
// which the share dialog appends per the user's toggles.
function buildShareParams(runtime: Runtime, exportScope: HTMLElement | null): string[] {
  const parts: string[] = [];

  for (const input of runtime.getModel()) {
    const { id, type, value, group, fields } = input;
    const key = input.urlKey ?? id;
    if (group === 'export') continue;

    if (type === 'asset') {
      const assetId = (value as AssetRef | null)?.id;
      if (assetId && !assetId.startsWith('user/')) {
        parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(assetId)}`);
      }
      continue;
    }

    if (type === 'blocks') {
      if (!Array.isArray(value) || value.length === 0) continue;
      const compact = encodeBlocksCompact(value, fields ?? []);
      // Fall back to JSON if no fields defined (other tools)
      const encoded = compact ?? JSON.stringify(value);
      if (encoded.length <= 8000) parts.push(`${key}=${compact ? encoded : encodeURIComponent(encoded)}`);
      continue;
    }

    if (type === 'vector') {
      // One flat param per field ("<inputId>.<fieldId>"), matching syncUrl and
      // serializeUrlState. Without this the object stringifies to "[object Object]".
      // Fields still at their default are omitted to keep the link short.
      if (value && typeof value === 'object') {
        const vv = asRow(value);
        for (const f of fields ?? []) {
          const fv = vv[f.id];
          if (fv == null) continue;
          if (f.default !== undefined && String(fv) === String(f.default)) continue;
          parts.push(`${encodeURIComponent(`${key}.${f.id}`)}=${encodeURIComponent(String(fv))}`);
        }
      }
      continue;
    }

    if (value == null || value === '') continue;
    if (typeof value === 'boolean' && !value) continue;

    // Skip params whose value matches the declared default — they load identically without being in the URL.
    const def = input.default;
    if (def != null && (type as string) !== 'asset') {
      if (String(value) === String(def)) continue;
    }

    // A token-backed colour ({ ref, value }) serialises to its canonical token ref
    // so a shared/embedded link re-resolves against the destination's tokens — and
    // never leaks "[object Object]" into the URL (mirrors the engine's coerceToString).
    let str = type === 'color' && isTokenValue(value) ? value.ref : String(value);
    if (str.length > 150) continue;

    // Strip # from plain hex colors — saves 3 encoded chars (%23) per color param.
    // A token ref ({color.brand.jungle}) has no leading # and passes through as-is.
    if (type === 'color' && str.startsWith('#')) str = str.slice(1);

    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(str)}`);
  }

  // Export settings come from the live actions-bar controls (the export panel).
  const fmtEl = exportScope?.querySelector<HTMLSelectElement>('[data-action="format"]');
  if (fmtEl?.value) parts.push(`format=${encodeURIComponent(fmtEl.value)}`);
  const fname = exportScope?.querySelector<HTMLInputElement>('[data-action="filename"]')?.value?.trim();
  if (fname) parts.push(`filename=${encodeURIComponent(fname)}`);
  const w = parseFloat(exportScope?.querySelector<HTMLInputElement>('[data-action="export-width"]')?.value ?? '');
  const h = parseFloat(exportScope?.querySelector<HTMLInputElement>('[data-action="export-height"]')?.value ?? '');
  if (w > 0) parts.push(`w=${w}`);
  if (h > 0) parts.push(`h=${h}`);
  const u = exportScope?.querySelector<HTMLSelectElement>('[data-action="export-unit"]')?.value;
  if (u && u !== 'px') {
    parts.push(`unit=${u}`);
    const d = parseInt(exportScope?.querySelector<HTMLInputElement>('[data-action="export-dpi"]')?.value ?? '', 10);
    if (d > 0) parts.push(`dpi=${d}`);
  }
  // Colour profile is only meaningful for the CMYK print formats (Print PDF / Print
  // TIFF); carry it only when one is selected and it isn't the default condition.
  const prof = exportScope?.querySelector<HTMLSelectElement>('[data-action="cmyk-profile"]')?.value;
  if (isCmykFmt(fmtEl?.value) && prof && prof !== DEFAULT_CMYK_CONDITION) {
    parts.push(`profile=${encodeURIComponent(prof)}`);
  }
  // Open-password — standard-tier lock only (PDF or ZIP), only when set. Clear-text by
  // design so a shared link can carry the lock; never used for confidential files.
  const pdfPass = exportScope?.querySelector<HTMLInputElement>('[data-action="pdf-password"]')?.value;
  const pdfStrong = exportScope?.querySelector<HTMLSelectElement>('[data-action="pdf-lock-tier"]')?.value === 'strong';
  if ((fmtEl?.value === 'pdf' || fmtEl?.value === 'zip') && pdfPass && !pdfStrong) {
    parts.push(`password=${encodeURIComponent(pdfPass)}`);
  }
  // Print marks & bleed — print formats (pdf / pdf-cmyk / cmyk-tiff) only, and only
  // when the card is on.
  if (isPrintFmt(fmtEl?.value) && printEnabled(exportScope)) {
    const bleed = readBleed(exportScope);
    if (bleed) parts.push(`bleed=${encodeURIComponent(bleed)}`);
    const marks = readMarks(exportScope);
    if (marks) parts.push(`marks=${encodeURIComponent(marks)}`);
  }

  return parts;
}


// The Share button opens the shared dialog (components/share-dialog.js): a ready-to-copy
// link plus the on-visit behaviour toggles. This thin wrapper feeds it the live tool
// state; the Projects view reuses the same dialog for a saved session.
function showShareDialog(runtime: Runtime, exportScope: HTMLElement | null, manifest: ToolManifest): void {
  // Resolve the tool id from the address bar (path or hash form) so the link is the
  // crawler-visible /t/<id> shape. The dialog itself lives in components/share-dialog.js,
  // shared with the Projects view's per-session "Share link". buildShareParams stays here
  // (it reads the live runtime + export-panel DOM); the session path passes its own parts.
  const toolId = window.location.pathname.match(/^\/t\/([^/?]+)/)?.[1]
              ?? window.location.hash.match(/^#\/tool\/([^/?]+)/)?.[1];
  const currentFormat = exportScope?.querySelector<HTMLSelectElement>('[data-action="format"]')?.value || '';
  openShareDialog({ toolId, baseParts: buildShareParams(runtime, exportScope), manifest, currentFormat });
}


// Re-create <script> elements so the browser executes them.
// Walk the canvas DOM for HTML comment markers left by annotateTemplate, convert
// them into data-canvas-input attributes, then remove the comments.
// Block-element outputs (e.g. <p> from {{markdown}}) are marked directly.
// Plain text outputs get wrapped in a transparent <span> so they're clickable.
function resolveCanvasAnnotations(canvasEl: HTMLElement): void {
  const comments: Comment[] = [];
  const walker = document.createTreeWalker(canvasEl, NodeFilter.SHOW_COMMENT);
  let node: Node | null;
  while ((node = walker.nextNode())) comments.push(node as Comment);

  for (const comment of comments) {
    if (!comment.parentNode) continue;
    const text = (comment.nodeValue ?? '').trim();
    const m = text.match(/^ci:(.+)$/);
    if (!m) continue;
    const id = m[1]!;

    // Collect siblings until the matching closing comment.
    const between: Node[] = [];
    let closing: ChildNode | null = null;
    let cur: ChildNode | null = comment.nextSibling;
    while (cur) {
      if (cur.nodeType === Node.COMMENT_NODE && (cur.nodeValue ?? '').trim() === `/ci:${id}`) {
        closing = cur;
        break;
      }
      between.push(cur);
      cur = cur.nextSibling;
    }

    const elements = between.filter(n => n.nodeType === Node.ELEMENT_NODE);
    if (elements.length > 0) {
      for (const el of elements) (el as HTMLElement).dataset.canvasInput = id;
    } else {
      // Pure text — wrap in a span so it's individually clickable.
      const span = document.createElement('span');
      span.dataset.canvasInput = id;
      comment.parentNode.insertBefore(span, comment);
      for (const n of between) span.appendChild(n);
    }

    comment.remove();
    closing?.remove();
  }
}

function showClearDialog(onConfirm: () => void): void {
  const dialog = document.createElement('dialog');
  dialog.className = 'unsaved-dialog';
  dialog.innerHTML = `
    <div class="unsaved-dialog-body">
      <h2>Clear changes?</h2>
      <p>This will reset every field to its default value.<br>This cannot be undone.</p>
      <div class="unsaved-dialog-actions">
        <button class="unsaved-leave">Clear changes</button>
        <button class="unsaved-cancel">Cancel</button>
      </div>
    </div>
  `;
  document.body.appendChild(dialog);
  dialog.showModal();

  const cleanup = () => { dialog.close(); dialog.remove(); };

  dialog.querySelector('.unsaved-leave')!.addEventListener('click', () => { cleanup(); onConfirm(); });
  dialog.querySelector('.unsaved-cancel')!.addEventListener('click', cleanup);
  dialog.addEventListener('cancel', () => dialog.remove());
}

// onSave: optional async () => void that performs the save and navigates on
// success (the caller owns both). We await it rather than firing a button click,
// so "Save & leave" reliably saves *then* leaves instead of trusting a
// fire-and-forget click + timer.
function showUnsavedDialog(onSave: (() => Promise<void> | void) | null, onLeave: () => void, detail?: string): void {
  const dialog = document.createElement('dialog');
  dialog.className = 'unsaved-dialog';
  dialog.innerHTML = `
    <div class="unsaved-dialog-body">
      <h2>Unsaved changes</h2>
      <p>You have unsaved changes. <br>Would you like to save before leaving?</p>
      ${detail ? `<p class="unsaved-dialog-detail">${detail}</p>` : ''}
      <div class="unsaved-dialog-actions">
        ${onSave ? `<button class="unsaved-save">Save &amp; leave</button>` : ''}
        <button class="unsaved-leave">Leave without saving</button>
        <button class="unsaved-cancel">Cancel</button>
      </div>
    </div>
  `;
  dialog.dataset.sfxClose = 'off'; // this dialog owns its dismiss cue ('land' on Cancel), not the generic shoo
  document.body.appendChild(dialog);
  dialog.showModal();
  playSfx('crystal'); // a light glass-elevator lift as the save decision rises up

  const cleanup = () => { dialog.close(); dialog.remove(); };

  onSave && dialog.querySelector('.unsaved-save')?.addEventListener('click', async () => {
    cleanup();
    await onSave!();
  });
  dialog.querySelector('.unsaved-leave')!.addEventListener('click', () => { cleanup(); onLeave(); });
  dialog.querySelector('.unsaved-cancel')!.addEventListener('click', () => { playSfx('land'); cleanup(); }); // reverse-liftoff settle
  dialog.addEventListener('cancel', () => { playSfx('land'); dialog.remove(); }); // Escape = Cancel
}

