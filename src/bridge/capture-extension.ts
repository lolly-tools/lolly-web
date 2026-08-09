// SPDX-License-Identifier: MPL-2.0
/**
 * CaptureAPI + SiteTransport (web) — backed by the Lolly Chrome extension.
 *
 * A browser page can't read a cross-origin URL, but the companion extension can.
 * When installed, its MAIN-world content script sets `window.__lollyCapture` so we
 * can detect it synchronously at boot, and we route requests to it over
 * window.postMessage (its isolated content script relays to the background service
 * worker, which opens one inactive tab and closes it again).
 *
 * Two readings ride the same relay:
 *   - `host.capture.page()` → a PNG of the page (DevTools Protocol).
 *   - the Design System studio's website source → the page's markup, stylesheet
 *     text and a few icon/logo files, which `lib/design-system/extract-site.ts`
 *     parses into a census ON DEVICE (plan 97 §9).
 *
 * Nothing here fetches anything itself, and there is no server path: the deployed
 * app's CSP `connect-src` allowlists six hosts, and by decision Lolly runs no
 * fetching service. Website ingest therefore exists only where a transport does —
 * this extension, or the Tauri shells' native fetch — and the Website source tile
 * is not rendered at all otherwise.
 *
 * See shells/chrome-extension/.
 */

import type { CaptureAPI, AssetRef } from '@lolly-tools/core/host-v1';

/** What the extension announces about itself, synchronously, at document_start. */
interface LollyCaptureFlag {
  version?: string;
  /**
   * Version of the site-read request/reply shape this extension speaks. Absent on
   * copies older than 0.2.0, which answer screenshots but not site reads — hence a
   * separate announcement rather than one version number for both.
   */
  siteProtocol?: number;
}

declare global {
  interface Window {
    /** Set at document_start by the extension's MAIN-world content script. */
    __lollyCapture?: LollyCaptureFlag | boolean;
  }
}

/** The site-read shape this build speaks. Bump in lockstep with inpage.js. */
const SITE_PROTOCOL = 1;

/** The result message the extension's content script posts back. */
interface CaptureResultMessage {
  source: 'lolly-capture/ext';
  type: 'result';
  id: string;
  ok?: boolean;
  dataUrl?: string;
  error?: string;
}

function isCaptureResult(m: unknown): m is CaptureResultMessage {
  if (!m || typeof m !== 'object') return false;
  const r = m as Record<string, unknown>;
  return r.source === 'lolly-capture/ext' && r.type === 'result' && typeof r.id === 'string';
}

/** Synchronous, zero-cost detection — the extension sets this at document_start. */
export function hasCaptureExtension(): boolean {
  return typeof window !== 'undefined' && !!window.__lollyCapture;
}

/**
 * Synchronous, zero-cost detection of the SITE read specifically.
 *
 * Separate from `hasCaptureExtension()` because an installed-but-older extension
 * has the flag and cannot do this, and because the studio decides whether the
 * Website source exists at all before it renders — showing a source that cannot
 * run is the thing plan 97 §9 forbids.
 */
export function hasSiteCapture(): boolean {
  if (typeof window === 'undefined') return false;
  const flag = window.__lollyCapture;
  if (!flag || typeof flag !== 'object') return false;
  return typeof flag.siteProtocol === 'number' && flag.siteProtocol >= SITE_PROTOCOL;
}

let _seq = 0;

export function createExtensionCaptureAPI(): CaptureAPI {
  return {
    page(spec) {
      return new Promise<AssetRef>((resolve, reject) => {
        const id = `cap${++_seq}`;

        const cleanup = () => {
          clearTimeout(timer);
          window.removeEventListener('message', onMessage);
        };
        // Capture is slow (a real navigation + settle), so allow a generous window.
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error('Capture timed out — the Lolly extension did not respond.'));
        }, 90000);

        function onMessage(event: MessageEvent): void {
          if (event.source !== window) return;
          const m: unknown = event.data;
          if (!isCaptureResult(m) || m.id !== id) return;
          cleanup();
          if (m.ok && m.dataUrl) {
            resolve({
              source: 'remote',
              id: `capture:${spec.url}`,
              type: 'raster',
              format: 'png',
              url: m.dataUrl,
              width: spec.width,
              height: spec.height,
              meta: { capturedFrom: spec.url },
            });
          } else {
            reject(new Error(m.error || 'Page capture failed.'));
          }
        }

        window.addEventListener('message', onMessage);
        window.postMessage({ source: 'lolly-capture/page', type: 'capture', id, spec }, '*');
      });
    },
  };
}

// ─── Site read ────────────────────────────────────────────────────────────────

/** One file the transport fetched from the page: an icon, a logo, an og:image. */
export interface SiteAsset {
  /** Absolute URL it came from — the key the census matches its candidates on. */
  url: string;
  /** Content-Type as served, without parameters. May be '' if the server said nothing. */
  mime: string;
  bytes: Uint8Array;
}

