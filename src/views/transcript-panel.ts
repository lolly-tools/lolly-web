// SPDX-License-Identifier: MPL-2.0
/**
 * transcript-panel.ts - the right-docked Transcript surface for transcript-driven
 * editing (plans/174). Edit like a document: the clip's words flow as one paragraph;
 * click a word to seek, drag or double-click to select a span, Delete to CUT that
 * media, ⌘/Ctrl+Delete to STRIKE it (reversible - a second ⌘Delete on a struck span
 * restores it). All editing arithmetic lives in the pure, headless-tested
 * transcript-edit.ts / timeline-math.ts; this module is only DOM + native selection,
 * and every edit funnels through the injected undo-aware `write`, so ⌘Z takes it back.
 *
 * Opened FROM timeline-panel.ts, which hands us the closures it already holds
 * (getBoxes / write / clock seek+tick / cfg) and maps the panel's AUTHORED times to
 * the clock's compressed timebase. Self-contained: docked into the shared right-edge
 * column (lib/edge-dock.ts) on desktop, a fixed overlay below the mobile breakpoint.
 */

import { icon, type IconName } from '../lib/icons.ts';
import { t } from '../i18n.ts';
import { requestDock, releaseDock } from '../lib/edge-dock.ts';
import type { SpeechWordTiming } from '@lolly-tools/core/host-v1';
import type { Box, TimeCfg } from './timeline-math.ts';
import {
  transcriptRows, deleteMediaRange, ignoreMediaRange, restoreIgnored,
} from './transcript-edit.ts';
import '../styles/parts/transcript.css';

export interface TranscriptPanelOpts {
  cfg: TimeCfg;
  /** The source clip's word timings (media seconds), from subtitleSource(). */
  words: SpeechWordTiming[];
  /** The source asset id (may be '' for a stashed / URL source - then we match by url). */
  assetId: string;
  /** The box id the panel was opened on - the source clip, whose asset key we capture. */
  sourceId: string;
  /** The box sub-field carrying the asset ref (design: 'image'). */
  assetField: string;
  /** Read the live boxes array (closure over the runtime model). */
  getBoxes: () => Box[];
  /** The one undo-aware write path (timeline-panel's `write`). */
  write: (next: Box[]) => void;
  /** Seek the playhead to an AUTHORED-time millisecond (the caller maps to the clock). */
  seek: (ms: number) => void;
  /** Subscribe to playhead ticks (AUTHORED ms) for the read-along highlight. */
  subscribeTick: (cb: (ms: number) => void) => () => void;
  /** Optional: subscribe to model changes so external edits refresh the words. */
  subscribeModel?: (cb: () => void) => () => void;
  /** A human label for the clip, shown in the header. */
  title?: string;
}

export interface TranscriptPanel { close(): void; }

let _active: TranscriptPanel | null = null;

/** Close any open transcript panel (singleton - one clip's transcript at a time). */
export function closeTranscriptPanel(): void { _active?.close(); }

const idOf = (b: Box, cfg: TimeCfg): string => String(b[cfg.idField] ?? '');

/** The asset a box renders, keyed by BOTH its id and url. Splits copy the whole ref, so
 *  matching on either survives every edit - and a stashed / no-id source (a fresh
 *  recording, a URL) still resolves by url when its ref carries no persisted id. */
function assetKeyOf(b: Box | undefined, assetField: string): { id: string; url: string } | null {
  const r = b?.[assetField];
  if (r == null || typeof r !== 'object' || Array.isArray(r)) return null;
  const o = r as { id?: unknown; url?: unknown; source?: unknown };
  const id = typeof o.id === 'string' ? o.id : '';
  const url = typeof o.url === 'string' ? o.url : (typeof o.source === 'string' ? o.source : '');
  return (id || url) ? { id, url } : null;
}

/** A collision-free id minter for one edit (splitBox may mint twice). */
function makeMint(boxes: readonly Box[], cfg: TimeCfg): () => string {
  const used = new Set(boxes.map((b) => idOf(b, cfg)));
  let n = used.size;
  return () => { let id: string; do { n++; id = `b${n}`; } while (used.has(id)); used.add(id); return id; };
}

/** A labelled action button. `mousedown` preventDefault keeps the word selection alive
 *  when the button takes the click (else the click would collapse it first). */
function makeActBtn(iconName: IconName, label: string): { b: HTMLButtonElement; lab: HTMLElement } {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'tr-act';
  const ico = document.createElement('span');
  ico.className = 'tr-act-ico';
  ico.innerHTML = icon(iconName);   // trusted lib/icons constant
  const lab = document.createElement('span');
  lab.textContent = label;
  b.append(ico, lab);
  b.addEventListener('mousedown', (e) => e.preventDefault());
  return { b, lab };
}

