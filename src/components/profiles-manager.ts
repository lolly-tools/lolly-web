// SPDX-License-Identifier: MPL-2.0
/**
 * The print-profile panel — where an `.icc` on this device becomes a comparison
 * target the Colour Lab can chart against.
 *
 * A library, not a setting: dropping a file ADDS it, and pressing one of its
 * intent buttons is the separate, deliberate act that repoints the charts. That
 * split is `lib/color-profiles.ts`'s (ingest ≠ activate) and this panel does not
 * blur it — a drop that was only meant to stock the library never moves the
 * report out from under the reader.
 *
 * ## Why intent is a control here and not a fourth tab out there
 *
 * A gamut question without a rendering intent is under-specified: the same
 * profile is a different gamut under `perceptual` than under `absolute`, which is
 * why the intent is part of `GamutSource.id` rather than an argument. But four
 * pills per profile in the Lab's comparison row is exactly the tab-row failure
 * §11.6b describes. So the row out there carries ONE profile pill and the intent
 * choice lives on the profile's own row in here, next to the file it belongs to.
 *
 * An intent the profile has no table for is rendered UNAVAILABLE, never hidden:
 * "this file has no saturation table" is a real fact about the file (macOS's
 * Generic Lab Profile is exactly that case), and hiding the button would leave a
 * reader wondering whether we simply did not offer it. It carries `aria-disabled`
 * rather than `disabled` so it still takes focus and can still answer why.
 *
 * ## The press-condition rows
 *
 * The bottom section lists the conditions an export can DECLARE in its OutputIntent,
 * and every row is a button. It was a readout, which was honest and useless — FOGRA39
 * and SWOP are the first two things a print reader looks for. Pressing one charts the
 * condition when its profile is here, fetches it from the ICC registry when there is a
 * licence-clean source (`lib/press-conditions.ts`), and otherwise opens the picker
 * naming the filename to look for. Declaring a condition still needs no profile at
 * all: nothing here gates an export.
 *
 * ## Refusals
 *
 * Two, both from `ingestProfile`, both stated in one line and neither in a modal:
 * a file the reader cannot parse, and a profile no intent can be asked a gamut
 * question in. Nothing else is refused — an RGB monitor profile is a perfectly
 * good comparison target, it simply has no ink to report.
 */

import '../styles/parts/dropzone.css';   // the .updz dropzone this reuses verbatim
import {
  ingestProfile, listProfiles, isIngestFailure, INTENTS,
} from '../lib/color-profiles.ts';
import type { ColorProfilesHost, ProfileEntry } from '../lib/color-profiles.ts';
import type { RenderingIntent } from '@lolly/engine';
import { mountModal } from './modal.ts';
import {
  PRESS_CONDITIONS, conditionFor, locationHint, fetchSourceFor, sourceIsExact,
  fetchPressProfile,
} from '../lib/press-conditions.ts';
import type { PressCondition } from '../lib/press-conditions.ts';
import { originContradicted } from '../lib/press-profile-embed.ts';
import { icon } from '../lib/icons.ts';
import { announce } from '../a11y.ts';
import { escape } from '../utils.ts';
import { t } from '../i18n.ts';

export interface ProfilesPanelOpts {
  host: ColorProfilesHost;
  /** The profile+intent currently charted against, so its button reads pressed. */
  active?: { digest: string; intent: RenderingIntent } | null;
  /** A link asked for a profile this device does not have — say so, once. */
  absent?: boolean;
  /**
   * Chart against this profile under this intent. Returns whether it took.
   *
   * A success channel rather than `void`, because activation genuinely can fail
   * on a row this panel is showing: the bytes can have been evicted or dropped by
   * another tab since the list was read, and a row whose stored `meta.intents` is
   * missing offers the default intent by fallback, which the live gate can then
   * refuse. Adopting the button unconditionally made the panel and the Lab's pill
   * row assert opposite things about one profile, and erased the only line that
   * said so.
   */
  onActivate(digest: string, intent: RenderingIntent): boolean | Promise<boolean>;
  /** The file (and its tab, and its pill) is gone. */
  onRemove(digest: string): void | Promise<void>;
  /** A file landed in the library. NOT an activation — the caller decides whether
   *  this is the profile a link was waiting for. */
  onIngest?(digest: string): void | Promise<void>;
}

