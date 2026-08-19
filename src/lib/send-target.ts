// SPDX-License-Identifier: MPL-2.0
/**
 * send-target - a generic registry for cloud DESTINATIONS an export can be
 * sent to, straight from the export panel.
 *
 * The sibling of session-source / share-sections / export-policy: a neutral
 * seam, EMPTY by default, so a plain build renders the export panel exactly as
 * before - no card, no buttons, no network capability. What fills it:
 *
 *   - Built-in providers (send-targets-builtin.ts, one boot call in main.ts),
 *     each individually DORMANT until its config exists - e.g. the Google
 *     Drive target only reports available() once a Google OAuth client id is
 *     configured (lib/google-drive.ts). Config presence IS the feature flag:
 *     no id, no button, byte-identical behaviour.
 *   - A deployment's optional control plane (src/org/) can register instance
 *     targets, or re-register a built-in kind to route it through instance
 *     policy - the same way it registers a session source.
 *
 * Provider `kind` ids deliberately reuse the lolly-work provider vocabulary
 * (PROVIDER_KINDS: 'gdrive', 'dropbox', 'o365', …) so the individual OAuth
 * targets here and the control plane's federated catalog providers speak the
 * same names. The two layers stay independent: these are per-USER, browser-
 * side OAuth destinations for finished exports; the control plane's providers
 * are per-instance catalog sources.
 *
 * Multiple targets can be live at once (a person may connect Drive AND
 * Dropbox), so unlike session-source this registry holds a set - last
 * registration per kind wins, so a re-registering control plane replaces
 * rather than duplicates.
 */

/** One finished export, as handed to a target. */
export interface SendPayload {
  bytes: Uint8Array;
  /** Filename base (no extension enforced; targets may append/strip). */
  name: string;
  /** The export format id ('emf', 'png', …), lowercase. */
  format: string;
  mime: string;
}

/** What a completed send gives the UI to show. */
export interface SendOutcome {
  /** Where the file landed, when the provider has a viewable URL. */
  url?: string;
  /** Short, already-localised link/status label ("Open in Google Drawings"). */
  label: string;
}

export interface SendTarget {
  /** Provider id, aligned with lolly-work's PROVIDER_KINDS ('gdrive', …). */
  kind: string;
  /** Short, already-localised provider name ("Google Drive"). */
  label: string;
  /** Export formats this target accepts (lowercase); absent = every format. */
  formats?: readonly string[];
  /** Cheap render-time gate: is this target usable on this build/shell right
   *  now (config present, platform capable)? Never triggers auth or network. */
  available(): boolean;
  /** Already-localised button label for one format; absent = `Send to <label>`. */
  actionLabel?(format: string): string;
  /** Already-localised one-liner about scope/privacy, shown as the card's title
   *  tooltip ("Lolly can only see files it created …"). */
  hint?: string;
  /** Perform the send. May run an interactive OAuth popup. Rejects with a
   *  user-presentable message on failure (including a cancelled sign-in). */
  send(payload: SendPayload): Promise<SendOutcome>;
}

const targets = new Map<string, SendTarget>();

/** Register (or replace, by kind) one destination. */
export function registerSendTarget(t: SendTarget): void {
  targets.set(t.kind, t);
}

/** Remove one destination (an org policy withdrawing a built-in). */
export function unregisterSendTarget(kind: string): void {
  targets.delete(kind);
}

/** The destinations currently offered for one export format, in registration
 *  order. Empty (the default) = the export panel shows nothing. */
export function sendTargetsFor(format: string): SendTarget[] {
  const f = format.toLowerCase();
  return [...targets.values()].filter(t => t.available() && (!t.formats || t.formats.includes(f)));
}
