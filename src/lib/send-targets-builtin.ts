// SPDX-License-Identifier: MPL-2.0
/**
 * The shell's built-in send-target providers, registered once at boot
 * (main.ts). Each target is individually DORMANT until its own config exists
 * (its `available()` gate - e.g. gdrive needs a Google OAuth client id), so
 * registering all of them here costs nothing on a plain build: the export
 * panel consults sendTargetsFor() and renders exactly nothing.
 *
 * Adding a provider = one driver module exposing a SendTarget (see
 * lib/google-drive.ts for the reference shape: config gate, popup OAuth via
 * public/oauth-return.html, upload, viewable-link outcome) + one line here.
 * Keep `kind` ids aligned with the lolly-work provider vocabulary
 * ('dropbox', 'o365', …) so both worlds speak the same names.
 */
import { registerSendTarget } from './send-target.ts';
import { googleDriveSendTarget } from './google-drive.ts';
import { dropboxSendTarget } from './dropbox-send.ts';
import { oneDriveSendTarget } from './onedrive-send.ts';
import { s3SendTarget } from './s3-send.ts';
import { nextcloudSendTarget } from './nextcloud-send.ts';
import { mastodonSendTarget } from './mastodon-send.ts';
import { blueskySendTarget } from './bluesky-send.ts';
import { discordSendTarget } from './discord-send.ts';
import { primeConnections } from './provider-connections.ts';

export function registerBuiltinSendTargets(): void {
  registerSendTarget(googleDriveSendTarget());
  registerSendTarget(dropboxSendTarget());
  registerSendTarget(oneDriveSendTarget());
  registerSendTarget(s3SendTarget());
  registerSendTarget(nextcloudSendTarget());
  // The publish tier (plans/129 WP5): post-shaped destinations.
  registerSendTarget(mastodonSendTarget());
  registerSendTarget(blueskySendTarget());
  registerSendTarget(discordSendTarget());
  // Connection-gated kinds (s3, webdav, mastodon, bluesky, discord) gate on
  // hasConnection(), a sync read of the in-memory cache - warm it now so a
  // saved connection surfaces in the export panel without a /profile visit.
  primeConnections();
}
