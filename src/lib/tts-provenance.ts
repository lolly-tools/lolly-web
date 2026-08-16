// SPDX-License-Identifier: MPL-2.0
/**
 * TTS provenance - the ONE implementation of a generated clip's Content
 * Credential, shared by the save path (views/script-audio.ts) and the lazy
 * heal path (views/catalog.ts) so the two can never drift on the manifest
 * shape: c2pa.created with trainedAlgorithmicMedia and the full recipe
 * ({ script, voice, speed, model, lang }) in the action's parameters, RIFF
 * LIST/INFO tags, then the signed store embedded as a top-level RIFF chunk.
 *
 * The heal exists because clips saved before the wav embed shipped hold bare
 * WAV bytes (the earliest carry no record-side credential either - only
 * aiGenerated: 'full' and the meta.tts recipe). Everything needed to rebuild
 * the credential is in that recipe, so "Check Content Credentials" and the
 * details dialog re-stamp such a clip on sight instead of shrugging.
 *
 * NEVER heal audio Lolly did not generate: the meta.tts recipe is the proof
 * of origin, and shouldHealTts refuses without it - a user-recorded or
 * uploaded file is not ours to stamp.
 */
import type { AssetRef, HostV1 } from '@lolly-tools/core/host-v1';

/** The synthesis model every Kokoro clip records (buildTtsRecord writes it). */
export const TTS_MODEL = 'kokoro-82m-q8';

/** The human-readable AI declaration carried in ICMT and the created action. */
export const TTS_DECLARATION = 'Speech synthesized on-device from a typed script — the voice is AI-generated, not a real person';

/** The exact inputs that produced a clip - enough to rebuild its credential. */
export interface TtsRecipe {
  text: string;
  voice: string;
  speed: number;
  model: string;
  lang: string;
}

/** What both provenance builders consume: the clip's bytes as a Blob (read
 *  inside the try, so a failing read degrades instead of throwing), a display
 *  name for the manifest title and the recipe for the action parameters. */
export interface TtsProvenanceArgs {
  blob: Blob;
  name: string;
  recipe: TtsRecipe;
}

/**
 * Read the recipe off a stored record's meta.tts block (buildTtsRecord's
 * shape). Pure. Returns null unless the block proves Lolly generated the
 * clip - a non-empty script and voice; speed/model/lang default like the
 * save path wrote them.
 */
export function ttsRecipeFromMeta(meta: Record<string, unknown> | null | undefined): TtsRecipe | null {
  const tts = (meta as { tts?: unknown } | null | undefined)?.tts;
  if (!tts || typeof tts !== 'object') return null;
  const block = tts as Record<string, unknown>;
  const text = typeof block.text === 'string' ? block.text.trim() : '';
  const voice = typeof block.voice === 'string' ? block.voice.trim() : '';
  if (!text || !voice) return null;
  const speed = typeof block.speed === 'number' && Number.isFinite(block.speed) && block.speed > 0 ? block.speed : 1;
  const model = typeof block.model === 'string' && block.model ? block.model : TTS_MODEL;
  const lang = typeof block.lang === 'string' && block.lang ? block.lang : 'en';
  return { text, voice, speed, model, lang };
}

/**
 * Cheap sniff: does this WAV already carry an embedded C2PA chunk? Pure - a
 * top-level RIFF chunk walk (headers only, chunk bodies are skipped by size),
 * mirroring the engine's placeWav scan without pulling the c2pa cluster in.
 * Anything that is not a well-formed RIFF/WAVE reads as "no credential".
 */
export function hasRiffC2pa(bytes: Uint8Array): boolean {
  const fourcc = (o: number): string => String.fromCharCode(bytes[o]!, bytes[o + 1]!, bytes[o + 2]!, bytes[o + 3]!);
  if (bytes.length < 12 || fourcc(0) !== 'RIFF' || fourcc(8) !== 'WAVE') return false;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 12; i + 8 <= bytes.length; ) {
    if (fourcc(i) === 'C2PA') return true;
    const size = dv.getUint32(i + 4, true);
    i += 8 + size + (size & 1);   // chunks are word-aligned (pad byte on odd sizes)
  }
  return false;
}

/**
 * The heal decision, pure and testable: a USER wav whose meta.tts recipe
 * proves Lolly generated it, and whose stored bytes carry no embedded C2PA
 * chunk yet. An uploaded mp3, a recording without a recipe or an already
 * stamped clip all say no.
 */
export function shouldHealTts(
  ref: Pick<AssetRef, 'source' | 'type' | 'format' | 'meta'>,
  bytes: Uint8Array,
): boolean {
  if (ref.source !== 'user' || ref.type !== 'audio') return false;
  if (String(ref.format ?? '').toLowerCase() !== 'wav') return false;
  if (!ttsRecipeFromMeta(ref.meta)) return false;
  return !hasRiffC2pa(bytes);
}

/** The optional device-identity signer some hosts expose (bridge/identity). */
type SigningHost = HostV1 & { identity?: { signer(): Promise<unknown> } };

/** The signed-manifest options both builders share: the enrolled device
 *  identity when one is valid, else the engine's ephemeral on-device default
 *  (30-day window) - stampCaptureClip's recipe. */
async function signerOptions(host: HostV1): Promise<Record<string, unknown>> {
  let signer: unknown = null;
  try { signer = await (host as SigningHost).identity?.signer(); } catch { /* fall back to ephemeral */ }
  return signer
    ? { signer }
    : { dates: { notBefore: new Date(Date.now() - 60_000), notAfter: new Date(Date.now() + 30 * 86_400_000) } };
}

