// SPDX-License-Identifier: MPL-2.0
/**
 * SEAL public-key resolution over DNS-over-HTTPS.
 *
 * This is the ONE thing the SEAL verifier ever lets leave the device — and it is
 * NOT the file: it is a public-key DNS lookup for the domain the file's own SEAL
 * record names. The image bytes never go anywhere. The engine's `verifySeal`
 * keeps this out of engine/src (which stays network-free, like c2pa-verify does
 * WebCrypto but never fetch) by taking this as an injected `resolveKey`; it is
 * only ever called when a SEAL record was actually found in the file, so a normal
 * (non-SEAL) verify makes zero network requests.
 *
 * HONESTY — UNVERIFIED here: there is no network in the test/dev sandbox and no
 * real SEAL-signed sample, so this DoH + TXT-parse path has NOT been exercised
 * end-to-end. The cryptographic verification that CONSUMES the returned key IS
 * unit-tested against real signatures (tests/seal.test.ts). Treat the DoH/TXT
 * handling below as best-effort until it validates a genuine deployed key.
 *
 * SEAL DNS record (space-separated; only long values quoted):
 *   seal=1 ka=rsa kv=1 p="<base64 SPKI>"      (p= may be split into "AAA" "BBB")
 *   seal=1 ka=ec  pkd="<base64 digest>" pka=sha256   (key arrives inline via pk=)
 *   r=<ISO8601> | r=revoke | (no p=)          → revocation
 */
import type { SealRecord } from '@lolly/engine';

// Cloudflare's DoH JSON endpoint (SEAL-js defaults to Cloudflare too). JSON API,
// TXT type. If a deployment needs a different resolver this is the one knob.
const DOH_ENDPOINT = 'https://cloudflare-dns.com/dns-query';
const DOH_TIMEOUT_MS = 4000;

function base64ToBytes(input: string): Uint8Array {
  let s = input.replace(/\s+/g, '');
  const pad = s.length % 4;
  if (pad) s += '='.repeat(4 - pad);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Normalise a DoH TXT `data` field to the logical record text. Providers wrap
// each DNS character-string in quotes (and escape inner quotes as \"); a record
// split across several character-strings comes back as adjacent "…" tokens that
// must be concatenated. We keep the SEAL field-level quoting (p="…") intact.
function normaliseTxt(data: string): string {
  const s = String(data).trim();
  // Multiple character-string tokens: "part1" "part2" → concat their contents,
  // un-escaping DoH's \" → ".
  if (/^".*"$/.test(s)) {
    const tokens = s.match(/"((?:[^"\\]|\\.)*)"/g);
    if (tokens?.length) {
      return tokens.map((tok) => tok.slice(1, -1).replace(/\\(.)/g, '$1')).join('');
    }
  }
  return s;
}

// Pull SEAL fields out of one logical TXT record. `p=` may be several adjacent
// quoted strings which are concatenated; other values are a quoted string or a
// bare token.
function parseDnsSeal(txt: string): Record<string, string> | null {
  if (!/(^|\s)seal\s*=/.test(txt) && !/^seal\s*=/.test(txt)) return null;
  const fields: Record<string, string> = {};
  const re = /([A-Za-z][A-Za-z0-9._+-]*)\s*=\s*("(?:[^"]*)"(?:\s+"[^"]*")*|[^\s]+)/g;
  for (let m: RegExpExecArray | null; (m = re.exec(txt)); ) {
    const key = m[1]!;
    const raw = m[2]!;
    // Concatenate one-or-more quoted segments (split long p=), else strip a
    // single pair of surrounding quotes.
    const quoted = raw.match(/"([^"]*)"/g);
    fields[key] = quoted ? quoted.map((q) => q.slice(1, -1)).join('') : raw;
  }
  return 'seal' in fields ? fields : null;
}

async function digest(alg: string, bytes: Uint8Array): Promise<Uint8Array> {
  const name = alg === 'sha512' ? 'SHA-512' : alg === 'sha384' ? 'SHA-384' : 'SHA-256';
  return new Uint8Array(await crypto.subtle.digest(name, bytes as BufferSource));
}
const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Resolve the SPKI DER public key for a SEAL record's domain via DNS-over-HTTPS.
 * Returns null when nothing matches, the selector is revoked, or the lookup
 * fails — which the engine surfaces as an honest "unverified", never a pass.
 */
export async function resolveSealKey(record: SealRecord): Promise<Uint8Array | null> {
  const domain = record.domain;
  if (!domain || !/^[a-z0-9.\-_]+$/i.test(domain)) return null;

  let json: unknown;
  try {
    const ctl = AbortSignal.timeout ? AbortSignal.timeout(DOH_TIMEOUT_MS) : undefined;
    const resp = await fetch(`${DOH_ENDPOINT}?name=${encodeURIComponent(domain)}&type=TXT`, {
      headers: { accept: 'application/dns-json' },
      ...(ctl ? { signal: ctl } : {}),
    });
    if (!resp.ok) return null;
    json = await resp.json();
  } catch {
    return null;
  }

  const answers = (json as { Answer?: Array<{ data?: string }> })?.Answer;
  if (!Array.isArray(answers)) return null;

  for (const ans of answers) {
    const fields = parseDnsSeal(normaliseTxt(ans.data ?? ''));
    if (!fields) continue;
    // Select the entry matching this record's selectors.
    if ((fields.ka ?? '') !== record.keyAlg) continue;
    if ((fields.kv ?? '1') !== record.keyVersion) continue;
    if ((fields.uid ?? '') !== record.uid) continue;

    // Revocation: no p= (and no pkd), p=revoke, or r=revoke/empty → revoked.
    const r = fields.r;
    if (r === 'revoke' || r === '') return null;
    if (r && record.timestamp) {
      // r=<ISO8601>: signatures dated after that instant are revoked.
      const bound = Date.parse(r);
      const stamp = Date.parse(sealTimestampToIso(record.timestamp));
      if (Number.isFinite(bound) && Number.isFinite(stamp) && stamp > bound) return null;
    }

    // Direct key.
    if (fields.p && fields.p !== 'revoke') {
      try { return base64ToBytes(fields.p); } catch { return null; }
    }
    // Digest-only DNS + inline key in the file (the fully-offline pairing).
    if (fields.pkd && record.inlineKey) {
      try {
        const want = base64ToBytes(fields.pkd);
        const got = await digest((fields.pka ?? 'sha256').toLowerCase(), record.inlineKey);
        return bytesEqual(want, got) ? record.inlineKey : null;
      } catch { return null; }
    }
    // seal= present but no usable key material → global revocation.
    return null;
  }
  return null;
}

// SEAL timestamps are YYYYMMDDhhmmss[.frac]; loosely map to an ISO string just
// well enough for the r= after-date comparison (best-effort; UNVERIFIED).
function sealTimestampToIso(ts: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?/.exec(ts);
  if (!m) return ts;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4] ?? '00'}:${m[5] ?? '00'}:${m[6] ?? '00'}Z`;
}
