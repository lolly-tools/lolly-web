// SPDX-License-Identifier: MPL-2.0
/**
 * Tool view — input subsystem.
 *
 * The sidebar input controls and the in-place embed editor, split out of tool.ts
 * (which keeps mountTool + the mount-only helpers). renderInputs builds the control
 * markup, syncInputs applies the minimal DOM update on a model change, and
 * openEmbedEditor drives a throwaway child runtime through the SAME render path.
 *
 * This module never value-imports from ./tool.ts (that would create a runtime
 * cycle) — it only `import type`s the shell-side aliases it needs from there.
 */
import { createRuntime, parseUrlState, serializeUrlState, buildEmbedUrl, parseToolUrl, parseDataRows, DEFAULT_FILE_MAX_BYTES, bakeAssetRef } from '@lolly/engine';
import { escape, NAV_EVENTS } from '../utils.js';
import { mountModal } from '../components/modal.ts';
import { announce } from '../a11y.js';
import { colorFieldHtml, wireColorField } from '../components/color-field.js';
import { helpTip, wireHelpTips, linkHelpDescriptions } from '../components/help-tip.js';
import { canSkipInputsRebuild } from './inputs-sync.js';
import { jellyActive } from '../lib/jelly.ts';
import { trapFocus, type FocusTrap } from '../lib/focus-trap.ts';
import { installTablePaste } from '../lib/table-paste.ts';
import { splitMarkdownIntoBlocks } from '../lib/markdown.ts';
import { playSliderTick, playScrubTick } from '../lib/sfx.ts';
import { icon, hasIcon } from '../lib/icons.ts';
import {
  nestingActive, nestingConfig, deriveBlockKeys, blockParentIndex,
  blockTreeOrder, blockReparentMove, buildRefOptions, materializeRefTarget,
} from './block-tree.js';
import { getTool } from '../bridge/tool-loader.js';
import { brandFontFamilies } from '../user-fonts.ts';
import { storeUserUpload, askLollyIntent } from './picker.js';
import flatpickr from 'flatpickr';

import type { AssetRef, ComposeAPI, InputFile } from '../../../../engine/src/bridge/host-v1.js';
import type { InputModelItem, InputValue, InputSpec, BlockFieldSpec } from '../../../../engine/src/inputs.js';
import type { LoadedTool } from '../../../../engine/src/loader.js';
import type { Runtime } from '../../../../engine/src/runtime.js';

import { asRow, type BlockRow } from './tool-types.ts';
import type { WebToolHost, PanelEl, EmbedDescribe, FlatpickrHost } from './tool.ts';

/** The two-step block-remove button arms itself with these expandos. */
interface ConfirmButton extends HTMLElement { _armed?: boolean; _disarm?: (() => void) | null; }
/** A block drag handle flags the click that trails a drag. */
interface DragHandle extends HTMLElement { _dragJustHappened?: boolean; }
/** The active block drag-reorder gesture, or null when none is running. */
interface BlockDrag { inputId: string; from: number; intent: 'before' | 'after' | 'inside' | null; over: number | null; }

export const asStr = (v: InputValue | undefined): string | undefined => (typeof v === 'string' ? v : undefined);

// Set to true while a custom slider is being dragged so renderInputs
// doesn't rebuild the sidebar (killing pointer capture mid-drag).
// The canvas still updates live via contentEl.innerHTML in the subscriber.
export let _sliderDragging = false;

// Active block drag-reorder gesture: { inputId, from } while a block's header is
// being dragged to a new position. Module-scoped so it survives the closure of a
// single renderInputs pass (the panel only rebuilds on drop).
let _blockDrag: BlockDrag | null = null;

/**
 * Read a picked / dropped File into the in-memory FileRef the input model carries
 * (bytes + metadata). The bytes live only in memory and are never uploaded — the
 * url is a local object URL for previews. Shared by the sidebar file-picker and
 * the canvas drop zone so both produce an identical model value.
 */
async function fileToRef(file: File): Promise<InputFile> {
  return {
    __file: true,
    name: file.name,
    mime: file.type || 'application/octet-stream',
    size: file.size,
    bytes: new Uint8Array(await file.arrayBuffer()),
    url: URL.createObjectURL(file),
  };
}

