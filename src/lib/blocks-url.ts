// SPDX-License-Identifier: MPL-2.0
/**
 * Compact blocks → URL encoding - extracted from views/tool.ts so the wire
 * format is directly testable (lib/blocks-url.test.ts pins it) and both call
 * sites (the share dialog and syncUrl's address-bar write) share one encoder.
 *
 * Format: rows joined by '~', each row its declared fields joined by ',' in
 * FIELD ORDER - the order IS the wire format, so a tool's blocks `fields` list
 * is append-only forever (see the darkroom tool.json `layers` input). Each field
 * value is encodeURIComponent'd (so an in-value ','/'~' becomes %2C/%7E and never
 * splits a row); real hex colours drop their leading '#' (restored on decode).
 *
 * SEPARATOR SAFETY (why this no longer bails to JSON): the compact string is the
 * VALUE of a query param, and both call sites put it through ONE MORE url-encode
 * layer - URLSearchParams in the address bar, encodeURIComponent in the share link
 * (encodeModelParam) - so the load boundary's single percent-decode restores the
 * compact string with its in-value %2C/%7E escapes INTACT, exactly like the table
 * compact form (url-mode.ts encodeTableCompact). decodeBlocksCompact then splits on
 * the RAW separators only and decodes each field. So a comma or tilde in a label,
 * a CSS-var colour, an SVG path or a keyframe track rides fine - which is what lets
 * the design tool (prose + paths + gradients, always separator-bearing) use this
 * compact form instead of the ~1.2-1.5x-larger JSON fallback it used to fall to.
 *
 * `keepUserIds` is the ADDRESS-BAR variant (syncUrl): a `user/…` upload id is
 * device-local, so it resolves fine on a refresh/bookmark of THIS device - and
 * a layer-heavy import (darkroom's layers) would otherwise write every row with an
 * empty image field. The share dialog keeps the policy of never exporting
 * user/ ids off-device.
 */

import { assetIdForUrl } from '@lolly/engine';
import type { AssetRef } from '@lolly-tools/core/host-v1';
import type { BlockFieldSpec, InputValue } from '../../../../engine/src/inputs.ts';
import { asRow } from '../views/tool-types.ts';

/** A real hex colour (`#rgb`..`#rrggbbaa`) - only these lose their '#' (round-tripped
 *  by decodeBlocksCompact). A CSS var()/keyword/token colour is left verbatim. */
const HEX_COLOR = /^#[0-9a-fA-F]{3,8}$/;

/**
 * Encode a blocks array into the compact tilde-delimited URL format, or null only
 * when it structurally can't be one (not an array, empty, or the input declares no
 * fields) - in which case the caller falls back to the lossless JSON form. It no
 * longer bails on separator-bearing values (see SEPARATOR SAFETY above).
 */
export function encodeBlocksCompact(
  items: InputValue,
  fields: BlockFieldSpec[],
  opts: { keepUserIds?: boolean } = {},
): string | null {
  if (!Array.isArray(items) || !items.length || !fields.length) return null;
  // encodeURIComponent escapes ',' (→%2C) but NOT '~' (it's unreserved), so a '~' inside
  // a value would collide with the ROW separator - escape it by hand, exactly as the table
  // compact form does (url-mode.ts encodeTableCompact). The ',' field separator is safe
  // because encodeURIComponent already escapes any in-value comma.
  const cell = (s: string): string => encodeURIComponent(s).replace(/~/g, '%7E');
  return items.map(item => {
    const vals = fields.map(f => {
      const raw = asRow(item)[f.id];
      // Asset sub-fields hold an AssetRef object - its link-safe id via
      // assetIdForUrl (a baked ref shares as its provenance URL, never its
      // data: bytes); uploaded user/ refs aren't shareable, same as top-level
      // (except the address-bar variant - see keepUserIds above).
      if (f.type === 'asset') {
        const id = raw && typeof raw === 'object' ? assetIdForUrl(raw as AssetRef) : '';
        return cell(id && (opts.keepUserIds || !String(id).startsWith('user/')) ? String(id) : '');
      }
      let v = String(raw ?? '');
      if (f.type === 'color' && HEX_COLOR.test(v)) v = v.slice(1);
      return cell(v);
    });
    // Trailing-trim: an unset field encodes to '' and decodeBlocksCompact re-pads a
    // short row to '' (the identical box), so trailing empty fields are pure waste.
    // Most rows set only their first handful of dozens of declared fields (a design
    // box: ~15 of 80), so dropping the trailing run of empties is a large saving.
    let end = vals.length;
    while (end > 0 && vals[end - 1] === '') end--;
    return vals.slice(0, end).join(',');
  }).join('~');
}