/** The one created-action shape (trainedAlgorithmicMedia + the full recipe). */
const createdAction = (recipe: TtsRecipe, digitalSourceType: string) => ({
  action: 'c2pa.created',
  digitalSourceType,
  description: TTS_DECLARATION,
  parameters: { script: recipe.text, voice: recipe.voice, speed: recipe.speed, model: recipe.model, lang: recipe.lang },
});

/**
 * Sign a record-side Content Credential for a generated clip - the machine-
 * readable "this voice is synthetic" mark (EU AI Act Article 50). Nothing is
 * embedded into the file: the hash binds the whole wav byte range (no
 * exclusions), mirroring a sidecar manifest, and the store is persisted ON
 * the asset record (credential/credentialFormat) - exactly what
 * host.assets.credential serves the runtime's ingredient gathering, so a
 * video or image composed from the clip chains the AI origin into its own
 * manifest. Never throws - a failure logs and returns null.
 */
export async function buildTtsCredential(host: HostV1, args: TtsProvenanceArgs): Promise<{ store: Uint8Array; format: string } | null> {
  try {
    const { buildC2paManifest, GENERATED_SOURCE_TYPE, ENGINE_VERSION } = await import('@lolly/engine');
    const bytes = new Uint8Array(await args.blob.arrayBuffer());
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    const store = await buildC2paManifest({
      title: args.name,
      claimGenerator: 'Lolly lolly.tools',
      generatorInfo: { name: 'Lolly', version: ENGINE_VERSION },
      actions: [createdAction(args.recipe, GENERATED_SOURCE_TYPE)],
      assetHash: { exclusions: [], hash },
      format: 'audio/wav',
      ...(await signerOptions(host) as object),
    });
    return { store, format: 'wav' };
  } catch (err) {
    host.log?.('warn', `tts provenance: Content Credential not attached — ${(err as Error)?.message || err}`);
    return null;
  }
}

/**
 * Embed the clip's provenance INTO the wav bytes: LIST/INFO tags first (INAM
 * title, ICMT the AI-declaration line, IART only with the profile's "Use my
 * details" opt-in - the same gate buildExportMeta applies - ISFT lolly.tools),
 * then the signed C2PA manifest as a top-level RIFF chunk via the engine's
 * two-pass embed, so the hash binding covers the FINAL byte layout tags
 * included. Returns the finished blob plus the extracted store (mirrored onto
 * the record for the runtime's fast ingredient path), or null on any failure - 
 * callers fall back to the record-side-only credential.
 */
export async function embedTtsProvenance(host: HostV1, args: TtsProvenanceArgs): Promise<{ blob: Blob; store: Uint8Array } | null> {
  try {
    const { embedC2pa, embedWavInfo, extractC2paStore, GENERATED_SOURCE_TYPE, ENGINE_VERSION } = await import('@lolly/engine');
    // Personal details only with the explicit profile opt-in, never by default.
    let artist = '';
    try {
      const p = (await host.profile.get()) ?? {};
      if ((p as { useDetails?: unknown }).useDetails === true) {
        artist = [p.firstname, p.lastname].map((s) => String(s ?? '').trim()).filter(Boolean).join(' ');
      }
    } catch { /* no profile → no artist */ }
    const bytes = new Uint8Array(await args.blob.arrayBuffer());
    const tagged = embedWavInfo(bytes, { title: args.name, artist, comment: TTS_DECLARATION });
    const embedded = await embedC2pa(tagged, 'wav', {
      title: args.name,
      claimGenerator: 'Lolly lolly.tools',
      generatorInfo: { name: 'Lolly', version: ENGINE_VERSION },
      ...(artist ? { author: { name: artist } } : {}),
      actions: [createdAction(args.recipe, GENERATED_SOURCE_TYPE)],
      ...(await signerOptions(host) as object),
    });
    const ex = extractC2paStore(embedded);
    if (!ex) throw new Error('embedded credential did not read back');
    return { blob: new Blob([embedded as BlobPart], { type: 'audio/wav' }), store: ex.store };
  } catch (err) {
    host.log?.('warn', `tts provenance: in-file credential not embedded — ${(err as Error)?.message || err}`);
    return null;
  }
}

/** The narrow bridge seam the heal writes through (bridge/assets.ts). */
export interface TtsHealHost extends HostV1 {
  assets: HostV1['assets'] & {
    _restampUserAsset(id: string, patch: { blob: Blob; credential: Uint8Array; credentialFormat: string }): Promise<void>;
  };
}

/**
 * Lazily re-stamp one pre-embed clip: rebuild the credential exactly as the
 * save path does (same manifest, same INFO tags), then replace the record's
 * blob + credential in place. Returns the healed blob so the caller can hand
 * the STAMPED bytes straight to /verify, or null when the asset does not
 * qualify (shouldHealTts) or the embed failed - never throws.
 */
export async function healTtsProvenance(host: TtsHealHost, ref: AssetRef, bytes: Uint8Array): Promise<Blob | null> {
  if (!shouldHealTts(ref, bytes)) return null;
  const recipe = ttsRecipeFromMeta(ref.meta)!;
  const name = String(ref.meta?.name ?? ref.id);
  const embedded = await embedTtsProvenance(host, { blob: new Blob([bytes as BlobPart], { type: 'audio/wav' }), name, recipe });
  if (!embedded) return null;
  try {
    await host.assets._restampUserAsset(ref.id, { blob: embedded.blob, credential: embedded.store, credentialFormat: 'wav' });
  } catch (err) {
    host.log?.('warn', `tts provenance: heal write failed — ${(err as Error)?.message || err}`);
    return null;
  }
  return embedded.blob;
}