// Honour the OS "reduce motion" setting for the JS-driven scroll/reveal below.
// The global CSS reset zeroes CSS animations + scroll-behavior, but it can't reach
// an explicit JS scrollIntoView({behavior:'smooth'}) or a WAAPI tween — those have
// to be gated here.
function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// Bring a sidebar control into view and flash a one-shot "you are here" pulse on
// its row. The single entry point for every canvas-click and block-expand scroll,
// so arrival is consistent: top-aligned (clear of the sticky header via the row's
// scroll-margin), smooth unless reduce-motion. `control` may be the control itself
// or any node inside its row/block.
function scrollToControl(control: Element | null | undefined, { pulse = true }: { pulse?: boolean } = {}): void {
  if (!control) return;
  const row = control.closest('.input-row, .block-item') || control;
  row.scrollIntoView({ block: 'start', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  if (!pulse) return;
  row.classList.remove('is-target');
  void (row as HTMLElement).offsetWidth;      // restart the keyframe if it's mid-flight
  row.classList.add('is-target');
  const done = () => row.classList.remove('is-target');
  row.addEventListener('animationend', done, { once: true });
  setTimeout(done, 700);                       // fallback if the keyframe is reduce-motion-zeroed
}

// Reveal a block's fields with a brief height tween when it expands. The resting
// collapsed state stays `display:none` (so folded fields keep out of the Tab order
// and the a11y tree) — only the open is animated, and only when motion is allowed.
function revealBlockFields(item: Element): void {
  if (prefersReducedMotion()) return;
  const fields = item.querySelector<HTMLElement>('.block-fields');
  if (!fields || typeof fields.animate !== 'function') return;
  // Compositor-only fade — NO height tween. The old height animation forced a full
  // sidebar reflow every frame and slid every block below for 180ms, while the card
  // chrome (padding/border-radius/background) snapped instantly — the visible shake.
  // The fields are display:none when collapsed, so they land in their FINAL position
  // in a single reflow the moment they un-hide; only opacity/transform (which never
  // affect layout) animate, so nothing moves a pixel after settle.
  fields.animate(
    [{ opacity: 0, transform: 'translateY(-4px)' }, { opacity: 1, transform: 'none' }],
    { duration: 120, easing: 'ease-out' }
  );
}

// Single seam for folding/unfolding a block: keeps the collapse class, the chevron
// button's aria-label/title, and the open animation in lockstep wherever a block is
// toggled (chevron, pill body, collapse-all, canvas click). renderInputs re-applies
// the collapse state across model rebuilds via the captured collapsedBlocks set.
function toggleBlock(item: Element, collapsed: boolean): void {
  if (item.classList.contains('is-collapsed') === collapsed) return;
  item.classList.toggle('is-collapsed', collapsed);
  const btn = item.querySelector('[data-block-collapse]');
  btn?.setAttribute('aria-label', collapsed ? 'Expand block' : 'Collapse block');
  btn?.setAttribute('title', collapsed ? 'Expand' : 'Collapse');
  if (!collapsed) revealBlockFields(item);
}

// Click-to-focus for a single block inside a blocks input: expand the target
// block and fold every other typed block to a pill, then drop the caret in its
// text field and scroll it into view. Folding mirrors the manual collapse
// toggle's button state so renderInputs re-applies it across model rebuilds.
// Triggered when a rendered canvas block is clicked — an "edit one at a time"
// focus mode. Blocks with no text field (headshot, blank) just expand + scroll.
function focusSidebarBlock(blocksEl: Element, index: number | string): void {
  const items = [...blocksEl.querySelectorAll<HTMLElement>('.block-item.is-typed')];
  const target = items.find(b => b.dataset.blockIndex === String(index));
  if (!target) return;

  for (const b of items) toggleBlock(b, b !== target);

  // Reveal the block if it sits inside a closed section, then bring it into view.
  target.closest('details.input-section')?.setAttribute('open', '');
  // Defer the scroll one frame: the bulk collapse above relocated every block, so
  // scrolling now would chase a layout that's about to settle (a double-motion lurch).
  requestAnimationFrame(() => scrollToControl(target));

  const field = target.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    '.block-fields textarea.block-field, .block-fields input.block-field:not([type="range"])'
  );
  if (field) {
    field.focus();
    const end = field.value?.length ?? 0;
    try { field.setSelectionRange(end, end); } catch { /* non-text field */ }
  }
}

/**
 * Reflect a model change in the sidebar with the least work. renderInputs()
 * rebuilds the whole panel's innerHTML and re-wires every listener (and
 * destroys/recreates each flatpickr) — necessary on first render or a structural
 * change, but pure waste on a keystroke, where the only change is a value the
 * edited field already shows. In that case (canSkipInputsRebuild) the rebuild is
 * skipped entirely. Returns the model to remember as the new baseline.
 */
function syncInputs(el: PanelEl, model: InputModelItem[], prevModel: InputModelItem[] | null | undefined, runtime: Runtime, host: WebToolHost, onDirty?: (id: string) => void): InputModelItem[] {
  if (canSkipInputsRebuild(el, model, prevModel)) return model;
  renderInputs(el, model, runtime, host, onDirty);
  return model;
}

// Serialises drop-to-add commits per blocks-input id across re-renders (see the
// dropToAdd wiring below): each multi-file drop waits for the previous one to
// commit before reading the live array, so two quick drops can't both read the
// same base and clobber one another.
const _dropChains = new Map<string, Promise<void>>();

// Builds the "upload each file → append one block per file" committer for a blocks
// input that declares `dropToAdd`. Shared by the sidebar blocks list (renderInputs)
// and the canvas drop zone (setupCanvasBlocksDrop, e.g. logo-wall) so both surfaces
// accept a pile of files identically and serialise through _dropChains — a drop onto
// the canvas and one onto the sidebar can't read the same base array and clobber.
function makeBlocksDropper({ runtime, host, input, onDirty }: {
  runtime: Runtime; host: WebToolHost; input: InputSpec; onDirty?: (id: string) => void;
}): { accept: string; plural: string; addFiles: (fileList: FileList | File[] | null | undefined) => Promise<void> } {
  const blockId = input.id;
  const field = input.dropToAdd!.field;

  // Accept filter: "image/*" (default) matches any image; a trailing /* matches a
  // whole MIME group; an exact type matches itself. Files with no MIME type (some
  // OS drag sources report none) are allowed when accept has a wildcard group, so
  // they're not silently dropped — the upload path validates bytes.
  const accept = (input.dropToAdd!.accept || 'image/*').trim();
  const accepted = (file: File): boolean => {
    const t = (file.type || '').toLowerCase();
    if (!accept || accept === '*' || accept === '*/*') return true;
    if (!t) return accept.includes('/*');
    return accept.split(',').some(a => {
      a = a.trim().toLowerCase();
      return a.endsWith('/*') ? t.startsWith(a.slice(0, -1)) : t === a;
    });
  };

  // The noun for prompts/announcements comes from the input label, so this stays
  // generic — a future "Documents"/"Videos" blocks input reads correctly.
  const plural = (input.label || 'files').toLowerCase();
  const singular = plural.replace(/s$/, '');

  const commit = async (fileList: File[]): Promise<void> => {
    const all = Array.from(fileList || []);
    const files = all.filter(accepted);
    if (all.length && !files.length) { announce(`Those don't look like ${plural}.`, { assertive: true }); return; }
    if (!files.length) return;
    const made: Record<string, InputValue>[] = [];
    for (const file of files) {
      try {
        const ref = await storeUserUpload(host as unknown as Parameters<typeof storeUserUpload>[0], file);
        const block: Record<string, InputValue> = {};
        for (const f of input.fields ?? []) block[f.id] = f.id === field ? ref : blockFieldDefault(f);
        made.push(block);
      } catch (e) {
        host.log?.('warn', `drop-to-add: couldn't add ${file.name}`, { error: String(e) });
        announce(`Couldn't add ${file.name}.`, { assertive: true });
      }
    }
    if (!made.length) return;
    // Re-read the live array at commit time: an earlier drop (or another edit) may
    // have changed it while our uploads were in flight.
    const live = runtime.getModel().find(i => i.id === blockId)?.value;
    const base = Array.isArray(live) ? live : [];
    runtime.setInput(blockId, [...base, ...made]);
    onDirty?.(blockId);
    announce(`Added ${made.length} ${made.length === 1 ? singular : plural}.`);
  };

  // Chain commits for this input so concurrent drops/selections (from either the
  // sidebar or the canvas) serialise — each reads the live array only after the
  // previous one has committed. Snapshot the files NOW: commit runs a microtask
  // later, by which time a change handler's `value = ''` may have emptied the list.
  const addFiles = (fileList: FileList | File[] | null | undefined): Promise<void> => {
    const snapshot = Array.from(fileList || []);
    const next = (_dropChains.get(blockId) || Promise.resolve()).then(() => commit(snapshot));
    _dropChains.set(blockId, next.catch(() => {}));
    return next;
  };

  return { accept, plural, addFiles };
}

function renderInputs(el: PanelEl, model: InputModelItem[], runtime: Runtime, host: WebToolHost, onDirty?: (id: string) => void): void {
  const modelValues: Record<string, InputValue> = Object.fromEntries(model.map(i => [i.id, i.value]));
  const panelModel = model.filter(i => {
    if (i.group === 'export') return false;
    if (!i.showIf) return true;
    // A showIf value may be a single value or an array of accepted values
    // (render if the current value is any of them).
    return Object.entries(i.showIf).every(([k, v]) =>
      Array.isArray(v) ? v.includes(modelValues[k] as InputValue) : modelValues[k] === v);
  });

  // `attachTo` (schema): an input whose control rides INSIDE a sibling's row
  // rather than taking its own labelled row — a compact modifier that belongs to
  // another control (e.g. a fit toggle on an asset slot). Resolved against
  // panelModel, not model, so a target hidden by its own showIf releases its
  // attachments back into ordinary rows rather than silently swallowing them.
  const attachedTo = (i: InputModelItem): string | null =>
    i.attachTo && panelModel.some(t => t.id === i.attachTo && t.id !== i.id) ? i.attachTo : null;
  const attachments = new Map<string, InputModelItem[]>();
  for (const i of panelModel) {
    const target = attachedTo(i);
    if (!target) continue;
    attachments.set(target, [...(attachments.get(target) ?? []), i]);
  }
  const rowModel = panelModel.filter(i => !attachedTo(i));

  const active       = document.activeElement as HTMLElement | null;
  const focusId      = active?.dataset?.inputId;
  const blockFocusId = active?.dataset?.fieldId;
  // Vector number fields can't use data-input-id (that's the container) or
  // data-field-id (the blocks handler claims those), so restore them by
  // "<inputId>::<fieldId>".
  const vecFocusKey  = active?.classList?.contains('vec-num')
    ? `${(active.closest('[data-input-id]') as HTMLElement | null)?.dataset.inputId}::${active.dataset.vecField}`
    : null;
  const selStart     = (active as HTMLInputElement | null)?.selectionStart;
  const selEnd       = (active as HTMLInputElement | null)?.selectionEnd;

  // A vector that carries the SAME trailing index as the colour right above it is
  // that colour's sub-control, not its sibling — mesh-gradient's `color3` → `pos3`.
  // Marked here (the row markup is the only place that can see both) so the sidebar
  // can tuck the pair together; the shell CSS can't correlate two ids on its own.
  // Deliberately narrow: filter-duotone's `colorBg` → `imageFraming` shares no index
  // and stays an ordinary sibling, which is correct — its framing isn't the colour's.
  const indexOf = (id: string): string | null => id.match(/(\d+)$/)?.[1] ?? null;
  const isSubControl = (input: InputModelItem, prev: InputModelItem | null): boolean =>
    !!prev
    && input.control === 'vector'
    && (prev.control === 'color-picker' || prev.control === 'palette-picker')
    && indexOf(input.id) !== null
    && indexOf(input.id) === indexOf(prev.id);

  const renderOneInput = (input: InputModelItem, prev: InputModelItem | null): string => {
    const isCheckbox = input.control === 'checkbox';
    // `display: 'pill'` on a boolean → an inline chip toggle. Still a checkbox row
    // (control-before-label <label>), so the existing checkbox change wiring fires
    // unchanged; the CSS reshapes it, and consecutive pills are flowed into one
    // wrapped .input-pillbar by the section loop below.
    const isPill = isCheckbox && input.display === 'pill';
    // The datetime field is a flatpickr (altInput) control, and the whole panel
    // re-renders on every keystroke — a floating label would re-animate from its
    // resting to floating position each time the value re-populates and visibly
    // wobble. Pin it to a static label above the field instead.
    const isStaticLabel = input.control === 'datetime-local-input';
    // Composite controls hold MANY interactive elements. A wrapping <label> makes the
    // browser forward any dead-space click to the label's first labelable descendant —
    // so a `blocks` input forwards gap / pill-body / near-miss clicks to block #0's
    // collapse chevron (the reported "clicking the 2nd scene expands the 1st"), and a
    // `vector` input forwards to its first number field. Wrap these in a <div role=group>
    // instead: the caption still names them (aria-labelledby), but it never proxies clicks.
    const isComposite = ['blocks', 'vector', 'asset-picker', 'file-picker', 'color-picker'].includes(input.control);
    const cls = `input-row${isCheckbox ? ' input-row--checkbox' : ''}${isPill ? ' input-row--pill' : ''}${isStaticLabel ? ' input-row--static-label' : ''}${isSubControl(input, prev) ? ' input-row--sub' : ''}`;
    const valueTag = input.control === 'slider'
      ? ` <span class="input-value">${parseFloat(String(input.value ?? 0))}</span>`
      : '';
    const labelId = `irow-label-${escape(input.id)}`;
    // Help moves behind an info button (see help-tip.js). The label id rides on the
    // text span only, so a composite's aria-labelledby never absorbs "More info".
    const ht = input.help ? helpTip(input.help) : null;
    const labelText = `<span class="input-label-text"${isComposite ? ` id="${labelId}"` : ''}>${escape(input.label ?? input.id)}${valueTag}</span>`;
    const label = `<span class="input-label">${labelText}${ht ? ht.button : ''}</span>`;
    // Anything attached to this input leads its control, wrapped in a flex row.
    // Wrapping (rather than splicing markup into the target's own control) keeps
    // this agnostic about what the target control IS — no asset-picker internals
    // here, so any control can host an attachment.
    const lead = (attachments.get(input.id) ?? []).map(attachedControlHtml).join('');
    const control = lead
      ? `<div class="input-attached">${lead}${controlHtml(input, modelValues)}</div>`
      : controlHtml(input, modelValues);
    const help = ht ? ht.pop : '';
    if (isCheckbox) return `<label class="${cls}">${control}${label}${help}</label>`;
    if (isComposite) return `<div class="${cls}" role="group" aria-labelledby="${labelId}">${label}${control}${help}</div>`;
    return `<label class="${cls}">${label}${control}${help}</label>`;
  };

  const openSections = new Set(
    [...el.querySelectorAll('.input-section[open] .input-section-summary')].map(s => s.textContent)
  );

  // Folded blocks carry no model value, so capture which are collapsed and re-apply
  // once the panel HTML is regenerated. Tree blocks key by their stable derived id
  // (data-block-key) so fold state follows a card across a drag-reparent reorder;
  // others key by array index as before.
  const foldKey = (b: HTMLElement): string => `${(b.closest('.blocks-input') as HTMLElement | null)?.dataset.inputId}:${b.dataset.blockKey || b.dataset.blockIndex}`;
  const collapsedBlocks = new Set(
    [...el.querySelectorAll<HTMLElement>('.block-item.is-collapsed')].map(foldKey)
  );

  const parts: string[] = [];
  let openSection: string | null = null;
  let prevInput: InputModelItem | null = null;
  let pillbarOpen = false;   // a run of consecutive `display:'pill'` booleans, wrapped
  const isPillInput = (i: InputModelItem): boolean => i.control === 'checkbox' && i.display === 'pill';
  const closePillbar = (): void => { if (pillbarOpen) { parts.push('</div>'); pillbarOpen = false; } };
  for (const input of rowModel) {
    const sec = input.section ?? null;
    if (sec !== openSection) {
      closePillbar();   // a chip bar never spans a section boundary
      if (openSection !== null) parts.push('</div></details>');
      if (sec !== null) {
        const wasOpen = openSections.has(sec);
        parts.push(`<details class="input-section"${wasOpen ? ' open' : ''}><summary class="input-section-summary">${escape(sec)}</summary><div class="input-section-body">`);
      }
      openSection = sec;
      prevInput = null;   // a section break ends any pairing
    }
    // Open a chip bar around a run of pills; close it the moment a non-pill follows.
    const pill = isPillInput(input);
    if (pill && !pillbarOpen) { parts.push('<div class="input-pillbar" role="group">'); pillbarOpen = true; }
    else if (!pill && pillbarOpen) closePillbar();
    parts.push(renderOneInput(input, prevInput));
    prevInput = input;
  }
  closePillbar();
  if (openSection !== null) parts.push('</div></details>');
  // Destroy flatpickr instances on the outgoing markup so their body-level calendars +
  // document/window listeners don't orphan. Deferred to a microtask because this
  // re-render is reachable from flatpickr's own onClose (onClose→setInput→emit→syncInputs
  // →renderInputs); destroying the closing instance synchronously nukes its config
  // mid-callback and throws. The new instances are distinct elements, so the deferred
  // destroy of the old ones never touches them.
  const staleFps = [...el.querySelectorAll<FlatpickrHost>('.fp-datetime')].map(c => c._flatpickr).filter(Boolean);
  el.innerHTML = parts.join('');
  if (staleFps.length) queueMicrotask(() => staleFps.forEach(fp => fp!.destroy()));

  const collapseBlock = (item: Element): void => {
    item.classList.add('is-collapsed');
    const btn = item.querySelector('[data-block-collapse]');
    btn?.setAttribute('aria-label', 'Expand block');
    btn?.setAttribute('title', 'Expand');
  };
  // On the first render of a freshly-mounted tool, fold every typed block so the
  // sidebar opens as a clean, scannable list — the user expands the ones they
  // want to edit. On later re-renders, preserve whatever the user had folded
  // (captured above); newly-added blocks stay open.
  const firstRender = !el.dataset.blocksDefaulted;
  el.dataset.blocksDefaulted = '1';
  if (firstRender) {
    el.querySelectorAll('.block-item.is-typed').forEach(collapseBlock);
  } else if (collapsedBlocks.size) {
    el.querySelectorAll<HTMLElement>('.block-item.is-typed').forEach(item => {
      if (collapsedBlocks.has(foldKey(item))) collapseBlock(item);
    });
  }

  // Reflect the live fold state on each blocks input's "Collapse all" pill: when
  // every block is already folded it offers "Expand all", otherwise "Collapse all".
  // Called after the fold-restore pass above and after every fold change (chevron,
  // header click, the pill itself) so the label never goes stale.
  const syncCollapseAllPills = (): void => {
    el.querySelectorAll('.blocks-input').forEach(wrap => {
      const pill = wrap.querySelector<HTMLElement>('[data-blocks-collapse-all]');
      if (!pill) return;
      const blocks = [...wrap.querySelectorAll('.block-item.is-typed')];
      const allFolded = blocks.length > 0 && blocks.every(b => b.classList.contains('is-collapsed'));
      pill.dataset.mode = allFolded ? 'expand' : 'collapse';
      pill.textContent = allFolded ? 'Expand all' : 'Collapse all';
      pill.setAttribute('aria-label', allFolded ? 'Expand all blocks' : 'Collapse all blocks');
    });
  };
  syncCollapseAllPills();

  if (focusId) {
    const restored = el.querySelector<HTMLInputElement>(`[data-input-id="${CSS.escape(focusId)}"]`);
    if (restored) {
      restored.focus();
      if (selStart != null && restored.setSelectionRange) {
        restored.setSelectionRange(selStart, selEnd!);
      }
    }
  }

  if (blockFocusId) {
    const restored = el.querySelector<HTMLInputElement>(`[data-field-id="${CSS.escape(blockFocusId)}"]`);
    if (restored) {
      restored.focus();
      if (selStart != null && restored.setSelectionRange) {
        restored.setSelectionRange(selStart, selEnd!);
      }
    }
  }

  if (vecFocusKey) {
    const [vid, vfield] = vecFocusKey.split('::');
    const restored = el.querySelector<HTMLElement>(
      `.vector-input[data-input-id="${CSS.escape(vid!)}"] .vec-num[data-vec-field="${CSS.escape(vfield!)}"]`
    );
    restored?.focus(); // number inputs expose no caret to restore
  }

  el.querySelectorAll<HTMLElement>('[data-input-id]').forEach(control => {
    const id    = control.dataset.inputId!;
    const input = panelModel.find(i => i.id === id);

    if (input?.control === 'slider') {
      setupCustomSlider(control, runtime, id, onDirty);
      return;
    }

    if (input?.control === 'asset-picker') {
      control.addEventListener('click', async () => {
        // Returning to a slot that already holds a live Lolly render: most such
        // visits mean "tweak the render", not "replace it" — so offer the edit
        // path first (same flow as the ✦ Edit badge) before opening the picker.
        const curVal = input.value as AssetRef | null;
        const curToolUrl = asStr(asRow(curVal?.meta as InputValue | undefined).toolUrl);
        if (curToolUrl && host.compose?.renderUrl) {
          const intent = await askLollyIntent(asStr(asRow(curVal?.meta as InputValue | undefined).name));
          if (!intent) return;
          if (intent === 'edit') {
            const edited = await openEmbedEditor(host, { editUrl: curToolUrl, slotLabel: input.label ?? input.id });
            if (edited) { runtime.setInput(id, edited); onDirty?.(id); }
            return;
          }
        }
        const ref = await host.assets.pick({
          title:       `Choose ${input.label ?? input.id}`,
          type:        input.assetType === 'any' ? undefined : (input.assetType as AssetRef['type'] | undefined),
          tags:        (input.filter?.tags as string[] | undefined),
          namespace:   (input.filter?.namespace as string | undefined),
          allowUpload: input.allowUpload === true,
          current:     curVal?.id,
          // A slot already holding a Lolly render gets an "edit the tool you're
          // using" banner in the picker (its inputs pre-filled), alongside the
          // normal choose-a-different-image grids.
          currentToolUrl:  curToolUrl,
          currentToolName: asStr(asRow(curVal?.meta as InputValue | undefined).name),
          // Picking a tool in the picker opens its inputs first (configure → insert),
          // reusing the same in-place editor the "from <tool>" Edit badge uses.
          editTool:    (toolUrl: string, mode = 'insert') => openEmbedEditor(host, { editUrl: toolUrl, slotLabel: input.label ?? input.id, mode }),
        } as Parameters<WebToolHost['assets']['pick']>[0]);
        if (ref) { runtime.setInput(id, ref); onDirty?.(id); }
      });
      return;
    }

    if (input?.control === 'file-picker') {
      const native  = control.querySelector<HTMLInputElement>('.file-native');
      const trigger = control.querySelector<HTMLButtonElement>('.file-trigger');
      const clearer = control.querySelector<HTMLButtonElement>('.file-clear');
      // Revoke the previous preview object URL so picking a new file doesn't leak.
      const revokePrev = () => {
        const prev = runtime.getModel().find(i => i.id === id)?.value;
        const prevUrl = asRow(prev).url;
        if (prevUrl) URL.revokeObjectURL(prevUrl as string);
      };
      trigger?.addEventListener('click', () => native?.click());
      clearer?.addEventListener('click', () => { revokePrev(); runtime.setInput(id, null); onDirty?.(id); });
      native?.addEventListener('change', async () => {
        const file = native.files && native.files[0];
        if (!file) return;
        // Manifest cap when declared, engine backstop otherwise — a pick is a
        // full read into memory, so it is never unbounded.
        const cap = input.maxSize ?? DEFAULT_FILE_MAX_BYTES;
        if (file.size > cap) {
          announce(`That file is too large (max ${fmtBytes(cap)}).`, { assertive: true });
          native.value = '';
          return;
        }
        const ref = await fileToRef(file);
        revokePrev();
        runtime.setInput(id, ref);
        onDirty?.(id);
      });
      return;
    }

    if (input?.control === 'datetime-local-input') return; // handled by flatpickr onClose
    if (input?.control === 'color-picker') return; // native picker handled by color-popover-native listener

    if (input?.control === 'vector') {
      setupVectorControl(control, runtime, id, onDirty, input);
      return;
    }

    // Jelly-mode boolean rows: <jelly-switch> emits `change` on its host (never
    // `input`) and has no `.type` — wire it straight to the runtime and skip the
    // generic listener below. Undo/redo needs nothing extra: history hooks at
    // runtime.setInput, and replay repaints the panel from the model (the host's
    // live `.checked` getter keeps inputs-sync's domReflectsValue honest).
    if (control.tagName === 'JELLY-SWITCH') {
      control.addEventListener('change', () => {
        runtime.setInput(id, (control as unknown as { checked: boolean }).checked);
      });
      return;
    }

    // Spreadsheet paste: a longtext gets clean TSV from an HTML-table clipboard
    // (Excel/Sheets/Numbers) instead of the delimiter-guessing plain-text form.
    if (control.tagName === 'TEXTAREA') installTablePaste(control as HTMLTextAreaElement);

    control.addEventListener('input', (e) => {
      if (e.target !== control) return; // block fields bubble up — ignore them here
      const ctl = control as HTMLInputElement;
      const value = ctl.type === 'checkbox' ? ctl.checked : ctl.value;
      runtime.setInput(id, value);
    });
  });

  el.querySelectorAll<FlatpickrHost>('.fp-datetime').forEach(control => {
    const id       = control.dataset.inputId!;
    const initVal  = control.dataset.fpValue || null;
    const existing = control._flatpickr;
    if (existing) existing.destroy();
    flatpickr(control, {
      enableTime:    true,
      dateFormat:    'Y-m-dTH:i',
      altInput:      true,
      altFormat:     'D j M Y h:iK',
      defaultDate:   initVal || undefined,
      allowInput:    false,
      time_24hr:     true,
      disableMobile: true,
      onReady(_: Date[], __: string, fp: { altInput?: HTMLInputElement }) {
        if (fp.altInput) fp.altInput.placeholder = control.placeholder || 'Live — current time';
      },
      // onClose fires once when the picker closes, after the user has finished
      // picking both the date and time. onChange would fire mid-interaction and
      // trigger renderInputs → el.innerHTML reset → destroying the open calendar.
      onClose(selectedDates: Date[], dateStr: string) {
        const next = selectedDates.length ? dateStr : '';
        runtime.setInput(id, next);
        onDirty?.(id);
      },
    });
  });

  el.querySelectorAll<HTMLElement>('[data-clear-id]').forEach(btn => {
    btn.addEventListener('click', () => {
      const clearId = btn.dataset.clearId!;
      runtime.setInput(clearId, null);
      onDirty?.(clearId);
    });
  });

  // icon-toggle: one button that CYCLES its select's options (see the schema's
  // select branch). Two options make it a toggle, which is the intended use.
  el.querySelectorAll<HTMLElement>('[data-toggle-id]').forEach(btn => {
    btn.addEventListener('click', () => {
      const toggleId = btn.dataset.toggleId!;
      const item = model.find(i => i.id === toggleId);
      const opts = item?.options ?? [];
      if (!opts.length) return;
      const at = opts.findIndex(o => o.value === item!.value);
      runtime.setInput(toggleId, opts[(at + 1) % opts.length]!.value);
      onDirty?.(toggleId);
    });
  });

  // Edit a Lolly-sourced image in place: re-open the source tool's own inputs
  // (pre-filled from the asset's stored embed URL), tweak, and re-apply the new
  // render to this same slot. Only present when the asset carries meta.toolUrl.
  el.querySelectorAll<HTMLElement>('[data-edit-id]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const editId  = btn.dataset.editId!;
      const cur     = panelModel.find(i => i.id === editId);
      const toolUrl = asStr(asRow(asRow(cur?.value).meta).toolUrl);
      if (!toolUrl || !host.compose?.renderUrl) return;
      const ref = await openEmbedEditor(host, { editUrl: toolUrl, slotLabel: cur!.label ?? editId });
      if (ref) { runtime.setInput(editId, ref); onDirty?.(editId); }
    });
  });

  // A BAKED slot (meta.baked, no toolUrl) is inert by design; its ❄ row offers
  // two ways back to the source when meta.bakedFrom survived baking: Edit re-opens
  // the source tool's inputs (rebake: true — the apply re-freezes, never un-bakes),
  // Re-bake re-renders the same URL and freezes it again in one click.
  el.querySelectorAll<HTMLElement>('[data-baked-edit-id]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const editId    = btn.dataset.bakedEditId!;
      const cur       = panelModel.find(i => i.id === editId);
      const bakedFrom = asStr(asRow(asRow(cur?.value).meta).bakedFrom);
      if (!bakedFrom || !host.compose?.renderUrl) return;
      const ref = await openEmbedEditor(host, { editUrl: bakedFrom, slotLabel: cur!.label ?? editId, rebake: true });
      if (ref) { runtime.setInput(editId, ref); onDirty?.(editId); }
    });
  });
  el.querySelectorAll<HTMLButtonElement>('[data-rebake-id]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const editId    = btn.dataset.rebakeId!;
      const cur       = panelModel.find(i => i.id === editId);
      const bakedFrom = asStr(asRow(asRow(cur?.value).meta).bakedFrom);
      if (!bakedFrom || !host.compose?.renderUrl) return;
      const label = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Re-baking…';
      const ref = await rebakeFromUrl(host, bakedFrom);
      btn.disabled = false;
      btn.textContent = label;
      if (ref) { runtime.setInput(editId, ref); onDirty?.(editId); }
      else showRebakeError(btn);
    });
  });

  // ONE shared colour picker for every colour surface (OKLCH sliders, hex, alpha,
  // swatches, popover toggle). Top-level inputs commit via setInput(id); a block
  // field's composite id ("blockId:idx:fieldId" — ':' never appears in a real
  // input id) routes into its block row instead. Block rows store plain strings,
  // so a token-linked swatch pick is flattened to its hex there — the {ref,value}
  // shape is a top-level-input contract (resolveTokenRefs), not a row value.
  wireColorField(el, {
    onChange: (inputId: string, value: InputValue) => {
      if (!inputId.includes(':')) { runtime.setInput(inputId, value); onDirty?.(inputId); return; }
      const parts = inputId.split(':');
      const blockId = parts[0]!, idx = parseInt(parts[1]!, 10), fieldId = parts[2]!;
      const inp = panelModel.find(i => i.id === blockId);
      if (!inp) return;
      const arr = (Array.isArray(inp.value) ? inp.value : []).map(x => ({ ...asRow(x) }));
      const row = arr[idx] ?? (arr[idx] = {});
      const o = value as { ref?: unknown; value?: unknown };
      row[fieldId] = (value && typeof value === 'object' && typeof o.ref === 'string' ? String(o.value ?? '') : value) as InputValue;
      runtime.setInput(blockId, arr);
      onDirty?.(blockId);
    },
    onInteractStart: () => { _sliderDragging = true; },
    onInteractEnd: () => { _sliderDragging = false; },
  });

  // On-demand help: delegated tap/Escape/outside-click wiring is attached once and
  // survives rebuilds; the aria-describedby links are (re)applied every render.
  wireHelpTips(el);
  linkHelpDescriptions(el);

  // Block field changes
  el.querySelectorAll<HTMLInputElement>('[data-field-id]').forEach(field => {
    field.addEventListener('input', () => {
      // A number field mid-decimal — "1." or just "." — reports value="" with
      // validity.badInput. Committing that empties the model, which re-renders
      // the panel (blocks always take the full rebuild path) and wipes the
      // trailing "." the user is about to complete, so "1.2" lands as "12".
      // Hold off until the value parses; the field keeps showing the in-progress
      // text on its own, and the spinner arrows still commit valid steps. badInput
      // is never true for text/textarea/select, so this only ever guards numbers.
      if (field.validity?.badInput) return;
      const parts = field.dataset.fieldId!.split(':');
      const blockId = parts[0]!, idx = parseInt(parts[1]!, 10), fieldId = parts[2]!;
      const inp = panelModel.find(i => i.id === blockId);
      if (!inp) return;
      let arr = (Array.isArray(inp.value) ? inp.value : []).map(x => ({ ...asRow(x) }));
      const row = arr[idx] ?? (arr[idx] = {});
      const value: InputValue = field.type === 'checkbox' ? field.checked : field.value;
      row[fieldId] = value;
      // Picking a parent from a reference dropdown anchors the target to a durable
      // id, so the link can't drift if rows are later reordered/added (same as the
      // drag-reparent path). Only for a same-input tree parent ref.
      const fdef = (inp.fields ?? []).find(f => f.id === fieldId);
      if (value && fdef?.optionsFrom && inp.nesting && fieldId === nestingConfig(inp).parentField) {
        arr = materializeRefTarget(arr, String(value), nestingConfig(inp));
      }
      runtime.setInput(blockId, arr);
      onDirty?.(blockId);
    });
  });

  // "+ Add" (and each typed add-menu option) appends a block. Typed menus carry
  // data-block-add-type, which seeds the discriminator; fields start at their
  // declared defaults so a new block renders cleanly rather than all-blank.
  el.querySelectorAll<HTMLButtonElement>('[data-block-add]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      const blockId = btn.dataset.blockAdd!;
      const inp = panelModel.find(i => i.id === blockId);
      if (!inp) return;
      const arr = Array.isArray(inp.value) ? [...inp.value] : [];
      const block: Record<string, InputValue> = {};
      for (const f of inp.fields ?? []) block[f.id] = blockFieldDefault(f);
      const type = btn.dataset.blockAddType;
      if (inp.addMenu && type !== undefined) block[inp.addMenu.field] = type;
      runtime.setInput(blockId, [...arr, block]);
      onDirty?.(blockId);
    });
  });

  // When pasting Markdown over an existing list, ask whether to replace or append.
  function askPasteMode(count: number): Promise<'replace' | 'add' | null> {
    const content =
      `<h2 class="modal-title">Paste Markdown</h2>` +
      `<p class="modal-msg">You have ${count} slide${count === 1 ? '' : 's'} already. Replace them with the pasted deck, or add the pasted slides to the end?</p>` +
      `<div class="modal-actions">` +
        `<button type="button" class="btn modal-cancel" data-act="cancel">Cancel</button>` +
        `<button type="button" class="btn" data-act="add">Add to slides</button>` +
        `<button type="button" class="btn modal-primary" data-act="replace">Replace slides</button>` +
      `</div>`;
    return new Promise<'replace' | 'add' | null>(resolve => {
      const modal = mountModal<'replace' | 'add' | null>(content, {
        className: 'modal',
        ariaLabel: 'Paste Markdown',
        cancelValue: null,
        initialFocus: dlg => dlg.querySelector<HTMLElement>('[data-act="replace"]'),
        onClose: r => resolve(r ?? null),
      });
      modal.el.querySelectorAll<HTMLButtonElement>('[data-act]').forEach(b =>
        b.addEventListener('click', () => modal.close(b.dataset.act === 'cancel' ? null : (b.dataset.act as 'replace' | 'add'))));
    });
  }

  // Markdown → slides, shared by the "Paste" (clipboard) and "Use File" (.md/.txt)
  // actions: split into one block per heading (lib/markdown.splitMarkdownIntoBlocks),
  // then replace or append (asking when the list isn't empty). Returns a status the
  // caller flashes on the control.
  async function applyMarkdown(md: string, blockId: string, inp: InputModelItem): Promise<'ok' | 'empty' | 'cancel'> {
    if (!md.trim()) return 'empty';
    const sections = splitMarkdownIntoBlocks(md);
    if (!sections.length) return 'empty';
    const has = (fid: string): boolean => (inp.fields ?? []).some(f => f.id === fid);
    // The block must have somewhere to put the prose — a `body` (or at least a `heading`).
    if (!has('body') && !has('heading')) return 'empty';
    const made = sections.map(sec => {
      const block: Record<string, InputValue> = {};
      for (const f of inp.fields ?? []) block[f.id] = blockFieldDefault(f);
      if (has('kind')) block.kind = 'text';
      if (has('heading')) block.heading = sec.heading;
      if (has('body')) block.body = sec.body;
      return block;
    });
    const cur = runtime.getModel().find(i => i.id === blockId)?.value;
    const base = Array.isArray(cur) ? cur : (Array.isArray(inp.value) ? inp.value : []);
    let mode: 'replace' | 'add' = 'replace';
    if (base.length) { const choice = await askPasteMode(base.length); if (!choice) return 'cancel'; mode = choice; }
    runtime.setInput(blockId, mode === 'add' ? [...base, ...made] : made);
    onDirty?.(blockId);
    return 'ok';
  }
  // CSV / JSON → block rows via the engine's parseDataRows (column→field mapping), then
  // replace or append. The importData counterpart to applyMarkdown.
  async function applyData(text: string, inp: InputModelItem, format?: 'csv' | 'json'): Promise<'ok' | 'empty' | 'cancel'> {
    const cfg = (inp as { importData?: { columns?: Record<string, unknown> } }).importData ?? {};
    const fields = inp.fields ?? [];
    try {
      const { rows, truncated } = parseDataRows(text, { fields, format, columns: cfg.columns as Record<string, string> | undefined });
      if (!rows.length) return 'empty';
      const filled = rows.map(r => {
        const b: Record<string, InputValue> = {};
        for (const f of fields) { const v = (r as Record<string, InputValue>)[f.id]; b[f.id] = (v === '' || v == null) ? blockFieldDefault(f) : v; }
        return b;
      });
      const live = runtime.getModel().find(i => i.id === inp.id)?.value;
      const base = Array.isArray(live) ? live : [];
      let mode: 'replace' | 'add' = 'replace';
      if (base.length) { const choice = await askPasteMode(base.length); if (!choice) return 'cancel'; mode = choice; }
      runtime.setInput(inp.id, mode === 'add' ? [...base, ...filled] : filled);
      onDirty?.(inp.id);
      const n = filled.length;
      announce(`Imported ${n} ${n === 1 ? 'row' : 'rows'}${truncated ? ' (capped to the first ' + n + ')' : ''}.`);
      return 'ok';
    } catch (e) {
      host.log?.('warn', 'data import failed', { error: String(e) });
      announce((e as { message?: string })?.message || 'Could not read that.', { assertive: true });
      return 'empty';
    }
  }

  // Detect what the pasted/uploaded text IS (Markdown vs CSV vs JSON) among the importers
  // this input enables, and route it. A file's extension wins; otherwise the content is
  // sniffed (`{`/`[` → JSON; headings/`---`/bullets/pipes → Markdown; commas → CSV).
  async function routeImport(text: string, inp: InputModelItem, filename?: string): Promise<'ok' | 'empty' | 'cancel'> {
    const s = text.trim();
    if (!s) return 'empty';
    const canMd = (inp as { mdPaste?: boolean }).mdPaste === true;
    const canData = !!(inp as { importData?: unknown }).importData;
    const ext = (filename ?? '').toLowerCase();
    if (canData && /\.csv$/.test(ext)) return applyData(s, inp, 'csv');
    if (canData && /\.json$/.test(ext)) return applyData(s, inp, 'json');
    if (canMd && /\.(md|markdown|mdown|txt|text)$/.test(ext)) return applyMarkdown(s, inp.id, inp);
    if (canData && (s[0] === '{' || s[0] === '[')) return applyData(s, inp, 'json');
    const looksMd = /(^|\n)#{1,6}\s|\n-{3,}[ \t]*(\n|$)|(^|\n)\s*[-*]\s+|\|[^\n]*\|/.test(s);
    if (canMd && looksMd) return applyMarkdown(s, inp.id, inp);
    if (canData && /,/.test(s) && /\n/.test(s)) return applyData(s, inp, undefined);
    if (canMd) return applyMarkdown(s, inp.id, inp);
    if (canData) return applyData(s, inp, undefined);
    return 'empty';
  }

  const ioFlash = (btn: HTMLElement, status: 'ok' | 'empty' | 'cancel'): void => {
    if (status === 'cancel') return;
    const cls = status === 'ok' ? 'is-ok' : 'is-empty';
    btn.classList.add(cls); window.setTimeout(() => btn.classList.remove(cls), 1100);
  };
  const uploadAccept = (inp: InputModelItem): string => {
    const parts: string[] = [];
    if ((inp as { mdPaste?: boolean }).mdPaste === true) parts.push('.md', '.markdown', '.mdown', '.txt', '.text', 'text/markdown', 'text/plain');
    if ((inp as { importData?: unknown }).importData) parts.push('.csv', '.json', 'text/csv', 'application/json');
    return parts.join(',');
  };

  // "Paste" — read the clipboard, detect its format, route it.
  el.querySelectorAll<HTMLButtonElement>('[data-blocks-io-paste]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const inp = panelModel.find(i => i.id === btn.dataset.blocksIoPaste);
      if (!inp) return;
      let text = '';
      try { text = await navigator.clipboard.readText(); } catch { /* denied / unsupported */ }
      ioFlash(btn, await routeImport(text, inp));
    });
  });
  // "Upload" — pick a Markdown / CSV / JSON file, detect its format, route it.
  el.querySelectorAll<HTMLButtonElement>('[data-blocks-io-upload]').forEach(btn => {
    const inp = panelModel.find(i => i.id === btn.dataset.blocksIoUpload);
    if (!inp) return;
    const native = document.createElement('input');
    native.type = 'file';
    native.accept = uploadAccept(inp);
    native.style.display = 'none';
    btn.parentElement?.appendChild(native);
    btn.addEventListener('click', () => native.click());
    native.addEventListener('change', async () => {
      const file = native.files?.[0];
      native.value = '';
      if (!file) return;
      let text = '';
      try { text = await file.text(); } catch { /* unreadable */ }
      ioFlash(btn, await routeImport(text, inp, file.name));
    });
  });

  // Drop-to-add: a blocks input that declares `dropToAdd` turns its list into a
  // drop zone — dragging or selecting several image files at once uploads each
  // and appends one block per file (the image in the named asset field, every
  // other field at its default). It reuses the picker's upload path, so SVGs are
  // sanitised and big rasters downscaled exactly like a single "+ Add" upload.
  panelModel.filter(i => i.control === 'blocks' && i.dropToAdd?.field).forEach(input => {
    const blockId = input.id;
    const field = input.dropToAdd!.field;
    if (!(input.fields ?? []).some(f => f.id === field && f.type === 'asset')) return;
    const wrap = el.querySelector<HTMLElement>(`.blocks-input[data-input-id="${CSS.escape(blockId)}"]`);
    const list = wrap?.querySelector<HTMLElement>('.blocks-list');
    if (!wrap || !list) return;
    wrap.classList.add('blocks-input--droppable');

    // The committer (upload each file → append one block per file) is shared with
    // the canvas drop zone (setupCanvasBlocksDrop), so both surfaces behave alike
    // and serialise through _dropChains.
    const { accept, plural, addFiles } = makeBlocksDropper({ runtime, host, input, onDirty });

    // Hidden multi-file input, opened by the drop hint — so "select several files"
    // works alongside drag-and-drop.
    const native = document.createElement('input');
    native.type = 'file';
    native.multiple = true;
    native.accept = accept;
    native.style.display = 'none';
    wrap.appendChild(native);
    native.addEventListener('change', () => { addFiles(native.files); native.value = ''; });

    // A persistent drop hint that doubles as a "choose files" button — it stays
    // put once blocks exist (just with shorter text) so adding more is always one
    // drop or click away, alongside the per-row "+ Add".
    const hasItems = !!list.querySelector('.block-item');
    const hint = document.createElement('button');
    hint.type = 'button';
    hint.className = 'blocks-drop-hint';
    hint.textContent = hasItems
      ? `Drop or click to add more ${plural}`
      : `Drop ${plural} here, or click to choose files`;
    hint.addEventListener('click', () => native.click());
    list.appendChild(hint);

    let depth = 0;
    const setDrag = (on: boolean) => wrap.classList.toggle('is-file-dragover', on);
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types || []).includes('Files');
    list.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; setDrag(true); });
    list.addEventListener('dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; });
    list.addEventListener('dragleave', (e) => { e.preventDefault(); if (--depth <= 0) { depth = 0; setDrag(false); } });
    list.addEventListener('drop', (e) => { e.preventDefault(); depth = 0; setDrag(false); addFiles(e.dataTransfer?.files); });
  });


  // Typed add-menu: toggle the option list; one open at a time.
  el.querySelectorAll<HTMLElement>('[data-block-add-toggle]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const menu = btn.closest('.block-add-menu')?.querySelector<HTMLElement>('.block-add-options');
      if (!menu) return;
      const willOpen = menu.hidden;
      el.querySelectorAll<HTMLElement>('.block-add-options').forEach(m => { if (m !== menu) m.hidden = true; });
      menu.hidden = !willOpen;
      btn.setAttribute('aria-expanded', String(willOpen));
    });
  });

  // Per-block asset (image) fields delegate to the host picker, mirroring the
  // top-level asset-picker control but writing into the block array.
  el.querySelectorAll<HTMLElement>('[data-block-asset]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const [blockId = '', idxStr = '', fId = ''] = (btn.dataset.blockAsset ?? '').split(':');
      const idx = parseInt(idxStr, 10);
      const inp = panelModel.find(i => i.id === blockId);
      if (!inp) return;
      const f: Partial<BlockFieldSpec> = (inp.fields ?? []).find(x => x.id === fId) ?? {};
      const cur = Array.isArray(inp.value) ? asRow(inp.value[idx])[fId] : null;
      // Same choice-first flow as the top-level slot: a block image that's a
      // live Lolly render offers "edit it" before "replace it".
      const curToolUrl = asStr(asRow(asRow(cur).meta).toolUrl);
      if (curToolUrl && host.compose?.renderUrl) {
        const intent = await askLollyIntent(asStr(asRow(asRow(cur).meta).name));
        if (!intent) return;
        if (intent === 'edit') {
          const edited = await openEmbedEditor(host, { editUrl: curToolUrl, slotLabel: f.label ?? fId });
          if (!edited) return;
          const arr2 = (Array.isArray(inp.value) ? inp.value : []).map(x => ({ ...asRow(x) }));
          const row2 = arr2[idx] ?? (arr2[idx] = {});
          row2[fId] = edited;
          runtime.setInput(blockId, arr2);
          onDirty?.(blockId);
          return;
        }
      }
      const ref = await host.assets.pick({
        title:       `Choose ${f.label ?? fId}`,
        type:        f.assetType === 'any' ? undefined : f.assetType,
        tags:        f.filter?.tags,
        namespace:   f.filter?.namespace,
        allowUpload: f.allowUpload === true,
        current:     asStr(asRow(cur).id),
        // Mirror the top-level slot: a block image that's already a Lolly render
        // offers its edit-in-place banner inside the picker too.
        currentToolUrl:  curToolUrl,
        currentToolName: asStr(asRow(asRow(cur).meta).name),
        editTool:    (toolUrl: string, mode = 'insert') => openEmbedEditor(host, { editUrl: toolUrl, slotLabel: f.label ?? fId, mode }),
      } as Parameters<typeof host.assets.pick>[0]);
      if (!ref) return;
      const arr = (Array.isArray(inp.value) ? inp.value : []).map(x => ({ ...asRow(x) }));
      const row = arr[idx] ?? (arr[idx] = {});
      row[fId] = ref;
      runtime.setInput(blockId, arr);
      onDirty?.(blockId);
    });
  });

  el.querySelectorAll<HTMLElement>('[data-block-asset-clear]').forEach(btn => {
    btn.addEventListener('click', () => {
      const [blockId = '', idxStr = '', fId = ''] = (btn.dataset.blockAssetClear ?? '').split(':');
      const idx = parseInt(idxStr, 10);
      const inp = panelModel.find(i => i.id === blockId);
      if (!inp) return;
      const arr = (Array.isArray(inp.value) ? inp.value : []).map(x => ({ ...asRow(x) }));
      const row = arr[idx];
      if (row) row[fId] = null;
      runtime.setInput(blockId, arr);
      onDirty?.(blockId);
    });
  });

  // Edit a Lolly-sourced block image in place (same flow as the top-level
  // data-edit-id handler, but writing back into the block array).
  el.querySelectorAll<HTMLElement>('[data-block-asset-edit]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const [blockId = '', idxStr = '', fId = ''] = (btn.dataset.blockAssetEdit ?? '').split(':');
      const idx = parseInt(idxStr, 10);
      const inp = panelModel.find(i => i.id === blockId);
      if (!inp) return;
      const cur     = Array.isArray(inp.value) ? asRow(inp.value[idx])[fId] : null;
      const toolUrl = asStr(asRow(asRow(cur).meta).toolUrl);
      if (!toolUrl || !host.compose?.renderUrl) return;
      const f: Partial<BlockFieldSpec> = (inp.fields ?? []).find(x => x.id === fId) ?? {};
      const ref = await openEmbedEditor(host, { editUrl: toolUrl, slotLabel: f.label ?? fId });
      if (!ref) return;
      const arr = (Array.isArray(inp.value) ? inp.value : []).map(x => ({ ...asRow(x) }));
      const row = arr[idx] ?? (arr[idx] = {});
      row[fId] = ref;
      runtime.setInput(blockId, arr);
      onDirty?.(blockId);
    });
  });

  // Baked block image (same flows as the top-level data-baked-edit-id /
  // data-rebake-id handlers, but writing back into the block array): ❄ Edit
  // re-opens the source via meta.bakedFrom and commits a RE-baked ref; ↻ Re-bake
  // re-renders + freezes in one click.
  el.querySelectorAll<HTMLElement>('[data-block-baked-edit]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const [blockId = '', idxStr = '', fId = ''] = (btn.dataset.blockBakedEdit ?? '').split(':');
      const idx = parseInt(idxStr, 10);
      const inp = panelModel.find(i => i.id === blockId);
      if (!inp) return;
      const cur       = Array.isArray(inp.value) ? asRow(inp.value[idx])[fId] : null;
      const bakedFrom = asStr(asRow(asRow(cur).meta).bakedFrom);
      if (!bakedFrom || !host.compose?.renderUrl) return;
      const f: Partial<BlockFieldSpec> = (inp.fields ?? []).find(x => x.id === fId) ?? {};
      const ref = await openEmbedEditor(host, { editUrl: bakedFrom, slotLabel: f.label ?? fId, rebake: true });
      if (!ref) return;
      const arr = (Array.isArray(inp.value) ? inp.value : []).map(x => ({ ...asRow(x) }));
      const row = arr[idx] ?? (arr[idx] = {});
      row[fId] = ref;
      runtime.setInput(blockId, arr);
      onDirty?.(blockId);
    });
  });
  el.querySelectorAll<HTMLButtonElement>('[data-block-rebake]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const [blockId = '', idxStr = '', fId = ''] = (btn.dataset.blockRebake ?? '').split(':');
      const idx = parseInt(idxStr, 10);
      const inp = panelModel.find(i => i.id === blockId);
      if (!inp) return;
      const cur       = Array.isArray(inp.value) ? asRow(inp.value[idx])[fId] : null;
      const bakedFrom = asStr(asRow(asRow(cur).meta).bakedFrom);
      if (!bakedFrom || !host.compose?.renderUrl) return;
      btn.disabled = true;
      const ref = await rebakeFromUrl(host, bakedFrom);
      btn.disabled = false;
      if (!ref) { showRebakeError(btn); return; }
      const arr = (Array.isArray(inp.value) ? inp.value : []).map(x => ({ ...asRow(x) }));
      const row = arr[idx] ?? (arr[idx] = {});
      row[fId] = ref;
      runtime.setInput(blockId, arr);
      onDirty?.(blockId);
    });
  });

  // Block range sliders: hold the sidebar steady while dragging (the canvas
  // still updates live), exactly like the top-level custom slider / vector scrub.
  el.querySelectorAll<HTMLInputElement>('.block-range-input').forEach(r => {
    const hold = () => { _sliderDragging = true; };
    const release = () => { _sliderDragging = false; };
    r.addEventListener('pointerdown', hold);
    r.addEventListener('pointerup', release);
    r.addEventListener('pointercancel', release);
    r.addEventListener('blur', release);
    r.addEventListener('change', release);
  });

  // Remove is a two-step confirm so a stray click can't drop a block: the first
  // click arms the button ("Delete?"); a second click within 3s (or while armed)
  // commits. Clicking elsewhere — or the timeout — disarms it.
  el.querySelectorAll<ConfirmButton>('[data-block-remove]').forEach(btn => {
    // Confirm only for typed (card) blocks; compact name/value rows keep their
    // immediate delete (a "Delete?" label would stretch their tight grid cells).
    const confirms = !!btn.closest('.block-item.is-typed');
    const commit = () => {
      const blockId = btn.dataset.blockInput!;
      const idx = parseInt(btn.dataset.blockIndex ?? '', 10);
      const inp = panelModel.find(i => i.id === blockId);
      if (!inp) return;
      const arr = (Array.isArray(inp.value) ? [...inp.value] : []).filter((_, i) => i !== idx);
      runtime.setInput(blockId, arr);
      onDirty?.(blockId);
    };
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!confirms) { commit(); return; }
      if (btn._armed) { btn._disarm?.(); commit(); return; }
      btn._armed = true;
      btn.classList.add('is-confirming');
      const original = btn.innerHTML;
      btn.innerHTML = 'Delete?';
      const away = (ev: PointerEvent) => { if (!btn.contains(ev.target as Node)) btn._disarm?.(); };
      const t = setTimeout(() => btn._disarm?.(), 3000);
      btn._disarm = () => {
        btn._armed = false;
        btn.classList.remove('is-confirming');
        btn.innerHTML = original;
        clearTimeout(t);
        document.removeEventListener('pointerdown', away, true);
        btn._disarm = null;
      };
      // Defer so this very click doesn't immediately count as "clicking away".
      setTimeout(() => document.addEventListener('pointerdown', away, true), 0);
    });
  });

  // Drag a block's header to reorder. Native HTML5 DnD — the header is the handle.
  // For a plain blocks input the array is spliced into the new order. For a TREE
  // input (input.nesting active) the drop zone splits into before / after / inside,
  // so a card can be moved, re-nested or reordered in one gesture; the dragged
  // card's parent reference is updated and its whole subtree travels with it.
  const clearDropMarks = () => el
    .querySelectorAll('.drag-over, .drop-before, .drop-after, .drop-inside')
    .forEach(n => n.classList.remove('drag-over', 'drop-before', 'drop-after', 'drop-inside'));

  el.querySelectorAll<HTMLElement>('.block-item.is-typed').forEach(item => {
    const head = item.querySelector<DragHandle>('[data-block-handle]');
    if (!head) return;
    const blockId = head.dataset.blockInput!;
    const idx = parseInt(head.dataset.blockIndex ?? '', 10);
    const treeInp = panelModel.find(i => i.id === blockId);
    const treeMode = nestingActive(treeInp, modelValues);

    // Which of the three zones the pointer is over, by vertical position in the row.
    const zoneIntent = (e: DragEvent): 'before' | 'after' | 'inside' => {
      const r = item.getBoundingClientRect();
      const rel = (e.clientY - r.top) / Math.max(1, r.height);
      return rel < 0.30 ? 'before' : rel > 0.70 ? 'after' : 'inside';
    };

    head.addEventListener('dragstart', (e) => {
      _blockDrag = { inputId: blockId, from: idx, intent: null, over: null };
      e.dataTransfer!.effectAllowed = 'move';
      try { e.dataTransfer!.setData('text/plain', String(idx)); } catch { /* Safari */ }
      item.classList.add('is-dragging');
    });
    head.addEventListener('dragend', () => {
      item.classList.remove('is-dragging');
      clearDropMarks();
      _blockDrag = null;   // clear even on a cancelled drag (no drop fired) so it can't go stale
      // A real drag suppresses the trailing click, but flag it anyway so a drag that
      // the browser rounds to a click can't also expand the pill (see head click below).
      head._dragJustHappened = true;
      setTimeout(() => { head._dragJustHappened = false; }, 0);
    });
    item.addEventListener('dragover', (e) => {
      if (!_blockDrag || _blockDrag.inputId !== blockId) return;
      e.preventDefault();
      e.dataTransfer!.dropEffect = 'move';
      if (!treeMode) { item.classList.toggle('drag-over', idx !== _blockDrag!.from); return; }
      if (idx === _blockDrag!.from) { item.classList.remove('drop-before', 'drop-after', 'drop-inside'); return; }
      const intent = zoneIntent(e);
      _blockDrag!.intent = intent;
      _blockDrag!.over = idx;
      item.classList.toggle('drop-before', intent === 'before');
      item.classList.toggle('drop-after', intent === 'after');
      item.classList.toggle('drop-inside', intent === 'inside');
    });
    item.addEventListener('dragleave', () => item.classList.remove('drag-over', 'drop-before', 'drop-after', 'drop-inside'));
    item.addEventListener('drop', (e) => {
      if (!_blockDrag || _blockDrag.inputId !== blockId) return;
      e.preventDefault();
      const from = _blockDrag.from, to = idx, intent = _blockDrag.intent || zoneIntent(e);
      clearDropMarks();
      _blockDrag = null;
      const inp = panelModel.find(i => i.id === blockId);
      if (!inp || from == null) return;
      const arr = Array.isArray(inp.value) ? inp.value : [];
      if (from < 0 || from >= arr.length) return;
      let next: InputValue[] | null;
      if (treeMode) {
        next = blockReparentMove(arr as BlockRow[], from, to, intent, nestingConfig(inp)) as InputValue[] | null;
        if (!next) return;                      // no-op / illegal (e.g. into own subtree)
      } else {
        if (from === to) return;
        next = [...arr];
        const [moved] = next.splice(from, 1);
        next.splice(to, 0, moved!);
      }
      runtime.setInput(blockId, next);
      onDirty?.(blockId);
    });

    // Icon button folds this block to a pill — pure DOM toggle, no re-render
    // (renderInputs re-applies the collapsed state across rebuilds). toggleBlock
    // keeps the chevron's aria/title and the open animation in lockstep.
    const collapse = item.querySelector('[data-block-collapse]');
    collapse?.addEventListener('click', (e) => {
      e.stopPropagation();                 // don't reach the header's expand/drag
      const folded = !item.classList.contains('is-collapsed');
      toggleBlock(item, folded);
      syncCollapseAllPills();
      // On expand, bring the revealed fields into view so the click never looks dead
      // (a lower pill's fields would otherwise open below the scroll fold).
      if (!folded) scrollToControl(item, { pulse: false });
    });

    // The whole pill is the expand target while collapsed — clicking its body (preview,
    // swatch, grip, dead space) opens it, not just the 22px chevron. Only acts while
    // collapsed; ignores the chevron/remove buttons (they handle themselves) and the
    // click that ends a drag-reorder. Expanded cards are untouched (fields stay editable).
    head.addEventListener('click', (e) => {
      if (!item.classList.contains('is-collapsed')) return;
      if ((e.target as HTMLElement).closest('button')) return;
      if (head._dragJustHappened) return;
      toggleBlock(item, false);
      syncCollapseAllPills();
      scrollToControl(item, { pulse: false });
    });
  });

  // "Collapse all / Expand all" pill: fold or unfold every block in its group at
  // once — pure DOM toggle like the per-block chevron (renderInputs re-applies the
  // fold state across rebuilds), so no model change and no re-render.
  el.querySelectorAll<HTMLElement>('[data-blocks-collapse-all]').forEach(pill => {
    pill.addEventListener('click', (e) => {
      e.stopPropagation();
      const wrap = pill.closest('.blocks-input')!;
      const fold = pill.dataset.mode !== 'expand';
      wrap.querySelectorAll('.block-item.is-typed').forEach(item => toggleBlock(item, fold));
      syncCollapseAllPills();
      // Expanding many at once: surface the first so the change is visible.
      if (!fold) {
        const first = wrap.querySelector('.block-item');
        if (first) scrollToControl(first, { pulse: false });
      }
    });
  });

  if (el._colorPopoverDismiss) {
    document.removeEventListener('click', el._colorPopoverDismiss, true);
  }
  el._colorPopoverDismiss = (e: MouseEvent) => {
    const t = e.target as HTMLElement;
    if (!t.closest('.color-picker-field') && !t.closest('.color-popover')) {
      el.querySelectorAll<HTMLElement>('.color-popover:not([hidden])').forEach(p => { p.hidden = true; p.style.cssText = ''; });
    }
  };
  document.addEventListener('click', el._colorPopoverDismiss, true);

  // Dismiss any open typed add-menu on an outside click. A click inside
  // .block-add-menu is left alone (the option's own handler appends + rebuilds).
  if (el._blockMenuDismiss) {
    document.removeEventListener('click', el._blockMenuDismiss, true);
  }
  el._blockMenuDismiss = (e: MouseEvent) => {
    if (!(e.target as HTMLElement).closest('.block-add-menu')) {
      el.querySelectorAll<HTMLElement>('.block-add-options:not([hidden])').forEach(m => { m.hidden = true; });
    }
  };
  document.addEventListener('click', el._blockMenuDismiss, true);

  // Aggregate disposer — the ONE teardown call for everything this render parked
  // outside the panel's own subtree: the document-level capture dismissers above
  // (colour popover, block add-menu, help tips) and the body-mounted flatpickr
  // calendars. Consumers (tool view teardown, the embed editor, multi-edit) call
  // this instead of re-listing the expandos, so a new leak source added here can
  // never be missed at a call site. Reads the live expandos/instances at dispose
  // time, so the latest render's listeners are always the ones removed.
  el._inputsDispose = () => {
    if (el._colorPopoverDismiss) document.removeEventListener('click', el._colorPopoverDismiss, true);
    if (el._blockMenuDismiss)    document.removeEventListener('click', el._blockMenuDismiss, true);
    if (el._helpTipDismiss)      document.removeEventListener('click', el._helpTipDismiss, true);
    // flatpickr appends its calendar to <body> and registers document/window
    // listeners released only by destroy(). Deferred to a microtask (same nuance
    // as the re-render path above): a dispose reachable from flatpickr's own
    // onClose must not nuke the closing instance mid-callback.
    const fps = [...el.querySelectorAll<FlatpickrHost>('.fp-datetime')].map(c => c._flatpickr).filter(Boolean);
    if (fps.length) queueMicrotask(() => fps.forEach(fp => fp!.destroy()));
  };
}