/**
 * The intent buttons say the whole word.
 *
 * They used to read `per rel sat abs`. That is trade shorthand, and it is the panel
 * where a first-time reader meets rendering intents at all — the abbreviation was
 * saving width in a modal that has width to spare, and putting the meaning in a
 * `title` attribute, which does not exist on a touch device. A label the reader
 * understands beats a tooltip explaining a label they do not. The Lab's own pill still
 * abbreviates (`FOGRA39 · rel`, `shortLabel` in lib/color-profiles.ts) because 22
 * characters there genuinely is the budget.
 *
 * Lazy, not a module constant: `t` needs the catalog loaded.
 */
const intentName = (i: RenderingIntent): string => ({
  perceptual: t('Perceptual'),
  relative: t('Relative'),
  saturation: t('Saturation'),
  absolute: t('Absolute'),
}[i]);

const kb = (bytes: number): string => `${Math.max(1, Math.round(bytes / 1024))} kB`;

/** One stored profile's row: what it is, which intents it can answer, and remove. */
function rowHtml(e: ProfileEntry, active: ProfilesPanelOpts['active']): string {
  // 'ink' only where there IS ink: a three-channel Lab or RGB profile has
  // channels, and calling them inks would be the kind of small false claim this
  // panel exists to avoid.
  const inky = /^(CMYK|CMY|[2-9A-F]CLR)$/i.test(e.colourSpace.trim());
  const meta = [
    e.colourSpace || e.deviceClass,
    e.channels ? (inky ? t('{n} ink', { n: String(e.channels) }) : t('{n} ch', { n: String(e.channels) })) : '',
    e.version ? `v${e.version}` : '',
    kb(e.bytes),
  ].filter(Boolean).join(' · ');
  const live = active?.digest === e.digest ? active.intent : null;
  // An intent with no table is aria-disabled rather than `disabled`: a disabled button
  // is unfocusable, so on a keyboard or a touch screen the reason it cannot be pressed
  // was unreachable. This way the button still takes focus (tooltip + focus ring) and a
  // tap answers in the status line instead of doing nothing.
  const intents = INTENTS.map((i) => {
    const can = e.intents.includes(i);
    const name = intentName(i);
    const tip = can ? '' : ` data-tip="${escape(t('No {i} table in this file', { i: name.toLowerCase() }))}"`;
    return `<button type="button" class="view-seg-btn" data-lab-intent="${i}"
      aria-pressed="${live === i}"${can ? '' : ' aria-disabled="true"'}${tip}
      >${escape(name)}</button>`;
  }).join('');
  return `
    <li class="labp-row${live ? ' is-active' : ''}" data-labp-digest="${escape(e.digest)}">
      <div class="labp-row-head">
        <div class="labp-row-id">
          <strong class="labp-row-name">${escape(e.description || e.name)}</strong>
          <span class="labp-row-meta">${escape(meta)}</span>
        </div>
        <button type="button" class="labp-remove" data-labp-remove
          aria-label="${escape(t('Remove {name}', { name: e.description || e.name }))}">${escape(t('Remove'))}</button>
      </div>
      <div class="view-seg labp-intents" role="group"
        aria-label="${escape(t('Rendering intent for {name}', { name: e.description || e.name }))}">${intents}</div>
    </li>`;
}

/**
 * Open the panel. Resolves when it closes.
 *
 * The whole panel body is an innerHTML target and may be — it hosts buttons and a
 * file input, no MOUNTED control. (The Lab's readability cards and picker are the
 * ones that must never be rebuilt under themselves; nothing of that kind is here.)
 */