export function openTranscriptPanel(opts: TranscriptPanelOpts): TranscriptPanel {
  closeTranscriptPanel();
  const { cfg, words, assetId, assetField, getBoxes, write, seek, subscribeTick, subscribeModel } = opts;

  // The source asset's stable key, captured ONCE from the clip we opened on. Every box
  // that renders a window of it - the original plus every split - carries the same asset
  // ref, so we match on id-or-url and stay correct as cuts accrue. Falls back to the
  // passed assetId when the opened box can't be found (already edited away, say).
  const srcKey = assetKeyOf(getBoxes().find((b) => idOf(b, cfg) === opts.sourceId), assetField)
    ?? (assetId ? { id: assetId, url: '' } : null);
  function srcBoxes(boxes: readonly Box[]): Box[] {
    if (!srcKey) return [];
    return boxes.filter((b) => {
      const k = assetKeyOf(b, assetField);
      return !!k && ((!!srcKey.id && k.id === srcKey.id) || (!!srcKey.url && k.url === srcKey.url));
    });
  }

  const panel = document.createElement('aside');
  panel.className = 'tr-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', t('Transcript'));

  // ── header ────────────────────────────────────────────────────────────────
  const head = document.createElement('div');
  head.className = 'tr-head';
  const title = document.createElement('span');
  title.className = 'tr-title';
  title.textContent = opts.title || t('Transcript');
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'tr-close';
  closeBtn.setAttribute('aria-label', t('Close'));
  closeBtn.innerHTML = icon('close');
  head.append(title, closeBtn);

  // ── toolbar: the actions, spelled out (no shortcut knowledge required) ────────
  const toolbar = document.createElement('div');
  toolbar.className = 'tr-toolbar';
  const cut = makeActBtn('trash', t('Cut'));
  cut.b.setAttribute('data-danger', '');
  cut.b.title = t('Remove the selected words and their audio (⌘Z undoes)');
  const skip = makeActBtn('minus', t('Skip'));
  skip.b.title = t('Skip the selected words on playback, keeping them (a second Skip restores)');

  const spacer = document.createElement('span');
  spacer.className = 'tr-spacer';

  const showSkipped = document.createElement('label');
  showSkipped.className = 'tr-chk';
  const showSkippedCb = document.createElement('input');
  showSkippedCb.type = 'checkbox';
  showSkippedCb.checked = true;
  showSkipped.append(showSkippedCb, document.createTextNode(t('Show skipped')));
  toolbar.append(cut.b, skip.b, spacer, showSkipped);

  // ── the flowing transcript + foot ────────────────────────────────────────────
  const list = document.createElement('div');
  list.className = 'tr-list';
  const flow = document.createElement('div');
  flow.className = 'tr-flow';
  // A READ-ONLY contenteditable: the browser gives a real blinking caret, click-to-place,
  // arrow-key navigation and native drag/double-click selection - the "edit like a document"
  // feel - while every actual mutation is blocked, so the words can only be SELECTED, never
  // typed over. All edits go through Delete/⌘Delete (onKey below) → the tested media ops.
  flow.contentEditable = 'true';
  flow.spellcheck = false;
  flow.setAttribute('role', 'textbox');
  flow.setAttribute('aria-multiline', 'true');
  flow.setAttribute('aria-readonly', 'true');
  flow.addEventListener('beforeinput', (e) => e.preventDefault());   // no typing/native delete
  flow.addEventListener('paste', (e) => e.preventDefault());
  flow.addEventListener('drop', (e) => e.preventDefault());
  list.appendChild(flow);
  const foot = document.createElement('div');
  foot.className = 'tr-foot';
  foot.textContent = t('Click a word to jump · drag to select · then Cut or Skip (or press Delete / ⌘Delete)');

  panel.append(head, toolbar, list, foot);
  document.body.appendChild(panel);
  // Dock into the shared right-edge column so the stage AND the timeline are NUDGED
  // in (not overlapped) - #view reserves `--dock-w` and re-fits (lib/edge-dock.ts).
  const docked = requestDock('transcript', panel, { icon: icon('transcript'), label: t('Transcript') });

  const syncHideIgnored = (): void => { panel.dataset.hideIgnored = showSkippedCb.checked ? '0' : '1'; };

  /** The rendered word spans, cached for the per-tick read-along scan. */
  let wordEls: HTMLElement[] = [];

  function render(): void {
    const rows = transcriptRows(words, srcBoxes(getBoxes()), cfg, { granularity: 'word' });
    flow.textContent = '';   // clears the words AND any prior empty message - one owner
    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'tr-empty';
      empty.textContent = t('No speech left in this clip.');
      flow.appendChild(empty);
      wordEls = [];
      return;
    }
    const els: HTMLElement[] = [];
    for (const row of rows) {
      const w = document.createElement('span');
      w.className = 'tr-word' + (row.ignored ? ' is-ignored' : '');
      w.textContent = row.text;
      w.dataset.ms0 = String(row.mStart);
      w.dataset.ms1 = String(row.mEnd);
      w.dataset.t0 = String(row.timelineStart);
      w.dataset.t1 = String(row.timelineEnd);
      w.dataset.box = row.boxId;
      flow.append(w, document.createTextNode(' '));
      els.push(w);
    }
    wordEls = els;
    nowEl = null;
  }

  function idsNow(boxes: Box[]): string[] {
    return srcBoxes(boxes).map((b) => idOf(b, cfg));
  }

  /** The word spans the native selection currently touches (partial counts). */
  function selectedWords(): HTMLElement[] {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return [];
    return wordEls.filter((w) => sel.containsNode(w, true));
  }

  /** Is the selection anchored inside the transcript flow (not some other field)? */
  function selectionInFlow(): boolean {
    const a = window.getSelection()?.anchorNode;
    return !!a && flow.contains(a);
  }

  /** Delete or strike the selected words. ⌘Delete on an all-struck selection restores it. */
  function applySelection(strike: boolean): void {
    const spans = selectedWords();
    if (!spans.length) return;
    let boxes = getBoxes();

    if (strike && spans.every((w) => w.classList.contains('is-ignored'))) {
      // Un-strike: clear the flag on every box the selection covers.
      for (const bId of new Set(spans.map((w) => w.dataset.box || ''))) boxes = restoreIgnored(boxes, cfg, bId);
      write(boxes);
    } else {
      const mStart = Math.min(...spans.map((w) => Number(w.dataset.ms0)));
      const mEnd = Math.max(...spans.map((w) => Number(w.dataset.ms1)));
      const ids = idsNow(boxes);
      const mint = makeMint(boxes, cfg);
      write(strike
        ? ignoreMediaRange(boxes, cfg, ids, mStart, mEnd, mint)
        : deleteMediaRange(boxes, cfg, ids, mStart, mEnd, mint));
    }
    window.getSelection()?.removeAllRanges();
    render();
  }

  // Click a word (no active selection) seeks the playhead to it. A drag/double-click
  // leaves a non-collapsed selection, so it selects instead of seeking.
  flow.addEventListener('click', (e) => {
    const w = (e.target as HTMLElement).closest?.('.tr-word') as HTMLElement | null;
    if (!w) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    seek(Math.max(0, Number(w.dataset.t0) * 1000));
  });

  // ── read-along highlight ────────────────────────────────────────────────────
  let nowEl: HTMLElement | null = null;
  const onTick = subscribeTick((ms) => {
    const sec = ms / 1000;
    let hit: HTMLElement | null = null;
    for (const w of wordEls) {
      if (sec >= Number(w.dataset.t0) && sec < Number(w.dataset.t1)) { hit = w; break; }
    }
    if (hit === nowEl) return;
    nowEl?.classList.remove('is-now');
    hit?.classList.add('is-now');
    nowEl = hit;
  });

  // External model edits (canvas trims, splits) refresh the words.
  const onModel = subscribeModel ? subscribeModel(() => render()) : null;

  showSkippedCb.addEventListener('change', syncHideIgnored);

  // Keep the toolbar in step with the live selection: the actions are enabled only once
  // words are picked, and Skip flips to Restore when the whole selection is already struck.
  function syncToolbar(): void {
    const spans = selectedWords();
    const has = spans.length > 0;
    cut.b.disabled = !has;
    skip.b.disabled = !has;
    skip.lab.textContent = has && spans.every((w) => w.classList.contains('is-ignored')) ? t('Restore') : t('Skip');
  }
  cut.b.addEventListener('click', () => applySelection(false));
  skip.b.addEventListener('click', () => applySelection(true));
  document.addEventListener('selectionchange', syncToolbar);

  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectionInFlow()) {
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) {
        e.preventDefault();
        e.stopPropagation();
        applySelection(e.metaKey || e.ctrlKey);
      }
    }
  }
  document.addEventListener('keydown', onKey, true);
  closeBtn.addEventListener('click', () => close());

  let closed = false;
  function close(): void {
    if (closed) return;
    closed = true;
    onTick();
    onModel?.();
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('selectionchange', syncToolbar);
    if (docked) releaseDock('transcript'); // restores the element to <body>, un-nudges #view
    panel.remove();
    if (_active === api) _active = null;
  }

  syncHideIgnored();
  render();
  syncToolbar();
  // Focus the transcript so the caret is there immediately - it reads as a document to
  // edit, not a panel to read. Harmless when empty.
  try { flow.focus({ preventScroll: true }); } catch { /* older browsers: no options arg */ }

  const api: TranscriptPanel = { close };
  _active = api;
  return api;
}