// Starting value for a freshly-added block field. An explicit `default` wins;
// otherwise the type picks a sensible empty (number→min, select→first option,
// asset→null, text/color→'').
function blockFieldDefault(f: BlockFieldSpec): InputValue {
  if (f.default !== undefined) return f.default;
  switch (f.type) {
    case 'number':  return f.min ?? 0;
    case 'select':  return f.options?.[0]?.value ?? '';
    case 'boolean': return false;
    case 'asset':   return null;
    default:        return '';
  }
}

// Human-readable byte size for the file picker (chosen-file label + size limits).
function fmtBytes(n: number): string {
  if (!(n > 0)) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / 1024 ** i;
  return `${i === 0 ? v : v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

/**
 * The control for an `attachTo` input — one compact button riding inside its
 * target's row (see renderInputs). Only `display: 'icon-toggle'` has a compact
 * form; anything else falls back to its normal control, which still reads fine
 * inline because the wrapper is just a flex row.
 *
 * The button shows the CURRENT option's icon and is labelled with the option it
 * will switch TO, so a screen-reader user gets the action rather than the state
 * (the state is already in the row's own label).
 */
function attachedControlHtml(input: InputModelItem): string {
  if (input.display !== 'icon-toggle') return controlHtml(input);
  const opts = input.options ?? [];
  if (!opts.length) return '';
  const at = Math.max(0, opts.findIndex(o => o.value === input.value));
  const cur = opts[at]!;
  const next = opts[(at + 1) % opts.length]!;
  const glyph = cur.icon && hasIcon(cur.icon) ? icon(cur.icon, { size: 16 }) : escape(cur.label ?? cur.value);
  const title = `${input.label ?? input.id}: ${cur.label ?? cur.value} — switch to ${next.label ?? next.value}`;
  return `<button type="button" class="icon-toggle" data-toggle-id="${escape(input.id)}" title="${escape(title)}" aria-label="${escape(title)}">${glyph}</button>`;
}

function controlHtml(input: InputModelItem, modelValues: Record<string, InputValue> = {}): string {
  const id  = escape(input.id);
  const val = escape(input.value ?? '');
  switch (input.control) {
    case 'textarea':
      return `<textarea data-input-id="${id}" rows="${input.rows ?? 3}" maxlength="${input.maxLength ?? ''}" placeholder="${escape(input.placeholder ?? ' ')}">${val}</textarea>`;
    case 'slider': {
      // rangeWhen lets a slider's bounds depend on another input (e.g. per-pose
      // limits): the first entry whose `when` matches the current model wins,
      // overriding min/max/step. Mirrors showIf, matched against modelValues.
      const rangeWhen = (input as { rangeWhen?: { when?: Record<string, InputValue>; min?: number; max?: number; step?: number }[] }).rangeWhen;
      const rw = Array.isArray(rangeWhen)
        ? rangeWhen.find(r => Object.entries(r.when ?? {}).every(([k, v]) => modelValues[k] === v))
        : null;
      const min  = rw?.min  ?? input.min  ?? 0;
      const max  = rw?.max  ?? input.max  ?? 100;
      const step = rw?.step ?? input.step ?? 1;
      // Clamp the displayed value into the active range so a leftover out-of-range
      // value (e.g. carried from another pose, before the hook snaps it back)
      // can't push the thumb/fill past the track.
      const num  = Math.min(max, Math.max(min, parseFloat(String(input.value ?? min))));
      const pct  = ((num - min) / (max - min) * 100).toFixed(3);
      const stops = Math.round((max - min) / step);
      const ticks = (stops >= 2 && stops <= 30)
        ? `<div class="cs-ticks" aria-hidden="true">${
            Array.from({ length: stops + 1 }, (_, i) =>
              `<span class="cs-tick" style="left:${(i / stops * 100).toFixed(3)}%"></span>`
            ).join('')
          }</div>`
        : '';
      const unit = input.unit ?? input.suffix ?? '';
      return `<div class="custom-slider" data-input-id="${id}"
          data-min="${min}" data-max="${max}" data-step="${step}"${unit ? ` data-unit="${escape(unit)}"` : ''}
          tabindex="0" role="slider" aria-label="${escape(input.label ?? id)}"
          aria-valuemin="${min}" aria-valuemax="${max}" aria-valuenow="${num}" aria-valuetext="${escape(unit ? `${num} ${unit}` : String(num))}">
        <div class="cs-track">
          <div class="cs-fill" style="width:${pct}%"></div>
          <div class="cs-thumb" style="left:${pct}%"></div>
        </div>
        ${ticks}
      </div>`;
    }
    case 'select': {
      // No filter box for long lists: a native select already type-aheads, and the
      // extra text input read as the field itself (an empty box wearing the row's
      // label, because `.input-row:has(input…)` switches the row to the floating
      // label meant for text fields) while only narrowing a dropdown you had to open
      // first. It sat above every 11-16 option select — blend mode, language,
      // transition, motion — where there was nothing to filter.
      // brandFonts: append every font the user added to their brand as extra options
      // (de-duped against the manifest's own), so a font picker lists the whole brand
      // type kit — mirrors the same flag on a `blocks` select sub-field.
      let selOpts = (input.options ?? []).map(o => ({ value: String(o.value), label: String(o.label ?? o.value) }));
      if (input.brandFonts) {
        const seen = new Set(selOpts.map(o => o.value));
        for (const fam of brandFontFamilies()) if (!seen.has(fam)) { selOpts.push({ value: fam, label: fam }); seen.add(fam); }
      }
      return `<select data-input-id="${id}">${selOpts.map(o =>
        `<option value="${escape(o.value)}" ${o.value === String(input.value ?? '') ? 'selected' : ''}>${escape(o.label)}</option>`
      ).join('')}</select>`;
    }
    case 'checkbox':
      // Jelly effects: plain boolean rows render the soft-body switch. Pill-display
      // booleans keep the native checkbox — their chip look is CSS reshaping the
      // checkbox row, not a switch. Block-field checkboxes (blocks editor) are
      // separate markup below and stay native too.
      return jellyActive() && input.display !== 'pill'
        ? `<jelly-switch data-input-id="${id}" size="sm" label="${escape(input.label || id)}"${input.value ? ' checked' : ''}></jelly-switch>`
        : `<input type="checkbox" data-input-id="${id}" ${input.value ? 'checked' : ''}>`;
    case 'color-picker':
      // Shared SUSE colour picker (see components/color-field.js).
      // `swatchesOnly` makes it a palette-restricted picker (no hex/native/alpha).
      return colorFieldHtml(id, input.value, { swatchesOnly: input.swatchesOnly === true });
    case 'palette-picker':
      return `<input type="text" data-input-id="${id}" value="${val}" placeholder="(palette picker: stub)">`;
    case 'asset-picker': {
      const v = input.value as AssetRef | null;
      const currentLabel = asRow(v?.meta as InputValue | undefined).name ?? v?.id ?? 'Choose asset…';
      const hasValue = Boolean(input.value);
      // A selected asset carries a resolved blob: URL (see runtime resolveAssetRefs)
      // — show it as a small preview so the picked image is visible at a glance.
      // A lottie ref's URL is the animation JSON (unrenderable in <img>), so it
      // gets a play-glyph stub instead.
      const thumbUrl = v?.url;
      const thumb = v?.type === 'lottie'
        ? `<span class="asset-picker-thumb-inline asset-picker-thumb-lottie" aria-hidden="true">&#9654;</span>`
        : thumbUrl
          ? `<img class="asset-picker-thumb-inline" src="${escape(thumbUrl)}" alt="">`
          : '';
      // An image minted from a pasted Lolly link keeps its origin in meta.toolUrl —
      // the canonical, re-renderable embed URL (see compose.renderUrl). Surface that
      // provenance and an Edit affordance that re-opens the source tool's own inputs
      // (openEmbedEditor) so the editor can tweak it and re-apply. Plain library /
      // uploaded assets have no toolUrl, so they show no badge.
      const metaRow = asRow(v?.meta as InputValue | undefined);
      const fromTool = metaRow.toolUrl ? (metaRow.name ?? 'a Lolly tool') : null;
      // A BAKED ref (meta.baked — engine bakeAssetRef) is a frozen copy of a tool
      // render: no meta.toolUrl, so the live ✦ path above ignores it by design.
      // It gets its own ❄ provenance row instead; Edit (re-bakes on apply) and
      // Re-bake appear only when the source URL (meta.bakedFrom) survived baking.
      const bakedName = metaRow.baked === true ? (metaRow.name ?? 'a Lolly tool') : null;
      const canRebake = bakedName !== null && typeof metaRow.bakedFrom === 'string';
      // A Lolly-backed slot reads differently at a glance (is-lolly: brand-tinted
      // border + a ✦ spark on the trigger) so "this image is live, not a file"
      // is visible before clicking — the click then offers edit-or-replace.
      return `<div class="asset-picker-row${fromTool ? ' is-lolly' : ''}">
        ${thumb}
        <button type="button" class="asset-picker-trigger" data-input-id="${id}">${fromTool ? '<span class="asset-lolly-spark" aria-hidden="true">&#10022;</span> ' : ''}${escape(currentLabel)}</button>
        ${hasValue ? `<button type="button" class="asset-clear" data-clear-id="${id}" aria-label="Clear selection">&#x2715;</button>` : ''}
      </div>${fromTool ? `<div class="asset-from-tool">
        <span class="asset-from-tool-label"><span class="asset-from-tool-spark" aria-hidden="true">&#10022;</span> from <strong>${escape(fromTool)}</strong></span>
        <button type="button" class="asset-edit" data-edit-id="${id}">Edit</button>
      </div>` : ''}${bakedName ? `<div class="asset-from-tool asset-from-tool--baked">
        <span class="asset-from-tool-label"><span class="asset-from-tool-spark" aria-hidden="true">&#10052;</span> baked from <strong>${escape(bakedName)}</strong></span>
        ${canRebake ? `<button type="button" class="asset-edit" data-baked-edit-id="${id}">Edit</button>
        <button type="button" class="asset-edit" data-rebake-id="${id}">Re-bake</button>` : ''}
      </div>` : ''}`;
    }
    case 'file-picker': {
      // A picked file is a FileRef (bytes + metadata) the hook transforms; the
      // bytes live only in memory and are never uploaded or persisted. The native
      // <input type=file> is hidden behind a styled trigger; binding (renderInputs)
      // reads the File into a FileRef on change.
      const ref = input.value && typeof input.value === 'object' && (input.value as InputFile).__file ? (input.value as InputFile) : null;
      const accept = Array.isArray(input.accept) ? input.accept.join(',') : '';
      const meta = ref ? `${escape(ref.name)}${ref.size ? ` · ${fmtBytes(ref.size)}` : ''}` : '';
      return `<div class="file-picker" data-input-id="${id}">
        <input type="file" class="file-native" ${accept ? `accept="${escape(accept)}"` : ''} hidden>
        <button type="button" class="file-trigger">${ref ? 'Replace file…' : 'Choose file…'}</button>
        ${ref ? `<div class="file-chosen"><span class="file-name" title="${escape(ref.name)}">${meta}</span><button type="button" class="file-clear" aria-label="Remove file">&#x2715;</button></div>` : ''}
      </div>`;
    }
    case 'time-input':
      return `<div class="time-input-wrap"><input type="time" data-input-id="${id}" value="${val}"></div>`;
    case 'datetime-local-input':
      return `<input type="text" class="fp-datetime" data-input-id="${id}" data-fp-value="${val}" placeholder="Live — current time" readonly>`;
    case 'blocks': {
      const items   = Array.isArray(input.value) ? input.value : [];
      const fields  = input.fields ?? [];
      // addMenu turns "+ Add" into a typed menu and makes one sub-field the
      // block's fixed discriminator (shown as a head label, not an editable
      // control). Other sub-fields can opt into per-type visibility via showFor.
      const addMenu  = input.addMenu || null;
      const discr    = addMenu ? fields.find(f => f.id === addMenu.field) : null;
      const typeOpts = discr?.options ?? [];
      const typeLabel = (v: InputValue | null | undefined): unknown => typeOpts.find(o => o.value === v)?.label ?? (v ?? '');

      // Stack a label above a control inside a typed block; plain controls
      // (untyped blocks) render bare to keep the legacy compact row layout —
      // unless the input opts in with `labelledFields` (e.g. logo-wall, whose
      // optional per-logo controls aren't self-evident).
      const labelEach = !!(addMenu || input.labelledFields);
      const labelled = (f: BlockFieldSpec, inner: string, cls = ''): string => {
        if (!labelEach) return inner;
        const ht = f.help ? helpTip(f.help) : null;
        return `<div class="block-control${cls}"><span class="block-control-label">${escape(f.label ?? f.id)}${ht ? ht.button : ''}</span>${inner}${ht ? ht.pop : ''}</div>`;
      };

      // A sub-field's `showIf` is matched first against sibling fields of the same
      // block, then against top-level input values (modelValues) — so a per-block
      // control can depend on both another block field and a global toggle.
      const blockShowIf = (f: BlockFieldSpec, item: BlockRow): boolean => {
        if (!f.showIf) return true;
        return Object.entries(f.showIf).every(([k, v]) =>
          ((item && k in item) ? item[k] : modelValues[k]) === v);
      };

      const blockField = (f: BlockFieldSpec, item: BlockRow, idx: number, typeVal: InputValue | null | undefined): string => {
        const fieldId = `${id}:${idx}:${escape(f.id)}`;
        if (addMenu && f.id === addMenu.field) return '';                 // discriminator → head label
        if (Array.isArray(f.showFor) && !f.showFor.includes(typeVal as string)) return '';
        if (!blockShowIf(f, item)) return '';

        // A reference picker: choices come from the rows of another blocks input
        // (e.g. "parent" lists the other cards). The value stored is each target
        // row's derived id, which the tool's hook resolves — so this replaces the
        // old "type the matching ID by hand" text boxes without any data change.
        if (f.optionsFrom) {
          const cur = String(item[f.id] ?? f.default ?? '');
          const { options, emptyLabel, freeText } = buildRefOptions({
            of: f.optionsFrom,
            ownerInputId: input.id,
            idx,
            getRows: (inId: string) => (Array.isArray(modelValues[inId]) ? modelValues[inId] : []) as BlockRow[],
            ownerNestingCfg: input.nesting ? nestingConfig(input) : null,
          });
          if (freeText) {
            // Combobox — pick an existing target or type a new id (kanban columns).
            const listId = `dl-${id}-${idx}-${escape(f.id)}`;
            const dlOpts = options.map(o => `<option value="${escape(o.value)}">${escape(o.label)}</option>`).join('');
            return labelled(f, `<input class="block-field block-field--ref" list="${listId}" data-field-id="${fieldId}"
              value="${escape(cur)}" placeholder="${escape(f.placeholder ?? emptyLabel ?? '— none —')}"
              aria-label="${escape(f.label ?? f.id)}"><datalist id="${listId}">${dlOpts}</datalist>`);
          }
          // Strict select. A stored value matching no current row is surfaced as a
          // selected "(unknown)" option rather than silently dropped — so a stale or
          // mistyped reference is visible instead of just "the link didn't work".
          const known = options.some(o => o.value === cur);
          const empty = `<option value=""${cur === '' ? ' selected' : ''}>${escape(emptyLabel ?? '— none —')}</option>`;
          const unknown = (cur !== '' && !known)
            ? `<option value="${escape(cur)}" selected>${escape(cur)} (unknown)</option>` : '';
          const opts = options.map(o =>
            `<option value="${escape(o.value)}"${o.value === cur ? ' selected' : ''}>${escape(o.label)}</option>`).join('');
          return labelled(f, `<select class="block-field block-field--ref" data-field-id="${fieldId}" aria-label="${escape(f.label ?? f.id)}">${empty}${unknown}${opts}</select>`);
        }

        if (f.type === 'boolean') {
          const on = !!item[f.id];
          const ht = f.help ? helpTip(f.help) : null;
          // Checkbox + inline label (always labelled — a bare checkbox is opaque),
          // spanning the full row so it reads as its own line.
          return `<label class="block-control block-control--checkbox block-control--full">
            <input type="checkbox" class="block-field block-field--checkbox" data-field-id="${fieldId}"${on ? ' checked' : ''}>
            <span class="block-control-label">${escape(f.label ?? f.id)}${ht ? ht.button : ''}</span>
            ${ht ? ht.pop : ''}
          </label>`;
        }

        if (f.type === 'color') {
          // The SAME picker as top-level colour inputs (OKLCH sliders, hex, alpha,
          // lazy token-aware swatches) — `block` spans the popover across the
          // sidebar and wireColorField's onChange routes the composite id back
          // into this block's row (see the ':' route in the wiring below).
          return labelled(f, colorFieldHtml(fieldId, String(item[f.id] ?? '').trim(), { block: true }));
        }

        if (f.type === 'select') {
          const cur = String(item[f.id] ?? f.default ?? '');
          // brandFonts: append every font the user added to their brand as extra
          // options (de-duped against the manifest's own), so a font picker lists
          // the whole brand type kit, not just a hardcoded pair.
          let choices = (f.options ?? []).map(o => ({ value: String(o.value), label: String(o.label ?? o.value) }));
          if (f.brandFonts) {
            const seen = new Set(choices.map(o => o.value));
            for (const fam of brandFontFamilies()) if (!seen.has(fam)) { choices.push({ value: fam, label: fam }); seen.add(fam); }
          }
          const opts = choices.map(o =>
            `<option value="${escape(o.value)}" ${o.value === cur ? 'selected' : ''}>${escape(o.label)}</option>`).join('');
          return labelled(f, `<select class="block-field" data-field-id="${fieldId}" aria-label="${escape(f.label ?? f.id)}">${opts}</select>`);
        }

        if (f.type === 'number') {
          const min = f.min ?? 0, max = f.max ?? 1, step = f.step ?? 0.01;
          const cur = item[f.id] ?? f.default ?? min;
          // display:'slider' → range track; otherwise a plain number input that shows
          // the value and accepts decimals (e.g. 1.3, 0.5). Mirrors the top-level
          // number-vs-slider convention so block fields read consistently.
          if (f.display === 'slider') {
            return labelled(f, `<input type="range" class="block-field block-range-input" data-field-id="${fieldId}"
              min="${min}" max="${max}" step="${step}" value="${escape(cur)}" aria-label="${escape(f.label ?? f.id)}">`);
          }
          return labelled(f, `<input type="number" class="block-field block-number-input" data-field-id="${fieldId}"
            min="${min}" max="${max}" step="${step}" value="${escape(cur)}" inputmode="decimal" aria-label="${escape(f.label ?? f.id)}">`);
        }

        if (f.type === 'asset') {
          const ref = asRow(item[f.id]);
          const has = ref && ref.url;
          // A block image pasted from a Lolly link is re-editable too (mirrors the
          // top-level asset-picker case): a ✦ Edit button keyed on the same field id
          // the picker/clear handlers use re-opens the source tool (openEmbedEditor).
          const fromTool = asRow(ref.meta).toolUrl ? (asRow(ref.meta).name ?? 'a Lolly tool') : null;
          // A BAKED block image (meta.baked, no toolUrl — mirrors the top-level ❄
          // row): ❄ Edit re-opens the source tool (re-baking on apply) and ↻
          // Re-bake re-renders + freezes in place. Only when meta.bakedFrom survived.
          const bakedName = asRow(ref.meta).baked === true ? (asRow(ref.meta).name ?? 'a Lolly tool') : null;
          const canRebake = bakedName !== null && typeof asRow(ref.meta).bakedFrom === 'string';
          // A lottie ref's URL is JSON — show a play-glyph + name, not a dead <img>.
          const trigger = !has ? `<span>&#43; ${escape(f.label ?? 'Image')}</span>`
            : ref.type === 'lottie' ? `<span class="block-asset-lottie"><span aria-hidden="true">&#9654;</span> ${escape(asRow(ref.meta).name ?? ref.id)}</span>`
            : `<img src="${escape(ref.url)}" alt="">`;
          return labelled(f, `<div class="block-asset${fromTool ? ' is-lolly' : ''}">
            <button type="button" class="block-asset-trigger" data-block-asset="${fieldId}" aria-label="${escape(f.label ?? f.id)}">
              ${trigger}
            </button>
            ${fromTool ? `<button type="button" class="block-asset-edit" data-block-asset-edit="${fieldId}" title="Edit — from ${escape(fromTool)}" aria-label="Edit image, from ${escape(fromTool)}">&#10022;</button>` : ''}
            ${canRebake ? `<button type="button" class="block-asset-edit block-asset-edit--baked" data-block-baked-edit="${fieldId}" title="Edit — baked from ${escape(bakedName)}" aria-label="Edit image, baked from ${escape(bakedName)}">&#10052;</button>
            <button type="button" class="block-asset-edit block-asset-edit--baked" data-block-rebake="${fieldId}" title="Re-bake — from ${escape(bakedName)}" aria-label="Re-bake image from ${escape(bakedName)}">&#8635;</button>` : ''}
            ${has ? `<button type="button" class="block-asset-clear" data-block-asset-clear="${fieldId}" aria-label="Remove ${escape(f.label ?? 'image')}">&#x2715;</button>` : ''}
          </div>`, ' block-control--full');
        }

        // A field can opt into a multi-line textarea for specific block kinds
        // (e.g. body text) via `multilineFor`; other kinds keep the single-line
        // input. Both carry data-field-id, so the generic commit + focus-restore
        // handlers below treat them identically.
        if (Array.isArray(f.multilineFor) && f.multilineFor.includes(typeVal as string)) {
          return `<textarea class="block-field block-field--textarea${addMenu ? ' block-field--full' : ''}"
            data-field-id="${fieldId}" rows="${f.rows ?? 3}"
            placeholder="${escape(f.placeholder ?? f.label ?? f.id)}"
            aria-label="${escape(f.label ?? f.id)}">${escape(String(item[f.id] ?? ''))}</textarea>`;
        }
        return `<input class="block-field${addMenu ? ' block-field--full' : ''}"
          data-field-id="${fieldId}"
          placeholder="${escape(f.placeholder ?? f.label ?? f.id)}"
          value="${escape(String(item[f.id] ?? ''))}"
          aria-label="${escape(f.label ?? f.id)}">`;
      };

      const removeBtn = (idx: number, label: unknown): string => `<button type="button" class="block-remove" draggable="false"
        data-block-remove data-block-input="${id}" data-block-index="${idx}"
        aria-label="Remove ${escape(label || 'block')}" title="Remove">&#x2715;</button>`;

      // Six-dot grip — signals the header is a drag handle for reordering.
      const grip = `<svg class="block-grip" viewBox="0 0 10 16" width="10" height="16" aria-hidden="true">
        <circle cx="2.5" cy="3" r="1.2"/><circle cx="7.5" cy="3" r="1.2"/>
        <circle cx="2.5" cy="8" r="1.2"/><circle cx="7.5" cy="8" r="1.2"/>
        <circle cx="2.5" cy="13" r="1.2"/><circle cx="7.5" cy="13" r="1.2"/></svg>`;

      // Icon-only collapse toggle in the header — folds the block to a pill. The
      // chevron rotates to indicate state (CSS). State carries no model value, so
      // it's a pure DOM toggle here and re-applied after re-render by renderInputs.
      const collapseBtn = `<button type="button" class="block-collapse" data-block-collapse draggable="false" aria-label="Collapse block" title="Collapse">
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4 6.5 8 10l4-3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>`;

      // Collapsed-pill summary: the first non-empty text field, plus the first
      // valid colour field as a dot — so a folded block stays identifiable.
      // Both respect the active type's showFor visibility.
      const visibleFor = (f: BlockFieldSpec, typeVal: InputValue | null | undefined, item: BlockRow): boolean =>
        !(Array.isArray(f.showFor) && !f.showFor.includes(typeVal as string)) && blockShowIf(f, item);
      const previewOf = (item: BlockRow, typeVal: InputValue | null | undefined): string => {
        for (const f of fields) {
          if (addMenu && f.id === addMenu.field) continue;
          if (!visibleFor(f, typeVal, item)) continue;
          // A field with no declared type renders as a text input, so treat it as
          // text here too — otherwise compact name/value blocks (whose fields omit
          // `type`) would collapse to a blank pill.
          const ty = f.type || 'text';
          if (ty === 'text' || ty === 'longtext') {
            const v = String(item[f.id] ?? '').trim();
            if (v) return v;
          }
        }
        return '';
      };
      const swatchOf = (item: BlockRow, typeVal: InputValue | null | undefined): string => {
        for (const f of fields) {
          if (!visibleFor(f, typeVal, item)) continue;
          if (f.type === 'color') {
            const v = String(item[f.id] ?? '').trim();
            if (/^#[0-9a-fA-F]{3,8}$/.test(v)) return v;
          }
        }
        return '';
      };

      // Tree mode: when the input declares `nesting` and it's active for the
      // current model (e.g. diagramType ∈ org|mindmap), render the flat array as an
      // indented outline in pre-order, and let the header drag drop above / below /
      // inside another card (see the drag handlers in renderInputs). The DATA stays
      // a flat reference-by-id array — only the presentation is tree-shaped.
      const nesting = nestingActive(input, modelValues);
      const nestCfg = nesting ? nestingConfig(input) : null;

      const itemHtml = (item: BlockRow, idx: number, depth = 0, key: string | null = null): string => {
        const typeVal = addMenu ? item[addMenu.field] : null;
        const inner = fields.map(f => blockField(f, item, idx, typeVal)).join('');
        const sw = swatchOf(item, typeVal);
        const swatch = sw ? `<span class="block-head-swatch" style="background:${sw}"></span>` : '';
        const preview = `<span class="block-head-preview">${escape(previewOf(item, typeVal))}</span>`;
        // Typed blocks label their header with the variant name; untyped (compact
        // name/value) blocks have no variant, so the header is a bare handle. The
        // empty label still holds the flex spacer that right-aligns the controls,
        // and the collapsed pill (preview + swatch) supplies the identity. Both
        // kinds carry `is-typed` so they share the card chrome, collapse, drag and
        // first-render fold; `block-item--row` lets CSS tune the compact variant.
        const label = addMenu ? typeLabel(typeVal) : '';
        const rowCls = addMenu ? '' : ' block-item--row';
        const nestAttrs = nesting
          ? ` data-block-nested data-block-key="${escape(key ?? '')}" style="--block-depth:${depth}"` : '';
        const nestCls = nesting ? ` is-nestable${depth > 0 ? ' is-child' : ''}` : '';
        const title = nesting ? 'Drag to move, nest or reorder' : 'Drag to reorder';
        return `<div class="block-item is-typed${rowCls}${nestCls}" data-block-type="${escape(typeVal ?? '')}" data-block-index="${idx}"${nestAttrs}>
          <div class="block-head" data-block-handle draggable="true"
               data-block-input="${id}" data-block-index="${idx}" title="${title}">
            ${grip}<span class="block-type-label">${escape(label)}</span>${swatch}${preview}${collapseBtn}${removeBtn(idx, label || 'block')}
          </div>
          <div class="block-fields">${inner}</div>
        </div>`;
      };

      // In tree mode the list renders in pre-order (parent immediately above its
      // children) with each row carrying its TRUE array index, so the drag handlers
      // operate on the real array regardless of display order.
      let itemsHtml: string;
      if (nesting) {
        const rows = items as BlockRow[];
        const keys = deriveBlockKeys(rows, nestCfg!);
        const order = blockTreeOrder(rows, blockParentIndex(rows, keys, nestCfg!.parentField));
        itemsHtml = order.map(e => itemHtml(asRow(rows[e.idx]), e.idx, e.depth, keys[e.idx]!)).join('');
      } else {
        itemsHtml = items.map((it, i) => itemHtml(asRow(it), i)).join('');
      }

      let adder: string;
      if (addMenu) {
        const opts = typeOpts.map(o => {
          const used = items.some(it => asRow(it)[addMenu.field] === o.value);
          const disabled = used && !o.repeatable;
          return `<button type="button" class="block-add-option" data-block-add="${id}"
            data-block-add-type="${escape(o.value)}"${disabled ? ' disabled' : ''}>${escape(o.label ?? o.value)}</button>`;
        }).join('');
        adder = `<div class="block-add-menu">
          <button type="button" class="block-add block-add--prominent" data-block-add-toggle="${id}" aria-haspopup="true" aria-expanded="false">&#43; ${escape(addMenu.label ?? 'Add')}</button>
          <div class="block-add-options" hidden>${opts}</div>
        </div>`;
      } else {
        adder = `<button type="button" class="block-add" data-block-add="${id}">+ Add</button>`;
      }

      // Quick-start group: "Paste" + "Upload" — the fast ways to fill the whole list, so
      // they lead as the first, most prominent offer (before hand-adding blocks). Each
      // DETECTS what it's given — Markdown (mdPaste) or CSV/JSON (importData) — and routes
      // accordingly (see the paste/upload handlers). Shown when the input enables either.
      // The "Collapse all" pill is a quiet tidy-up affordance and stays right.
      const canMd = input.mdPaste === true;
      const canData = !!(input as { importData?: unknown }).importData;
      const kinds = [canMd ? 'Markdown' : '', canData ? 'CSV/JSON' : ''].filter(Boolean).join(' or ');
      const quickGroup = (canMd || canData)
        ? `<div class="blocks-quick-group">` +
            `<button type="button" class="blocks-quick blocks-io" data-blocks-io-paste="${id}" aria-label="Paste ${kinds} from the clipboard" title="Paste ${kinds} from the clipboard"><span class="blocks-quick-ic" aria-hidden="true">&#182;</span> Paste</button>` +
            `<button type="button" class="blocks-quick blocks-io" data-blocks-io-upload="${id}" aria-label="Upload a ${kinds} file" title="Upload a ${kinds} file from your device"><span class="blocks-quick-ic" aria-hidden="true">&#8615;</span> Upload</button>` +
          `</div>`
        : '';
      const collapsePill = items.length > 1
        ? `<button type="button" class="blocks-collapse-all" data-blocks-collapse-all="${id}" data-mode="collapse" aria-label="Collapse all blocks">Collapse all</button>`
        : '';
      const toolbar = (quickGroup || collapsePill)
        ? `<div class="blocks-toolbar${quickGroup ? ' blocks-toolbar--quick' : ''}">${quickGroup}${collapsePill}</div>` : '';
      return `<div class="blocks-input blocks-input--cards${addMenu ? ' blocks-input--typed' : ''}${nesting ? ' blocks-input--tree' : ''}" data-input-id="${id}">
        ${toolbar}
        <div class="blocks-list">${itemsHtml}</div>
        ${adder}
      </div>`;
    }
    case 'vector': {
      // One compound input rendered as N Figma-style fields: drag the label to
      // scrub, or type a number. The whole { fieldId: number } object is committed
      // at once (see setupVectorControl), so bulk mode sees a single column.
      const fields = input.fields ?? [];
      const v = asRow(input.value);
      const fieldHtml = (f: BlockFieldSpec): string => {
        const fv = v[f.id] ?? f.default ?? f.min ?? 0;
        const lab = escape(f.label ?? f.id);
        // Tiny single-character indicator shown inside the field (+ / X / Y …),
        // doubling as the drag handle. Field may set its own `symbol`; otherwise
        // the first letter of the label. Full label stays in title + aria-label.
        const sym = escape(f.symbol ?? (f.label ?? f.id).trim().charAt(0).toUpperCase());
        return `<span class="vec-field">
          <span class="vec-scrub" data-vec-scrub="${escape(f.id)}" title="Drag to adjust ${lab}" aria-hidden="true">${sym}</span>
          <input type="number" class="vec-num" data-vec-field="${escape(f.id)}"
            value="${escape(fv)}"${f.min !== undefined ? ` min="${f.min}"` : ''}${f.max !== undefined ? ` max="${f.max}"` : ''} step="${f.step ?? 1}"
            aria-label="${escape((input.label ? input.label + ' — ' : '') + (f.label ?? f.id))}">
        </span>`;
      };
      return `<div class="vector-input" data-input-id="${id}">${fields.map(fieldHtml).join('')}</div>`;
    }
    default:
      return `<input type="text" data-input-id="${id}" value="${val}" maxlength="${input.maxLength ?? ''}" placeholder="${escape(input.placeholder ?? ' ')}">`;
  }
}

