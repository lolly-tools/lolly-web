// SPDX-License-Identifier: MPL-2.0
/**
 * Catalog integrity — web wiring for engine/src/catalog-integrity.ts.
 *
 * INERT BY DEFAULT: everything here no-ops unless the build pins a catalog
 * public key via the VITE_CATALOG_PUBLIC_KEY_JWK env var (a P-256 public JWK
 * JSON string — printed by `node scripts/sign-catalog.ts --gen-key`). No key
 * ships in this repo; pinning one is a per-deployment decision, made where the
 * catalog is actually signed (sign-catalog.ts writes /catalog/tools/index.sig.json).
 *
 * When a key IS pinned, this fails CLOSED: a missing/unfetchable envelope or an
 * index.json that doesn't match its signed hash throws, and the signed envelope
 * + imported key are exposed (getToolIntegrity) for loadTool call sites to pass
 * as `integrity` opts so per-tool-file digests are enforced before hooks run.
 */

import { importSpkiOrJwkPublicKey, verifyCatalogEnvelope } from '../../../../engine/src/catalog-integrity.ts';
import type { CatalogSignatureEnvelope } from '../../../../engine/src/catalog-integrity.ts';
import type { ToolIntegrityOpts } from '../../../../engine/src/loader.ts';

declare global {
  // Merge the optional pin into vite-env.d.ts's minimal ImportMetaEnv — Vite
  // only exposes VITE_-prefixed vars, and this one is unset by default.
  interface ImportMetaEnv {
    readonly VITE_CATALOG_PUBLIC_KEY_JWK?: string;
  }
}

const PINNED_KEY: string = import.meta.env.VITE_CATALOG_PUBLIC_KEY_JWK ?? '';

/** Whether this build pins a catalog signing key (i.e. integrity is enforced). */
export function isCatalogKeyPinned(): boolean {
  return PINNED_KEY.length > 0;
}

let cached: Promise<ToolIntegrityOpts | null> | null = null;

async function load(): Promise<ToolIntegrityOpts | null> {
  if (!PINNED_KEY) return null;
  const publicKey = await importSpkiOrJwkPublicKey(PINNED_KEY);
  // Bypasses the service worker's /tools cache by construction (it's under
  // /catalog, which sw.js deliberately never caches) — the envelope is always
  // as fresh as the index it binds.
  const resp = await fetch('/catalog/tools/index.sig.json');
  if (!resp.ok) {
    throw new Error(`catalog integrity: signature envelope missing (HTTP ${resp.status}) but a key is pinned`);
  }
  const envelope = await resp.json() as CatalogSignatureEnvelope;
  return { envelope, publicKey };
}

/**
 * The signed envelope + imported public key for loadTool's `integrity` opts,
 * or null when no key is pinned (the unsigned/compat path). Cached; a failed
 * fetch clears the cache so the next sync retries instead of pinning failure.
 */
export function getToolIntegrity(): Promise<ToolIntegrityOpts | null> {
  if (!cached) {
    cached = load().catch((e: unknown) => {
      cached = null;
      throw e;
    });
  }
  return cached;
}

/**
 * Verify freshly-fetched /catalog/tools/index.json bytes against the pinned
 * signed envelope. Resolves silently when no key is pinned; throws on ANY
 * mismatch when one is — the caller treats it as a failed sync (fail closed).
 */
export async function assertToolIndexIntegrity(indexText: string): Promise<void> {
  const integrity = await getToolIntegrity();
  if (!integrity) return;
  const result = await verifyCatalogEnvelope(
    integrity.envelope,
    new TextEncoder().encode(indexText),
    integrity.publicKey,
  );
  if (!result.ok) {
    throw new Error(`catalog integrity: tool index rejected — ${result.reason}`);
  }
}
