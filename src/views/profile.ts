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
import { applyTheme, THEMES } from '../theme.ts';
import { playThemeSfx, playSfx } from '../lib/sfx.ts';
import { staggerReveal } from '../lib/reveal.ts';
import { soundSwitchHtml, wireSoundSwitch } from '../components/sound-toggle.ts';
import { BATCH_SLOT_PREFIX } from '../lib/batch-slots.ts';
import { trapFocus, type FocusTrap } from '../lib/focus-trap.ts';
import { escape } from '../utils.ts';
import { announce } from '../a11y.ts';
import { getMetrics } from '../metrics.ts';
import { renderActivity } from '../lib/activity-summary.ts';
import { openHeadshotCropper } from '../components/headshot-cropper.ts';
import { storeUserUpload } from './picker.ts';
import { CATEGORY_FLAGS, PRO_FLAG, flagEnabled } from '../feature-flags.ts';
import { saveBlob } from '../pro/zip.ts';
import { exportBackup, importBackup } from '../data-transfer.ts';
import { exportBrandPack, importBrandPack } from '../brand-transfer.ts';
import {
  listUserFonts, installGoogleFont, removeUserFont, setPrimaryFont, registerUserFonts,
  primaryFontFamily,
} from '../user-fonts.ts';
import type { UserFontsHost, UserFontFamily } from '../user-fonts.ts';
import { POPULAR_FAMILIES } from '../lib/google-fonts.ts';
import { USER_TOKENS_ID } from '../bridge/tokens.ts';
import { applyChromeBrandVars } from '../brand-vars.ts';
import { confirmDialog, closeConfirmDialogs } from '../components/confirm-dialog.ts';
import { relativeTime } from '../folder-tiles.ts';
import { catalogSummaryBody, hydrateCatalogAssets } from '../lib/catalog-summary.ts';
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
const COLLAPSE_CHEV = `<svg class="profile-collapse-chev" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>`;
// Shield-with-check — the same glyph the gallery's green Verify button uses.
const VERIFY_SHIELD = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/></svg>`;
// Jump to the Verify view — styled to match the gallery's green Verify button.
const VERIFY_LINK = `<a href="#/verify" class="btn identity-verify-link" aria-label="Verify Content Credentials — check any file on-device">${VERIFY_SHIELD}<span>Verify a file</span></a>`;
// Compass/gauge glyph — the same one the gallery's Dashboard button uses, for the bottom toolbar.
const DASHBOARD_ICON = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/></svg>`;

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
  const currentTheme = (profile as { theme?: string }).theme ?? localStorage.getItem('theme') ?? 'light';
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

  // One toggle row for a feature flag (closes over `profile` for its checked state).
  const flagRow = (f: FeatureFlag) => `
    <li>
      <label class="feature-flag">
        <span class="feature-flag-label">${escape(f.label)}${f.pill ? `<span class="feature-flag-pill">${escape(f.pill)}</span>` : ''}</span>
        <input type="checkbox" class="feature-flag-input" data-flag="${escape(f.id)}" ${flagEnabled(profile, f.id) ? 'checked' : ''}>
        <span class="feature-flag-switch" aria-hidden="true"></span>
      </label>
    </li>`;

  viewEl.innerHTML = `
    <a href="#/" class="tools-home home-full">Tools</a>
    <div class="profile-layout">
      <h1 class="visually-hidden">Your profile</h1>

      <section class="profile-card">
        <h2>Your details</h2>
        <form class="profile-form" id="profile-form">
          <div class="profile-details-grid">
            <div class="profile-details-main">
              <div class="profile-fields">
                ${fields.map(f => `<label class="profile-field">
                  <span class="profile-field-label">${escape(FIELD_LABELS[f] ?? f)}</span>
                  <input ${fieldAttrs(f)} name="${f}" value="${escape((profile as Record<string, unknown>)[f] ?? '')}" placeholder=" ">
                </label>`).join('')}
              </div>

              <div class="profile-actions">
                <button type="submit" class="profile-btn-primary">Save Profile</button>
                <label class="profile-check">
                  <span class="profile-check-tag">${profile.useDetails ? 'Opted-in' : 'opt-in'}</span>
                  <input type="checkbox" name="useDetails" ${profile.useDetails ? 'checked' : ''}>
                  <span class="profile-check-text">${profile.useDetails ? 'Using my details' : 'Use my details to create'}</span>
                </label>
              </div>
            </div>

            <aside class="profile-side">
              <div class="profile-field">
                <span class="profile-field-label headshot-heading">Headshot</span>
                <div class="headshot">
                  <div class="headshot-preview${headshotUrl ? '' : ' is-empty'}" id="headshot-preview"${headshotUrl ? ` style="background-image:url('${escape(headshotUrl)}')"` : ''}>
                    <button type="button" class="headshot-edit" id="headshot-upload">${headshotUrl ? 'Edit' : 'Upload'}</button>
                  </div>
                  <button type="button" class="headshot-remove" id="headshot-remove" aria-label="Remove headshot" title="Remove"${headshotUrl ? '' : ' hidden'}>&times;</button>
                  <input type="file" id="headshot-file" accept="image/png,image/jpeg,image/webp,image/avif,image/heic,image/heif" hidden>
                </div>
                <p class="profile-inline-error" id="headshot-error" style="color:hsl(var(--destructive));font-size:13px;margin:.4rem 0 0" hidden></p>
              </div>
              <div class="profile-field">
                <span class="profile-field-label">Theme</span>
                <div class="segmented-control" id="theme-picker" role="group" aria-label="Theme">
                  ${THEMES.map(t => `<button type="button" class="segmented-btn" data-theme-value="${t}" aria-pressed="${t === currentTheme}">${escape(t.charAt(0).toUpperCase() + t.slice(1))}</button>`).join('')}
                </div>
              </div>
              <div class="profile-field profile-field--sound">
                ${soundSwitchHtml()}
              </div>
            </aside>
          </div>
        </form>
      </section>

      <section class="profile-card brand-card" id="brand-card" aria-label="Your brand">
        <h2>Your brand</h2>
        <div class="brand-cta-row">
          <p class="brand-status" id="brand-status">Loading…</p>
          <a href="#/start" class="profile-btn-primary brand-setup-link" id="brand-setup-link">Set up your brand →</a>
        </div>

        <div class="brand-fonts">
          <h3 class="brand-subhead">Brand fonts</h3>
          <p class="storage-hint-text">Add any <strong>Google Font</strong> — it downloads to <em>this device</em> (latin faces, a few hundred KB), works fully offline, and renders in the app, your tools and every export. One font is always the <strong>primary</strong> — the face the whole app wears.</p>
          <ul class="brand-font-list" id="brand-font-list" role="list"></ul>
          <form class="brand-font-add" id="brand-font-add">
            <input type="text" id="brand-font-input" list="google-font-list" placeholder="Search Google Fonts — e.g. Inter, Fraunces, Space Grotesk" autocomplete="off" autocapitalize="words" spellcheck="false" aria-label="Google Fonts family name">
            <datalist id="google-font-list">${POPULAR_FAMILIES.map(f => `<option value="${escape(f)}"></option>`).join('')}</datalist>
            <button type="submit" class="btn" id="brand-font-add-btn">Add font</button>
          </form>
          <p class="profile-inline-error" id="brand-font-error" style="color:hsl(var(--destructive));font-size:13px;margin:.4rem 0 0" hidden></p>
        </div>

        <div class="brand-share">
          <h3 class="brand-subhead">Share your brand</h3>
          <p class="storage-hint-text">One file with your design tokens, fonts and theme — send it to anyone and their Lolly wears your brand. Loading a brand file changes the look only; sessions and images stay put.</p>
          <div class="storage-actions">
            <button type="button" id="brand-export-btn" class="btn" data-sfx="whoosh">Export brand file</button>
            <button type="button" id="brand-import-btn" class="btn">Load a brand file…</button>
            <input type="file" id="brand-import-input" accept=".zip,application/zip" hidden>
          </div>
        </div>
      </section>

      <details class="profile-card profile-collapse profile-activity" id="activity-section"${startOpen('activity-section')}>
        <summary class="profile-collapse-summary"><h2>Your activity</h2>${COLLAPSE_CHEV}</summary>
        <div class="profile-collapse-body">${renderActivity(getMetrics(), window.__toolIndex?.tools ?? [])}</div>
      </details>

      <details class="profile-card profile-collapse" id="storage-section"${startOpen('storage-section')}>
        <summary class="profile-collapse-summary"><h2>Storage</h2>${COLLAPSE_CHEV}</summary>
        <div class="profile-collapse-body" id="storage-body"><p class="storage-hint-text">Loading…</p></div>
      </details>

      <details class="profile-card profile-collapse" id="feature-flags-section"${(openState['feature-flags-section'] || focusFlags) ? ' open' : ''}>
        <summary class="profile-collapse-summary"><h2>Feature flags</h2>${COLLAPSE_CHEV}</summary>
        <div class="profile-collapse-body">
          <p class="storage-hint-text feature-hint-text">Self-governance, autonomy, choice. Enable or disable parts of the app here</p>
          <ul class="feature-flags" id="feature-flags">
            ${CATEGORY_FLAGS.map(f =>
              // Set the on-device Offline Utilities drawer apart from the creative
              // tool categories above it with its own separator.
              (f.category === 'utility' ? '<li class="feature-flag-divider" aria-hidden="true"></li>' : '') + flagRow(f)
            ).join('')}
            <li class="feature-flag-divider" aria-hidden="true"></li>
            ${flagRow(PRO_FLAG)}
          </ul>
        </div>
      </details>

      <details class="profile-card profile-collapse" id="identity-section"${startOpen('identity-section')}>
        <summary class="profile-collapse-summary"><h2>Content Credentials</h2>${COLLAPSE_CHEV}</summary>
        <div class="profile-collapse-body" id="identity-body"><p class="storage-hint-text">Loading…</p></div>
      </details>

      <details class="profile-card profile-collapse" id="catalog-section"${startOpen('catalog-section')}>
        <summary class="profile-collapse-summary"><h2>Catalogue</h2>${COLLAPSE_CHEV}</summary>
        <div class="profile-collapse-body">
          <p class="storage-hint-text">What ships in this build — the tools and brand assets synced to this device as data.</p>
          ${catalogSummaryBody(window.__toolIndex?.tools ?? [])}
        </div>
      </details>

    </div>

    <footer class="profile-footer" aria-label="More">
      <a href="#/d" class="profile-nav-link btn" data-sfx="dashboard" aria-label="Dashboard — this device, the brand system &amp; the full feature set">${DASHBOARD_ICON}<span class="profile-nav-label">Dashboard</span></a>
      <a href="#/verify" class="profile-nav-link profile-nav-link--verify btn" data-sfx="verify" aria-label="Verify Content Credentials — check any file on-device">${VERIFY_SHIELD}<span class="profile-nav-label">Verify</span></a>
    </footer>
  `;

  // Feature flags — auto-save each toggle (a preference, like the theme picker).
  viewEl.querySelector('#feature-flags')?.addEventListener('change', async e => {
    const input = (e.target as Element).closest<HTMLInputElement>('[data-flag]');
    if (!input) return;
    const current = await host.profile.get();
    const featureFlags = { ...(current.featureFlags ?? {}), [input.dataset.flag!]: input.checked };
    await host.profile.set!({ ...current, featureFlags });
    announce(`${input.checked ? 'Enabled' : 'Disabled'}`);
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

  // Theme picker
  viewEl.querySelector('#theme-picker')!.addEventListener('click', async e => {
    const btn = (e.target as Element).closest<HTMLElement>('[data-theme-value]');
    if (!btn) return;
    const theme = btn.dataset.themeValue!;
    viewEl.querySelectorAll<HTMLElement>('[data-theme-value]').forEach(b => {
      b.setAttribute('aria-pressed', String(b.dataset.themeValue === theme));
    });
    applyTheme(theme);
    playThemeSfx(theme);
    const updated = { ...(await host.profile.get()), theme };
    await host.profile.set!(updated);
  });

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
    if (optInTag) optInTag.textContent = on ? 'Opted-in' : 'opt-in';
    if (optInText) optInText.textContent = on ? 'Using my details' : 'Use my details to create';
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
    if (uploadBtn) uploadBtn.textContent = headshotUrl ? 'Edit' : 'Upload';
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
    const label = btn?.textContent ?? 'Save';
    if (btn) btn.disabled = true;
    const data = Object.fromEntries(new FormData(e.target as HTMLFormElement).entries());
    // Checkboxes aren't reliably in FormData (omitted when unchecked), so read it explicitly.
    const useDetails = (e.target as HTMLFormElement).querySelector<HTMLInputElement>('[name="useDetails"]')?.checked ?? false;
    delete data.useDetails;
    try {
      const current = await host.profile.get();
      // The FormData rows are dynamic string/File pairs; the merged record is a Profile.
      await host.profile.set!({ ...current, ...data, useDetails } as unknown as Profile);
      if (btn) btn.textContent = 'Saved';
      playSfx('saveProfile');   // a warm, lovely "all set" chime on a successful save
      announce('Profile saved');
      // Stay on the page; restore the button shortly after so users can keep editing.
      setTimeout(() => { if (btn) { btn.textContent = label; btn.disabled = false; } }, 1600);
    } catch {
      if (btn) { btn.textContent = label; btn.disabled = false; }
      announce("Couldn't save — try again", { assertive: true });
    }
  });

  // Persist each section's open/closed state across visits.
  for (const id of ['activity-section', 'storage-section', 'feature-flags-section', 'identity-section', 'catalog-section']) {
    const d = viewEl.querySelector<HTMLDetailsElement>('#' + id);
    d?.addEventListener('toggle', () => {
      openState[id] = d!.open;
      try { localStorage.setItem(OPEN_KEY, JSON.stringify(openState)); } catch { /* storage blocked */ }
    });
  }

  // ── Your brand: the prominent #/start pathway (for anyone who missed the
  // welcome's "make it yours"), the Google-Fonts manager, and the shareable
  // brand pack. Hydrates immediately — it's IDB reads only, and this card is
  // the one that must never hide behind a collapsed section. ───────────────────
  const fontsHost = host as unknown as UserFontsHost;
  const brandErr = viewEl.querySelector<HTMLElement>('#brand-font-error');
  const showBrandError = (msg: string) => {
    if (brandErr) { brandErr.textContent = msg; brandErr.hidden = !msg; }
    if (msg) announce(msg, { assertive: true });
  };

  async function paintBrandStatus(): Promise<void> {
    const statusEl = viewEl.querySelector<HTMLElement>('#brand-status');
    const linkEl = viewEl.querySelector<HTMLElement>('#brand-setup-link');
    if (!statusEl || !linkEl) return;
    let metaId = '';
    try {
      metaId = (await (host.assets as unknown as {
        _findMetaByType?(t: string): Promise<{ id: string } | null>;
      })._findMetaByType?.('tokens'))?.id ?? '';
    } catch { /* discovery unavailable — show the unbranded pathway */ }
    if (metaId === USER_TOKENS_ID) {
      statusEl.innerHTML = 'Your brand is installed — every tool, page and export wears it.';
      linkEl.textContent = 'Adjust your brand →';
    } else if (metaId) {
      statusEl.innerHTML = 'Running the catalogue’s built-in brand. Derive your own from a single colour — it takes a minute and stays on this device.';
      linkEl.textContent = 'Set up your brand →';
    } else {
      statusEl.innerHTML = 'This install is unbranded. Pick one colour and Lolly derives the ramps, themes and every semantic slot — <strong>make it yours</strong>.';
      linkEl.textContent = 'Set up your brand →';
    }
  }

  function fontRowHtml(f: UserFontFamily): string {
    return `
      <li class="brand-font-row${f.primary ? ' is-primary' : ''}" data-font-family="${escape(f.family)}">
        <span class="brand-font-specimen" style="font-family:'${escape(f.family)}'" aria-hidden="true">Aa</span>
        <span class="brand-font-meta">
          <span class="brand-font-name" style="font-family:'${escape(f.family)}'">${escape(f.family)}</span>
          <span class="brand-font-sub">${escape(f.weights)} · ${fmtBytes(f.bytes)}</span>
        </span>
        ${f.primary
    ? '<span class="brand-font-primary-badge">Primary</span>'
    : `<button type="button" class="btn brand-font-make-primary" data-make-primary="${escape(f.family)}">Make primary</button>`}
        <button type="button" class="brand-font-del" data-del-font="${escape(f.family)}" aria-label="Remove ${escape(f.family)}">&#x2715;</button>
      </li>`;
  }

  let fontFamilies: UserFontFamily[] = [];
  async function paintFontList(): Promise<void> {
    const list = viewEl.querySelector<HTMLElement>('#brand-font-list');
    if (!list) return;
    fontFamilies = await listUserFonts(fontsHost).catch(() => []);
    // There is always exactly one primary. When it isn't one of the added fonts
    // — the active brand's own font token (e.g. SUSE) or the platform default —
    // show it as a fixed row so the "primary" story never has a hole in it.
    const rows: string[] = [];
    if (!fontFamilies.some(f => f.primary)) {
      const builtin = await primaryFontFamily(fontsHost).catch(() => '');
      rows.push(`
        <li class="brand-font-row is-primary is-builtin">
          <span class="brand-font-specimen" style="font-family:'${escape(builtin || 'Outfit')}'" aria-hidden="true">Aa</span>
          <span class="brand-font-meta">
            <span class="brand-font-name">${escape(builtin || 'Outfit')}</span>
            <span class="brand-font-sub">${builtin ? 'built-in brand font' : 'platform default'}</span>
          </span>
          <span class="brand-font-primary-badge">Primary</span>
        </li>`);
    }
    rows.push(...fontFamilies.map(fontRowHtml));
    if (!fontFamilies.length) {
      rows.push('<li class="brand-font-empty">No fonts added yet — pick any Google Font below to make it yours.</li>');
    }
    list.innerHTML = rows.join('');
  }
  void paintBrandStatus();
  void paintFontList();

  // Add a family — the module downloads it, stores the faces as user assets,
  // registers them, and auto-primaries the first font.
  viewEl.querySelector<HTMLFormElement>('#brand-font-add')?.addEventListener('submit', async e => {
    e.preventDefault();
    const input = viewEl.querySelector<HTMLInputElement>('#brand-font-input');
    const btn = viewEl.querySelector<HTMLButtonElement>('#brand-font-add-btn');
    const family = input?.value.trim();
    if (!family || !btn || !input) return;
    showBrandError('');
    const prev = btn.textContent;
    btn.disabled = true; input.disabled = true;
    btn.textContent = 'Downloading…';
    try {
      const fam = await installGoogleFont(fontsHost, family);
      input.value = '';
      playSfx('saveProfile');
      await paintFontList();
      await paintBrandStatus(); // a first font installs user tokens → branded
      await refreshCounter();   // the faces live in user storage — remeter
      announce(`Added ${fam.family}${fam.primary ? ' as your primary font' : ''} — stored on this device`);
    } catch (err) {
      showBrandError(String((err as { message?: unknown })?.message ?? err));
    }
    btn.textContent = prev; btn.disabled = false; input.disabled = false;
    input.focus();
  });

  // Make-primary / remove, delegated (rows repaint wholesale).
  viewEl.querySelector('#brand-font-list')?.addEventListener('click', async e => {
    const make = (e.target as Element).closest<HTMLButtonElement>('[data-make-primary]');
    if (make) {
      make.disabled = true;
      try {
        await setPrimaryFont(fontsHost, make.dataset.makePrimary!);
        await paintFontList();
        await paintBrandStatus();
        announce(`${make.dataset.makePrimary} is now your primary font`);
      } catch (err) { make.disabled = false; showBrandError(String((err as { message?: unknown })?.message ?? err)); }
      return;
    }
    const del = (e.target as Element).closest<HTMLButtonElement>('[data-del-font]');
    if (!del) return;
    const fam = fontFamilies.find(f => f.family === del.dataset.delFont);
    if (!fam) return;
    const ok = await confirmDialog({
      title: `Remove ${fam.family}?`,
      message: `Its font files (${fmtBytes(fam.bytes)}) are deleted from this device${fam.primary ? ' and the next font (or the platform default) becomes primary' : ''}. You can re-add it any time.`,
      confirmLabel: 'Remove',
    });
    if (!ok) return;
    del.disabled = true;
    try {
      await removeUserFont(fontsHost, fam);
      await paintFontList();
      await refreshCounter();
      announce(`Removed ${fam.family}`);
    } catch (err) { del.disabled = false; showBrandError(String((err as { message?: unknown })?.message ?? err)); }
  });

  // Export the brand pack (tokens + fonts + theme) as one shareable zip.
  viewEl.querySelector('#brand-export-btn')?.addEventListener('click', async e => {
    const btn = e.currentTarget as HTMLButtonElement;
    const prev = btn.textContent;
    btn.disabled = true; btn.textContent = 'Exporting…';
    try {
      const { blob, filename, summary } = await exportBrandPack(
        { host: host as unknown as Parameters<typeof exportBrandPack>[0]['host'], storage: localStorage });
      saveBlob(blob, filename);
      btn.textContent = 'Exported';
      announce(`Brand exported — ${summary.tokens ? 'tokens, ' : ''}${summary.fontFamilies} font ${summary.fontFamilies === 1 ? 'family' : 'families'}`);
    } catch (err) {
      host.log?.('error', 'Brand export failed', { error: String(err) });
      btn.textContent = 'Export failed';
      showBrandError(String((err as { message?: unknown })?.message ?? err));
    }
    setTimeout(() => { btn.textContent = prev; btn.disabled = false; }, 1800);
  });

  // Load someone else's brand pack. Merge-only; sessions/images untouched.
  const brandImportInput = viewEl.querySelector<HTMLInputElement>('#brand-import-input');
  viewEl.querySelector('#brand-import-btn')?.addEventListener('click', () => brandImportInput?.click());
  brandImportInput?.addEventListener('change', async () => {
    const file = brandImportInput!.files?.[0];
    brandImportInput!.value = '';
    if (!file) return;
    showBrandError('');
    const btn = viewEl.querySelector<HTMLButtonElement>('#brand-import-btn');
    const prev = btn?.textContent ?? '';
    if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }
    try {
      const summary = await importBrandPack(
        { host: host as unknown as Parameters<typeof importBrandPack>[0]['host'], storage: localStorage },
        await file.arrayBuffer());
      applyTheme(localStorage.getItem('theme') || 'light');
      playSfx('optIn');
      await paintFontList();
      await paintBrandStatus();
      await refreshCounter();
      const failNote = summary.failedFonts ? ` · ${summary.failedFonts} font file${summary.failedFonts === 1 ? '' : 's'} couldn’t be stored` : '';
      announce(`Brand loaded — ${summary.fontFamilies} font ${summary.fontFamilies === 1 ? 'family' : 'families'}${summary.tokens ? ', tokens installed' : ''}${failNote}`, summary.failedFonts ? { assertive: true } : undefined);
    } catch (err) {
      showBrandError(String((err as { message?: unknown })?.message ?? err));
    }
    if (btn) { btn.textContent = prev; btn.disabled = false; }
  });

  // ── Storage: lazy. Fetch the data + render the (heavy) image grid only when the
  // section is first expanded, then wire its handlers. ──────────────────────────
  const storageDetails = viewEl.querySelector<HTMLDetailsElement>('#storage-section');
  let storageLoaded = false;
  // Tool display names + a glyph for sessions saved without a thumbnail.
  const toolNameById = new Map((window.__toolIndex?.tools ?? []).map(t => [t.id, t.name] as [string, string]));
  const toolNameOf = (id: string) => toolNameById.get(id) || id || 'Saved session';
  const SESS_PLACEHOLDER = `<span class="store-sess-thumb is-placeholder" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="1.5"/><path d="m21 15-4.5-4.5L7 21"/></svg></span>`;
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
    // user assets (brand tokens doc, font faces — managed in the Your brand card)
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
      <input type="checkbox" class="store-sess-check" data-slot="${escape(s.slot)}" aria-label="Select ${escape(label)}">
      ${thumb}
      <span class="store-sess-meta">
        <span class="store-sess-label">${escape(label)}${isBatch ? '<span class="store-sess-tag">batch</span>' : ''}</span>
        <span class="store-sess-sub">${escape(toolNameOf(s.toolId))}${s.updatedAt ? ` · ${escape(relativeTime(s.updatedAt))}` : ''}</span>
      </span>
      <span class="session-size">${fmtBytes(bytes)}</span>
      <button type="button" class="store-sess-del" data-del-session="${escape(s.slot)}" aria-label="Delete ${escape(label)}">&#x2715;</button>
    </li>`;
  }
  function sessionRowsHtml(m: StorageModel, sort: string) {
    const sizes = m.sessions.sizes;
    const rows = [...m.sessions.list];
    if (sort === 'recent') rows.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    else rows.sort((a, b) => (sizes[b.slot] || 0) - (sizes[a.slot] || 0));
    if (!rows.length) return `<li class="storage-empty">No saved sessions yet.</li>`;
    return rows.map(s => renderSessRow(s, sizes[s.slot] || 0)).join('');
  }

  // The whole section, rendered ONCE. applyMeter() then refreshes only the viz so an
  // open managed list (multi-select state) is never rebuilt out from under the user.
  function renderSection(m: StorageModel, sort: string) {
    const hasPrev = m.previews.available;
    return `
      <section class="store-meter" aria-label="Storage on this device">
        <header class="store-hero">
          <p class="store-hero-num" id="store-hero-num" data-bytes="0">0 KB</p>
          <p class="store-hero-cap">On this device ${infoDot('The real total this origin uses on this device, measured by your browser. Everything below is on THIS device only — nothing is uploaded.')}</p>
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
          <li><button type="button" class="store-chip" data-cat="sessions"><span class="store-chip-sw" data-cat="sessions"></span><span class="store-chip-name">Saved sessions</span><span class="store-chip-val" data-size="sessions">—</span></button></li>
          <li><button type="button" class="store-chip" data-cat="images"><span class="store-chip-sw" data-cat="images"></span><span class="store-chip-name">My images</span><span class="store-chip-val" data-size="images">—</span></button></li>
          <li><button type="button" class="store-chip" data-cat="cache"><span class="store-chip-sw" data-cat="cache"></span><span class="store-chip-name">Asset cache</span><span class="store-chip-val" data-size="cache">—</span></button></li>
          ${hasPrev ? `<li><button type="button" class="store-chip" data-cat="previews"><span class="store-chip-sw" data-cat="previews"></span><span class="store-chip-name">Tool previews</span><span class="store-chip-val" data-size="previews">—</span></button></li>` : ''}
          ${m.hasEstimate ? `<li><span class="store-chip store-chip--other"><span class="store-chip-sw is-hatch"></span><span class="store-chip-name">Other</span><span class="store-chip-val" data-size="other">—</span>${infoDot('Your profile, internal indexes, the offline app cache and storage overhead — everything not itemised above. Calculated as total used minus the measured items. Clear it with "Clear all my data" below.')}</span></li>` : ''}
        </ul>

        <p class="store-quota" id="store-quota" hidden><span class="storage-bar-wrap"><span class="storage-bar-fill" id="store-quota-fill" style="width:0%"></span></span><span class="store-quota-text" id="store-quota-text"></span></p>
        <p class="store-reclaim" id="store-reclaim"></p>
        <p class="store-footnote" id="store-footnote" hidden></p>

        <div class="store-manages">
          <details class="store-manage" data-cat="sessions">
            <summary class="store-manage-sum">${COLLAPSE_CHEV}<span>Saved sessions</span> <span class="storage-count" data-count="sessions">0</span> <span class="storage-hint" data-size-hint="sessions">0 KB</span></summary>
            <div class="store-manage-body">
              <div class="store-sess-tools">
                <label class="store-selall"><input type="checkbox" id="sess-selall"> Select all</label>
                <button type="button" class="store-sort" data-sort="${sort}">${sort === 'recent' ? 'Recent ▾' : 'Largest first ▾'}</button>
              </div>
              <ul class="store-sess-list" id="store-sess-list">${sessionRowsHtml(m, sort)}</ul>
              <a class="store-manage-link" href="#/p">Organise in Projects →</a>
            </div>
          </details>

          <details class="store-manage" data-cat="images">
            <summary class="store-manage-sum">${COLLAPSE_CHEV}<span>My images</span> <span class="storage-count" id="userimg-count">0</span> <span class="storage-hint" id="userimg-size">0 KB</span> ${infoDot('Images you save to reuse across tools. This size includes your profile photo and any brand fonts.')}</summary>
            <div class="store-manage-body">
              <div class="userimg-grid" id="userimg-grid">
                ${m.images.list.map(userImageThumb).join('')}
                <button type="button" class="userimg-add" id="userimg-add" aria-label="Add images">
                  <span class="userimg-add-icon" aria-hidden="true">+</span>
                  <span class="userimg-add-text">Add</span>
                </button>
              </div>
              <input type="file" id="userimg-file" accept="image/svg+xml,image/png,image/apng,image/jpeg,image/webp,image/gif,image/avif,image/heic,image/heif,video/mp4,video/webm,.mp4,.webm,.mov" multiple hidden>
              <p class="profile-inline-error" id="userimg-error" style="color:hsl(var(--destructive));font-size:13px;margin:.4rem 0 0" hidden></p>
            </div>
          </details>

          <div class="store-manage store-manage--row" data-cat="cache">
            <span class="store-manage-name">Asset cache ${infoDot('Downloaded catalog content; it re-downloads on demand. Safe to clear.')} <span class="storage-count" data-size-label="cache">0 KB</span></span>
            <button type="button" id="clear-cache-btn" class="btn-link-danger">Clear cache</button>
          </div>

          ${hasPrev ? `<div class="store-manage store-manage--row" data-cat="previews">
            <span class="store-manage-name">Tool previews ${infoDot('Snapshots Lolly draws of personalised tool cards — they redraw when needed. Safe to clear.')} <span class="storage-count" data-size-label="previews">0 KB</span></span>
            <button type="button" id="clear-previews-btn" class="btn-link-danger">Clear previews</button>
          </div>` : ''}
        </div>

        <div class="storage-subsection">
          <div class="storage-subsection-header">
            <span>Move to another device ${infoDot('Export everything — profile, saved sessions, uploaded images and preferences — as one file, then import it on another offline install to pick up exactly where you left off. Stays entirely on your devices.')}</span>
          </div>
          <div class="storage-actions">
            <button type="button" id="export-data-btn" class="btn" data-sfx="whoosh">Export my data</button>
            <button type="button" id="import-data-btn" class="btn">Import data…</button>
            <input type="file" id="import-data-input" accept=".zip,application/zip" hidden>
          </div>
          <button type="button" id="export-render-btn" class="btn storage-hoard-btn">📦 Export my data &amp; render everything</button>
          <p class="storage-hoard-hint">The backup above, plus a second zip that <strong>renders every saved session</strong> to its output file — organised into folders that mirror your Projects. A complete offline archive; can be large and slow with many sessions.</p>
        </div>

        <div class="storage-actions">
          <button type="button" id="clear-storage-btn" class="btn btn-danger">Clear all my data</button>
        </div>

        <div class="store-selbar" id="store-selbar" role="region" aria-live="polite" hidden>
          <span class="store-selbar-count">0 selected</span>
          <button type="button" class="btn store-selbar-clear">Clear selection</button>
          <button type="button" class="btn btn-danger store-selbar-del">Delete</button>
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
      if (el) el.innerHTML = `Up to <strong>${fmtBytes(m.cache.bytes + m.previews.bytes + selectedSessionBytes())}</strong> can be freed here`;
    }

    // Refresh ONLY the visualization (hero, segments, legend, quota, reclaim, aria,
    // manage-summary badges) from a fresh model. Never rebuilds the session list/grid.
    function applyMeter(m: StorageModel) {
      countUp(heroNum, m.hasEstimate ? m.total : m.measured);
      const headroom = body.querySelector<HTMLElement>('#store-headroom');
      if (headroom) {
        if (m.hasEstimate && m.quota) {
          const used = m.usage! / m.quota;
          const phrase = used < 0.5 ? 'lots of room left' : used < 0.8 ? 'plenty of room left' : used < 0.95 ? 'getting full' : 'almost full';
          headroom.textContent = `Using ${fmtPct(m.usage!, m.quota)} of your ${fmtBytes(m.quota)} device budget · ${phrase}`;
          headroom.hidden = false;
        } else headroom.hidden = true;
      }
      const segs: Array<[string, number, string, boolean]> = [
        ['sessions', m.sessions.bytes, 'Saved sessions', true],
        ['images', m.images.bytes, 'My images', true],
        ['cache', m.cache.bytes, 'Asset cache', true],
        ['previews', m.previews.bytes, 'Tool previews', m.previews.available],
      ];
      for (const [cat, bytes, label, avail] of segs) {
        const seg = bar?.querySelector<HTMLElement>(`.seg[data-cat="${cat}"]`);
        if (!seg) continue;
        seg.style.flexGrow = String(Math.max(0, bytes));
        seg.hidden = !avail || bytes <= 0;
        seg.setAttribute('aria-label', `${label}, ${fmtBytes(bytes)} — manage`);
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
        if (quotaText) quotaText.innerHTML = `${fmtBytes(m.usage!)} of ${fmtBytes(m.quota)} device budget · <strong>${fmtPct(m.usage!, m.quota)}</strong> used`;
        if (quotaRow) quotaRow.hidden = false;
      } else if (quotaRow) quotaRow.hidden = true;

      const note = body.querySelector<HTMLElement>('#store-footnote');
      if (note) {
        if (!m.hasEstimate) { note.textContent = 'Device total unavailable — showing measured items only.'; note.hidden = false; }
        else if (m.overshoot) { note.textContent = "Measured items meet or exceed the browser's estimate (estimates are approximate)."; note.hidden = false; }
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
      if (list && !list.querySelector('.store-sess')) list.innerHTML = `<li class="storage-empty">No saved sessions yet.</li>`;
    };
    function syncSelbar() {
      const checked = [...body.querySelectorAll<HTMLElement>('.store-sess-check:checked')];
      if (selbar) {
        selbar.hidden = checked.length === 0;
        let bytes = 0; checked.forEach(c => bytes += model.sessions.sizes[c.dataset.slot!] || 0);
        const cnt = selbar.querySelector('.store-selbar-count');
        if (cnt) cnt.textContent = `${checked.length} selected · ${fmtBytes(bytes)}`;
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
      const label = row?.querySelector('.store-sess-label')?.textContent || 'this session';
      const ok = await confirmDialog({
        title: 'Delete this session?',
        message: `"${label}" will be permanently removed from this device${bytes ? `, freeing about ${fmtBytes(bytes)}` : ''}. This cannot be undone.`,
        confirmLabel: 'Delete',
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
      announce(`Freed ${fmtBytes(bytes)} — ${fmtBytes(model.hasEstimate ? model.total : model.measured)} used`);
    }

    async function deleteSelectedSessions(btn: HTMLButtonElement) {
      const checked = [...body.querySelectorAll<HTMLElement>('.store-sess-check:checked')];
      if (!checked.length) return;
      const slots = checked.map(c => c.dataset.slot!);
      let bytes = 0; slots.forEach(s => bytes += model.sessions.sizes[s] || 0);
      const ok = await confirmDialog({
        title: `Delete ${slots.length} saved session${slots.length === 1 ? '' : 's'}?`,
        message: `This permanently removes ${slots.length === 1 ? 'it' : 'them'} from this device, freeing about ${fmtBytes(bytes)}. This cannot be undone.`,
        confirmLabel: `Delete ${slots.length}`,
      });
      if (!ok) return;
      const prev = btn.textContent; btn.disabled = true; btn.textContent = 'Deleting…';
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
        ? `Deleted ${done} session${done === 1 ? '' : 's'} — freed ${fmtBytes(freed)}`
        : `Deleted ${done} of ${slots.length} — freed ${fmtBytes(freed)}; some could not be removed`);
    }

    function toggleSort(btn: HTMLElement) {
      sessSort = sessSort === 'size' ? 'recent' : 'size';
      btn.dataset.sort = sessSort;
      btn.textContent = sessSort === 'recent' ? 'Recent ▾' : 'Largest first ▾';
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
      const prev = btn.textContent; btn.disabled = true; btn.textContent = 'Clearing…';
      try { await fn(); } catch (err) { host.log?.('error', doneMsg, { error: String(err) }); }
      btn.textContent = 'Cleared';
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
      if (cacheBtn) { await clearRegenerable(cacheBtn, () => clearIdbStores(['asset-blob', 'asset-meta']), 'Cleared asset cache'); return; }

      const prevBtn = (e.target as Element).closest<HTMLButtonElement>('#clear-previews-btn');
      if (prevBtn) { await clearRegenerable(prevBtn, () => host.previews?.clear(), 'Cleared tool previews'); return; }

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
          <h3 id="clear-dialog-title">Clear all my data?</h3>
          <p>This removes your profile, all saved sessions, your uploaded images, and the asset cache. Cannot be undone.</p>
          <label class="clear-confirm">
            <span class="clear-confirm-prompt">Type <strong>${word}</strong> to confirm</span>
            <input type="text" class="clear-confirm-input" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" aria-label="Type ${word} to confirm">
          </label>
          <div class="clear-dialog-actions">
            <button class="btn btn-danger" data-scope="all" disabled>Clear everything</button>
            <button class="btn" data-scope="cancel">Cancel</button>
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
        clearBtn.textContent = 'Clearing…';

        localStorage.clear();
        sessionStorage.clear();
        await clearIdbStores(['state', 'profile', 'user-assets', 'asset-blob', 'asset-meta']);
        host.profile.bust!();
        applyTheme('light');
        trap?.release();   // un-inert the page before re-mounting the profile view
        document.removeEventListener('keydown', onKey);
        overlay.remove();
        await mountProfile(viewEl, host);
      });
    });

    // Export everything to a portable .zip for carrying to another offline install.
    viewEl.querySelector('#export-data-btn')?.addEventListener('click', async e => {
      const btn = e.currentTarget as HTMLButtonElement;
      const prev = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Exporting…';
      try {
        // host carries the web-only bridge methods exportBackup needs; its exact
        // BackupHost type isn't exported from data-transfer.
        const { blob, filename, summary } = await exportBackup({ host: host as unknown as Parameters<typeof exportBackup>[0]['host'], storage: localStorage });
        saveBlob(blob, filename);
        announce(`Exported ${summary.sessions} session${summary.sessions === 1 ? '' : 's'} and ${summary.userAssets} image${summary.userAssets === 1 ? '' : 's'}`);
        btn.textContent = 'Exported';
      } catch (err) {
        host.log?.('error', 'Data export failed', { error: String(err) });
        btn.textContent = 'Export failed';
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
          <h3 id="hoard-dialog-title">Export everything — and render it all?</h3>
          <p>Downloads a full <strong>backup</strong> of your data, then a <strong>rendered archive</strong> — every saved session output to its file, in folders that mirror your Projects. Nothing is deleted. A big library makes a big zip and can take a while.</p>
          <label class="clear-confirm">
            <span class="clear-confirm-prompt">Type <strong>${escape(word)}</strong> to confirm</span>
            <input type="text" class="clear-confirm-input" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" aria-label="Type ${escape(word)} to confirm">
          </label>
          <div class="clear-dialog-actions">
            <button class="btn btn-go" data-scope="go" disabled>Hoard it all 📦</button>
            <button class="btn" data-scope="cancel">Cancel</button>
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
        const n = `${count} ${count === 1 ? 'creation is a video or animation' : 'of your creations are videos or animations'}`;
        const overlay = document.createElement('div');
        overlay.className = 'clear-dialog-overlay';
        overlay.innerHTML = `
          <div class="clear-dialog clear-dialog--hoard" role="dialog" aria-modal="true" aria-labelledby="keepactive-title">
            <h3 id="keepactive-title">Keep this tab active?</h3>
            <p>${escape(n)}. Those record in <strong>real time</strong>, so this browser tab must stay open and in front the whole time they render — switch away and they pause. Include them?</p>
            <div class="clear-dialog-actions">
              <button class="btn btn-go" data-choice="include">I'm willing to keep this tab active</button>
              <button class="btn" data-choice="skip">Skip videos for now</button>
              <button class="btn" data-choice="cancel">Cancel</button>
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
      toast.innerHTML = `<button type="button" class="pro-toast-close" aria-label="Close">✕</button><div class="pro-toast-mount"><p class="pro-progress-msg"><strong>Preparing your export…</strong></p></div>`;
      document.body.appendChild(toast);
      const mount = toast.querySelector<HTMLElement>('.pro-toast-mount')!;
      toast.querySelector('.pro-toast-close')!.addEventListener('click', () => toast.remove());

      const prof = await host.profile.get().catch(() => null);
      const author = prof && (prof as { useDetails?: boolean }).useDetails ? prof : null;

      // 1) Portable data backup (quick) — the same bundle the "Export my data" button makes.
      try {
        const { blob, filename, summary } = await exportBackup({ host: host as unknown as Parameters<typeof exportBackup>[0]['host'], storage: localStorage });
        saveBlob(blob, filename);
        mount.innerHTML = `<p class="pro-progress-msg"><strong>Saved your data backup.</strong> Now rendering every creation…</p>`;
        announce(`Data backup saved: ${summary.sessions} session${summary.sessions === 1 ? '' : 's'}, ${summary.userAssets} image${summary.userAssets === 1 ? '' : 's'}`);
      } catch (err) {
        host.log?.('error', 'Data export failed', { error: String(err) });
        mount.innerHTML = `<p class="pro-progress-msg pro-log-err">The data backup failed (${escape(String((err as { message?: unknown })?.message ?? err))}). Continuing to the render…</p>`;
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
          mount.innerHTML = `<p class="pro-progress-msg"><strong>Backup saved.</strong> You have no saved sessions to render yet — make something first, then come back.</p>`;
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
          mount.innerHTML = `<p class="pro-progress-msg"><strong>Backup saved.</strong> Render cancelled — nothing else was downloaded.</p>`;
        }
      } catch (err) {
        mount.innerHTML = `<p class="pro-progress-msg pro-log-err">Render failed: ${escape(String((err as { message?: unknown })?.message ?? err))}</p>`;
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
        const skipNote = summary.skipped ? ` · ${summary.skipped} newer item${summary.skipped === 1 ? '' : 's'} skipped` : '';
        // Failed restores are surfaced separately (and assertively) — a silently-dropped
        // image would be lost for good once the user discards the source backup.
        const failNote = summary.failedAssets ? ` · ${summary.failedAssets} image${summary.failedAssets === 1 ? '' : 's'} couldn’t be restored (storage full?)` : '';
        announce(`Imported ${summary.sessions} session${summary.sessions === 1 ? '' : 's'} and ${summary.userAssets} image${summary.userAssets === 1 ? '' : 's'}${skipNote}${failNote}`, summary.failedAssets ? { assertive: true } : undefined);
        await mountProfile(viewEl, host);
      });
    });
  }
  storageDetails?.addEventListener('toggle', () => { if (storageDetails!.open) loadStorage(); });
  // A persisted-open section renders open from the HTML `open` attribute, which does
  // NOT fire `toggle`, so kick the lazy load here (runs after first paint).
  if (storageDetails?.open) loadStorage();

  // ── Catalogue: the tool tiles are in the HTML already; only the brand-asset
  // counts need a fetch, so defer it to first expand (once). ────────────────────
  const catalogDetails = viewEl.querySelector<HTMLDetailsElement>('#catalog-section');
  let catalogHydrated = false;
  const loadCatalog = () => {
    if (catalogHydrated || !catalogDetails) return;
    catalogHydrated = true;
    hydrateCatalogAssets(catalogDetails);
  };
  catalogDetails?.addEventListener('toggle', () => { if (catalogDetails!.open) loadCatalog(); });
  if (catalogDetails?.open) loadCatalog();

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
      <p class="identity-blurb">Sign exports with a verified identity — a short-lived certificate ties your email to files you export; the key never leaves this device. <a href="/info/content-credentials-identity.html" target="_blank" rel="noopener">How it works</a></p>
      <label class="identity-days-row">Verified for
        <select class="identity-days-select" aria-label="Certificate lifetime">
          <option value="7">7 days</option>
          <option value="30" selected>30 days</option>
          <option value="90">90 days</option>
          <option value="365">365 days</option>
        </select>
        <span class="identity-days-hint">— longer keeps exports verified longer; shorter limits misuse if this device is lost. The CA has the final say.</span>
      </label>
      <div class="identity-providers">
        ${providers.length
    ? providers.map(p => `<button type="button" class="btn" data-identity-provider="${p}">${escape(PROVIDER_LABELS[p])}</button>`).join('')
    : '<p class="storage-hint-text">No sign-in provider is configured on this deployment yet.</p>'}
      </div>
      ${VERIFY_LINK}
      <p class="identity-error" role="alert" hidden></p>`;
  }

  function renderIdentityStatus(s: IdentityStatus) {
    const provider = PROVIDER_LABELS[s.identity?.provider as string] ?? s.identity?.provider ?? '';
    const when = s.notAfter ? new Date(s.notAfter).toLocaleDateString() : '';
    const life = s.expired ? (when ? `expired ${when}` : 'expired') : (when ? `renews ${when}` : '');
    return `
      <div class="identity-status${s.expired ? ' is-expired' : ''}">
        <p class="identity-signing">Signing as <strong>${escape(s.identity?.email ?? '')}</strong>${provider ? ` <span class="identity-via">via ${escape(provider)}</span>` : ''}</p>
        ${life ? `<p class="identity-life">${escape(life)}</p>` : ''}
        <div class="identity-actions">
          <button type="button" class="btn" data-identity-act="renew">Renew</button>
          <button type="button" class="btn" data-identity-act="forget">Forget this device</button>
        </div>
        ${VERIFY_LINK}
        <p class="identity-error" role="alert" hidden></p>
      </div>`;
  }

  async function paintIdentity() {
    const body = identityBody();
    if (!body) return;
    if (!host.identity) { // bridge feature-detected, like host.previews
      body.innerHTML = `<p class="storage-hint-text">Signing identity isn't available in this build.</p>`;
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
    btn.textContent = 'Waiting…';
    try {
      const s = await host.identity!.enroll(provider, { days });
      await paintIdentity();
      announce(`Enrolled as ${s?.identity?.email ?? 'your account'}`);
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
          act.textContent = 'Really forget?';
          act.classList.add('is-confirm');
          setTimeout(() => {
            if (!document.contains(act)) return;
            delete act.dataset.confirm;
            act.textContent = 'Forget this device';
            act.classList.remove('is-confirm');
          }, 4000);
          return;
        }
        act.disabled = true;
        try { await host.identity!.forget(); }
        catch (err) { act.disabled = false; showIdentityError(String((err as { message?: unknown })?.message ?? err)); return; }
        await paintIdentity();
        announce('Forgotten — exports on this device sign anonymously again');
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
  const name = ref.meta?.name ?? 'Image';
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
      <button type="button" class="userimg-view" data-view-userimg="${escape(ref.id)}" title="${escape(name)}" aria-label="View ${escape(name)}">
        ${media}
      </button>
      <button type="button" class="userimg-delete" data-delete-userimg="${escape(ref.id)}" title="Delete" aria-label="Delete ${escape(name)}">&#x2715;</button>
    </div>
  `;
}

// Full-size preview overlay for a user image. Closes on backdrop click, the ✕,
// or Escape. Mirrors the simple overlay pattern used by the clear-data dialog.
function openImageLightbox(ref: AssetRef) {
  const name = ref.meta?.name ?? 'Image';
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
      <button type="button" class="userimg-lightbox-close" aria-label="Close">&#x2715;</button>
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
      <h3 id="import-dialog-title">Import data?</h3>
      <p>This loads the profile, saved sessions, images and preferences from the file. Anything with the same name on this device is overwritten; everything else is kept.</p>
      <p class="import-error" style="color:hsl(var(--destructive));font-size:13px;margin:0" hidden></p>
      <div class="clear-dialog-actions">
        <button class="btn" data-scope="import">Import</button>
        <button class="btn" data-scope="cancel">Cancel</button>
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
    (e.target as HTMLElement).textContent = 'Importing…';
    try {
      await onConfirm();
      trap?.release();  // un-inert before the success re-mount
      document.removeEventListener('keydown', onKey);
      overlay.remove(); // success re-mounts the page; drop the (body-level) overlay
    } catch (err) {
      if (errEl) { errEl.textContent = (err as { message?: string })?.message || 'Import failed.'; errEl.hidden = false; }
      btns.forEach(b => (b.disabled = false));
      (e.target as HTMLElement).textContent = 'Import';
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