// Re-render a baked ref's source URL (meta.bakedFrom) and freeze the result
// again — the one-click "Re-bake" path. Null on ANY failure (render or bake) so
// the caller keeps the existing baked bytes and shows the inline error instead
// of half-updating the slot.
async function rebakeFromUrl(host: WebToolHost, bakedFrom: string): Promise<AssetRef | null> {
  try {
    const ref = await host.compose!.renderUrl!(bakedFrom);
    return ref ? bakeAssetRef(ref) : null;
  } catch {
    return null;
  }
}

// Inline re-bake failure notice — the same error style the embed editor's
// preview uses. Injected after the row that owns the button (top-level ❄ row or
// block-asset), replaced on retry, cleared by the next successful rebuild.
function showRebakeError(btn: HTMLElement): void {
  const row = btn.closest('.asset-from-tool, .block-asset');
  if (!row) return;
  row.parentElement?.querySelector('.asset-rebake-error')?.remove();
  row.insertAdjacentHTML('afterend', `<p class="asset-picker-error asset-rebake-error">Couldn't re-bake this image — the source render failed.</p>`);
}

/**
 * Edit a Lolly-sourced image in place → Promise<AssetRef | null>.
 *
 * An asset minted from a pasted Lolly link records its origin as a canonical,
 * re-renderable embed URL (meta.toolUrl — see compose.renderUrl). This overlay
 * re-opens the SOURCE tool's own inputs, pre-filled from that URL, so an editor can
 * make minor changes (and adjust format/size), preview live, and re-apply the new
 * render to the same slot. Resolves to a fresh tool-sourced AssetRef (a new
 * canonical id) or null if cancelled.
 *
 * Reuse, not reinvention: the source tool's controls are driven by a throwaway
 * runtime via the SAME renderInputs/syncInputs the main sidebar uses, and every
 * preview + the final commit go through host.compose.renderUrl(buildEmbedUrl(…)) —
 * the SAME minting the paste flow uses. So the re-applied asset round-trips through
 * URL mode + saved sessions exactly like the original; provenance is just the URL
 * we already persist, nothing new is stored.
 *
 * `rebake` (a baked slot editing via its meta.bakedFrom): the commit wraps the
 * fresh render with bakeAssetRef, so editing a frozen image never un-bakes it.
 */
