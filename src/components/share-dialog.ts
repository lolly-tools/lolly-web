// SPDX-License-Identifier: MPL-2.0
/**
 * The Share-link dialog — a ready-to-copy link plus toggles for the on-visit behaviour
 * flags (fullscreen / export panel / auto-download / copy-on-visit / pin-version) and an
 * optional "Shortest link" pack. Extracted from views/tool.js so it can be invoked from
 * anywhere that has a tool id + serialised state — the tool view's Share button AND the
 * Projects view's per-session "Share link" action (which reconstructs the state from a
 * saved session via createRuntime → serializeUrlState).
 *
 * Callers pass the ALREADY-BUILT query parts (tool inputs + optional export settings) and
 * the tool's manifest; this module only assembles the URL, renders the dialog, and copies.
 */
import { escape } from '../utils.ts';
import { bumpMetric } from '../metrics.ts';
import { announce } from '../a11y.ts';
import { packQuery, isPackAvailable, PACK_PARAM, packEncrypted, isEncryptAvailable, ENC_PARAM } from '@lolly/engine';
import { mountModal } from './modal.ts';
import { shareSectionBuilders } from '../lib/share-sections.ts';
import { jellyActive } from '../lib/jelly.ts';

// Above this readable-query length the Share dialog auto-adopts the packed form.
const AUTO_PACK_MIN = 1800;

// When even the SHORTEST achievable link (packed, if that helps) is this long, the
// state has outgrown a reliably-pasteable URL: many chats, emails and social posts
// truncate links past ~2000 chars, and the engine hard-rejects a tool URL past 4096
// (tool-url.js MAX_URL) so it wouldn't even reopen. At that point we warn and nudge
// the user to remove some elements rather than hand them a link that breaks on paste.
const SHARE_WARN_LEN = 2000;

// Bitmap formats copy to the clipboard as a PNG; text/html copy as text/rich text.
// Vector (svg/pdf) and video formats have no useful clipboard form, so the
// "copy on visit" toggle is hidden for them. Mirrors performCopy()'s branches.
const SHARE_BITMAP_FORMATS = new Set(['png', 'jpg', 'jpeg', 'webp', 'avif']);
const SHARE_TEXT_FORMATS   = new Set(['txt', 'md', 'markdown', 'html']);

async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    Object.assign(ta.style, { position: 'fixed', opacity: '0', pointerEvents: 'none' });
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

