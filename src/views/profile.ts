// SPDX-License-Identifier: MPL-2.0
/**
 * Profile view — personal details + appearance preferences.
 *
 * Theme selection auto-saves on click (it's a preference, not a form field).
 * The other personal details save on form submit.
 *
 * Activity / Storage / Feature flags / Content Credentials are collapsible
 * sections, collapsed by default. Storage and Content Credentials are also
 * LAZY: their expensive work (storage estimate, asset listing/sizes, the
 * image-thumbnail grid; identity status + the CA health probe) is deferred
 * until the section is expanded, so first paint only awaits the profile +
 * headshot.
 */

import '../styles/parts/profile.css';   // async CSS chunk (lazy view — not on the landing)
import '../styles/parts/storage.css';   // the storage-reconciliation meter lives in /profile
import { applyTheme, currentTheme, THEMES, THEME_LABELS } from '../theme.ts';
import { currentLang, switchLang, t, docsHref } from '../i18n.ts';
import type { Lang } from '../i18n.ts';
import { langFabHtml, attachLangMenu } from '../components/lang-menu.ts';
import { playThemeSfx, playSfx } from '../lib/sfx.ts';
import { staggerReveal } from '../lib/reveal.ts';
import { soundSwitchHtml, wireSoundSwitch } from '../components/sound-toggle.ts';
import { BATCH_SLOT_PREFIX } from '../lib/batch-slots.ts';
import { trapFocus, type FocusTrap } from '../lib/focus-trap.ts';
import { escape } from '../utils.ts';
import { icon } from '../lib/icons.ts';
import { announce } from '../a11y.ts';
import { getMetrics } from '../metrics.ts';
import { renderActivity } from '../lib/activity-summary.ts';
import { openHeadshotCropper } from '../components/headshot-cropper.ts';
import { storeUserUpload } from './picker.ts';
import { CATEGORY_FLAGS, PRO_FLAG, NEUROSPICY_FLAG, STRIP_UPLOAD_META_FLAG, flagEnabled, isFlagOn, setFlagMirror } from '../feature-flags.ts';
import { stopNeurospicy } from '../lib/neurospicy.ts';
import { syncNeuroDock } from '../components/neuro-dock.ts';
import { saveBlob } from '../pro/zip.ts';
import { exportBackup, importBackup } from '../data-transfer.ts';
// Colour / palette / fonts / brand-pack / corner radius all live in the
// Dashboard's "Your brand" editor now (and the #/start wizard).
import { registerUserFonts } from '../user-fonts.ts';
import type { UserFontsHost } from '../user-fonts.ts';
import { applyChromeBrandVars } from '../brand-vars.ts';
import { confirmDialog, closeConfirmDialogs } from '../components/confirm-dialog.ts';
import { relativeTime } from '../folder-tiles.ts';
import type { HostV1, Profile, AssetRef, ProfileAPI, AssetsAPI, StateEntry } from '../../../../engine/src/bridge/host-v1.ts';
import type { FeatureFlag } from '../feature-flags.ts';

/** A saved session as the web state bridge lists it — StateEntry plus the
 *  export filename and the thumbnail this view renders. */
interface SessionEntry extends StateEntry {
  filename?: string | null;
  thumb?: string | null;
}

/** The slice of the tool-previews cache this view reads. */
interface PreviewsSlice {
  list(): Promise<Array<{ thumb?: string | null }>>;
  size?(): Promise<number>;
  clear(): Promise<unknown>;
}

interface IdentityInfo { provider?: string; email?: string }
interface IdentityStatus {
  enrolled?: boolean;
  identity?: IdentityInfo;
  notBefore?: string;
  notAfter?: string;
  expired?: boolean;
}
interface IdentityAPI {
  status(): Promise<IdentityStatus>;
  enroll(provider: string, opts?: { days?: number; email?: string }): Promise<IdentityStatus>;
  forget(): Promise<unknown>;
  completeEnrollment(token: string): Promise<IdentityStatus>;
}

interface CaHealth { ok?: boolean; devProvider?: boolean; configured?: { github?: boolean; google?: boolean; suse?: boolean; email?: boolean } }

/**
 * The web bridge as this view drives it: HostV1 plus the host-UI-only surface
 * that isn't part of the tool-facing contract. `identity`/`previews` are the
 * concrete web-only APIs (WebHost declares them). The profile setter, the
 * user-asset helpers and `state.sizes` live on the web bridge at runtime but
 * aren't in the shared HostV1 types, so they're modelled as optional here (and
 * asserted present at the call sites, which only ever run in the web shell —
 * this keeps main.ts's `mountProfile(view, WebHost)` call type-correct).
 */
interface ProfileHost extends HostV1 {
  profile: ProfileAPI & {
    set?(profile: Profile): Promise<void>;
    bust?(): void;
  };
  assets: AssetsAPI & {
    _deleteUserAsset?(id: string): Promise<unknown>;
    _listUserAssets?(): Promise<AssetRef[]>;
    _uploadUserAsset?(record: Record<string, unknown>): Promise<void>;
    _blobCacheSize?(): Promise<number>;
    _userAssetsSize?(): Promise<number>;
  };
  state: {
    save(slot: string, data: object): Promise<void>;
    load(slot: string): Promise<object | null>;
    list(): Promise<SessionEntry[]>;
    delete(slot: string): Promise<void>;
    sizes?(): Promise<Record<string, number>>;
  };
  identity: IdentityAPI;
  previews: PreviewsSlice;
}

interface PreviewsMeasure { bytes: number; count: number; available: boolean }
interface StorageModel {
  sessions: { bytes: number; count: number; sizes: Record<string, number>; list: SessionEntry[] };
  images: { bytes: number; count: number; list: AssetRef[] };
  cache: { bytes: number };
  previews: PreviewsMeasure;
  measured: number;
  hasEstimate: boolean;
  usage: number | null;
  quota: number | null;
  overshoot: boolean;
  other: number;
  total: number;
}

// Friendly labels for the raw profile field keys.
const FIELD_LABELS: Record<string, string> = {
  firstname: 'First name', lastname: 'Last name', email: 'Email',
  phone: 'Phone', city: 'City', country: 'Country',
};

// Per-field input semantics — the right keyboard on mobile, native validation
// and autofill where it helps. Anything not listed falls back to a plain text
// input (autocomplete off, as before).
const FIELD_ATTRS: Record<string, Record<string, string>> = {
  firstname: { type: 'text', autocomplete: 'given-name' },
  lastname:  { type: 'text', autocomplete: 'family-name' },
  email:     { type: 'email', inputmode: 'email', autocomplete: 'email' },
  phone:     { type: 'tel', autocomplete: 'tel' },
};
const fieldAttrs = (f: string): string => {
  const a = FIELD_ATTRS[f] ?? { type: 'text', autocomplete: 'off' };
  return Object.entries(a).map(([k, v]) => `${k}="${escape(v)}"`).join(' ');
};

// The headshot lives in the user-assets store under one fixed id (so a new one
// overwrites the old and it only ever occupies a single slot), and is kept out
// of the "My images" library list.
const HEADSHOT_ID = 'user/headshot';

// Randomised word the user must type to confirm the irreversible "clear all my
// data" action — a deliberate speed-bump against an accidental wipe.
const CLEAR_CONFIRM_WORDS = ['lolly', 'open', 'free', 'privacy', 'choice', 'thank you', 'security', 'goodbye'];

// Playful word the user types to confirm the (heavy but SAFE) "export everything AND
// render it all" action. A speed-bump for a big job — potentially many renders + a large
// download — but the mood is celebratory data-ownership, NOT the sombre clear-data gate,
// so the two word pools never overlap. Kept short + lowercase for easy typing.
const HOARD_CONFIRM_WORDS = ['hoard', 'mine', 'stash', 'vault', 'archive', 'homeward', 'liberate', 'agency', 'to the drive', 'own it', 'my data', 'keep it all'];

// Chevron for a collapsible section's summary (rotates 90° when open via CSS).
// Path data lives in lib/icons.ts as 'chevronRight' — was a <polyline>, same shape as
// the (deduped) <path> chevrons in gallery.ts/projects.ts (component-audit rec 5).
const COLLAPSE_CHEV = icon('chevronRight', { size: 16, strokeWidth: 2.5, className: 'profile-collapse-chev' });
const INFO_ICON = icon('info', { size: 14 });
// Shield-with-check — the same glyph the gallery's green Verify button uses (deduped
// against footer-nav.ts's identical NAV_ICONS.shield as 'shieldCheck').
const VERIFY_SHIELD = icon('shieldCheck', { size: 18 });
// Jump to the Verify view — styled to match the gallery's green Verify button.
// A function (not a module const) so t() runs at render time, after the catalog loads.
const verifyLink = (): string => `<a href="#/verify" class="btn identity-verify-link" aria-label="${escape(t('Verify Content Credentials — check any file on-device'))}">${VERIFY_SHIELD}<span>${t('Verify a file')}</span></a>`;
// Compass/gauge glyph — the same one the gallery's Dashboard button uses, for the bottom toolbar.
const DASHBOARD_ICON = icon('dashboard', { size: 18 });

// A small "i" badge with a hover/focus tooltip — used beside storage headings.
// A real <button> (not a tabbable span) so its role + keyboard focus are native.
const infoDot = (text: string): string =>
  `<button type="button" class="info-dot" aria-label="${escape(text)}">i<span class="info-tip" aria-hidden="true">${escape(text)}</span></button>`;