async function openEmbedEditor(host: WebToolHost, { editUrl, slotLabel, mode = 'edit', rebake = false }: { editUrl?: string; slotLabel?: string; mode?: string; rebake?: boolean } = {}): Promise<AssetRef | null> {
  if (!host.compose?.renderUrl) return null;
  const parsed = parseToolUrl(editUrl);
  if (!parsed) return null;

  let tool: LoadedTool, desc: EmbedDescribe | null, child: Runtime;
  try {
    [tool, desc] = await Promise.all([getTool(parsed.toolId), host.compose._describeUrl(editUrl!)]);
    if (!tool || !desc) return null;
    const state = parseUrlState(parsed.query, tool.manifest);
    child = await createRuntime(tool, host, state.values);
  } catch {
    return null; // unknown tool / bad link → silently no-op (button shouldn't have shown)
  }

  return new Promise<AssetRef | null>(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'embed-editor-overlay';
    const fmtOptions = desc!.formats.map(f =>
      `<option value="${escape(f)}"${f === desc!.format ? ' selected' : ''}>${escape(f.toUpperCase())}</option>`
    ).join('');
    const titleSlot = escape(slotLabel ?? 'image');
    // 'insert' = filling an empty slot from the picker's Tools/Saved list; 'edit' =
    // re-opening an already-placed Lolly asset via its "from <tool>" badge.
    const titleVerb  = mode === 'insert' ? 'New' : 'Edit';
    const applyLabel = mode === 'insert' ? 'Insert' : 'Re-apply to slot';
    overlay.innerHTML = `
      <div class="embed-editor-backdrop" aria-hidden="true"></div>
      <div class="embed-editor-panel" role="dialog" aria-modal="true" aria-label="Edit ${titleSlot}">
        <header class="embed-editor-head">
          <span class="embed-editor-spark" aria-hidden="true">&#10022;</span>
          <h2 class="embed-editor-title">${titleVerb} ${titleSlot} <span class="embed-editor-from">from ${escape(desc!.name)}</span></h2>
          <button type="button" class="embed-editor-close" aria-label="Close">&times;</button>
        </header>
        <div class="embed-editor-body">
          <div class="embed-editor-form">
            <div class="tool-inputs ee-inputs"></div>
          </div>
          <div class="embed-editor-side">
            <div class="asset-picker-toolcard-controls">
              <label>Format <select class="ee-format" aria-label="Render format">${fmtOptions}</select></label>
              <label>Width <input type="number" class="ee-w" min="1" inputmode="numeric" placeholder="auto" value="${desc!.width ?? ''}"></label>
              <label>Height <input type="number" class="ee-h" min="1" inputmode="numeric" placeholder="auto" value="${desc!.height ?? ''}"></label>
            </div>
            <div class="asset-picker-toolcard-preview ee-preview"><div class="asset-picker-loading">Rendering…</div></div>
            <div class="embed-editor-actions">
              <button type="button" class="ee-cancel">Cancel</button>
              <button type="button" class="ee-apply" disabled>${applyLabel}</button>
            </div>
          </div>
        </div>
      </div>`;
    // Return focus to whatever opened the editor (the Edit button) when it closes —
    // matches the picker / export-panel convention so keyboard + AT users keep their
    // place rather than being dropped on <body> behind the (now-removed) scrim.
    const opener = document.activeElement;
    document.body.appendChild(overlay);

    const inputsEl  = overlay.querySelector<PanelEl>('.ee-inputs')!;
    const fmtSel    = overlay.querySelector<HTMLSelectElement>('.ee-format')!;
    const wEl       = overlay.querySelector<HTMLInputElement>('.ee-w')!;
    const hEl       = overlay.querySelector<HTMLInputElement>('.ee-h')!;
    const previewEl = overlay.querySelector<HTMLElement>('.ee-preview')!;
    const applyBtn  = overlay.querySelector<HTMLButtonElement>('.ee-apply')!;
    // Move focus into the dialog so it's not stranded on the obscured Edit trigger,
    // and contain Tab within it (inert the page behind; backdrop stays clickable).
    overlay.querySelector<HTMLElement>('.embed-editor-close')?.focus();
    const trap: FocusTrap = trapFocus(overlay);

    let pending: AssetRef | null = null;   // the AssetRef "Re-apply" will commit
    let renderSeq = 0;    // drop a stale render when controls change again
    let prevModel: InputModelItem[] | undefined;

    // Re-serialise the child's inputs to a canonical embed URL and re-render the
    // preview. width/height/unit/dpi ride in opts (not the query). We use the engine's
    // LOSSLESS serializeUrlState — NOT buildShareParams, which is the share-LINK
    // serialiser and silently drops scalars >150 chars, user/ assets and big block
    // arrays. The original paste keeps the query verbatim, so the edit flow must too,
    // or a long input (e.g. a QR `url`) would revert to default on re-apply and corrupt
    // the asset. Reserved width/height inputs that serializeUrlState emits are skipped
    // on re-parse; the effective size is carried via the opts below. renderUrl mints the id.
    const renderPreview = async () => {
      const seq = ++renderSeq;
      pending = null;
      applyBtn.disabled = true;
      previewEl.innerHTML = `<div class="asset-picker-loading">Rendering…</div>`;
      const query = serializeUrlState(child.getModel());
      const url = buildEmbedUrl({ toolId: parsed.toolId, format: fmtSel.value, query });
      const ref = url ? await host.compose!.renderUrl!(url, {
        format: fmtSel.value,
        width:  parseInt(wEl.value, 10) || undefined,
        height: parseInt(hEl.value, 10) || undefined,
        unit:   desc!.unit ?? undefined,
        dpi:    desc!.dpi ?? undefined,
      } as Parameters<NonNullable<ComposeAPI['renderUrl']>>[1]).catch(() => null) : null;
      if (seq !== renderSeq) return; // a newer change supersedes this render
      if (!ref) {
        previewEl.innerHTML = `<p class="asset-picker-error">Couldn't render this — the inputs may be too large to re-apply as a link.</p>`;
        return;
      }
      pending = ref;
      previewEl.innerHTML = `<img class="asset-picker-toolcard-img" src="${escape(ref.url)}" alt="Preview of the ${escape(desc!.name)} render">`;
      applyBtn.disabled = false;
    };

    let debounce: number | undefined;
    const schedulePreview = () => { clearTimeout(debounce); debounce = setTimeout(renderPreview, 300); };

    // The child runtime drives the source tool's input panel (the very same
    // renderInputs/syncInputs path as the main sidebar). subscribe fires once
    // immediately (initial render + first preview) and on every later change.
    child.subscribe(({ model }) => {
      if (!_sliderDragging) prevModel = syncInputs(inputsEl, model, prevModel, child, host, () => {});
      schedulePreview();
    });

    const close = (value: AssetRef | null): void => {
      trap.release();
      clearTimeout(debounce);
      renderSeq++; // invalidate any in-flight preview render so it can't write to the detached overlay
      document.removeEventListener('keydown', onKey);
      NAV_EVENTS.forEach(ev => window.removeEventListener(ev, onNav));
      // Everything renderInputs parked outside the panel's subtree — the document-
      // level capture dismissers + the child flatpickrs' body-level calendars —
      // in one aggregate call (mirrors mountTool's _cleanup).
      inputsEl._inputsDispose?.();
      overlay.remove();
      if (opener instanceof HTMLElement) opener.focus();
      resolve(value);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); close(null); } };
    document.addEventListener('keydown', onKey);
    // A route change under the open editor (browser Back, an in-app link) cancels it —
    // the body-mounted overlay must never outlive the view that spawned it, and the
    // trap's inert background must be released (NAV_EVENTS contract, utils.ts).
    const onNav = (): void => close(null);
    NAV_EVENTS.forEach(ev => window.addEventListener(ev, onNav));

    overlay.querySelector('.embed-editor-backdrop')!.addEventListener('click', () => close(null));
    overlay.querySelector('.embed-editor-close')!.addEventListener('click', () => close(null));
    overlay.querySelector('.ee-cancel')!.addEventListener('click', () => close(null));
    applyBtn.addEventListener('click', () => {
      if (!pending) return;
      if (!rebake) { close(pending); return; }
      // A baked slot keeps its baked-ness: freeze the fresh render before
      // committing. A render the engine refuses to bake (grown past the size
      // ceiling) keeps the dialog open with the failed-preview error style —
      // shrink it and re-apply, or cancel to keep the current bytes.
      try { close(bakeAssetRef(pending)); }
      catch {
        previewEl.innerHTML = `<p class="asset-picker-error">This render is too large to freeze — make it smaller, or cancel to keep the current image.</p>`;
        applyBtn.disabled = true;
        pending = null;
      }
    });
    fmtSel.addEventListener('change', renderPreview);
    wEl.addEventListener('input', schedulePreview);
    hEl.addEventListener('input', schedulePreview);
  });
}