// Assemble a full shareable URL from query parts. For a tool we emit the crawler-visible
// PATH form (/t/<id>) — the fragment is never sent to the server, so social crawlers only
// ever saw the generic og.png; /t/<id> is the per-tool OG stub that redirects a human back
// into the SPA with these params. `toolId` is passed explicitly (the tool view resolves it
// from location; the Projects session-share passes the saved session's toolId); if absent,
// fall back to the current location.
function shareUrlFromParts(parts: readonly string[], toolId?: string): string {
  const qs = parts.join('&');
  const query = qs ? '?' + qs : '';
  const id = toolId
    ?? window.location.pathname.match(/^\/t\/([^/?]+)/)?.[1]
    ?? window.location.hash.match(/^#\/tool\/([^/?]+)/)?.[1];
  if (id) return `${window.location.origin}/t/${id}${query}`;
  return window.location.origin + window.location.pathname + window.location.hash.split('?')[0] + query;
}

/** An input field (top-level, or a `blocks` sub-field) — we only need its type. */
interface ShareInput {
  type?: string;
  fields?: readonly { type?: string }[];
}

/** The manifest slice that drives which share toggles + notes are offered. */
interface ShareManifest {
  version?: string | number;
  render?: {
    export?: boolean;
    formats?: readonly string[];
    actions?: readonly unknown[];
  };
  inputs?: readonly ShareInput[];
}

// Input types that carry a user image. Catalog assets serialise as a shared ref,
// but a device-local image (an upload, or one from the picker's saved/library
// tabs) is bytes in this browser — it can't ride in a URL, so the recipient never
// gets it. When a tool declares one of these, the Share dialog says so.
const IMAGE_INPUT_TYPES = new Set(['asset', 'file']);
function hasImageInput(manifest: ShareManifest): boolean {
  return (manifest.inputs ?? []).some(inp =>
    IMAGE_INPUT_TYPES.has(inp.type ?? '') ||
    (inp.type === 'blocks' && (inp.fields ?? []).some(f => IMAGE_INPUT_TYPES.has(f.type ?? ''))),
  );
}

export interface ShareDialogOpts {
  /** the tool this link opens */
  toolId?: string;
  /** query parts (tool inputs + optional export settings) */
  baseParts?: readonly string[];
  /** the tool manifest (drives which toggles are offered) */
  manifest?: ShareManifest;
  /** the export format the link should imply (for copy-on-visit) */
  currentFormat?: string;
  /** dialog heading */
  title?: string;
}

/**
 * Open the Share dialog.
 * @param {object} o
 * @param {string} o.toolId        the tool this link opens
 * @param {string[]} o.baseParts   query parts (tool inputs + optional export settings)
 * @param {object} o.manifest      the tool manifest (drives which toggles are offered)
 * @param {string} [o.currentFormat] the export format the link should imply (for copy-on-visit)
 * @param {string} [o.title]       dialog heading
 */
export function openShareDialog({ toolId, baseParts = [], manifest = {}, currentFormat = '', title = 'Share this tool' }: ShareDialogOpts): HTMLDialogElement {
  // The readable query we'd pack (tool state + export settings) — WITHOUT the on-visit
  // flags, which stay readable outside the pack and merge on load.
  const baseQuery = baseParts.join('&');

  // Only offer toggles the tool can actually honour.
  const canExport  = manifest.render?.export !== false && (manifest.render?.formats?.length ?? 0) > 0;
  const actions    = manifest.render?.actions ?? ['copy', 'download', 'save'];
  const currentFmt = currentFormat || manifest.render?.formats?.[0] || '';
  const isBitmap   = SHARE_BITMAP_FORMATS.has(currentFmt);
  const showCopy   = canExport && actions.includes('copy') && (isBitmap || SHARE_TEXT_FORMATS.has(currentFmt));
  const copyLabel  = isBitmap ? 'Copy image to clipboard on visit' : 'Copy to clipboard on visit';
  const version    = manifest.version;
  const showImageNote = hasImageInput(manifest);
  // Offer password-protection only when there's state to encrypt and WebCrypto is present.
  const encryptable = isEncryptAvailable() && !!baseQuery;

  const content = `
    <div class="share-dialog-body">
      <h2>${escape(title)}</h2>
      <div class="share-link-row">
        <input type="text" class="share-link-field" readonly aria-label="Shareable link">
        ${jellyActive()
          // Keep the class: the copy handler selects by it, and the unlayered
          // jelly bridge reset (lib/jelly.ts) already strips its layered fill so
          // there's no second box behind the capsule. Accent = the row's action.
          ? `<jelly-button class="share-copy-btn" label="Copy">Copy</jelly-button>`
          : `<button type="button" class="share-copy-btn">Copy</button>`}
      </div>
      <p class="share-warning" data-share-warning role="status" hidden></p>
      ${showImageNote ? `<p class="share-note">
        <span class="share-note-ico" aria-hidden="true">🛫</span>
        <span>Only the <b>inputs</b>, <b>settings</b>, <b>tool</b> selection, and <b>catalog assets</b> travel in this link. <br><b>images</b> or <b>files</b> you added from <b>this device stay here</b> <i>— you'll need to share those separately</i>.</span>
      </p>` : ''}
      <label class="share-shortest" data-shortest-row hidden>
        <input type="checkbox" data-shortest>
        <span class="share-shortest-text">
          <strong>Shortest link</strong>
          <span class="share-shortest-note" data-shortest-note></span>
        </span>
      </label>
      ${encryptable ? `
      <label class="share-shortest" data-encrypt-row>
        <input type="checkbox" data-encrypt>
        <span class="share-shortest-text">
          <strong>Password-protect this link</strong>
          <span class="share-shortest-note">Encrypts the whole link (AES-256). The recipient types a password to open it — no server.</span>
        </span>
      </label>
      <div data-encrypt-body hidden style="margin:-.2rem 0 .2rem 1.7rem">
        <input type="password" data-encrypt-pw aria-label="Password to protect this link" autocomplete="off" spellcheck="false" placeholder="Set a password"
               style="width:100%;box-sizing:border-box;padding:8px 11px;font-size:13px;border:1px solid hsl(var(--input));border-radius:var(--radius);background:hsl(var(--background));color:hsl(var(--foreground))">
        <span class="share-shortest-note" style="display:block;margin-top:.3rem">The password is <b>not</b> in the link — share it separately, and note it can't be recovered if lost.</span>
      </div>` : ''}
      <fieldset class="share-toggles">
        <legend>When the recipient opens the link…</legend>
        <label><input type="checkbox" data-flag="full"> Open in fullscreen (hide controls)</label>
        <label data-options-row><input type="checkbox" data-flag="options"> Open with the export panel expanded</label>
        ${canExport ? `<label><input type="checkbox" data-flag="export"> Download automatically when opened</label>` : ''}
        ${showCopy ? `<label><input type="checkbox" data-flag="copy"> ${escape(copyLabel)}</label>` : ''}
        ${version ? `<label><input type="checkbox" data-flag="_v"> Pin this tool version (${escape(String(version))})</label>` : ''}
      </fieldset>
      <div class="share-extra-sections" data-extra-sections></div>
      <div class="share-dialog-actions">
        ${jellyActive()
          ? `<jelly-button variant="platinum" class="share-done" label="Done">Done</jelly-button>`
          : `<button type="button" class="share-done">Done</button>`}
      </div>
    </div>
  `;
  const modal = mountModal<void>(content, { className: 'share-dialog' });
  const dialog = modal.el;

  const field       = dialog.querySelector<HTMLInputElement>('.share-link-field')!;
  const fullCb      = dialog.querySelector<HTMLInputElement>('[data-flag="full"]');
  const optionsCb   = dialog.querySelector<HTMLInputElement>('[data-flag="options"]');
  const optionsRow  = dialog.querySelector<HTMLElement>('[data-options-row]');
  const checkboxes  = [...dialog.querySelectorAll<HTMLInputElement>('.share-toggles input[type="checkbox"]')];
  const shortestRow = dialog.querySelector<HTMLElement>('[data-shortest-row]')!;
  const shortestCb  = dialog.querySelector<HTMLInputElement>('[data-shortest]')!;
  const shortestNote = dialog.querySelector<HTMLElement>('[data-shortest-note]');
  const warnEl      = dialog.querySelector<HTMLElement>('[data-share-warning]')!;
  // Packed token for the current state — filled in async once we know it helps.
  let packedToken: string | null = null;
  // Encrypted (`zx`) token for the current state + typed password — recomputed as the
  // password changes; null when protection is off or no password is set yet.
  const encryptCb   = dialog.querySelector<HTMLInputElement>('[data-encrypt]');
  const encryptBody = dialog.querySelector<HTMLElement>('[data-encrypt-body]');
  const encryptPw   = dialog.querySelector<HTMLInputElement>('[data-encrypt-pw]');
  const copyBtn     = dialog.querySelector<HTMLButtonElement>('.share-copy-btn')!;
  let encToken: string | null = null;

  // Warn once we know the shortest link this state can produce is still too long to
  // share reliably (see SHARE_WARN_LEN). `bestLen` is the packed length when packing
  // helps, else the readable length — so the message reflects the best case, not the
  // toggle. Suggest trimming, since compression can't rescue it.
  const flagShareability = (bestLen: number) => {
    const over = bestLen >= SHARE_WARN_LEN;
    warnEl.hidden = !over;
    if (over) {
      warnEl.textContent = `⚠️ This link is very long (${bestLen.toLocaleString()} characters) and may get cut off when pasted into chats, emails or social posts — or fail to open. Remove some elements (blocks, long text) to make it shareable.`;
    }
  };
  const readableLen = shareUrlFromParts(baseParts, toolId).length;
  flagShareability(readableLen);   // best guess until the packed length lands

  const flagParts = () => {
    const parts: string[] = [];
    for (const cb of checkboxes) {
      if (cb.disabled || !cb.checked) continue;
      parts.push(cb.dataset.flag === '_v' ? `_v=${encodeURIComponent(String(version))}` : cb.dataset.flag!);
    }
    return parts;
  };

  const refresh = () => {
    // On-visit flags always ride readable (and outside the pack/encryption, where
    // they still override on load) so the recipient — and any crawler — can see the
    // behaviour even on a password-protected link.
    const flags = flagParts();
    const encryptOn = !!encryptCb?.checked;
    // A password-protected link is inherently packed+encrypted, so it overrides the
    // "shortest" choice; grey that out while it's on.
    shortestCb.disabled = encryptOn;
    shortestRow.classList.toggle('is-disabled', encryptOn);
    if (encryptOn && !encToken) {
      // Never emit an unencrypted link while protection is on but no token is ready.
      field.value = encryptPw?.value ? 'Generating protected link…' : 'Enter a password above to generate the protected link.';
      // toggleAttribute (not .disabled): a jelly-button reflects disabled via the
      // ATTRIBUTE only, and a native <button> honours it too — one path for both.
      copyBtn.toggleAttribute('disabled', true);
      return;
    }
    copyBtn.toggleAttribute('disabled', false);
    const base = (encryptOn && encToken) ? [`${ENC_PARAM}=${encToken}`]
      : (shortestCb?.checked && packedToken) ? [`${PACK_PARAM}=${packedToken}`]
      : [...baseParts];
    field.value = shareUrlFromParts([...base, ...flags], toolId);
  };

  // Compute the packed form once. Only offer "Shortest link" when the codec is
  // available AND it actually beats the readable link; auto-check it when the
  // readable link is long enough to risk the URL ceiling.
  if (isPackAvailable() && baseQuery) {
    packQuery(baseQuery).then(token => {
      if (!token || !dialog.isConnected) return;
      const packedLen   = shareUrlFromParts([`${PACK_PARAM}=${token}`], toolId).length;
      if (packedLen >= readableLen) return;             // packing wouldn't help — don't offer it
      packedToken = token;
      if (shortestNote) shortestNote.textContent = `${readableLen} → ${packedLen} characters`;
      shortestRow.hidden = false;
      if (readableLen >= AUTO_PACK_MIN) shortestCb.checked = true;   // auto-adopt for big states
      flagShareability(packedLen);   // the packed form is the shortest we can offer
      refresh();
    }).catch(() => { /* leave the readable link */ });
  }
  shortestCb?.addEventListener('change', refresh);

  // Password-protect: recompute the encrypted token as the password changes
  // (debounced — PBKDF2 is deliberately slow). The password never leaves the client;
  // only the ciphertext token goes into the link.
  let encReq = 0;
  let encDebounce: ReturnType<typeof setTimeout> | undefined;
  const recomputeEnc = () => {
    if (encryptBody) encryptBody.hidden = !encryptCb?.checked;
    const pw = encryptPw?.value ?? '';
    if (!encryptCb?.checked || !pw) { encToken = null; refresh(); return; }
    const mine = ++encReq;
    packEncrypted(baseQuery, pw).then(tok => {
      if (mine !== encReq || !dialog.isConnected) return;   // superseded or closed
      encToken = tok;
      refresh();
    }).catch(() => { if (mine === encReq) { encToken = null; refresh(); } });
  };
  encryptCb?.addEventListener('change', () => { encToken = null; recomputeEnc(); });
  encryptPw?.addEventListener('input', () => {
    encToken = null; refresh();                 // show "Generating…" immediately
    clearTimeout(encDebounce);
    encDebounce = setTimeout(recomputeEnc, 250);
  });

  // `full` collapses the sidebar, so the export panel has nowhere to anchor —
  // full wins, exactly as the URL handling and CSS do. Reflect that here.
  const syncFullWins = () => {
    const dim = !!fullCb?.checked;
    if (optionsCb) { optionsCb.disabled = dim; if (dim) optionsCb.checked = false; }
    optionsRow?.classList.toggle('is-disabled', dim);
  };

  for (const cb of checkboxes) cb.addEventListener('change', () => { syncFullWins(); refresh(); });

  dialog.querySelector<HTMLButtonElement>('.share-copy-btn')!.addEventListener('click', async function (this: HTMLButtonElement) {
    await copyToClipboard(field.value);
    bumpMetric('linksCopied');
    announce('Shareable link copied');
    const prev = this.textContent;
    this.textContent = 'Copied!';
    setTimeout(() => { this.textContent = prev; }, 1500);
  });

  dialog.querySelector('.share-done')!.addEventListener('click', () => modal.close());
  // Escape and a backdrop click are handled by mountModal (both close with no value).

  syncFullWins();
  refresh();
  field.focus();
  field.select();

  // Extra sections from the generic registry (empty by default → nothing mounts,
  // so the dialog is byte-identical without a registrant). A deployment's optional
  // control plane registers one to offer instance-hosted links (see src/org/).
  // Builders may be async; mount each only if it returns a node and the dialog is
  // still open. Each gets the dialog's own copy affordance.
  const extraHost = dialog.querySelector<HTMLElement>('[data-extra-sections]');
  const builders = shareSectionBuilders();
  if (extraHost && builders.length) {
    const ctx = { toolId, baseParts, currentFormat: currentFmt, copy: copyToClipboard };
    for (const build of builders) {
      Promise.resolve(build(ctx))
        .then(node => { if (node && dialog.isConnected) extraHost.appendChild(node); })
        .catch(() => { /* a section that fails to build simply doesn't appear */ });
    }
  }

  return dialog;
}
