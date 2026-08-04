// SPDX-License-Identifier: MPL-2.0
/**
 * Compact blocks → URL encoding — extracted from views/tool.ts so the wire
 * format is directly testable (lib/blocks-url.test.ts pins it) and both call
 * sites (the share dialog and syncUrl's address-bar write) share one encoder.
 *
 * Format: rows joined by '~', each row its declared fields joined by ',' in
 * FIELD ORDER — the order IS the wire format, so a tool's blocks `fields` list
 * is append-only forever (see layer-stack's tool.json). Values are
 * encodeURIComponent'd; colours drop their '#'. The engine's
 * decodeBlocksCompact (url-mode.ts) is the other half.
 */

import { assetIdForUrl } from '@lolly/engine';
import type { AssetRef } from '@lolly-tools/core/host-v1';
import type { BlockFieldSpec, InputValue } from '../../../../engine/src/inputs.ts';
import { asRow } from '../views/tool-types.ts';

/**
 * Encode a blocks array into the compact tilde-delimited URL format, or null
 * when it isn't possible (no declared fields, or a value carries a raw '~'/','
 * — the separators can't be escaped, see the check below — in which case the
 * caller falls back to the lossless JSON form).
 *
 * `keepUserIds` is the ADDRESS-BAR variant (syncUrl): a `user/…` upload id is
 * device-local, so it resolves fine on a refresh/bookmark of THIS device — and
 * a layer-heavy import (layer-stack) would otherwise write every row with an
 * empty image field. The share dialog keeps the policy of never exporting
 * user/ ids off-device.
 */
export function encodeBlocksCompact(
  items: InputValue,
  fields: BlockFieldSpec[],
  opts: { keepUserIds?: boolean } = {},
): string | null {
  if (!Array.isArray(items) || !items.length || !fields.length) return null;
  // Raw (pre-encoding) value of each field, for the separator-safety check below.
  const rowVals = items.map(item =>
    fields.map(f => {
      const raw = asRow(item)[f.id];
      // Asset sub-fields hold an AssetRef object — its link-safe id via
      // assetIdForUrl (a baked ref shares as its provenance URL, never its
      // data: bytes); uploaded user/ refs aren't shareable, same as top-level
      // (except the address-bar variant — see keepUserIds above).
      if (f.type === 'asset') {
        const id = raw && typeof raw === 'object' ? assetIdForUrl(raw as AssetRef) : '';
        return id && (opts.keepUserIds || !String(id).startsWith('user/')) ? String(id) : '';
      }
      const v = String(raw ?? '');
      return f.type === 'color' ? v.replace(/^#/, '') : v;
    })
  );
  // The record ('~') and field (',') separators can't be escaped inside a value:
  // the compact string is pushed into the share URL raw, and on parse
  // URLSearchParams percent-DECODES the whole value (%7E→'~', %2C→',') BEFORE the
  // block splitter runs — so an escaped separator collapses back into a real one
  // and one row splits into several with shifted fields. A '~' or ',' is easy to
  // inject via CSV/JSON import (or by typing one into a label). When any value
  // carries either separator, bail: return null so the caller falls back to the
  // lossless JSON block form (which round-trips cleanly through URLSearchParams).
  if (rowVals.some(r => r.some(v => v.includes('~') || v.includes(',')))) return null;
  return rowVals.map(r => r.map(encodeURIComponent).join(',')).join('~');
}