// A vector input: N number fields committed together as one { fieldId: number }
// object. Each field can be typed into, or its label dragged horizontally to
// scrub (Figma-style). Scrubbing sets _sliderDragging so the sidebar isn't
// rebuilt mid-drag; the canvas still updates live via the runtime subscriber.
function setupVectorControl(container: HTMLElement, runtime: Runtime, id: string, onDirty: ((id: string) => void) | undefined, input: InputModelItem): void {
  const fields = input.fields ?? [];
  const nums = new Map<string, HTMLInputElement>();
  container.querySelectorAll<HTMLInputElement>('.vec-num').forEach(n => nums.set(n.dataset.vecField!, n));

  const commit = () => {
    const obj: Record<string, InputValue> = {};
    for (const f of fields) {
      const el = nums.get(f.id);
      if (!el) continue;
      const n = Number(el.value);
      obj[f.id] = Number.isNaN(n) ? (asRow(input.value)[f.id] ?? f.default ?? 0) : n;
    }
    runtime.setInput(id, obj);
    onDirty?.(id);
  };

  nums.forEach(el => el.addEventListener('input', commit));

  // The whole field is the scrub surface, not just the symbol — drag anywhere on
  // a value to change it (Figma-style); the symbol is only a visual cue. A plain
  // click (no movement past the threshold) falls through to focus the <input> for
  // typing. Pointer Lock kicks in once dragging starts so the cursor wraps at
  // screen edges and a wide range (e.g. zoom) isn't capped by the sidebar width.
  container.querySelectorAll<HTMLElement>('.vec-field').forEach(fieldEl => {
    const fieldId = fieldEl.querySelector<HTMLElement>('.vec-scrub')?.dataset.vecScrub;
    const f  = fields.find(x => x.id === fieldId);
    const el = fieldId ? nums.get(fieldId) : undefined;
    if (!f || !el) return;
    const step  = f.step ?? 1;
    const clamp = (v: number): number => {
      if (f.min !== undefined) v = Math.max(f.min, v);
      if (f.max !== undefined) v = Math.min(f.max, v);
      return v;
    };
    let wasDragging = false;

    fieldEl.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      const startX   = e.clientX;
      const startVal = Number(el.value) || 0;
      let   accumulated = 0;   // total pixel delta once pointer lock is active
      let   dragging    = false;
      let   lastVecVal  = String(startVal); // last value we ticked on, so we tick per step

      function onMove(ev: PointerEvent): void {
        if (!dragging) {
          // Below the threshold this is still a potential click — leave it alone
          // so the field stays typeable.
          if (Math.abs(ev.clientX - startX) < 4) return;
          dragging = true;
          _sliderDragging = true;         // keep the sidebar from rebuilding mid-drag
          el!.blur();                      // leave any text-edit mode
          document.body.style.cursor = 'ew-resize';
          fieldEl.setPointerCapture(e.pointerId);
          const req = fieldEl.requestPointerLock?.({ unadjustedMovement: true });
          if (req instanceof Promise) req.catch(() => fieldEl.requestPointerLock?.());
        }
        if (document.pointerLockElement === fieldEl) accumulated += ev.movementX;
        else accumulated = ev.clientX - startX; // keep in sync for the switch to locked mode
        el!.value = String(clamp(startVal + Math.round(accumulated / 4) * step)); // ~1 step / 4px
        if (el!.value !== lastVecVal) { lastVecVal = el!.value; playScrubTick(); } // detent per step
        commit();                          // live: canvas re-hydrates, sidebar held
      }

      function onUp(): void {
        fieldEl.removeEventListener('pointermove', onMove);
        fieldEl.removeEventListener('pointerup', onUp);
        fieldEl.removeEventListener('pointercancel', onUp);
        document.removeEventListener('pointerlockchange', onLockChange);
        if (document.pointerLockElement === fieldEl) document.exitPointerLock();
        document.body.style.cursor = '';
        if (dragging) {
          _sliderDragging = false;
          wasDragging = true;
          setTimeout(() => { wasDragging = false; }, 50);
          commit();                        // final commit now re-renders the sidebar
        }
      }

      function onLockChange(): void {
        // Escape key or other external release — stop dragging cleanly.
        if (document.pointerLockElement !== fieldEl) onUp();
      }

      fieldEl.addEventListener('pointermove', onMove);
      fieldEl.addEventListener('pointerup', onUp);
      fieldEl.addEventListener('pointercancel', onUp);
      document.addEventListener('pointerlockchange', onLockChange);
    });

    // Suppress the click-to-focus that follows a drag so the caret doesn't jump
    // into the field after scrubbing.
    fieldEl.addEventListener('click', e => {
      if (wasDragging) { e.preventDefault(); el!.blur(); }
    });
  });
}

