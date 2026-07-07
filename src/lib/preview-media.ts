// SPDX-License-Identifier: MPL-2.0
/**
 * A tool's committed preview element, shared by the gallery tiles and the asset picker.
 *
 * `tools/<id>/card.html` — a self-contained animated HTML banner (CSS `@keyframes`, no JS,
 * e.g. digi-ad's ad loop) — renders in a SANDBOXED, click-through `<iframe>`:
 *   • sandbox="allow-same-origin" — no scripts run (safe), but the banner's own brand
 *     @font-face can still load from same-origin /catalog/fonts.
 *   • pointer-events:none — clicks fall through to the tile's own link/button.
 *   • loading="lazy" — an off-screen banner costs nothing until it scrolls near.
 * It's a few KB of vector-crisp CSS that animates natively and pauses off-screen — far
 * lighter than an APNG/GIF/video for an HTML/CSS tool.
 *
 * Every other preview (card.svg / card.png / a generated svg|png|apng) is a plain `<img>`.
 * Pass a `cls` matching the surrounding image so the box is identical either way, and an
 * `iframeSize` CSS fragment for the fitting the context needs (the default fills a
 * definite box; a fixed-height slot such as the hero or a picker tile passes an
 * aspect-ratio instead so the responsive banner isn't stretched).
 */
import { escape } from '../utils.ts';

export function isHtmlPreview(src: string | undefined | null): boolean {
  return !!src && src.endsWith('.html');
}

export function previewMedia(src: string, cls: string, iframeSize = 'width:100%;height:100%'): string {
  if (isHtmlPreview(src)) {
    return `<iframe class="${cls}" src="${escape(src)}" tabindex="-1" aria-hidden="true" loading="lazy" scrolling="no" sandbox="allow-same-origin" style="border:0;background:transparent;pointer-events:none;${iframeSize}"></iframe>`;
  }
  return `<img class="${cls}" src="${escape(src)}" alt="" aria-hidden="true" loading="lazy" decoding="async">`;
}