export function openProfilesPanel(opts: ProfilesPanelOpts): Promise<void> {
  return new Promise<void>((resolve) => {
    const modal = mountModal<void>(`
      <div class="labp">
        <header class="labp-head">
          <h2 class="labp-title">${escape(t('Print profile'))}</h2>
          <button type="button" class="labp-close" data-labp-close
            aria-label="${escape(t('Close'))}">×</button>
        </header>
        <p class="labp-intro">${escape(t('An ICC profile from your printer becomes a fourth comparison target beside the three display gamuts. Nothing leaves this device.'))}</p>
        <label class="updz labp-drop">
          <input type="file" class="updz-input visually-hidden" data-labp-file
            accept=".icc,.icm,application/vnd.iccprofile"
            aria-label="${escape(t('Add an ICC profile'))}">
          <span class="updz-icon" aria-hidden="true">${icon('upload')}</span>
          <span class="updz-copy">
            <span class="updz-text">${escape(t('Drop an .icc here, or'))} <span class="updz-browse">${escape(t('browse'))}</span></span>
            <span class="updz-hint">${escape(t('ICC v2 or v4 — a press condition, or any device profile'))}</span>

          </span>
        </label>
        ${/* The fastest route to a real press profile is often one already on the
              machine — it is offline, and it is the exact separation the shop uses.
              (The ICC registry can also be fetched; see the condition rows below.)
              BELOW the drop zone, not inside it — three wrapped lines of path turned
              the target into a wall of text. */''}
        <p class="labp-where">${escape(t('Already on this device:'))} <code>${escape(locationHint())}</code></p>
        <p class="labp-msg" data-labp-msg role="status" aria-live="polite"${opts.absent ? '' : ' hidden'}
          >${opts.absent ? escape(t('This link compares against a profile that isn’t on this device.')) : ''}</p>
        <ul class="labp-list" data-labp-list></ul>
        <p class="labp-hint">${escape(t('absolute keeps the paper white'))}</p>
        ${/* What a Print PDF can DECLARE, and whether we can also evaluate it. The
              export panel has always let you name one of these in the OutputIntent;
              naming is a claim about your target, and it carries no measurements, so
              the Lab could say nothing about the condition your own export names. Each
              row closes that in one press: it charts the condition if its profile is
              here, fetches it from the ICC registry if it is not, and falls back to the
              file picker with the filename to look for. No row does nothing. */''}
        <section class="labp-conds">
          <h3 class="labp-conds-h">${escape(t('Press conditions your exports can declare'))}</h3>
          <ul class="labp-conds-list" data-labp-conds></ul>
        </section>
      </div>`, {
      className: 'modal labp-modal',
      ariaLabel: t('Print profile'),
      initialFocus: el => el.querySelector<HTMLElement>('[data-labp-file]'),
      onClose: () => resolve(),
    });

    const el = modal.el;
    const list = el.querySelector<HTMLElement>('[data-labp-list]')!;
    const msg = el.querySelector<HTMLElement>('[data-labp-msg]')!;
    const file = el.querySelector<HTMLInputElement>('[data-labp-file]')!;
    const drop = el.querySelector<HTMLElement>('.labp-drop')!;

    const say = (text: string): void => {
      msg.textContent = text;
      msg.hidden = !text;
      if (text) announce(text);
    };

    const conds = el.querySelector<HTMLElement>('[data-labp-conds]')!;

    /** condition id → the stored profile that satisfies it. Filled by `refresh`, read by
     *  `pickCondition`, so a press acts on the same list the reader is looking at. */
    const loaded = new Map<string, ProfileEntry>();

    async function refresh(): Promise<void> {
      const rows = await listProfiles(opts.host).catch(() => []);
      list.innerHTML = rows.length
        ? rows.map(e => rowHtml(e, opts.active)).join('')
        : `<li class="labp-empty">${escape(t('No profiles yet.'))}</li>`;

      // A condition is "loaded" when one of the profiles on this device names it.
      // Matched on the profile's own `desc`, since that is what the vendor wrote —
      // several spellings are in circulation, which is why the match list is a list.
      loaded.clear();
      for (const e of rows) {
        const c = conditionFor(e.description || e.name);
        if (c && !loaded.has(c.id)) loaded.set(c.id, e);
      }
      conds.innerHTML = PRESS_CONDITIONS.map((c) => {
        const found = loaded.get(c.id);
        const src = fetchSourceFor(c);
        // Three different facts, and the row states which one it is holding. Declaring
        // a condition in a PDF is a claim about your target and needs no file;
        // COMPARING against it needs the file's measurements. Nothing here is a
        // refusal — a condition with no profile still exports exactly as it did.
        const state = found ? 'loaded' : src ? 'fetch' : 'declare';
        const note = found
          ? t('Loaded — {name}', { name: found.description || found.name })
          : src
            // The row names the FILE it will fetch, not the condition, because those are
            // not always the same thing: an export declares CGATS TR 001 for SWOP and the
            // registry's profile is built from TR003. Saying which file it is getting is
            // how the reader can tell.
            ? (sourceIsExact(c)
              ? t('Get {file} — free from the ICC registry', { file: src.name })
              : t('Get {file} — free from the ICC registry, built from {data}', { file: src.name, data: src.charData ?? '' }))
          : c.files.length
            ? t('Exports can declare it. Look for {file} on this device.', { file: c.files[0]! })
            : t('Exports can declare it. Load its profile to compare against it.');
        const label = found
          ? t('Compare against {name}', { name: c.info })
          : src
            ? t('Get the profile for {name}', { name: c.info })
            : t('Choose the profile for {name}', { name: c.info });
        return `<li class="labp-cond" data-state="${state}">
          <button type="button" class="labp-cond-btn" data-labp-cond="${escape(c.id)}"
            aria-label="${escape(label)}">
            <span class="labp-cond-id">${escape(c.identifier)}</span>
            <span class="labp-cond-name">${escape(c.info)}</span>
            <span class="labp-cond-note" data-labp-cond-note>${escape(note)}</span>
          </button>
        </li>`;
      }).join('');
    }

    /**
     * A condition row was pressed. Never a dead end — the three states it can be in
     * are the three useful things to do:
     *
     * 1. the profile is here → chart against it and get out of the way (this is the
     *    one that must feel instant: it is the same act as pressing its intent pill);
     * 2. a licence-clean source exists → fetch it once, store it on-device, chart it.
     *    Deliberately NOT the drop zone's ingest≠activate split: a drop only stocks the
     *    library, but pressing a condition IS the request to compare against it;
     * 3. nothing to fetch → open the picker the user already has open, and name the
     *    file to look for. A filename is two clicks; a folder is a search.
     */
    async function pickCondition(id: string): Promise<void> {
      const c = PRESS_CONDITIONS.find(x => x.id === id);
      if (!c) return;
      const found = loaded.get(id);
      if (found) { await chartAgainst(found.digest, found.activeIntent); return; }
      const src = fetchSourceFor(c);
      if (!src) { wantFile(c); return; }

      const row = conds.querySelector<HTMLElement>(`[data-labp-cond="${CSS.escape(id)}"]`)?.closest<HTMLElement>('.labp-cond');
      const note = row?.querySelector<HTMLElement>('[data-labp-cond-note]');
      const was = note?.textContent ?? '';
      row?.setAttribute('data-busy', '');
      if (note) note.textContent = t('Fetching {file}…', { file: src.name });
      const bytes = await fetchPressProfile(src);
      row?.removeAttribute('data-busy');
      if (note) note.textContent = was;
      if (!bytes) {
        // Offline, or the registry moved the file. Say the actionable thing rather than
        // the network's thing: the profile is very likely already on this machine.
        say(c.files.length
          ? t('Couldn’t fetch it. Look for {file} on this device.', { file: c.files[0]! })
          : t('Couldn’t fetch it — add the file yourself.'));
        return;
      }
      const blob = new Blob([bytes as unknown as BlobPart], { type: 'application/vnd.iccprofile' });
      // Record WHERE this came from. A registry fetch for condition `c` pairs the
      // profile with that condition by construction, which is what lets a Print PDF
      // embed it and still declare a registered name (press-profile-embed.ts). Note
      // it is recorded even for SWOP, whose source states CGATS TR003: sourceIsExact
      // is false there, so the pairing step declines it and the export says `Custom`.
      //
      // Unless the bytes that actually arrived contradict the row — if the registry
      // ever re-points a filename, the file's own `targ` says so, and an origin that
      // is wrong is worse than no origin at all. Refusing to record it here is
      // cheaper than repairing it on every export (the embed path re-checks anyway).
      const provenance = originContradicted(bytes, c.id)
        ? null
        : { kind: 'registry' as const, url: src.url, conditionId: c.id, charData: src.charData };
      const r = await ingestProfile(
        opts.host,
        typeof File === 'function' ? new File([blob], src.name, { type: blob.type }) : blob,
        provenance ? { origin: provenance } : {},
      ).catch(() => ({ error: 'unreadable' as const }));
      if (isIngestFailure(r)) {
        say(t('That file isn’t a profile this can read.'));
        return;
      }
      await opts.onIngest?.(r.digest);
      await chartAgainst(r.digest, r.activeIntent);
    }

    /** Chart against a profile and close, or say why the charts did not move. */
    async function chartAgainst(digest: string, intent: RenderingIntent): Promise<void> {
      const ok = await opts.onActivate(digest, intent);
      if (ok) { opts.active = { digest, intent }; modal.close(); return; }
      say(t('That profile could not be read — add the file again.'));
      await refresh();
    }

    /** No source to fetch: open the picker and name the file worth looking for. */
    function wantFile(c: PressCondition): void {
      if (c.files.length) say(t('Look for {file} in {where}', { file: c.files.join(t(' or ')), where: locationHint() }));
      file.click();
    }

    async function take(files: FileList | null): Promise<void> {
      if (!files?.length) return;
      drop.classList.add('is-busy');
      for (const f of Array.from(files)) {
        const r = await ingestProfile(opts.host, f).catch(() => ({ error: 'unreadable' as const }));
        if (!isIngestFailure(r)) {
          say('');
          await opts.onIngest?.(r.digest);
          continue;
        }
        say(r.error === 'unreadable'
          ? t('That file isn’t a profile this can read.')
          : t('This profile has no gamut to compare against.'));
      }
      drop.classList.remove('is-busy');
      file.value = '';
      await refresh();
    }

    file.addEventListener('change', () => { void take(file.files); });
    for (const evt of ['dragenter', 'dragover', 'dragleave', 'drop']) {
      drop.addEventListener(evt, (e) => { e.preventDefault(); e.stopPropagation(); });
    }
    for (const evt of ['dragenter', 'dragover']) {
      drop.addEventListener(evt, () => drop.classList.add('is-dragover'));
    }
    for (const evt of ['dragleave', 'drop']) {
      drop.addEventListener(evt, () => drop.classList.remove('is-dragover'));
    }
    drop.addEventListener('drop', (e) => { void take((e as DragEvent).dataTransfer?.files ?? null); });

    el.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (target.closest('[data-labp-close]')) { modal.close(); return; }
      const cond = target.closest<HTMLElement>('[data-labp-cond]');
      if (cond?.dataset.labpCond) {
        if (cond.closest('.labp-cond')?.hasAttribute('data-busy')) return;   // a fetch is in flight
        void pickCondition(cond.dataset.labpCond);
        return;
      }
      const row = target.closest<HTMLElement>('[data-labp-digest]');
      const digest = row?.dataset.labpDigest;
      if (!digest) return;
      if (target.closest('[data-labp-remove]')) {
        void Promise.resolve(opts.onRemove(digest)).then(() => {
          opts.active = opts.active?.digest === digest ? null : opts.active;
          return refresh();
        });
        return;
      }
      const btn = target.closest<HTMLElement>('[data-lab-intent]');
      const intent = btn?.dataset.labIntent as RenderingIntent | undefined;
      if (!intent) return;
      if (btn?.getAttribute('aria-disabled') === 'true') {
        // Focusable on purpose (see rowHtml), so this is reachable by touch and keyboard
        // rather than being a button that silently does nothing.
        say(t('No {i} table in this file', { i: intentName(intent).toLowerCase() }));
        return;
      }
      void Promise.resolve(opts.onActivate(digest, intent)).then((ok) => {
        if (ok) {
          opts.active = { digest, intent };
          say('');
        } else {
          // The charts did NOT move, so the button must not read pressed. Say what
          // is true of the file rather than of the click: re-adding it is the fix.
          say(t('That profile could not be read — add the file again.'));
        }
        return refresh();
      });
    });

    void refresh();
  });
}