function setupCustomSlider(el: HTMLElement, runtime: Runtime, id: string, onDirty?: (id: string) => void): void {
  const min  = parseFloat(el.dataset.min ?? '');
  const max  = parseFloat(el.dataset.max ?? '');
  const step = parseFloat(el.dataset.step ?? '') || 1;
  const unit = el.dataset.unit || '';
  const track = el.querySelector<HTMLElement>('.cs-track')!;
  const fill  = el.querySelector<HTMLElement>('.cs-fill')!;
  const thumb = el.querySelector<HTMLElement>('.cs-thumb')!;

  let lastSnapped = parseFloat(el.getAttribute('aria-valuenow') ?? '') || min;
  // Live numeric readout next to the label. The panel rebuild is suppressed during a
  // slider drag (_sliderDragging), so update this span directly or it stalls mid-drag.
  const valueOut = el.closest('.input-row')?.querySelector<HTMLElement>('.input-value');

  function snap(raw: number): number {
    const s = Math.round((raw - min) / step) * step + min;
    return +(Math.min(max, Math.max(min, s)).toFixed(10));
  }

  // Keep aria-valuenow and a human aria-valuetext (with the unit, when one exists)
  // in lockstep so screen readers announce the value on every change.
  function setAria(v: number): void {
    el.setAttribute('aria-valuenow', String(v));
    el.setAttribute('aria-valuetext', unit ? `${v} ${unit}` : String(v));
  }

  function setThumb(rawVal: number): void {
    const pct = ((Math.min(max, Math.max(min, rawVal)) - min) / (max - min) * 100).toFixed(3);
    fill.style.width = pct + '%';
    thumb.style.left = pct + '%';
  }

  el.addEventListener('pointerdown', e => {
    e.preventDefault();
    el.focus({ preventScroll: true }); // so the keyboard handler is live right after a click
    el.setPointerCapture(e.pointerId);
    _sliderDragging = true;
    el.classList.add('dragging');

    function fromPointer(e: PointerEvent): void {
      const rect  = track.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      const raw   = min + ratio * (max - min);
      setThumb(raw);
      const snapped = snap(raw);
      if (snapped !== lastSnapped) {
        lastSnapped = snapped;
        setAria(snapped);
        if (valueOut) valueOut.textContent = String(snapped);
        runtime.setInput(id, snapped);
        playSliderTick(); // a soft detent per step passed (rate-limited in sfx)
      }
    }

    function onUp(): void {
      el.removeEventListener('pointermove', fromPointer);
      el.removeEventListener('pointerup', onUp);
      _sliderDragging = false;
      el.classList.remove('dragging');
      // Snap thumb to final stop and trigger one last render
      setThumb(lastSnapped);
      onDirty?.(id);
      runtime.setInput(id, lastSnapped);
    }

    el.addEventListener('pointermove', fromPointer);
    el.addEventListener('pointerup', onUp);
    fromPointer(e);
  });

  el.addEventListener('keydown', e => {
    let next: number | null = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp')   next = lastSnapped + step;
    else if (e.key === 'ArrowLeft'  || e.key === 'ArrowDown') next = lastSnapped - step;
    else if (e.key === 'Home')      next = min;
    else if (e.key === 'End')       next = max;
    else if (e.key === 'PageUp')    next = lastSnapped + step * 10;
    else if (e.key === 'PageDown')  next = lastSnapped - step * 10;
    if (next === null) return;
    e.preventDefault();
    const snapped = snap(next);
    if (snapped === lastSnapped) return;
    lastSnapped = snapped;
    setThumb(lastSnapped);
    setAria(lastSnapped);
    onDirty?.(id);
    runtime.setInput(id, lastSnapped);
  });
}

export { syncInputs, openEmbedEditor, scrollToControl, focusSidebarBlock, fileToRef, fmtBytes, makeBlocksDropper };
