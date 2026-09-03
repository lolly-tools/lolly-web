// SPDX-License-Identifier: MPL-2.0
/**
 * The lolly:// scheme, mapped onto the app's own routes (plans/174).
 *
 * A deep link is an app address with the site name taken for granted:
 * `lolly://<route>` is `https://lolly.tools/<route>`, and it is the string an OS
 * hands the installed app - a Raycast or Alfred "open URL" action, `open` /
 * `xdg-open` / `start` in a terminal, a .desktop Action, a GNOME Shell or KRunner
 * result, an Android or iOS link tap. Three sources feed it (the desktop poll loop
 * in linux-desktop-boot.ts, the Android LollyShare bridge and the iOS queue behind
 * drop-router.ts's initDeepLinkIntake) and all of them route through here, so the
 * grammar is decided once.
 *
 * The rule: a deep link may only open a route the app already owns. Tool forms
 * go through the engine's own recogniser (parseToolUrl: `t/<id>`, `tool/<id>`,
 * `tool/<id>.<ext>` and a bare `<id>`); everything else must start with a word
 * from APP_PATH_WORDS, the frozen route vocabulary of plan 171. A link that is
 * neither is refused with null, never forwarded. An OS-delivered string is
 * untrusted input, and "navigate wherever it says" is how a crafted link would
 * reach a route that was never meant to be linkable.
 */
import { APP_PATH_WORDS, parseToolUrl } from '../../../../engine/src/tool-url.ts';

const SCHEME_RE = /^lolly:\/\/+/i;
const HOST_RE = /^(?:www\.)?lolly\.(?:tools|art)(?=[/?#]|$)\/?/i;
// The engine's own cap on a Lolly URL (tool-url.ts MAX_URL), so a link the engine
// would refuse is refused here too instead of becoming an oversized hash.
const MAX_LINK = 4096;

/**
 * `lolly://tool/qr-code?url=x` → `#/tool/qr-code?url=x`; `lolly://lab` → `#/lab`;
 * `lolly://verify?asset=…` → `#/verify?asset=…`. Null for anything else, including
 * an https link (only the scheme is a deep link) and a route word with no route.
 */
export function deepLinkToHash(link: string): string | null {
  if (typeof link !== 'string' || !SCHEME_RE.test(link)) return null;
  const rest = link.replace(SCHEME_RE, '').replace(HOST_RE, '');
  if (!rest || rest.length > MAX_LINK || /[\s<>"'\\]/.test(rest)) return null;

  const tool = parseToolUrl(link);
  if (tool) {
    let query = tool.query;
    // An embed-form extension (`tool/qr-code.svg`) names a format the GUI reads
    // from the `format=` param, so carry it across unless the query already says.
    if (tool.format && !/(^|&)format=/.test(query)) {
      query = query ? `${query}&format=${tool.format}` : `format=${tool.format}`;
    }
    return `#/tool/${tool.toolId}${query ? `?${query}` : ''}`;
  }

  // A fragment inside a hash route means nothing, so it is dropped rather than
  // forwarded as a second '#'.
  const pathAndQuery = rest.split('#')[0] ?? '';
  const qi = pathAndQuery.indexOf('?');
  const path = (qi === -1 ? pathAndQuery : pathAndQuery.slice(0, qi)).replace(/\/+$/, '');
  const query = qi === -1 ? '' : pathAndQuery.slice(qi);
  const head = path.split('/')[0] ?? '';
  if (!head || !APP_PATH_WORDS.has(head)) return null;
  // `tool`/`t` with no valid id fell through parseToolUrl above: refuse rather than
  // open half an address.
  if (head === 'tool' || head === 't') return null;
  return `#/${path}${query}`;
}