/** Everything one reading of one page yields. Feeds `extract-site.ts` unchanged. */
export interface SiteReadResult {
  /** The page's markup, as serialised from the live DOM (so JS-built pages count). */
  html: string;
  /** Stylesheet text the markup does not already carry, in document order. */
  cssTexts: string[];
  assets: SiteAsset[];
  /** Where the page actually ended up after redirects — the census's base URL. */
  finalUrl: string;
  /** The page AS PAINTED, when asked for and available. Optional, always. */
  screenshotPng?: Uint8Array;
}

export interface SiteReadOptions {
  /**
   * Also return a PNG of the page. Off by default: it is a bonus signal (colours
   * as painted catch canvas and webfont brands the CSS misses), not the point.
   */
  screenshot?: boolean;
  /** Give up after this long. Defaults to the transport's own budget. */
  timeoutMs?: number;
}

/**
 * A way to read one website, on the user's command.
 *
 * Implemented twice — here over the Chrome extension, and in the Tauri shells over
 * a native fetch — so the studio's website source depends on a capability, not on
 * a platform. Both read ONE first-party URL: no crawling, no second hop, and
 * nothing at all until `read()` is called.
 */
export interface SiteTransport {
  /** Names who does the reading, so the consent line can say so honestly. */
  readonly kind: 'extension' | 'native';
  read(url: string, options?: SiteReadOptions): Promise<SiteReadResult>;
}

/** The site-read reply the extension's content script posts back. */
interface SiteResultMessage {
  source: 'lolly-capture/ext';
  type: 'lolly-capture/site-result';
  requestId: string;
  ok?: boolean;
  html?: unknown;
  cssTexts?: unknown;
  assets?: unknown;
  finalUrl?: unknown;
  screenshotBase64?: unknown;
  reason?: unknown;
}

function isSiteResult(m: unknown): m is SiteResultMessage {
  if (!m || typeof m !== 'object') return false;
  const r = m as Record<string, unknown>;
  return (
    r.source === 'lolly-capture/ext' &&
    r.type === 'lolly-capture/site-result' &&
    typeof r.requestId === 'string'
  );
}

function decodeBase64(b64: string): Uint8Array | null {
  try {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null; // one unreadable asset never fails the read
  }
}

/** Defensive: the reply crossed a postMessage boundary, so nothing about it is typed. */
function readAssets(raw: unknown): SiteAsset[] {
  if (!Array.isArray(raw)) return [];
  const out: SiteAsset[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const a = entry as Record<string, unknown>;
    if (typeof a.url !== 'string' || typeof a.bytesBase64 !== 'string') continue;
    const bytes = decodeBase64(a.bytesBase64);
    if (!bytes || !bytes.length) continue;
    out.push({ url: a.url, mime: typeof a.mime === 'string' ? a.mime : '', bytes });
  }
  return out;
}

function readCssTexts(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((t): t is string => typeof t === 'string' && t.length > 0);
}

/**
 * SiteTransport over the extension relay — the same one listener, one request id,
 * removed on settle discipline as `page()` above.
 *
 * The default budget is generous because the extension's own is: it allows 30 s
 * for the page to load, a settle, then up to 20 s to read it, and a shorter
 * window here would give up while the extension was still working. It is only
 * ever the backstop for an extension that dies without answering — an evicted
 * MV3 service worker — which is why it is not tuned to the sum.
 */
export function createExtensionSiteTransport(): SiteTransport {
  return {
    kind: 'extension',
    read(url, options = {}) {
      return new Promise<SiteReadResult>((resolve, reject) => {
        const requestId = `site${++_seq}`;

        const cleanup = () => {
          clearTimeout(timer);
          window.removeEventListener('message', onMessage);
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error('Reading the site timed out — the Lolly extension did not respond.'));
        }, options.timeoutMs ?? 90000);

        function onMessage(event: MessageEvent): void {
          if (event.source !== window) return;
          const m: unknown = event.data;
          if (!isSiteResult(m) || m.requestId !== requestId) return;
          cleanup();
          if (!m.ok) {
            reject(new Error(typeof m.reason === 'string' && m.reason ? m.reason : 'Site read failed.'));
            return;
          }
          const screenshot =
            typeof m.screenshotBase64 === 'string' ? decodeBase64(m.screenshotBase64) : null;
          resolve({
            html: typeof m.html === 'string' ? m.html : '',
            cssTexts: readCssTexts(m.cssTexts),
            assets: readAssets(m.assets),
            finalUrl: typeof m.finalUrl === 'string' && m.finalUrl ? m.finalUrl : url,
            ...(screenshot && screenshot.length ? { screenshotPng: screenshot } : {}),
          });
        }

        window.addEventListener('message', onMessage);
        window.postMessage(
          {
            source: 'lolly-capture/page',
            type: 'lolly-capture/site',
            requestId,
            url,
            options: { screenshot: !!options.screenshot },
          },
          '*',
        );
      });
    },
  };
}
