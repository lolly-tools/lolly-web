// SPDX-License-Identifier: MPL-2.0
/**
 * sync-service (plans/138 B1) - the shell-facing glue over the pure sync engine:
 * resolves the configured provider to a SyncRemote, threads the passphrase, and
 * persists the rev bookkeeping back into sync-config. Everything mechanical
 * (export/encrypt/put, head-compare, get/decrypt/import) lives in sync-engine.ts;
 * this only wires it to the user's chosen provider and settings.
 *
 * It also owns the two runtime touchpoints:
 *   - auto-push: a debounced scheduler; `markSyncDirty()` from a mutation site
 *     coalesces a burst into one push, and app-background flushes it immediately.
 *   - boot check: `checkNewer()` for main.ts to offer "apply the newer snapshot".
 */

import { t } from '../i18n.ts';
import { hasConnection } from './provider-connections.ts';
import { s3SyncRemote } from './s3-send.ts';
import { webdavSyncRemote } from './nextcloud-send.ts';
import { driveSyncRemote } from './google-drive.ts';
import { dropboxSyncRemote } from './dropbox-send.ts';
import type { SyncRemote, SnapshotMeta } from './sync-remote.ts';
import {
  pushSnapshot, checkForNewer, pullAndApply, makeSyncScheduler,
  type BackupDeps,
} from './sync-engine.ts';
import { getSyncConfig, saveSyncConfig, syncStateOf } from './sync-config.ts';

/** Provider kinds that have a two-way SyncRemote today. Each maps to a factory
 *  over the existing connected credentials. WebDAV/Dropbox/Drive follow the same
 *  wrap-the-send-driver shape and slot in here. */
const REMOTES: Record<string, () => SyncRemote> = {
  s3: () => s3SyncRemote(),
  webdav: () => webdavSyncRemote(),
  gdrive: () => driveSyncRemote(),
  dropbox: () => dropboxSyncRemote(),
};

/** Localised label per sync provider kind (aligned with the send-target labels). */
export function syncProviderLabel(kind: string): string {
  if (kind === 's3') return t('S3 bucket');
  if (kind === 'webdav') return t('Nextcloud / WebDAV');
  if (kind === 'gdrive') return t('Google Drive');
  if (kind === 'dropbox') return t('Dropbox');
  return kind;
}

/** The sync providers usable right now: a SyncRemote exists AND its credentials
 *  are connected on this device. Drives the /profile provider picker. */
export function availableSyncProviders(): Array<{ kind: string; label: string }> {
  return Object.keys(REMOTES)
    .filter((kind) => hasConnection(kind))
    .map((kind) => ({ kind, label: syncProviderLabel(kind) }));
}

function remoteFor(kind: string): SyncRemote | null {
  return REMOTES[kind]?.() ?? null;
}

/** Can this remote work without an interactive sign-in right now? Credential
 *  remotes omit the check (always silent); OAuth remotes answer per their token
 *  state. Used to keep the AUTO paths from popping a sign-in outside a gesture. */
async function isSilent(remote: SyncRemote): Promise<boolean> {
  return remote.canSyncSilently ? await remote.canSyncSilently() : true;
}

/** Push this device's state to the configured sync home now, updating the stored
 *  rev. Throws with a user-presentable message when nothing is configured. */
export async function syncNow(deps: BackupDeps): Promise<SnapshotMeta> {
  const cfg = await getSyncConfig();
  const remote = remoteFor(cfg.providerKind);
  if (!remote) throw new Error(t('Pick a connected provider for sync first.'));
  const { meta, state } = await pushSnapshot(deps, remote, { passphrase: cfg.passphrase || undefined });
  await saveSyncConfig({ lastSyncedRev: state.lastSyncedRev, lastSyncedAt: state.lastSyncedAt });
  return meta;
}

/** Is there a snapshot in the cloud this device hasn't written or applied? Cheap
 *  (head only). Returns {hasNewer:false} when no provider is configured. NOT gated
 *  on the enabled toggle - that governs AUTO behaviour; a manual "Check" works
 *  whenever a provider is set. */
