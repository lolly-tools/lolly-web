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

export function registerBuiltinSendTargets(): void {
  registerSendTarget(googleDriveSendTarget());
}