export async function mountProfile(viewEl: HTMLElement, host: ProfileHost, params: string = ''): Promise<void> {
  document.title = 'Profile — Lolly';
  // Only the first-paint-critical reads run upfront. The Storage section's heavy
  // work is deferred to loadStorage() (run when the section is first expanded).
  const profile = await host.profile.get();
  const fields = ['firstname', 'lastname', 'email', 'phone', 'city', 'country'];
  // The theme in force right now (applied at boot from the profile; localStorage
  // is only its FOUC mirror) — seeds the Appearance card's active preview.
  const activeTheme = currentTheme();
  // The headshot is a user asset; re-resolve it (the stored object URL goes stale
  // across reloads).
  const headshotRef = profile.headshot?.id ? await host.assets.get(profile.headshot!.id).catch(() => null) : null;
  let headshotUrl = headshotRef?.url || '';
  const focusParam = new URLSearchParams(params).get('focus');
  const focusFlags = focusParam === 'feature-flags';
  const focusUseDetails = focusParam === 'use-details';
  // Remember which sections were left open, across visits (a UI preference, so it
  // lives in localStorage like the theme — read synchronously before render).
  const OPEN_KEY = 'lolly-profile-open';
  let openState: Record<string, boolean> = {};
  try { openState = JSON.parse(localStorage.getItem(OPEN_KEY) || '{}') || {}; } catch { /* storage blocked */ }
  const startOpen = (id: string) => (openState[id] ? ' open' : '');

  // One toggle row for a feature flag (closes over `profile` for its checked state). Honours
  // a flag's `default` (opt-in flags start off) and shows an (i) explainer when it has `info`.
  const flagRow = (f: FeatureFlag) => `
    <li>
      <label class="feature-flag">
        <span class="feature-flag-label">${escape(t(f.label))}${f.pill ? `<span class="feature-flag-pill">${escape(t(f.pill))}</span>` : ''}${
          f.info ? `<span class="feature-flag-info"><button type="button" class="feature-flag-info-btn" aria-label="${escape(t('About: {label}', { label: t(f.label) }))}">${INFO_ICON}</button><span class="feature-flag-info-pop" role="tooltip">${escape(t(f.info))}</span></span>` : ''
        }</span>
        <input type="checkbox" class="feature-flag-input" data-flag="${escape(f.id)}" ${isFlagOn(profile, f) ? 'checked' : ''}>
        <span class="feature-flag-switch" aria-hidden="true"></span>
      </label>
    </li>`;

  viewEl.innerHTML = `
    <a href="#/" class="tools-home home-full">${t('Tools')}</a>
    <div class="gallery-topbar" style="justify-content:flex-end">
      <div class="gallery-topright">
        ${langFabHtml()}
      </div>
    </div>
    <div class="profile-layout">
      <h1 class="visually-hidden">${t('Your profile')}</h1>

      <section class="profile-card">
        <div class="profile-card-header">
          <h2>${t('Your details')}</h2>
        </div>
        <form class="profile-form" id="profile-form">
          <div class="profile-details-grid">
            <div class="profile-details-main">
              <div class="profile-fields">
                ${fields.map(f => `<label class="profile-field">
                  <span class="profile-field-label">${escape(t(FIELD_LABELS[f] ?? f))}</span>
                  <input ${fieldAttrs(f)} name="${f}" value="${escape((profile as Record<string, unknown>)[f] ?? '')}" placeholder=" ">
                </label>`).join('')}
              </div>

              <div class="profile-actions">
                <button type="submit" class="profile-btn-primary">${t('Save Profile')}</button>
                <label class="profile-check">
                  <span class="profile-check-tag">${t(profile.useDetails ? 'Opted-in' : 'opt-in')}</span>
                  <input type="checkbox" name="useDetails" ${profile.useDetails ? 'checked' : ''}>
                  <span class="profile-check-text">${t(profile.useDetails ? 'Using my details' : 'Use my details to create')}</span>
                </label>
              </div>
            </div>

            <aside class="profile-side">
              <div class="profile-field">
                <span class="profile-field-label headshot-heading">${t('Headshot')}</span>
                <div class="headshot">
                  <div class="headshot-preview${headshotUrl ? '' : ' is-empty'}" id="headshot-preview"${headshotUrl ? ` style="background-image:url('${escape(headshotUrl)}')"` : ''}>
                    <button type="button" class="headshot-edit" id="headshot-upload">${t(headshotUrl ? 'Edit' : 'Upload')}</button>
                  </div>
                  <button type="button" class="headshot-remove" id="headshot-remove" aria-label="${escape(t('Remove headshot'))}" title="${escape(t('Remove'))}"${headshotUrl ? '' : ' hidden'}>&times;</button>
                  <input type="file" id="headshot-file" accept="image/png,image/jpeg,image/webp,image/avif,image/heic,image/heif" hidden>
                </div>
                <p class="profile-inline-error" id="headshot-error" style="color:hsl(var(--destructive));font-size:13px;margin:.4rem 0 0" hidden></p>
              </div>
              <div class="profile-field profile-field--sound">
                ${soundSwitchHtml()}
              </div>
            </aside>
          </div>
        </form>
      </section>

      <section class="profile-card profile-card--appearance">
        <h2>${t('Appearance')}</h2>
        <p class="profile-appearance-sub">${t('How the app dresses for you — your preference, separate from your brand. Applied instantly and remembered on this device.')}</p>
        <div class="profile-theme-grid" data-theme-pick>
          ${THEMES.map(theme => `
            <button type="button" class="profile-theme${theme === activeTheme ? ' is-active' : ''}" data-theme-set="${escape(theme)}" data-theme="${escape(theme)}" aria-pressed="${theme === activeTheme ? 'true' : 'false'}">
              <div class="profile-theme-name">${escape(t(THEME_LABELS[theme]))}${theme === 'light' ? `<span class="profile-theme-pill">${t('default')}</span>` : ''}</div>
              <div class="profile-theme-dots">
                <span style="background:hsl(var(--primary))" title="primary"></span>
                <span style="background:hsl(var(--card))" title="card"></span>
                <span style="background:hsl(var(--accent))" title="accent"></span>
                <span style="background:hsl(var(--muted))" title="muted"></span>
                <span style="background:hsl(var(--foreground))" title="foreground"></span>
              </div>
              <div class="profile-theme-sample">Aa</div>
            </button>`).join('')}
        </div>
      </section>

      <details class="profile-card profile-collapse profile-activity" id="activity-section"${startOpen('activity-section')}>
        <summary class="profile-collapse-summary"><h2>${t('Your activity')}</h2>${COLLAPSE_CHEV}</summary>
        <div class="profile-collapse-body">${renderActivity(getMetrics(), window.__toolIndex?.tools ?? [])}</div>
      </details>

      <details class="profile-card profile-collapse" id="storage-section"${startOpen('storage-section')}>
        <summary class="profile-collapse-summary"><h2>${t('Storage')}</h2>${COLLAPSE_CHEV}</summary>
        <div class="profile-collapse-body" id="storage-body"><p class="storage-hint-text">${t('Loading…')}</p></div>
      </details>

      <details class="profile-card profile-collapse" id="feature-flags-section"${(openState['feature-flags-section'] || focusFlags) ? ' open' : ''}>
        <summary class="profile-collapse-summary"><h2>${t('Feature flags')}</h2>${COLLAPSE_CHEV}</summary>
        <div class="profile-collapse-body">
          <p class="storage-hint-text feature-hint-text">${t('Self-governance, autonomy, choice. Enable or disable parts of the app here')}</p>
          <ul class="feature-flags" id="feature-flags">
            ${CATEGORY_FLAGS.map(f =>
              // Set the on-device Offline Utilities drawer apart from the creative
              // tool categories above it with its own separator.
              (f.category === 'utility' ? '<li class="feature-flag-divider" aria-hidden="true"></li>' : '') + flagRow(f)
            ).join('')}
            <li class="feature-flag-divider" aria-hidden="true"></li>
            ${flagRow(NEUROSPICY_FLAG)}
            ${flagRow(PRO_FLAG)}
            ${flagRow(STRIP_UPLOAD_META_FLAG)}
          </ul>
        </div>
      </details>

      <details class="profile-card profile-collapse" id="identity-section"${startOpen('identity-section')}>
        <summary class="profile-collapse-summary"><h2>${t('Content Credentials')}</h2>${COLLAPSE_CHEV}</summary>
        <div class="profile-collapse-body" id="identity-body"><p class="storage-hint-text">${t('Loading…')}</p></div>
      </details>

    </div>

    <footer class="profile-footer" aria-label="${escape(t('More'))}">
      <a href="#/d" class="profile-nav-link btn" data-sfx="dashboard" aria-label="${escape(t('Dashboard — this device, the brand system & the full feature set'))}">${DASHBOARD_ICON}<span class="profile-nav-label">${t('Dashboard')}</span></a>
      <a href="#/verify" class="profile-nav-link profile-nav-link--verify btn" data-sfx="verify" aria-label="${escape(t('Verify Content Credentials — check any file on-device'))}">${VERIFY_SHIELD}<span class="profile-nav-label">${t('Verify')}</span></a>
    </footer>
  `;

  // Feature flags — auto-save each toggle (a preference, like the theme picker).
  viewEl.querySelector('#feature-flags')?.addEventListener('change', async e => {
    const input = (e.target as Element).closest<HTMLInputElement>('[data-flag]');
    if (!input) return;
    const current = await host.profile.get();
    const flagId = input.dataset.flag!;
    const featureFlags = { ...(current.featureFlags ?? {}), [flagId]: input.checked };
    await host.profile.set!({ ...current, featureFlags });
    // Keep the synchronous mirror in step so the Neurospicy player (rendered in
    // popovers, outside the profile-aware views) reflects the change on next render.
    setFlagMirror(flagId, input.checked);
    // Toggling the Neurospicy feature: silence any loop when turning it off (the UI is
    // gone, so leave no invisible audio), and show/hide the bottom-right dock to match.
    if (flagId === NEUROSPICY_FLAG.id) {
      if (!input.checked) stopNeurospicy();
      syncNeuroDock(host as unknown as Parameters<typeof syncNeuroDock>[0]);
    }
    announce(input.checked ? t('Enabled') : t('Disabled'));
  });

  // Deep-link target: the gallery's empty state links here (#/profile?focus=feature-flags)
  // to nudge re-enabling categories. The section is opened above; scroll it into view.
  if (focusFlags) {
    requestAnimationFrame(() =>
      viewEl.querySelector('#feature-flags-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
    );
  }

  // Deep-link target: the gallery's first-visit personalisation nudge links here
  // (#/profile?focus=use-details). Scroll the "Use my details" opt-in into view and
  // pulse it briefly so the control the nudge promised is easy to find.
  if (focusUseDetails) {
    const optIn = viewEl.querySelector<HTMLElement>('.profile-check');
    requestAnimationFrame(() => {
      optIn?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      optIn?.classList.add('is-focus-pulse');
      setTimeout(() => optIn?.classList.remove('is-focus-pulse'), 2400);
    });
  }

  // Appearance — theme preview cards (moved here from the dashboard). Each preview
  // applies the theme app-wide immediately (applyTheme mirrors to localStorage +
  // updates the PWA chrome colour) and persists it to the profile (canonical). The
  // active preview is flagged; a soft theme cue plays on switch.
  const themePick = viewEl.querySelector<HTMLElement>('[data-theme-pick]');
  themePick?.addEventListener('click', async e => {
    const btn = (e.target as Element).closest<HTMLButtonElement>('[data-theme-set]');
    if (!btn) return;
    const next = btn.dataset.themeSet;
    if (!next || next === currentTheme()) return;
    applyTheme(next);
    playThemeSfx(next);
    // Reflect the new active state across the picker.
    themePick.querySelectorAll<HTMLButtonElement>('[data-theme-set]').forEach(b => {
      const on = b.dataset.themeSet === next;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-pressed', String(on));
    });
    try {
      const updated = { ...(await host.profile.get()), theme: next };
      await host.profile.set?.(updated);
    } catch { /* preference save is best-effort */ }
  });

  // Language FAB menu — same control as gallery/catalog/projects, so switching
  // the language is consistent across views. switchLang saves to profile.lang +
  // localStorage, then reloads so the whole app re-renders in the new language.
  attachLangMenu(viewEl.querySelector<HTMLElement>('.lang-fab'), host);

  // Sound switch — the unified "Sound:" toggle (speaker indicator + sliding switch). Auto-saves
  // each flip to profile.sfxMuted + localStorage and chirps when re-enabled (via applySfxMuted,
  // inside wireSoundSwitch), a preference like the theme picker.
  wireSoundSwitch(viewEl, host as unknown as Parameters<typeof wireSoundSwitch>[1]);

  // Opt-in pill reflects the checkbox state (saved on form submit).
  const useDetailsInput = viewEl.querySelector<HTMLInputElement>('[name="useDetails"]');
  const optInTag = viewEl.querySelector('.profile-check-tag');
  const optInText = viewEl.querySelector('.profile-check-text');
  useDetailsInput?.addEventListener('change', () => {
    const on = useDetailsInput!.checked;
    if (optInTag) optInTag.textContent = on ? t('Opted-in') : t('opt-in');
    if (optInText) optInText.textContent = on ? t('Using my details') : t('Use my details to create');
    // Opting in is the app's most magical moment — a cascade up and back down; opting out is
    // genuinely sad. (The checkbox's press-tick already played via the global click cue.)
    playSfx(on ? 'optIn' : 'optOut');
  });

  // Headshot — upload → circular crop → save as a user asset → store the ref.
  const headshotFileInput = viewEl.querySelector<HTMLInputElement>('#headshot-file');
  const paintHeadshot = (url: string) => {
    headshotUrl = url || '';
    const preview = viewEl.querySelector<HTMLElement>('#headshot-preview');
    if (preview) {
      // Set the image as a background so the overlaid Edit button (and its click
      // listener) is never re-created.
      preview.classList.toggle('is-empty', !headshotUrl);
      preview.style.backgroundImage = headshotUrl ? `url('${headshotUrl}')` : '';
    }
    const uploadBtn = viewEl.querySelector('#headshot-upload');
    if (uploadBtn) uploadBtn.textContent = headshotUrl ? t('Edit') : t('Upload');
    const removeBtn = viewEl.querySelector<HTMLElement>('#headshot-remove');
    if (removeBtn) removeBtn.hidden = !headshotUrl;
  };
  viewEl.querySelector('#headshot-upload')?.addEventListener('click', () => headshotFileInput?.click());
  headshotFileInput?.addEventListener('change', async () => {
    const file = headshotFileInput!.files?.[0];
    headshotFileInput!.value = '';
    if (!file) return;
    const errEl = viewEl.querySelector<HTMLElement>('#headshot-error');
    if (errEl) errEl.hidden = true;
    try {
      const cropped = await openHeadshotCropper(file); // throws on undecodable
      if (!cropped) return; // user cancelled
      const ref = await saveHeadshot(host, cropped.blob);
      paintHeadshot(ref.url);
      await refreshCounter();
    } catch (err) {
      host.log?.('error', 'Headshot save failed', { error: String(err) });
      // Inline + announced, matching the import-dialog error pattern — not a
      // blocking alert(). e.g. the storage-cap message.
      const msg = String((err as { message?: unknown })?.message ?? err);
      if (errEl) { errEl.textContent = msg; errEl.hidden = false; }
      announce(msg, { assertive: true });
    }
  });
  viewEl.querySelector('#headshot-remove')?.addEventListener('click', async () => {
    await host.assets._deleteUserAsset!(HEADSHOT_ID).catch(() => {});
    const current = await host.profile.get();
    delete current.headshot;
    await host.profile.set!(current);
    paintHeadshot('');
    await refreshCounter();
  });

  // Live storage refresh — re-render the Storage meter IF it's loaded. The headshot
  // upload/remove paths change user-asset bytes and call this; it no-ops while the
  // Storage section is still collapsed (loadStorage sets refreshStorageMeter).
  let refreshStorageMeter: (() => Promise<void>) | null = null;
  async function refreshCounter() { if (refreshStorageMeter) await refreshStorageMeter(); }

  // Personal details form
  viewEl.querySelector('#profile-form')!.addEventListener('submit', async e => {
    e.preventDefault();
    const btn = (e.target as HTMLFormElement).querySelector<HTMLButtonElement>('button[type="submit"]');
    const label = btn?.textContent ?? t('Save');
    if (btn) btn.disabled = true;
    const data = Object.fromEntries(new FormData(e.target as HTMLFormElement).entries());
    // Checkboxes aren't reliably in FormData (omitted when unchecked), so read it explicitly.
    const useDetails = (e.target as HTMLFormElement).querySelector<HTMLInputElement>('[name="useDetails"]')?.checked ?? false;
    delete data.useDetails;
    try {
      const current = await host.profile.get();
      // The FormData rows are dynamic string/File pairs; the merged record is a Profile.
      await host.profile.set!({ ...current, ...data, useDetails } as unknown as Profile);
      if (btn) btn.textContent = t('Saved');
      playSfx('saveProfile');   // a warm, lovely "all set" chime on a successful save
      announce(t('Profile saved'));
      // Stay on the page; restore the button shortly after so users can keep editing.
      setTimeout(() => { if (btn) { btn.textContent = label; btn.disabled = false; } }, 1600);
    } catch {
      if (btn) { btn.textContent = label; btn.disabled = false; }
      announce(t("Couldn't save — try again"), { assertive: true });
    }
  });

  // Persist each section's open/closed state across visits.
  for (const id of ['activity-section', 'storage-section', 'feature-flags-section', 'identity-section']) {
    const d = viewEl.querySelector<HTMLDetailsElement>('#' + id);
    d?.addEventListener('toggle', () => {
      openState[id] = d!.open;
      try { localStorage.setItem(OPEN_KEY, JSON.stringify(openState)); } catch { /* storage blocked */ }
    });
  }

  const fontsHost = host as unknown as UserFontsHost;

  // ── Storage: lazy. Fetch the data + render the (heavy) image grid only when the
  // section is first expanded, then wire its handlers. ──────────────────────────
  const storageDetails = viewEl.querySelector<HTMLDetailsElement>('#storage-section');
  let storageLoaded = false;
  // Tool display names + a glyph for sessions saved without a thumbnail.
  const toolNameById = new Map((window.__toolIndex?.tools ?? []).map(t => [t.id, t.name] as [string, string]));
  const toolNameOf = (id: string) => toolNameById.get(id) || id || t('Saved session');
  // 'image' glyph — deduped against catalog-summary.ts's "raster" and valid.ts's
  // ICONS.image (near-identical circle-radius/path-endpoint roundings of the same
  // Lucide "image" icon; component-audit rec 5).
  const SESS_PLACEHOLDER = `<span class="store-sess-thumb is-placeholder" aria-hidden="true">${icon('image', { strokeWidth: 1.8 })}</span>`;
  const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Approximate, theme-agnostic byte formatting (KB/MB/GB) shared by the meter.
  const fmtPct = (usage: number, quota: number | null) => {
    if (!quota) return '0%';
    const p = (usage / quota) * 100;
    if (p < 0.1) return '<0.1%';
    return p < 10 ? `${p.toFixed(1)}%` : `${Math.round(p)}%`;
  };

  // Tool-previews cache: measurable (size()/list()) + clearable. Feature-detected so
  // an older/rebuilt bridge without host.previews just folds its bytes into "Other".
  async function measurePreviews(): Promise<PreviewsMeasure> {
    if (!host.previews?.list) return { bytes: 0, count: 0, available: false };
    try {
      const list = await host.previews.list();
      const bytes = typeof host.previews.size === 'function'
        ? await host.previews.size()
        : list.reduce((n, r) => n + (r?.thumb ? r.thumb.length : 0), 0);
      return { bytes, count: list.length, available: true };
    } catch { return { bytes: 0, count: 0, available: false }; }
  }

  // Read every measurer + the browser's ground-truth estimate into one model. The
  // four measured slices never sum to estimate().usage — the honest remainder is
  // "Other" = max(0, usage − measured), so measured + Other == usage by construction.
  async function measure(): Promise<StorageModel> {
    const estP = navigator.storage?.estimate
      ? navigator.storage.estimate().catch(() => null)
      : Promise.resolve(null);
    const [estimate, sessions, sessionSizes, cacheBytes, allImages, imagesBytes, previews] = await Promise.all([
      estP,
      host.state.list().catch((): SessionEntry[] => []),
      host.state.sizes!().catch((): Record<string, number> => ({})),
      host.assets._blobCacheSize!().catch(() => 0),
      host.assets._listUserAssets!().catch((): AssetRef[] => []),
      host.assets._userAssetsSize!().catch(() => 0),
      measurePreviews(),
    ]);
    const sessBytes = Object.values(sessionSizes).reduce((s, n) => s + n, 0);
    // The grid shows visual uploads only: the headshot is hidden, and the non-visual
    // user assets (brand tokens doc, font faces — managed in the Adjust your brand card)
    // would render as broken tiles. Their bytes stay in the slice either way.
    const VISUAL = new Set(['raster', 'vector', 'video', 'lottie']);
    const imageList = allImages.filter(a => a.id !== HEADSHOT_ID && VISUAL.has(a.type));
    const measured = sessBytes + imagesBytes + cacheBytes + previews.bytes;
    const hasEstimate = !!(estimate && estimate.usage != null);
    const usage: number | null = hasEstimate ? estimate!.usage! : null;
    const quota: number | null = (estimate && estimate.quota) || null;
    const overshoot = hasEstimate && measured > usage!; // estimates are bucketed/approximate
    const other = (hasEstimate && !overshoot) ? Math.max(0, usage! - measured) : 0;
    const total = hasEstimate ? Math.max(usage!, measured) : measured; // the hero number
    return {
      sessions: { bytes: sessBytes, count: sessions.length, sizes: sessionSizes, list: sessions },
      images: { bytes: imagesBytes, count: imageList.length, list: imageList },
      cache: { bytes: cacheBytes },
      previews,
      measured, hasEstimate, usage, quota, overshoot, other, total,
    };
  }

  // The one-read screen-reader overview (the bar itself stays interactive, not role=img).
  function reconciliationSentence(m: StorageModel) {
    const parts = [
      `Saved sessions ${fmtBytes(m.sessions.bytes)}`,
      `My images ${fmtBytes(m.images.bytes)}`,
      `Asset cache ${fmtBytes(m.cache.bytes)}`,
    ];
    if (m.previews.available) parts.push(`Tool previews ${fmtBytes(m.previews.bytes)}`);
    let s = m.hasEstimate
      ? `Using ${fmtBytes(m.total)}: ${parts.join(', ')}`
      : `Measured ${fmtBytes(m.measured)}: ${parts.join(', ')}`;
    if (m.hasEstimate && m.other > 0) s += `, and about ${fmtBytes(m.other)} of other app data and overhead`;
    s += (m.hasEstimate && m.quota) ? ` — ${fmtPct(m.usage!, m.quota)} of your ${fmtBytes(m.quota)} device budget.` : '.';
    return s;
  }

  // One selectable, deletable session row. Largest-first by default.
  function renderSessRow(s: SessionEntry, bytes: number) {
    const isBatch = String(s.slot).startsWith(BATCH_SLOT_PREFIX);
    const label = s.label || s.filename || toolNameOf(s.toolId);
    const thumb = s.thumb
      ? `<img class="store-sess-thumb" src="${escape(s.thumb)}" alt="" loading="lazy">`
      : SESS_PLACEHOLDER;
    return `<li class="store-sess" data-slot="${escape(s.slot)}">
      <input type="checkbox" class="store-sess-check" data-slot="${escape(s.slot)}" aria-label="${escape(t('Select {name}', { name: label }))}">
      ${thumb}
      <span class="store-sess-meta">
        <span class="store-sess-label">${escape(label)}${isBatch ? `<span class="store-sess-tag">${t('batch')}</span>` : ''}</span>
        <span class="store-sess-sub">${escape(toolNameOf(s.toolId))}${s.updatedAt ? ` · ${escape(relativeTime(s.updatedAt))}` : ''}</span>
      </span>
      <span class="session-size">${fmtBytes(bytes)}</span>
      <button type="button" class="store-sess-del" data-del-session="${escape(s.slot)}" aria-label="${escape(t('Delete {name}', { name: label }))}">&#x2715;</button>
    </li>`;
  }
  function sessionRowsHtml(m: StorageModel, sort: string) {
    const sizes = m.sessions.sizes;
    const rows = [...m.sessions.list];
    if (sort === 'recent') rows.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    else rows.sort((a, b) => (sizes[b.slot] || 0) - (sizes[a.slot] || 0));
    if (!rows.length) return `<li class="storage-empty">${t('No saved sessions yet.')}</li>`;
    return rows.map(s => renderSessRow(s, sizes[s.slot] || 0)).join('');
  }

  // The whole section, rendered ONCE. applyMeter() then refreshes only the viz so an
  // open managed list (multi-select state) is never rebuilt out from under the user.
  function renderSection(m: StorageModel, sort: string) {
    const hasPrev = m.previews.available;
    return `
      <section class="store-meter" aria-label="${escape(t('Storage on this device'))}">
        <header class="store-hero">
          <p class="store-hero-num" id="store-hero-num" data-bytes="0">0 KB</p>
          <p class="store-hero-cap">${t('On this device')} ${infoDot(t('The real total this origin uses on this device, measured by your browser. Everything below is on THIS device only — nothing is uploaded.'))}</p>
          <p class="store-headroom" id="store-headroom" hidden></p>
        </header>

        <div class="store-bar" id="store-bar">
          <button type="button" class="seg" data-cat="sessions" style="flex-grow:0"></button>
          <button type="button" class="seg" data-cat="images" style="flex-grow:0"></button>
          <button type="button" class="seg" data-cat="cache" style="flex-grow:0"></button>
          <button type="button" class="seg" data-cat="previews" style="flex-grow:0"${hasPrev ? '' : ' hidden'}></button>
          <span class="seg seg--other" data-cat="other" style="flex-grow:0" aria-hidden="true" hidden></span>
        </div>
        <p class="visually-hidden" id="store-aria-sentence"></p>

        <ul class="store-legend" role="list">
          <li><button type="button" class="store-chip" data-cat="sessions"><span class="store-chip-sw" data-cat="sessions"></span><span class="store-chip-name">${t('Saved sessions')}</span><span class="store-chip-val" data-size="sessions">—</span></button></li>
          <li><button type="button" class="store-chip" data-cat="images"><span class="store-chip-sw" data-cat="images"></span><span class="store-chip-name">${t('My images')}</span><span class="store-chip-val" data-size="images">—</span></button></li>
          <li><button type="button" class="store-chip" data-cat="cache"><span class="store-chip-sw" data-cat="cache"></span><span class="store-chip-name">${t('Asset cache')}</span><span class="store-chip-val" data-size="cache">—</span></button></li>
          ${hasPrev ? `<li><button type="button" class="store-chip" data-cat="previews"><span class="store-chip-sw" data-cat="previews"></span><span class="store-chip-name">${t('Tool previews')}</span><span class="store-chip-val" data-size="previews">—</span></button></li>` : ''}
          ${m.hasEstimate ? `<li><span class="store-chip store-chip--other"><span class="store-chip-sw is-hatch"></span><span class="store-chip-name">${t('Other')}</span><span class="store-chip-val" data-size="other">—</span>${infoDot(t('Your profile, internal indexes, the offline app cache and storage overhead — everything not itemised above. Calculated as total used minus the measured items. Clear it with "Clear all my data" below.'))}</span></li>` : ''}
        </ul>

        <p class="store-quota" id="store-quota" hidden><span class="storage-bar-wrap"><span class="storage-bar-fill" id="store-quota-fill" style="width:0%"></span></span><span class="store-quota-text" id="store-quota-text"></span></p>
        <p class="store-reclaim" id="store-reclaim"></p>
        <p class="store-footnote" id="store-footnote" hidden></p>

        <div class="store-manages">
          <details class="store-manage" data-cat="sessions">
            <summary class="store-manage-sum">${COLLAPSE_CHEV}<span>${t('Saved sessions')}</span> <span class="storage-count" data-count="sessions">0</span> <span class="storage-hint" data-size-hint="sessions">0 KB</span></summary>
            <div class="store-manage-body">
              <div class="store-sess-tools">
                <label class="store-selall"><input type="checkbox" id="sess-selall"> ${t('Select all')}</label>
                <button type="button" class="store-sort" data-sort="${sort}">${sort === 'recent' ? t('Recent ▾') : t('Largest first ▾')}</button>
              </div>
              <ul class="store-sess-list" id="store-sess-list">${sessionRowsHtml(m, sort)}</ul>
              <a class="store-manage-link" href="#/p">${t('Organise in Projects')} →</a>
            </div>
          </details>

          <details class="store-manage" data-cat="images">
            <summary class="store-manage-sum">${COLLAPSE_CHEV}<span>${t('My images')}</span> <span class="storage-count" id="userimg-count">0</span> <span class="storage-hint" id="userimg-size">0 KB</span> ${infoDot(t('Images you save to reuse across tools. This size includes your profile photo and any brand fonts.'))}</summary>
            <div class="store-manage-body">
              <div class="userimg-grid" id="userimg-grid">
                ${m.images.list.map(userImageThumb).join('')}
                <button type="button" class="userimg-add" id="userimg-add" aria-label="${escape(t('Add images'))}">
                  <span class="userimg-add-icon" aria-hidden="true">+</span>
                  <span class="userimg-add-text">${t('Add')}</span>
                </button>
              </div>
              <input type="file" id="userimg-file" accept="image/svg+xml,image/png,image/apng,image/jpeg,image/webp,image/gif,image/avif,image/heic,image/heif,video/mp4,video/webm,.mp4,.webm,.mov" multiple hidden>
              <p class="profile-inline-error" id="userimg-error" style="color:hsl(var(--destructive));font-size:13px;margin:.4rem 0 0" hidden></p>
            </div>
          </details>

          <div class="store-manage store-manage--row" data-cat="cache">
            <span class="store-manage-name">${t('Asset cache')} ${infoDot(t('Downloaded catalog content; it re-downloads on demand. Safe to clear.'))} <span class="storage-count" data-size-label="cache">0 KB</span></span>
            <button type="button" id="clear-cache-btn" class="btn-link-danger">${t('Clear cache')}</button>
          </div>

          ${hasPrev ? `<div class="store-manage store-manage--row" data-cat="previews">
            <span class="store-manage-name">${t('Tool previews')} ${infoDot(t('Snapshots Lolly draws of personalised tool cards — they redraw when needed. Safe to clear.'))} <span class="storage-count" data-size-label="previews">0 KB</span></span>
            <button type="button" id="clear-previews-btn" class="btn-link-danger">${t('Clear previews')}</button>
          </div>` : ''}
        </div>

        <div class="storage-subsection">
          <div class="storage-subsection-header">
            <span>${t('Move to another device')} ${infoDot(t('Export everything — profile, saved sessions, uploaded images and preferences — as one file, then import it on another offline install to pick up exactly where you left off. Stays entirely on your devices.'))}</span>
          </div>
          <div class="storage-actions">
            <button type="button" id="export-data-btn" class="btn" data-sfx="whoosh">${t('Export my data')}</button>
            <button type="button" id="import-data-btn" class="btn">${t('Import data…')}</button>
            <input type="file" id="import-data-input" accept=".zip,application/zip" hidden>
          </div>
          <button type="button" id="export-render-btn" class="btn storage-hoard-btn">📦 ${t('Export my data &amp; render everything')}</button>
          <p class="storage-hoard-hint">${t('The backup above, plus a second zip that <strong>renders every saved session</strong> to its output file — organised into folders that mirror your Projects. A complete offline archive; can be large and slow with many sessions.')}</p>
        </div>

        <div class="storage-actions">
          <button type="button" id="clear-storage-btn" class="btn btn-danger">${t('Clear all my data')}</button>
        </div>

        <div class="store-selbar" id="store-selbar" role="region" aria-live="polite" hidden>
          <span class="store-selbar-count">${t('0 selected')}</span>
          <button type="button" class="btn store-selbar-clear">${t('Clear selection')}</button>
          <button type="button" class="btn btn-danger store-selbar-del">${t('Delete')}</button>
        </div>
      </section>`;
  }

  async function loadStorage() {
    if (storageLoaded) return;
    storageLoaded = true;

    let model = await measure();
    let sessSort = 'size';
    const userImages = [...model.images.list]; // mutable mirror for the grid + lightbox

    const body = viewEl.querySelector<HTMLElement>('#storage-body')!;
    body.innerHTML = renderSection(model, sessSort);
    // Content loaded async after the card opened — cascade it in like the catalog does
    // (silent: the shuffle already played when the section toggled open).
    staggerReveal([...body.children], { sound: false });

    const bar = body.querySelector('#store-bar');
    const heroNum = body.querySelector<HTMLElement>('#store-hero-num');
    const selbar = body.querySelector<HTMLElement>('#store-selbar');
    const setText = (sel: string, text: string) => body.querySelectorAll(sel).forEach(e => { e.textContent = text; });

    // Hero count-up — cosmetic; set instantly under reduced-motion OR a hidden tab
    // (rAF is paused when document.hidden, so the final value must land immediately).
    function countUp(el: HTMLElement | null, to: number) {
      if (!el) return;
      const from = Number(el.dataset.bytes || 0);
      el.dataset.bytes = String(to);
      if (reduceMotion() || document.hidden || from === to) { el.textContent = fmtBytes(to); return; }
      const dur = 600; let t0: number | null = null;
      const tick = (now: number) => {
        if (t0 == null) t0 = now;
        const p = Math.min(1, (now - t0) / dur);
        const eased = 1 - (1 - p) ** 3;
        el.textContent = fmtBytes(Math.round(from + (to - from) * eased));
        if (p < 1) requestAnimationFrame(tick); else el.textContent = fmtBytes(to);
      };
      requestAnimationFrame(tick);
    }

    const selectedSessionBytes = () => {
      let n = 0;
      body.querySelectorAll<HTMLElement>('.store-sess-check:checked').forEach(c => { n += model.sessions.sizes[c.dataset.slot!] || 0; });
      return n;
    };
    function updateReclaim(m: StorageModel) {
      const el = body.querySelector('#store-reclaim');
      if (el) el.innerHTML = t('Up to <strong>{n}</strong> can be freed here', { n: fmtBytes(m.cache.bytes + m.previews.bytes + selectedSessionBytes()) });
    }

    // Refresh ONLY the visualization (hero, segments, legend, quota, reclaim, aria,
    // manage-summary badges) from a fresh model. Never rebuilds the session list/grid.
    function applyMeter(m: StorageModel) {
      countUp(heroNum, m.hasEstimate ? m.total : m.measured);
      const headroom = body.querySelector<HTMLElement>('#store-headroom');
      if (headroom) {
        if (m.hasEstimate && m.quota) {
          const used = m.usage! / m.quota;
          const phrase = used < 0.5 ? t('lots of room left') : used < 0.8 ? t('plenty of room left') : used < 0.95 ? t('getting full') : t('almost full');
          headroom.textContent = t('Using {pct} of your {quota} device budget · {phrase}', { pct: fmtPct(m.usage!, m.quota), quota: fmtBytes(m.quota), phrase });
          headroom.hidden = false;
        } else headroom.hidden = true;
      }
      const segs: Array<[string, number, string, boolean]> = [
        ['sessions', m.sessions.bytes, t('Saved sessions'), true],
        ['images', m.images.bytes, t('My images'), true],
        ['cache', m.cache.bytes, t('Asset cache'), true],
        ['previews', m.previews.bytes, t('Tool previews'), m.previews.available],
      ];
      for (const [cat, bytes, label, avail] of segs) {
        const seg = bar?.querySelector<HTMLElement>(`.seg[data-cat="${cat}"]`);
        if (!seg) continue;
        seg.style.flexGrow = String(Math.max(0, bytes));
        seg.hidden = !avail || bytes <= 0;
        seg.setAttribute('aria-label', t('{label}, {size} — manage', { label, size: fmtBytes(bytes) }));
        seg.title = `${label} — ${fmtBytes(bytes)}`;
      }
      const otherSeg = bar?.querySelector<HTMLElement>('.seg--other');
      if (otherSeg) { otherSeg.style.flexGrow = String(m.other); otherSeg.hidden = !(m.hasEstimate && !m.overshoot && m.other > 0); }

      setText('[data-size="sessions"]', fmtBytes(m.sessions.bytes));
      setText('[data-size="images"]', fmtBytes(m.images.bytes));
      setText('[data-size="cache"]', fmtBytes(m.cache.bytes));
      setText('[data-size="previews"]', fmtBytes(m.previews.bytes));
      setText('[data-size="other"]', `~${fmtBytes(m.other)}`);
      setText('[data-count="sessions"]', String(m.sessions.count));
      setText('[data-size-hint="sessions"]', fmtBytes(m.sessions.bytes));
      setText('[data-size-label="cache"]', fmtBytes(m.cache.bytes));
      setText('[data-size-label="previews"]', fmtBytes(m.previews.bytes));
      const imgCount = body.querySelector('#userimg-count');
      const imgSize = body.querySelector('#userimg-size');
      if (imgCount) imgCount.textContent = `${m.images.count}`;
      if (imgSize) imgSize.textContent = fmtBytes(m.images.bytes);

      const quotaRow = body.querySelector<HTMLElement>('#store-quota');
      const fill = body.querySelector<HTMLElement>('#store-quota-fill');
      const quotaText = body.querySelector('#store-quota-text');
      if (m.hasEstimate && m.quota) {
        if (fill) fill.style.width = `${Math.min(100, (m.usage! / m.quota) * 100)}%`;
        if (quotaText) quotaText.innerHTML = t('{used} of {quota} device budget · <strong>{pct}</strong> used', { used: fmtBytes(m.usage!), quota: fmtBytes(m.quota), pct: fmtPct(m.usage!, m.quota) });
        if (quotaRow) quotaRow.hidden = false;
      } else if (quotaRow) quotaRow.hidden = true;

      const note = body.querySelector<HTMLElement>('#store-footnote');
      if (note) {
        if (!m.hasEstimate) { note.textContent = t('Device total unavailable — showing measured items only.'); note.hidden = false; }
        else if (m.overshoot) { note.textContent = t("Measured items meet or exceed the browser's estimate (estimates are approximate)."); note.hidden = false; }
        else note.hidden = true;
      }
      const aria = body.querySelector('#store-aria-sentence');
      if (aria) aria.textContent = reconciliationSentence(m);
      updateReclaim(m);
    }

    // Explore: a legend chip / bar segment isolates its slice and opens + scrolls to
    // that category's manage panel. Re-clicking the active one clears the highlight.
    function exploreCategory(cat: string) {
      const next = bar?.getAttribute('data-active') === cat ? '' : cat;
      if (bar) {
        if (next) bar.setAttribute('data-active', next); else bar.removeAttribute('data-active');
        bar.querySelectorAll<HTMLElement>('.seg').forEach(s => s.classList.toggle('is-active', !!next && s.dataset.cat === next));
      }
      body.querySelectorAll<HTMLElement>('.store-chip').forEach(c => c.classList.toggle('is-active', !!next && c.dataset.cat === next));
      if (!next) return;
      const panel = body.querySelector<HTMLElement>(`.store-manage[data-cat="${cat}"]`);
      if (panel) {
        if (panel.tagName === 'DETAILS') (panel as HTMLDetailsElement).open = true;
        panel.scrollIntoView({ block: 'start', behavior: reduceMotion() ? 'auto' : 'smooth' });
      }
    }

    const ensureSessEmptyState = () => {
      const list = body.querySelector('#store-sess-list');
      if (list && !list.querySelector('.store-sess')) list.innerHTML = `<li class="storage-empty">${t('No saved sessions yet.')}</li>`;
    };
    function syncSelbar() {
      const checked = [...body.querySelectorAll<HTMLElement>('.store-sess-check:checked')];
      if (selbar) {
        selbar.hidden = checked.length === 0;
        let bytes = 0; checked.forEach(c => bytes += model.sessions.sizes[c.dataset.slot!] || 0);
        const cnt = selbar.querySelector('.store-selbar-count');
        if (cnt) cnt.textContent = t('{n} selected · {size}', { n: checked.length, size: fmtBytes(bytes) });
      }
      // Reserve space so the fixed bar never covers the section's bottom controls (mobile).
      body.querySelector('.store-meter')?.classList.toggle('has-selbar', checked.length > 0);
      const all = body.querySelector<HTMLInputElement>('#sess-selall');
      const boxes = [...body.querySelectorAll('.store-sess-check')];
      if (all) all.checked = boxes.length > 0 && checked.length === boxes.length;
      updateReclaim(model);
    }

    async function refreshMeter() { model = await measure(); applyMeter(model); }

    // The confirm modal restores focus to the (now-removed) delete control on close, so
    // after a deletion move focus to a surviving control — else keyboard/SR users drop to
    // <body> and have to re-traverse the page.
    function focusSurvivingSession(preferred?: HTMLElement | null) {
      const t = (preferred && document.contains(preferred) && preferred)
        || body.querySelector<HTMLElement>('.store-sess-del')
        || body.querySelector<HTMLElement>('.store-sort')
        || body.querySelector<HTMLElement>('.store-manage[data-cat="sessions"] > summary');
      t?.focus?.();
    }

    async function deleteOneSession(slot: string, btn: HTMLButtonElement) {
      const bytes = model.sessions.sizes[slot] || 0;
      const row = [...body.querySelectorAll<HTMLElement>('.store-sess')].find(r => r.dataset.slot === slot);
      const label = row?.querySelector('.store-sess-label')?.textContent || t('this session');
      const ok = await confirmDialog({
        title: t('Delete this session?'),
        message: bytes
          ? t('"{name}" will be permanently removed from this device, freeing about {size}. This cannot be undone.', { name: label, size: fmtBytes(bytes) })
          : t('"{name}" will be permanently removed from this device. This cannot be undone.', { name: label }),
        confirmLabel: t('Delete'),
      });
      if (!ok) return;
      // The next/previous row's delete button is the natural landing spot post-removal.
      const nextFocus = (row?.nextElementSibling || row?.previousElementSibling)?.querySelector?.('.store-sess-del') as HTMLElement | null | undefined;
      btn.disabled = true;
      try { await host.state.delete(slot); }
      catch (err) { host.log?.('error', 'Session delete failed', { slot, error: String(err) }); btn.disabled = false; return; }
      row?.remove();
      ensureSessEmptyState();
      syncSelbar();
      focusSurvivingSession(nextFocus);
      await refreshMeter();
      announce(t('Freed {freed} — {used} used', { freed: fmtBytes(bytes), used: fmtBytes(model.hasEstimate ? model.total : model.measured) }));
    }

    async function deleteSelectedSessions(btn: HTMLButtonElement) {
      const checked = [...body.querySelectorAll<HTMLElement>('.store-sess-check:checked')];
      if (!checked.length) return;
      const slots = checked.map(c => c.dataset.slot!);
      let bytes = 0; slots.forEach(s => bytes += model.sessions.sizes[s] || 0);
      const ok = await confirmDialog({
        title: slots.length === 1 ? t('Delete 1 saved session?') : t('Delete {n} saved sessions?', { n: slots.length }),
        message: slots.length === 1
          ? t('This permanently removes it from this device, freeing about {size}. This cannot be undone.', { size: fmtBytes(bytes) })
          : t('This permanently removes them from this device, freeing about {size}. This cannot be undone.', { size: fmtBytes(bytes) }),
        confirmLabel: t('Delete {n}', { n: slots.length }),
      });
      if (!ok) return;
      const prev = btn.textContent; btn.disabled = true; btn.textContent = t('Deleting…');
      // Only splice a row once its delete actually resolves — otherwise a rejected
      // delete leaves a ghost (row gone, but the session still counted by refreshMeter
      // and resurrected on the next sort). Freed bytes are summed from real successes.
      let freed = 0, done = 0;
      for (const slot of slots) {
        try { await host.state.delete(slot); }
        catch (err) { host.log?.('error', 'Session delete failed', { slot, error: String(err) }); continue; }
        freed += model.sessions.sizes[slot] || 0; done++;
        [...body.querySelectorAll<HTMLElement>('.store-sess')].find(r => r.dataset.slot === slot)?.remove();
      }
      btn.textContent = prev; btn.disabled = false;
      ensureSessEmptyState();
      syncSelbar();
      focusSurvivingSession();
      await refreshMeter();
      announce(done === slots.length
        ? (done === 1 ? t('Deleted 1 session — freed {size}', { size: fmtBytes(freed) }) : t('Deleted {n} sessions — freed {size}', { n: done, size: fmtBytes(freed) }))
        : t('Deleted {done} of {total} — freed {size}; some could not be removed', { done, total: slots.length, size: fmtBytes(freed) }));
    }

    function toggleSort(btn: HTMLElement) {
      sessSort = sessSort === 'size' ? 'recent' : 'size';
      btn.dataset.sort = sessSort;
      btn.textContent = sessSort === 'recent' ? t('Recent ▾') : t('Largest first ▾');
      const checked = new Set([...body.querySelectorAll<HTMLElement>('.store-sess-check:checked')].map(c => c.dataset.slot!));
      const list = body.querySelector('#store-sess-list');
      if (list) list.innerHTML = sessionRowsHtml(model, sessSort);
      checked.forEach(slot => {
        const box = [...body.querySelectorAll<HTMLInputElement>('.store-sess-check')].find(c => c.dataset.slot === slot);
        if (box) box.checked = true;
      });
      syncSelbar();
    }

    async function clearRegenerable(btn: HTMLButtonElement, fn: () => Promise<unknown>, doneMsg: string) {
      const prev = btn.textContent; btn.disabled = true; btn.textContent = t('Clearing…');
      try { await fn(); } catch (err) { host.log?.('error', doneMsg, { error: String(err) }); }
      btn.textContent = t('Cleared');
      setTimeout(() => { btn.textContent = prev; btn.disabled = false; }, 1500);
      await refreshMeter();
      announce(doneMsg);
    }

    // ── one delegated click listener (explore / clear / sort / multi-select bar) ──
    body.addEventListener('click', async (e) => {
      const explore = (e.target as Element).closest<HTMLElement>('.store-chip[data-cat], .seg[data-cat]');
      if (explore && explore.dataset.cat !== 'other') { exploreCategory(explore.dataset.cat!); return; }

      const del = (e.target as Element).closest<HTMLButtonElement>('[data-del-session]');
      if (del) { await deleteOneSession(del.dataset.delSession!, del); return; }

      const sortBtn = (e.target as Element).closest<HTMLElement>('.store-sort');
      if (sortBtn) { toggleSort(sortBtn); return; }

      const cacheBtn = (e.target as Element).closest<HTMLButtonElement>('#clear-cache-btn');
      if (cacheBtn) { await clearRegenerable(cacheBtn, () => clearIdbStores(['asset-blob', 'asset-meta']), t('Cleared asset cache')); return; }

      const prevBtn = (e.target as Element).closest<HTMLButtonElement>('#clear-previews-btn');
      if (prevBtn) { await clearRegenerable(prevBtn, () => host.previews?.clear(), t('Cleared tool previews')); return; }

      if ((e.target as Element).closest('.store-selbar-clear')) { body.querySelectorAll<HTMLInputElement>('.store-sess-check').forEach(c => { c.checked = false; }); syncSelbar(); return; }
      const selDel = (e.target as Element).closest<HTMLButtonElement>('.store-selbar-del');
      if (selDel) { await deleteSelectedSessions(selDel); return; }
    });

    // selection checkboxes (incl. select-all) update the floating action bar.
    body.addEventListener('change', (e) => {
      if ((e.target as Element).matches('.store-sess-check')) { syncSelbar(); }
      else if ((e.target as Element).matches('#sess-selall')) {
        const on = (e.target as HTMLInputElement).checked;
        body.querySelectorAll<HTMLInputElement>('.store-sess-check').forEach(c => { c.checked = on; });
        syncSelbar();
      }
    });

    // ── My images — same add/delete/lightbox handlers as before (grid reused). ──
    const userimgAddBtn = body.querySelector<HTMLButtonElement>('#userimg-add');
    async function syncUserImgMeta() {
      await refreshCounter(); // re-measures → applyMeter refreshes the count/size badges + legend + bar
    }
    const userimgFile = body.querySelector<HTMLInputElement>('#userimg-file');
    userimgAddBtn?.addEventListener('click', () => userimgFile?.click());
    userimgFile?.addEventListener('change', async () => {
      const files = [...(userimgFile!.files ?? [])];
      userimgFile!.value = '';
      if (!files.length) return;
      if (userimgAddBtn) userimgAddBtn.disabled = true;
      const imgErr = body.querySelector<HTMLElement>('#userimg-error');
      if (imgErr) imgErr.hidden = true;
      for (const file of files) {
        try {
          // host carries the web-only bridge methods storeUserUpload needs; its
          // exact PickerHost type isn't exported from picker.
          const ref = await storeUserUpload(host as unknown as Parameters<typeof storeUserUpload>[0], file);
          userImages.unshift(ref);
          body.querySelector('#userimg-grid')?.insertAdjacentHTML('afterbegin', userImageThumb(ref));
        } catch (err) {
          host.log?.('error', 'Image upload failed', { name: file.name, error: String(err) });
          const msg = String((err as { message?: unknown })?.message ?? err);
          if (imgErr) { imgErr.textContent = msg; imgErr.hidden = false; }
          announce(msg, { assertive: true });
          break;
        }
      }
      if (userimgAddBtn) userimgAddBtn.disabled = false;
      await syncUserImgMeta();
    });
    body.querySelector('#userimg-grid')?.addEventListener('click', async e => {
      const view = (e.target as Element).closest<HTMLElement>('[data-view-userimg]');
      if (view) {
        const ref = userImages.find(a => a.id === view.dataset.viewUserimg);
        if (ref) openImageLightbox(ref);
        return;
      }
      const btn = (e.target as Element).closest<HTMLButtonElement>('[data-delete-userimg]');
      if (!btn) return;
      const id = btn.dataset.deleteUserimg!;
      btn.disabled = true;
      try { await host.assets._deleteUserAsset!(id); }
      catch (err) { host.log?.('error', 'Failed to delete image', { id, error: String(err) }); btn.disabled = false; return; }
      btn.closest('[data-userimg]')?.remove();
      const i = userImages.findIndex(a => a.id === id);
      if (i !== -1) userImages.splice(i, 1);
      await syncUserImgMeta();
    });

    applyMeter(model);
    refreshStorageMeter = refreshMeter;

    // Clear all — confirmation dialog gated on typing a randomised word, so an
    // irreversible wipe can't be fired by reflex (or a stray double-click).
    viewEl.querySelector('#clear-storage-btn')?.addEventListener('click', () => {
      const word = CLEAR_CONFIRM_WORDS[Math.floor(Math.random() * CLEAR_CONFIRM_WORDS.length)]!;
      const overlay = document.createElement('div');
      overlay.className = 'clear-dialog-overlay';
      overlay.innerHTML = `
        <div class="clear-dialog" role="dialog" aria-modal="true" aria-labelledby="clear-dialog-title">
          <h3 id="clear-dialog-title">${t('Clear all my data?')}</h3>
          <p>${t('This removes your profile, all saved sessions, your uploaded images, and the asset cache. Cannot be undone.')}</p>
          <label class="clear-confirm">
            <span class="clear-confirm-prompt">${t('Type <strong>{word}</strong> to confirm', { word })}</span>
            <input type="text" class="clear-confirm-input" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" aria-label="${escape(t('Type {word} to confirm', { word }))}">
          </label>
          <div class="clear-dialog-actions">
            <button class="btn btn-danger" data-scope="all" data-sfx="byebye" disabled>${t('Clear everything')}</button>
            <button class="btn" data-scope="cancel">${t('Cancel')}</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);

      // Escape-to-dismiss + focus-restore + Tab focus-trap (inert the page behind).
      const opener = document.activeElement;
      let trap: FocusTrap | undefined;
      const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); dismiss(); } };
      const dismiss = () => {
        trap?.release();
        document.removeEventListener('keydown', onKey);
        overlay.remove();
        if (opener instanceof HTMLElement) opener.focus();
      };
      document.addEventListener('keydown', onKey);

      const confirmInput = overlay.querySelector<HTMLInputElement>('.clear-confirm-input')!;
      const clearBtn = overlay.querySelector<HTMLButtonElement>('[data-scope="all"]')!;
      const matches = () => confirmInput.value.trim().toLowerCase() === word;
      confirmInput.addEventListener('input', () => { clearBtn.disabled = !matches(); });
      confirmInput.addEventListener('keydown', e => { if (e.key === 'Enter' && matches()) { e.preventDefault(); clearBtn.click(); } });
      confirmInput.focus();
      trap = trapFocus(overlay);

      overlay.addEventListener('click', async e => {
        const scope = (e.target as Element).closest<HTMLElement>('[data-scope]')?.dataset.scope;
        if (!scope || scope === 'cancel') { dismiss(); return; }
        if (scope === 'all' && !matches()) return; // guard: the word must match

        const btns = overlay.querySelectorAll('button');
        btns.forEach(b => (b.disabled = true));
        clearBtn.textContent = t('Clearing…');

        localStorage.clear();
        sessionStorage.clear();
        await clearIdbStores(['state', 'profile', 'user-assets', 'asset-blob', 'asset-meta']);
        host.profile.bust!();
        applyTheme('light');
        trap?.release();
        document.removeEventListener('keydown', onKey);
        overlay.remove();
        // The bye-bye song is already playing (data-sfx on the confirm button). Land
        // back on the gallery: with the dismissed flag just wiped, the first-run
        // "Welcome to Lolly" greets the clean slate there (unbranded installs only —
        // a locked brand never shows it, see mountGallery). A hard reload (not just
        // a hash change) is required: in-memory singletons like the tokens bridge
        // cache (bridge/tokens.ts) only reset on bust(), so a soft nav would keep
        // painting a just-cleared user brand until the next manual refresh.
        window.location.hash = '';
        window.location.reload();
      });
    });

    // Export everything to a portable .zip for carrying to another offline install.
    viewEl.querySelector('#export-data-btn')?.addEventListener('click', async e => {
      const btn = e.currentTarget as HTMLButtonElement;
      const prev = btn.textContent;
      btn.disabled = true;
      btn.textContent = t('Exporting…');
      try {
        // host carries the web-only bridge methods exportBackup needs; its exact
        // BackupHost type isn't exported from data-transfer.
        const { blob, filename, summary } = await exportBackup({ host: host as unknown as Parameters<typeof exportBackup>[0]['host'], storage: localStorage });
        saveBlob(blob, filename);
        announce(t('Exported {sessions} and {images}', {
          sessions: summary.sessions === 1 ? t('1 session') : t('{n} sessions', { n: summary.sessions }),
          images: summary.userAssets === 1 ? t('1 image') : t('{n} images', { n: summary.userAssets }),
        }));
        btn.textContent = t('Exported');
      } catch (err) {
        host.log?.('error', 'Data export failed', { error: String(err) });
        btn.textContent = t('Export failed');
      }
      setTimeout(() => { btn.textContent = prev; btn.disabled = false; }, 1800);
    });

    // Export EVERYTHING and render it all: the portable backup (as above) AND a second zip
    // that renders every saved session to its output file, in a folder tree mirroring the
    // Projects view. It's non-destructive but potentially big/slow, so it's gated behind a
    // celebratory type-a-word confirm (a distinct, upbeat word pool from the clear-data gate).
    viewEl.querySelector('#export-render-btn')?.addEventListener('click', () => {
      const word = HOARD_CONFIRM_WORDS[Math.floor(Math.random() * HOARD_CONFIRM_WORDS.length)]!;
      const overlay = document.createElement('div');
      overlay.className = 'clear-dialog-overlay';
      overlay.innerHTML = `
        <div class="clear-dialog clear-dialog--hoard" role="dialog" aria-modal="true" aria-labelledby="hoard-dialog-title">
          <h3 id="hoard-dialog-title">${t('Export everything — and render it all?')}</h3>
          <p>${t('Downloads a full <strong>backup</strong> of your data, then a <strong>rendered archive</strong> — every saved session output to its file, in folders that mirror your Projects. Nothing is deleted. A big library makes a big zip and can take a while.')}</p>
          <label class="clear-confirm">
            <span class="clear-confirm-prompt">${t('Type <strong>{word}</strong> to confirm', { word: escape(word) })}</span>
            <input type="text" class="clear-confirm-input" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" aria-label="${escape(t('Type {word} to confirm', { word }))}">
          </label>
          <div class="clear-dialog-actions">
            <button class="btn btn-go" data-scope="go" disabled>${t('Hoard it all 📦')}</button>
            <button class="btn" data-scope="cancel">${t('Cancel')}</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);

      // Escape-to-dismiss + focus-restore + Tab focus-trap, mirroring the clear-all dialog above.
      const opener = document.activeElement;
      let trap: FocusTrap | undefined;
      const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); dismiss(); } };
      const dismiss = () => { trap?.release(); document.removeEventListener('keydown', onKey); overlay.remove(); if (opener instanceof HTMLElement) opener.focus(); };
      document.addEventListener('keydown', onKey);

      const confirmInput = overlay.querySelector<HTMLInputElement>('.clear-confirm-input')!;
      const goBtn = overlay.querySelector<HTMLButtonElement>('[data-scope="go"]')!;
      const matches = () => confirmInput.value.trim().toLowerCase() === word;
      confirmInput.addEventListener('input', () => { goBtn.disabled = !matches(); });
      confirmInput.addEventListener('keydown', e => { if (e.key === 'Enter' && matches()) { e.preventDefault(); goBtn.click(); } });
      confirmInput.focus();
      trap = trapFocus(overlay);

      overlay.addEventListener('click', async e => {
        const scope = (e.target as Element).closest<HTMLElement>('[data-scope]')?.dataset.scope;
        if (!scope || scope === 'cancel') { dismiss(); return; }
        if (scope === 'go' && !matches()) return; // guard: the word must match
        dismiss();
        await exportAndRenderEverything();
      });
    });

    // Secondary, on-demand gate for motion (video/animated) renders. They record in real
    // time and PAUSE the moment this tab is hidden, so including them is opt-in behind an
    // explicit "I'm willing to keep this tab active" affirmation. Resolves:
    //   'include' → render them (user committed to keeping the tab active)
    //   'skip'    → drop them, render everything else
    //   'cancel'  → abort the render (Escape / backdrop / Cancel)
    // `behind` is dimmed while the choice is open so the progress toast doesn't distract.
    function askKeepTabActive(count: number, behind?: HTMLElement): Promise<'include' | 'skip' | 'cancel'> {
      return new Promise(resolve => {
        const n = count === 1 ? t('1 creation is a video or animation') : t('{n} of your creations are videos or animations', { n: count });
        const overlay = document.createElement('div');
        overlay.className = 'clear-dialog-overlay';
        overlay.innerHTML = `
          <div class="clear-dialog clear-dialog--hoard" role="dialog" aria-modal="true" aria-labelledby="keepactive-title">
            <h3 id="keepactive-title">${t('Keep this tab active?')}</h3>
            <p>${t('{n}. Those record in <strong>real time</strong>, so this browser tab must stay open and in front the whole time they render — switch away and they pause. Include them?', { n: escape(n) })}</p>
            <div class="clear-dialog-actions">
              <button class="btn btn-go" data-choice="include">${t("I'm willing to keep this tab active")}</button>
              <button class="btn" data-choice="skip">${t('Skip videos for now')}</button>
              <button class="btn" data-choice="cancel">${t('Cancel')}</button>
            </div>
          </div>`;
        document.body.appendChild(overlay);
        behind?.classList.add('is-dimmed');
        const opener = document.activeElement;
        let settled = false;
        let trap: FocusTrap | undefined;
        const finish = (choice: 'include' | 'skip' | 'cancel'): void => {
          if (settled) return; settled = true;
          trap?.release();
          document.removeEventListener('keydown', onKey);
          overlay.remove();
          behind?.classList.remove('is-dimmed');
          if (opener instanceof HTMLElement) opener.focus();
          resolve(choice);
        };
        const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') { e.preventDefault(); finish('cancel'); } };
        document.addEventListener('keydown', onKey);
        overlay.addEventListener('click', e => {
          const choice = (e.target as Element).closest<HTMLElement>('[data-choice]')?.dataset.choice;
          if (choice === 'include' || choice === 'skip' || choice === 'cancel') { finish(choice); return; }
          if (e.target === overlay) finish('cancel');   // backdrop
        });
        trap = trapFocus(overlay, { initialFocus: overlay.querySelector<HTMLElement>('[data-choice="include"]') });
      });
    }

    // The two-part export+render job, kicked off once the confirm word matches. Runs in a
    // floating progress toast (torn down by its close button), like the projects view.
    async function exportAndRenderEverything(): Promise<void> {
      // The victorious fanfare fires when the render QUEUE finishes (see runBatchWithProgress),
      // not here at kickoff — so it lands as a genuine "it's all done" reward.
      const toast = document.createElement('div');
      // Top-right so the wait-time quips are readable while a big archive renders (the
      // bottom-right default can sit below the fold on a long, scrolled profile page).
      toast.className = 'pro-toast pro-toast--top';
      toast.innerHTML = `<button type="button" class="pro-toast-close" aria-label="${escape(t('Close'))}">✕</button><div class="pro-toast-mount"><p class="pro-progress-msg"><strong>${t('Preparing your export…')}</strong></p></div>`;
      document.body.appendChild(toast);
      const mount = toast.querySelector<HTMLElement>('.pro-toast-mount')!;
      toast.querySelector('.pro-toast-close')!.addEventListener('click', () => toast.remove());

      const prof = await host.profile.get().catch(() => null);
      const author = prof && (prof as { useDetails?: boolean }).useDetails ? prof : null;

      // 1) Portable data backup (quick) — the same bundle the "Export my data" button makes.
      try {
        const { blob, filename, summary } = await exportBackup({ host: host as unknown as Parameters<typeof exportBackup>[0]['host'], storage: localStorage });
        saveBlob(blob, filename);
        mount.innerHTML = `<p class="pro-progress-msg">${t('<strong>Saved your data backup.</strong> Now rendering every creation…')}</p>`;
        announce(t('Data backup saved: {sessions}, {images}', {
          sessions: summary.sessions === 1 ? t('1 session') : t('{n} sessions', { n: summary.sessions }),
          images: summary.userAssets === 1 ? t('1 image') : t('{n} images', { n: summary.userAssets }),
        }));
      } catch (err) {
        host.log?.('error', 'Data export failed', { error: String(err) });
        mount.innerHTML = `<p class="pro-progress-msg pro-log-err">${t('The data backup failed ({error}). Continuing to the render…', { error: escape(String((err as { message?: unknown })?.message ?? err)) })}</p>`;
      }

      // 2) Render EVERYTHING into one nested zip mirroring the Projects tree: loose
      // (uncategorised) sessions at the top, each top-level folder recursed into subpaths.
      try {
        const [{ createFolderStore, childFolders }, { exportSelectionAsBatch }] = await Promise.all([
          import('../folders.ts'),
          import('../pro/folder-export.ts'),
        ]);
        const store = createFolderStore(host as unknown as Parameters<typeof createFolderStore>[0]);
        const folders = await store.list();
        const entries = await (host.state as unknown as { list(): Promise<Array<{ slot: string }>> }).list().catch(() => []);
        const claimed = new Set(folders.flatMap(f => f.items.filter(i => i.type === 'session').map(i => i.ref)));
        const looseSlots = entries.filter(e => !claimed.has(e.slot)).map(e => e.slot);
        const topLevelIds = childFolders(folders, null).map(f => f.id);
        if (!looseSlots.length && !topLevelIds.length) {
          mount.innerHTML = `<p class="pro-progress-msg">${t('<strong>Backup saved.</strong> You have no saved sessions to render yet — make something first, then come back.')}</p>`;
          return;
        }
        const result = await exportSelectionAsBatch(host as unknown as Parameters<typeof exportSelectionAsBatch>[0], {
          label: prof?.firstname ? `${prof.firstname}'s Lolly` : 'Lolly',
          sessionRefs: looseSlots,
          folderIds: topLevelIds,
          allFolders: folders as unknown as NonNullable<Parameters<typeof exportSelectionAsBatch>[1]>['allFolders'],
          mount,
          author,
          announce,
          // Videos/animations encode in real time (they pause if the tab is hidden), so make
          // them opt-in behind an explicit "I'll keep this tab active" affirmation. Dim the
          // whole toast (not just its mount) while the choice is open — it floats above the
          // dialog's backdrop, so it needs its own dimming.
          onMotionFound: (count) => askKeepTabActive(count, toast),
        });
        // A falsy result means the motion prompt was cancelled — the backup still went out,
        // but nothing was rendered, so say so rather than leaving a stale "rendering…".
        if (!result) {
          mount.innerHTML = `<p class="pro-progress-msg">${t('<strong>Backup saved.</strong> Render cancelled — nothing else was downloaded.')}</p>`;
        }
      } catch (err) {
        mount.innerHTML = `<p class="pro-progress-msg pro-log-err">${t('Render failed: {error}', { error: escape(String((err as { message?: unknown })?.message ?? err)) })}</p>`;
        host.log?.('error', 'Render-everything failed', { error: String(err) });
      }
    }

    // Import a bundle from another install (merge-overwrite), then re-mount.
    const importInput = viewEl.querySelector<HTMLInputElement>('#import-data-input');
    viewEl.querySelector('#import-data-btn')?.addEventListener('click', () => importInput?.click());
    importInput?.addEventListener('change', () => {
      const file = importInput!.files?.[0];
      importInput!.value = ''; // let the same file be re-picked later
      if (!file) return;
      showImportDialog(async () => {
        playSfx('vacuum');   // the data gets sucked in — the mirror of export's whoosh
        const bytes = await file.arrayBuffer();
        const summary = await importBackup({ host: host as unknown as Parameters<typeof importBackup>[0]['host'], storage: localStorage }, bytes);
        host.profile.bust!();
        // The bundle may carry a brand: user tokens + font-face assets restore as
        // plain user assets, so drop the token caches, load the faces into
        // document.fonts and repaint the chrome — same as a fresh boot would.
        (host.tokens as { bust?(): void } | undefined)?.bust?.();
        await registerUserFonts(fontsHost).catch(() => { /* faces load at next boot */ });
        void applyChromeBrandVars(host as unknown as Parameters<typeof applyChromeBrandVars>[0]);
        applyTheme(localStorage.getItem('theme') || 'light');
        // `skipped` > 0 means the bundle came from a newer app and carried parts this
        // build doesn't understand yet — surface it rather than pretend a full restore.
        const skipNote = summary.skipped ? ` · ${summary.skipped === 1 ? t('1 newer item skipped') : t('{n} newer items skipped', { n: summary.skipped })}` : '';
        // Failed restores are surfaced separately (and assertively) — a silently-dropped
        // image would be lost for good once the user discards the source backup.
        const failNote = summary.failedAssets ? ` · ${summary.failedAssets === 1 ? t('1 image couldn’t be restored (storage full?)') : t('{n} images couldn’t be restored (storage full?)', { n: summary.failedAssets })}` : '';
        announce(t('Imported {sessions} and {images}', {
          sessions: summary.sessions === 1 ? t('1 session') : t('{n} sessions', { n: summary.sessions }),
          images: summary.userAssets === 1 ? t('1 image') : t('{n} images', { n: summary.userAssets }),
        }) + skipNote + failNote, summary.failedAssets ? { assertive: true } : undefined);
        await mountProfile(viewEl, host);
      });
    });
  }
  storageDetails?.addEventListener('toggle', () => { if (storageDetails!.open) loadStorage(); });
  // A persisted-open section renders open from the HTML `open` attribute, which does
  // NOT fire `toggle`, so kick the lazy load here (runs after first paint).
  if (storageDetails?.open) loadStorage();

  // ── Content Credentials: lazy, like Storage. The identity bridge (host.identity)
  // holds the device keypair + CA-issued cert; this section only ever shows either
  // a status card ("Signing as …") or the provider buttons + email magic-link form.
  // Everything repaints via body.innerHTML, so the click/submit handlers are
  // delegated once and survive every repaint. ────────────────────────────────────
  const identityDetails = viewEl.querySelector<HTMLDetailsElement>('#identity-section');
  const identityBody = () => viewEl.querySelector<HTMLElement>('#identity-body');
  const PROVIDER_LABELS: Record<string, string> = { suse: 'SUSE (id.suse.com)', github: 'GitHub', google: 'Google', dev: 'Dev', email: 'Email link' };
  let identityStatus: IdentityStatus | null = null;
  // The zero-secret Dev provider is offered only when the CA reports dev mode
  // (health contract: { ok: true, devProvider: boolean }). Memoised per mount.
  let caHealthP: Promise<CaHealth | null> | null = null;
  const caHealth = (): Promise<CaHealth | null> => (caHealthP ??= fetch('/api/ca/health').then(r => r.json()).catch(() => null));

  // Inline + announced, matching the headshot/import error pattern.
  function showIdentityError(msg: string) {
    const el = identityBody()?.querySelector<HTMLElement>('.identity-error');
    if (el) { el.textContent = msg; el.hidden = !msg; }
    if (msg) announce(msg, { assertive: true });
  }

  function renderEnrollForm(health: CaHealth | null) {
    // Show only the providers the deployment has actually configured (from
    // /api/ca/health.configured), so a button never 501s on click — and a newly
    // configured provider appears with no code change. 'dev' rides on devProvider.
    const cfg = health?.configured ?? {};
    const providers: string[] = [
      ...(cfg.github ? ['github'] : []),
      ...(cfg.google ? ['google'] : []),
      ...(cfg.suse ? ['suse'] : []),
      ...(health?.devProvider === true ? ['dev'] : []),
    ];
    return `
      <p class="identity-blurb">${t('Sign exports with a verified identity — a short-lived certificate ties your email to files you export; the key never leaves this device.')} <a href="${docsHref('content-credentials-identity')}" target="_blank" rel="noopener">${t('How it works')}</a></p>
      <label class="identity-days-row">${t('Verified for')}
        <select class="identity-days-select" aria-label="${escape(t('Certificate lifetime'))}">
          <option value="7">${t('7 days')}</option>
          <option value="30" selected>${t('30 days')}</option>
          <option value="90">${t('90 days')}</option>
          <option value="365">${t('365 days')}</option>
        </select>
        <span class="identity-days-hint">${t('— longer keeps exports verified longer; shorter limits misuse if this device is lost. The CA has the final say.')}</span>
      </label>
      <div class="identity-providers">
        ${providers.length
    ? providers.map(p => `<button type="button" class="btn" data-identity-provider="${p}">${escape(PROVIDER_LABELS[p] ?? p)}</button>`).join('')
    : `<p class="storage-hint-text">${t('No sign-in provider is configured on this deployment yet.')}</p>`}
      </div>
      ${verifyLink()}
      <p class="identity-error" role="alert" hidden></p>`;
  }

  function renderIdentityStatus(s: IdentityStatus) {
    const provider = PROVIDER_LABELS[s.identity?.provider as string] ?? s.identity?.provider ?? '';
    const when = s.notAfter ? new Date(s.notAfter).toLocaleDateString() : '';
    const life = s.expired ? (when ? t('expired {date}', { date: when }) : t('expired')) : (when ? t('renews {date}', { date: when }) : '');
    return `
      <div class="identity-status${s.expired ? ' is-expired' : ''}">
        <p class="identity-signing">${t('Signing as <strong>{email}</strong>', { email: escape(s.identity?.email ?? '') })}${provider ? ` <span class="identity-via">${t('via {provider}', { provider: escape(provider) })}</span>` : ''}</p>
        ${life ? `<p class="identity-life">${escape(life)}</p>` : ''}
        <div class="identity-actions">
          <button type="button" class="btn" data-identity-act="renew">${t('Renew')}</button>
          <button type="button" class="btn" data-identity-act="forget">${t('Forget this device')}</button>
        </div>
        ${verifyLink()}
        <p class="identity-error" role="alert" hidden></p>
      </div>`;
  }

  async function paintIdentity() {
    const body = identityBody();
    if (!body) return;
    if (!host.identity) { // bridge feature-detected, like host.previews
      body.innerHTML = `<p class="storage-hint-text">${t("Signing identity isn't available in this build.")}</p>`;
      return;
    }
    try { identityStatus = await host.identity.status(); }
    catch (err) {
      body.innerHTML = `<p class="identity-error" role="alert">${escape(String((err as { message?: unknown })?.message ?? err))}</p>`;
      return;
    }
    body.innerHTML = identityStatus?.enrolled
      ? renderIdentityStatus(identityStatus)
      : renderEnrollForm(await caHealth());
    staggerReveal([...body.children], { sound: false });  // cascade async content (shuffle already played on open)
  }

  // One OAuth/dev enrollment round-trip (popup) from a button, with a busy state.
  // enroll() resolves with the new status, and rejects on timeout/close/denial
  // with a user-presentable Error message. `days` (the 7/30/90/365 lifetime
  // pick) defaults to the form's select when not passed explicitly; the CA
  // clamps it server-side either way.
  async function enrollWith(provider: string, btn: HTMLElement, days?: number) {
    const body = identityBody()!;
    if (!Number.isFinite(days)) days = Number(body.querySelector<HTMLInputElement>('.identity-days-select')?.value);
    showIdentityError('');
    const label = btn.textContent;
    body.querySelectorAll('button').forEach(b => { b.disabled = true; });
    btn.textContent = t('Waiting…');
    try {
      const s = await host.identity!.enroll(provider, { days });
      await paintIdentity();
      announce(t('Enrolled as {who}', { who: s?.identity?.email ?? t('your account') }));
    } catch (err) {
      body.querySelectorAll('button').forEach(b => { b.disabled = false; });
      btn.textContent = label;
      showIdentityError(String((err as { message?: unknown })?.message ?? err));
    }
  }

  // Memoised as a promise (not a boolean) so the magic-link path below can await
  // the same in-flight load instead of racing a second one.
  let identityLoadP: Promise<void> | null = null;
  const loadIdentity = () => (identityLoadP ??= (async () => {
    await paintIdentity();
    const body = identityBody();
    if (!body || !host.identity) return;

    body.addEventListener('click', async (e) => {
      const prov = (e.target as Element).closest<HTMLElement>('[data-identity-provider]');
      if (prov) { await enrollWith(prov.dataset.identityProvider!, prov); return; }
      const act = (e.target as Element).closest<HTMLButtonElement>('[data-identity-act]');
      if (!act) return;
      if (act.dataset.identityAct === 'renew') {
        const provider = identityStatus?.identity?.provider;
        // Renew keeps the lifetime that was chosen last time (derived from the
        // cert window — the status card has no picker; change it via Forget +
        // re-enrol if you want a different duration).
        const prevDays = Math.round((Date.parse(identityStatus?.notAfter as string) - Date.parse(identityStatus?.notBefore as string)) / 86400000);
        // A legacy email (magic-link) identity can no longer renew by email — re-show the
        // enroll form so it re-enrols via a provider instead.
        if (provider === 'email') body.innerHTML = renderEnrollForm(await caHealth());
        else if (provider) await enrollWith(provider, act, [7, 30, 90, 365].includes(prevDays) ? prevDays : undefined);
        return;
      }
      if (act.dataset.identityAct === 'forget') {
        // Low-ceremony confirm: the first click arms the button, a second confirms
        // (it disarms itself after a moment, so a stray click can't linger armed).
        if (act.dataset.confirm !== '1') {
          act.dataset.confirm = '1';
          act.textContent = t('Really forget?');
          act.classList.add('is-confirm');
          setTimeout(() => {
            if (!document.contains(act)) return;
            delete act.dataset.confirm;
            act.textContent = t('Forget this device');
            act.classList.remove('is-confirm');
          }, 4000);
          return;
        }
        act.disabled = true;
        try { await host.identity!.forget(); }
        catch (err) { act.disabled = false; showIdentityError(String((err as { message?: unknown })?.message ?? err)); return; }
        await paintIdentity();
        announce(t('Forgotten — exports on this device sign anonymously again'));
      }
    });

  })());
  identityDetails?.addEventListener('toggle', () => { if (identityDetails!.open) loadIdentity(); });
  if (identityDetails?.open) loadIdentity();

  // The Storage manager opens body-level modals (the shared confirmDialog); tear any
  // down when the router swaps this view out (main.js calls _cleanup) so an orphaned
  // top-layer <dialog> can't block the next view.
  (viewEl as HTMLElement & { _cleanup?: () => void })._cleanup = () => closeConfirmDialogs();
}