export async function checkNewer(): Promise<{ hasNewer: boolean; meta: SnapshotMeta | null }> {
  const cfg = await getSyncConfig();
  const remote = remoteFor(cfg.providerKind);
  if (!remote) return { hasNewer: false, meta: null };
  return checkForNewer(remote, syncStateOf(cfg));
}

/** Download the cloud snapshot and apply it OVER this device (last-write-wins),
 *  updating the stored rev. Throws on a missing/wrong passphrase or no snapshot. */
export async function applyNewer(deps: BackupDeps): Promise<Awaited<ReturnType<typeof pullAndApply>>['summary']> {
  const cfg = await getSyncConfig();
  const remote = remoteFor(cfg.providerKind);
  if (!remote) throw new Error(t('Pick a connected provider for sync first.'));
  const { summary, state } = await pullAndApply(deps, remote, { passphrase: cfg.passphrase || undefined });
  await saveSyncConfig({ lastSyncedRev: state.lastSyncedRev, lastSyncedAt: state.lastSyncedAt });
  return summary;
}

// ── Auto-push (debounced, plus flush-on-background) ────────────────────────────

/** Debounce window for coalescing a burst of edits into one push. */
const PUSH_DEBOUNCE_MS = 8000;

let scheduler: { notifyChange(): void; flush(): Promise<void>; cancel(): void } | null = null;

/**
 * Wire auto-push once at boot. `getDeps` returns the live backup deps (host +
 * storage). A change → notifyChange() coalesces to one push after the debounce;
 * app-background/close flushes any pending push immediately. Every push re-reads
 * the config and no-ops when sync is off, so enabling/disabling needs no re-wiring.
 */
export function initSyncAutoPush(getDeps: () => BackupDeps): void {
  if (scheduler) return; // idempotent (re-entrant boot / HMR)
  scheduler = makeSyncScheduler(async () => {
    const cfg = await getSyncConfig();
    if (!cfg.enabled) return;
    const remote = remoteFor(cfg.providerKind);
    if (!remote || !(await isSilent(remote))) return;   // never pop OAuth outside a user gesture
    await syncNow(getDeps());
  }, PUSH_DEBOUNCE_MS, { onError: (err) => console.warn('Sync push failed:', err) });

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => { if (document.hidden) void scheduler?.flush(); });
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => { void scheduler?.flush(); });
  }
}

/** Signal that the user's state changed - schedules a debounced push if sync is on.
 *  A no-op until initSyncAutoPush() has run, and cheap to call from any mutation
 *  site (the enabled check happens inside the scheduled push). */
export function markSyncDirty(): void {
  scheduler?.notifyChange();
}

/**
 * Boot touchpoint: if sync is on and a sibling device left a NEWER snapshot, offer
 * to apply it (last-write-wins - replaces this device's data). Best-effort and
 * non-blocking; a wrong/absent passphrase for an encrypted snapshot sends the user
 * to the sync section to set it rather than failing loudly. Applying reloads so the
 * restored state is live everywhere.
 */
export async function maybeApplyNewerAtBoot(deps: BackupDeps): Promise<void> {
  let hasNewer = false;
  try {
    const cfg = await getSyncConfig();
    if (!cfg.enabled) return;                         // auto-apply only when sync is on
    const remote = remoteFor(cfg.providerKind);
    if (!remote || !(await isSilent(remote))) return; // don't pop OAuth at boot
    hasNewer = (await checkNewer()).hasNewer;
  } catch { return; }
  if (!hasNewer) return;
  const { confirmDialog } = await import('../components/confirm-dialog.ts');
  const ok = await confirmDialog({
    title: t('Apply the newer version from your cloud?'),
    message: t('A newer snapshot of your data was synced from another device. Applying it replaces this device’s projects, brand and settings with that version - this can’t be undone.'),
    confirmLabel: t('Apply and reload'),
    danger: true,
  });
  if (!ok) return;
  try {
    await applyNewer(deps);
    if (typeof location !== 'undefined') location.reload();
  } catch {
    // Most likely an encrypted snapshot needing its passphrase - send them to set it.
    const { navigateTo } = await import('../nav.ts');
    navigateTo('#/profile?focus=sync-section');
  }
}

/** Test seam: drop the scheduler so initSyncAutoPush can be re-armed. */
export function resetSyncServiceForTests(): void {
  scheduler?.cancel();
  scheduler = null;
}