function userImageThumb(ref: AssetRef) {
  const name = String(ref.meta?.name ?? t('Image'));
  // SVGs (logos/icons) shouldn't be cropped to fill — show the whole mark.
  const isVector = ref.type === 'vector' || ref.format === 'svg';
  // A lottie's url is JSON (no still image) — show a play-glyph stub, not a broken
  // <img>. Its live preview surface is Layout Studio; here it's just manageable.
  // A video plays itself, muted + looping; gif/apng/animated-webp animate in <img>.
  const media = ref.type === 'lottie'
    ? `<span class="userimg-thumb" style="display:flex;align-items:center;justify-content:center;font-size:2rem;color:var(--text-muted,#789)" aria-hidden="true">▶</span>`
    : ref.type === 'video'
      ? `<video class="userimg-thumb" src="${escape(ref.url)}" muted loop autoplay playsinline preload="metadata"></video>`
      : `<img class="userimg-thumb${isVector ? ' is-vector' : ''}" src="${escape(ref.url)}" alt="${escape(name)}" loading="lazy">`;
  return `
    <div class="userimg-item" data-userimg="${escape(ref.id)}">
      <button type="button" class="userimg-view" data-view-userimg="${escape(ref.id)}" title="${escape(name)}" aria-label="${escape(t('View {name}', { name }))}">
        ${media}
      </button>
      <button type="button" class="userimg-delete" data-delete-userimg="${escape(ref.id)}" title="${escape(t('Delete'))}" aria-label="${escape(t('Delete {name}', { name }))}">&#x2715;</button>
    </div>
  `;
}

// Full-size preview overlay for a user image. Closes on backdrop click, the ✕,
// or Escape. Mirrors the simple overlay pattern used by the clear-data dialog.
function openImageLightbox(ref: AssetRef) {
  const name = ref.meta?.name ?? t('Image');
  const isVector = ref.type === 'vector' || ref.format === 'svg';
  const isLottie = ref.type === 'lottie';
  const isVideo = ref.type === 'video';
  // viewBox-only SVGs report no intrinsic size, so label them "SVG" rather than
  // leaving the dimensions blank.
  const dims = ref.width && ref.height ? `${ref.width} × ${ref.height}` : (isVector ? 'SVG' : (isLottie ? 'Lottie' : (isVideo ? 'Video' : '')));
  // A lottie has no still frame to enlarge — show a play-glyph placeholder instead
  // of a broken <img>. (Placing it in Layout Studio is where it actually plays.)
  // A video plays full-size with controls; gif/apng/animated-webp enlarge as <img>.
  const media = isLottie
    ? `<div class="userimg-lightbox-img" style="display:flex;align-items:center;justify-content:center;min-width:220px;min-height:220px;font-size:5rem;color:var(--text-muted,#789)" aria-hidden="true">▶</div>`
    : isVideo
      ? `<video class="userimg-lightbox-img" src="${escape(ref.url)}" muted loop autoplay playsinline controls></video>`
      : `<img class="userimg-lightbox-img${isVector ? ' is-vector' : ''}" src="${escape(ref.url)}" alt="${escape(name)}">`;

  const overlay = document.createElement('div');
  overlay.className = 'userimg-lightbox-overlay';
  overlay.innerHTML = `
    <div class="userimg-lightbox" role="dialog" aria-modal="true" aria-label="${escape(name)}">
      <button type="button" class="userimg-lightbox-close" aria-label="${escape(t('Close'))}">&#x2715;</button>
      ${media}
      <div class="userimg-lightbox-caption">
        <span class="userimg-lightbox-name">${escape(name)}</span>
        ${dims ? `<span class="userimg-lightbox-dims">${escape(dims)}</span>` : ''}
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  // Return focus to whatever opened the lightbox when it closes.
  const opener = document.activeElement;
  const close = () => {
    document.removeEventListener('keydown', onKey);
    overlay.remove();
    if (opener instanceof HTMLElement) opener.focus();
  };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };

  overlay.addEventListener('click', (e) => {
    // Close when clicking the backdrop or the ✕; ignore clicks on the image itself.
    if (e.target === overlay || (e.target as Element).closest('.userimg-lightbox-close')) close();
  });
  document.addEventListener('keydown', onKey);
  overlay.querySelector<HTMLElement>('.userimg-lightbox-close')?.focus();
}

function clearIdbStores(storeNames: string[]) {
  return new Promise<void>((res, rej) => {
    const req = indexedDB.open('lolly');
    req.onerror = rej;
    req.onsuccess = e => {
      const db = (e.target as IDBOpenDBRequest).result;
      const tx = db.transaction(storeNames.filter(n => [...db.objectStoreNames].includes(n)), 'readwrite');
      tx.oncomplete = () => { db.close(); res(); };
      tx.onerror    = rej;
      storeNames.forEach(n => {
        if ([...db.objectStoreNames].includes(n)) tx.objectStore(n).clear();
      });
    };
  });
}

function fmtBytes(bytes: number) {
  if (!bytes) return '0 KB';
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

// Confirm + run a data import. The action may throw (not a backup, wrong format,
// quota); surface the reason in place and keep the dialog open rather than
// leaving the user guessing.
function showImportDialog(onConfirm: () => Promise<void>) {
  const overlay = document.createElement('div');
  overlay.className = 'clear-dialog-overlay';
  overlay.innerHTML = `
    <div class="clear-dialog" role="dialog" aria-modal="true" aria-labelledby="import-dialog-title">
      <h3 id="import-dialog-title">${t('Import data?')}</h3>
      <p>${t('This loads the profile, saved sessions, images and preferences from the file. Anything with the same name on this device is overwritten; everything else is kept.')}</p>
      <p class="import-error" style="color:hsl(var(--destructive));font-size:13px;margin:0" hidden></p>
      <div class="clear-dialog-actions">
        <button class="btn" data-scope="import">${t('Import')}</button>
        <button class="btn" data-scope="cancel">${t('Cancel')}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  // Escape-to-dismiss + focus-restore + Tab focus-trap (inert the page behind).
  const opener = document.activeElement;
  let trap: FocusTrap | undefined;
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); dismiss(); } };
  const dismiss = () => {
    trap?.release();
    document.removeEventListener('keydown', onKey);
    overlay.remove();
    if (opener instanceof HTMLElement) opener.focus();
  };
  document.addEventListener('keydown', onKey);
  overlay.querySelector<HTMLElement>('[data-scope="import"]')?.focus();
  trap = trapFocus(overlay);

  overlay.addEventListener('click', async e => {
    const scope = (e.target as Element).closest<HTMLElement>('[data-scope]')?.dataset.scope;
    if (!scope) return;
    if (scope === 'cancel') { dismiss(); return; }

    const btns = overlay.querySelectorAll('button');
    const errEl = overlay.querySelector<HTMLElement>('.import-error');
    btns.forEach(b => (b.disabled = true));
    (e.target as HTMLElement).textContent = t('Importing…');
    try {
      await onConfirm();
      trap?.release();  // un-inert before the success re-mount
      document.removeEventListener('keydown', onKey);
      overlay.remove(); // success re-mounts the page; drop the (body-level) overlay
    } catch (err) {
      if (errEl) { errEl.textContent = (err as { message?: string })?.message || t('Import failed.'); errEl.hidden = false; }
      btns.forEach(b => (b.disabled = false));
      (e.target as HTMLElement).textContent = t('Import');
    }
  });
}

// Store the cropped square WebP in the user-assets store (one fixed id, so it
// overwrites) and record the resulting AssetRef on the profile (sans the volatile
// object URL — consumers re-resolve by id). A fresh version each time avoids the
// bridge's id:format:version object-URL cache masking the new image.
async function saveHeadshot(host: ProfileHost, blob: Blob): Promise<AssetRef> {
  const record = {
    id: HEADSHOT_ID, type: 'raster', format: 'webp', blob,
    width: 512, height: 512, version: String(Date.now()),
    meta: { name: 'headshot.webp', tags: ['headshot'] },
  };
  await host.assets._uploadUserAsset!(record);
  const ref = await host.assets.get(HEADSHOT_ID);
  const { source, id, type, format, version, width, height, meta } = ref;
  const current = await host.profile.get();
  await host.profile.set!({ ...current, headshot: { source, id, type, format, version, width, height, meta } as AssetRef });
  return ref;
}
