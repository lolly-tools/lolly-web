// SPDX-License-Identifier: MPL-2.0
/**
 * Universal drop router — the "drop a file on the front door" seam (gallery +
 * dashboard roots, the welcome dialog's file-picker fallback, and the Android
 * share-target ingest — see initShareTargetIngest below). A SCOPED
 * drag-and-drop handler sniffs what landed and opens a chooser sheet offering
 * only the routes that genuinely apply:
 *
 *   design file (.fig/.penpot/.idml/.indd/SVG/zip) → Design, parsed to boxes
 *   token doc / .penpot / design-system pack zip → the Design System studio
 *   PDF / .ai   → edit as a design · pages → SVG library assets · compress ·
 *                 the Design System studio (a guidelines PDF's colours, marks
 *                 and embedded faces — plan 97 §8)
 *   PowerPoint  → slides → SVG library assets
 *   image/video/audio → the asset library · /verify (Content Credentials)
 *   unknown / C2PA-looking bytes → /verify
 *
 * A `.penpot` reaches TWO doors (Design and the studio), so both label
 * where they land rather than what they do (plan 97 §14.9).
 *
 * Design files travel by the same one-shot in-memory handoff pattern
 * lib/verify-handoff.ts proves: the File is stashed here, we navigate to
 * #/tool/design, and free-canvas consumes it on mount
 * (takePendingDesignImport) through the exact code path of its Import panel.
 *
 * Deliberately light at module scope: the picker (storeUserUpload), pdf-import
 * and pptx-import chunks all load lazily at drop/choice time, so attaching the
 * router costs the gallery cold path nothing. The byte sniff here is a few
 * local magic-number checks (zip 'PK', '%PDF', '<svg', JUMBF/'c2pa' markers) —
 * NOT a duplicate of design-import.ts's full format routing: real format
 * resolution (Penpot vs .fig vs IDML inside a zip, PDF page interpretation)
 * still happens solely in parseDesignFile once a design file reaches it.
 * design-import's own sniffers are module-private and ship in the heavy
 * kiwi/zstd chunk, which a JPEG drop should never pull in.
 *
 * House rules honoured: handlers attach to the given root only (never window/
 * document), preventDefault fires only for actual file drags, the chooser is
 * mountModal-based (via choiceDialog — Escape/backdrop close), and the DOM
 * cost is one hint pill per attached root.
 */

import { t, tRaw } from '../i18n.ts';
import { NAV_EVENTS } from '../utils.ts';
import { announce } from '../a11y.ts';
import { playSfx } from './sfx.ts';
import { choiceDialog, closeConfirmDialogs } from '../components/confirm-dialog.ts';
import type { DialogChoice } from '../components/confirm-dialog.ts';
import { setPendingVerify } from './verify-handoff.ts';
import type { PickerHost } from '../views/picker.ts';
import type { BeamPackHost } from './beam-pack.ts';

type PickerModule = typeof import('../views/picker.ts');

/** Everything the file-picker fallback should let through — a superset of the
 *  picker's UPLOAD_ACCEPT (that list deliberately excludes design formats). */
const UNIVERSAL_ACCEPT =
  '.fig,.penpot,.zip,.tar,.tgz,.gz,.svg,.idml,.indd,.pdf,.ai,.pptx,.psd,.psb,.xcf,image/*,video/*,audio/*,' +
  '.mov,.json,.lottie,.mp3,.wav,.ogg,.m4a,.flac,.bmp,.ico,.cur,.svgz,.lolly';

// Extension fallbacks for files whose MIME type the OS didn't fill in.
const DESIGN_EXT_RE = /\.(fig|penpot|idml|indd|svg|zip)$/i;
// .bmp/.ico usually arrive with an image/* MIME (already accepted); the ext entries are
// the blank-MIME backstop. .svgz is media/library only (svgz-as-design would need a
// gunzip step in parseDesignFile).
const MEDIA_EXT_RE = /\.(png|apng|jpe?g|webp|gif|avif|heic|heif|svg|svgz|bmp|ico|cur|mp4|webm|mov|mp3|wav|ogg|oga|opus|m4a|aac|flac|mid|midi|mod|xm|it|s3m|stm|mtm|json|lottie)$/i;
// Plain archives the shell can explode into member assets. EXCLUDES the design
// bundles (.penpot/.fig/.idml/.indd) and the OOXML/OCF packages (.xlsx/.docx/.pptx/
// .epub/.odt) — those are zips too but route to their own readers. This is a cheap
// name gate for the chooser; the authoritative byte check (never shred an office
// file) lives in archive-ingest.readArchiveMembers, run when the user commits.
const ARCHIVE_EXT_RE = /\.(zip|tar|tar\.gz|tgz)$/i;
const PURE_DESIGN_EXT_RE = /\.(fig|penpot|idml|indd)$/i;
const CONTAINER_DOC_EXT_RE = /\.(xlsx|docx|pptx|epub|odt)$/i;
// Design-system shapes (plan 97 §8). A Penpot project always carries a token
// document; the zip/JSON cases need evidence, below.
const PENPOT_EXT_RE = /\.penpot$/i;
const JSON_EXT_RE = /\.json$/i;
/** How much of a JSON drop the router is willing to parse just to decide which
 *  routes to OFFER. Bigger token documents still import fine through the
 *  studio's own source picker; they just don't get the shortcut here. */
export const TOKENS_SNIFF_MAX_BYTES = 4 * 1024 * 1024;

// ── one-shot handoff stashes (the verify-handoff pattern) ──────────────────────

let pendingDesign: { file: File; scenes: boolean } | null = null;

/** Consume the design file stashed by a drop route into Design — single use,
 *  cleared on read. free-canvas checks this on mount. `scenes` carries the
 *  "as timed scenes vs replace the board" choice the drop door offered
 *  (plans/104 §337): the "Make a video from its frames" door sets it true. */
export function takePendingDesignImport(): { file: File; scenes: boolean } | null {
  const d = pendingDesign;
  pendingDesign = null;
  return d;
}

let pendingDesignSystemFile: File | null = null;

/**
 * Consume the file stashed by the "Use as the design system" route — single use,
 * cleared on read, never written to disk. `views/start.ts` reads it on mount and
 * routes it by what it IS (a PDF opens the PDF source and scans it; a token
 * document, Penpot project or pack lands on the design-file card), so the studio
 * never asks a second time for a file the person already handed over.
 *
 * Every route below that reaches the studio arms it, including the PDF one — a
 * guidelines PDF is design-system material even though the sniff files it under
 * `pdf` (its colours, marks and embedded faces are the whole point of plan 97 §8's
 * PDF source).
 */
export function takePendingDesignSystemFile(): File | null {
  const f = pendingDesignSystemFile;
  pendingDesignSystemFile = null;
  return f;
}

let pendingToolFile: { toolId: string; file: File } | null = null;

/** Consume a file stashed for a specific tool (e.g. compress-pdf). Single use;
 *  returns null when the stash belongs to a different tool. NOTE: views/tool.ts
 *  does not consume this yet — until it does, the compress route simply lands
 *  the user on the tool's own (empty) drop canvas. */
export function takePendingToolFile(toolId: string): File | null {
  if (pendingToolFile?.toolId !== toolId) return null;
  const f = pendingToolFile.file;
  pendingToolFile = null;
  return f;
}

let pendingToolSeed: { toolId: string; values: Record<string, unknown> } | null = null;

/** Arm a one-shot initial-values seed for `toolId` — the layered-import route
 *  (psd-import) parses + stores layer assets BEFORE navigating, then stashes
 *  the block rows here; views/tool.ts folds them into initialValues on mount. */
export function setPendingToolSeed(toolId: string, values: Record<string, unknown>): void {
  pendingToolSeed = { toolId, values };
}

/** Consume the seed stashed for `toolId`. Single use; null for other tools. */
export function takePendingToolSeed(toolId: string): Record<string, unknown> | null {
  if (pendingToolSeed?.toolId !== toolId) return null;
  const v = pendingToolSeed.values;
  pendingToolSeed = null;
  return v;
}

// ── sniffing ───────────────────────────────────────────────────────────────────

export interface Sniff {
  design: boolean;
  pdf: boolean;
  pptx: boolean;
  media: boolean;
  c2pa: boolean;
  /** A layered bitmap (Photoshop PSD/PSB or GIMP XCF). */
  layers: boolean;
  /** A plain archive (.zip/.tar/.tar.gz) we can explode into member assets. */
  archive: boolean;
  /** Design-system material (plan 97 §8): a DTCG/Tokens-Studio token document,
   *  a Penpot project, or a zip whose parts say design-system pack. Additive —
   *  it never suppresses a route another flag already earned. */
  designSystem: boolean;
  /** A `.lolly` share file (plans/114) — a saved session + its assets + provenance.
   *  It IS a zip, so it must be recognised before the generic design/archive routes
   *  claim it; it opens directly (no chooser), never "unpacks". */
  lolly: boolean;
}

const isMediaFile = (f: File): boolean =>
  /^(image|video|audio)\//.test(f.type) || MEDIA_EXT_RE.test(f.name);

/**
 * True when a zip's head lists the parts a design-system container is made of.
 * A zip's LOCAL FILE HEADERS store entry names uncompressed, so a bounded head
 * read can name a zip's first entries even when their bodies are deflated —
 * which is the whole reason this is affordable at drop time. The pairings
 * mirror what `design-system/sources/file.ts` keys on when it really opens the
 * archive: a Lolly pack (`manifest.json` + `tokens.json`), a Penpot project
 * (same pair, tokens per file), a loose token-set export (`$metadata.json` /
 * `$themes.json`). Deliberately a heuristic: the authoritative read happens in
 * the studio, and the cost of a wrong guess here is one extra route offered.
 * Pure — exported for the co-located test.
 */
export function zipListsDesignSystemParts(head: string): boolean {
  if (head.includes('$metadata.json') || head.includes('$themes.json')) return true;
  return head.includes('manifest.json') && head.includes('tokens.json');
}

/**
 * True when an already-parsed JSON object is shaped like a token document:
 * Tokens-Studio container keys, a DTCG `$value` leaf, or the legacy
 * Tokens-Studio `{ value, type }` leaf. `coerceTokensDoc` alone answers yes to
 * ANY JSON object (it only rejects arrays/primitives), so a dropped Lottie or
 * GeoJSON would otherwise be offered as a design system.
 *
 * Bounded on purpose — a fixed node/depth budget, so the check costs the same
 * on a 40-token file and on a huge unrelated document. A token doc puts its
 * leaves shallow, so the budget only ever truncates material we would not have
 * recognised anyway. Pure — exported for the co-located test.
 */
export function looksLikeTokenDoc(doc: unknown, maxNodes = 4000, maxDepth = 8): boolean {
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return false;
  const root = doc as Record<string, unknown>;
  // Own keys only, everywhere: a token set is user-supplied JSON, so an
  // inherited `value`/`type` must never pass for a token leaf.
  if (Object.hasOwn(root, '$themes') || Object.hasOwn(root, '$metadata')) return true;
  let budget = maxNodes;
  const stack: Array<{ node: Record<string, unknown>; depth: number }> = [{ node: root, depth: 0 }];
  while (stack.length) {
    const { node, depth } = stack.pop()!;
    if (budget-- <= 0) return false;
    if (Object.hasOwn(node, '$value')) return true;
    if (Object.hasOwn(node, 'value') && Object.hasOwn(node, 'type') && typeof node.type === 'string') return true;
    if (depth >= maxDepth) continue;
    for (const child of Object.values(node)) {
      if (typeof child === 'object' && child !== null && !Array.isArray(child)) {
        stack.push({ node: child as Record<string, unknown>, depth: depth + 1 });
      }
    }
  }
  return false;
}

/**
 * The JSON half of the design-system sniff: a `.json` drop small enough to
 * parse, whose first non-blank byte is `{` (the head read answers that without
 * touching the rest), that survives the engine's own `coerceTokensDoc` and then
 * looks like tokens. The engine import is lazy so a JPEG drop never pays for it.
 */
async function looksLikeTokensFile(file: File, head: string): Promise<boolean> {
  const jsonish = JSON_EXT_RE.test(file.name) || /^(application|text)\/json$/.test(file.type);
  if (!jsonish || file.size > TOKENS_SNIFF_MAX_BYTES) return false;
  // Leading whitespace, or a UTF-8 BOM (latin1-decoded to EF BB BF), then '{'.
  if (!/^[\s\uFEFF\u00EF\u00BB\u00BF]*\{/.test(head)) return false;
  try {
    const { coerceTokensDoc } = await import('@lolly/engine');
    const { doc } = coerceTokensDoc(JSON.parse(await file.text()));
    return !!doc && looksLikeTokenDoc(doc);
  } catch {
    return false; // unreadable or not JSON after all — no route, no error
  }
}

/**
 * Classify one file by name/MIME plus (when `deep`) a bounded head read — 64 KB,
 * enough for the zip/PDF/SVG magic and a C2PA marker scan, never the whole file.
 */
async function sniffFile(file: File, deep: boolean, picker: PickerModule): Promise<Sniff> {
  const pptx = picker.isPptxUpload(file);
  let head: Uint8Array | null = null;
  if (deep) {
    try {
      head = new Uint8Array(await file.slice(0, 64 * 1024).arrayBuffer());
    } catch { /* unreadable — fall back to name/MIME only */ }
  }
  // latin1 keeps a 1:1 byte↔char mapping, so regex offsets equal byte offsets.
  const text = head ? new TextDecoder('latin1').decode(head) : '';
  // "%PDF" within the first 1 KB (the spec permits a little leading junk) —
  // mirrors design-import's isPdf window without pulling its chunk in.
  const pdf = picker.isPdfUpload(file) || text.slice(0, 1028).includes('%PDF');
  const zipMagic = !!head && head.length >= 4
    && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
  const svgText = /<svg[\s>]/i.test(text.slice(0, 4096));
  // A .lolly is a zip; recognise it by extension so the generic design/archive routes
  // (which zip-magic would otherwise trigger) never claim it — it opens directly. Also
  // accept the canonical MIME (LOLLY_MIME) for a share that arrives typed but with a
  // mangled name (e.g. Android ACTION_SEND of application/vnd.lolly+zip).
  const lolly = /\.lolly$/i.test(file.name) || file.type === 'application/vnd.lolly+zip';
  // JUMBF box type / C2PA manifest label / PNG caBX chunk — a heuristic "this
  // carries Content Credentials" signal, not a verification (that's /verify's job).
  const c2pa = /jumb|c2pa|caBX/.test(text);
  // Layered bitmaps: '8BPS' (PSD/PSB) or 'gimp xcf ' at offset 0 — the same
  // prefix check as the engine's sniffLayeredRaster, inlined so a JPEG drop
  // never pulls the engine chunk. Extension fallback for a blank OS MIME.
  const layers = head
    ? ((head[0] === 0x38 && head[1] === 0x42 && head[2] === 0x50 && head[3] === 0x53)
      || text.startsWith('gimp xcf '))
    : /\.(psd|psb|xcf)$/i.test(file.name);
  const design = !lolly && !pdf && !pptx && !layers && (DESIGN_EXT_RE.test(file.name) || zipMagic || svgText);
  // A plain archive: a zip/tar by name, or PK-magic bytes that aren't a design
  // bundle. Design bundles and office/OCF packages (zips too) are excluded so the
  // "unpack" route never competes for a .penpot or shreds a .xlsx.
  const archive = !lolly && !layers && !PURE_DESIGN_EXT_RE.test(file.name) && !CONTAINER_DOC_EXT_RE.test(file.name)
    && (ARCHIVE_EXT_RE.test(file.name) || (zipMagic && !DESIGN_EXT_RE.test(file.name)));
  // Design-system material (plan 97 §8), sniffed LAST and only on the deep
  // (single-file) path — the route is a single-file journey, and every flag
  // above is computed exactly as it was before this one existed. A .penpot is
  // one by extension; a zip needs its parts named; a .json has to parse.
  const designSystem = !lolly && deep && !pdf && !pptx && !layers
    && (PENPOT_EXT_RE.test(file.name)
      ? true
      : zipMagic || /\.zip$/i.test(file.name)
        ? zipListsDesignSystemParts(text)
        : await looksLikeTokensFile(file, text));
  // A PSD/XCF often carries an image/* MIME — the layered routes own it, not
  // the plain media ones (the library route still exists, as a flatten).
  return { design, pdf, pptx, media: isMediaFile(file) && !layers, c2pa, layers, archive, designSystem, lolly };
}

const toolExists = (id: string): boolean =>
  ((window as { __toolIndex?: { tools?: Array<{ id: string }> } }).__toolIndex?.tools ?? [])
    .some((tool) => tool.id === id);

// ── what the sheet offers, and what it says (pure) ─────────────────────────────
// Extracted from openDropChooser so the routing decisions can be pinned by a node
// test: which routes appear, which one LEADS, and which sentence names the
// destination. Everything below is a function of the sniff — no DOM, no navigation.

/** The chooser's surroundings: how many files, whether they can all be ingested
 *  as media, and which tools this build actually has. */
export interface ChooserContext {
  single: boolean;
  count: number;
  allIngestable: boolean;
  has: (toolId: string) => boolean;
}

/**
 * The routes on offer, in the order they are shown, with exactly one marked
 * `primary` (the highlighted default).
 *
 * A note on the archive route: it leads for a plain zip, because exploding it
 * into member assets is what a dropped archive usually means. It must NOT lead
 * for a zip the sniff positively identified as a design-system pack — unpacking
 * that shreds it into loose library files, which is the opposite of installing
 * it, and it is the one archive whose real destination we know (plan 97 §14.9:
 * a door names where it lands). So the studio goes first there, and unpack
 * stays available underneath.
 */
export function dropChooserChoices(s: Sniff, ctx: ChooserContext): DialogChoice[] {
  const { single, allIngestable, has } = ctx;
  const choices: DialogChoice[] = [];
  const packZip = single && s.archive && s.designSystem;
  if (single && s.layers && has('layer-stack')) {
    choices.push({ id: 'layers', label: t('Open as layers'), primary: true });
  }
  if (single && s.layers && has('design')) {
    choices.push({ id: 'design', label: t('Edit in Design') });
  }
  if (single && s.layers) {
    choices.push({ id: 'flatten', label: t('Add the flattened image to your library') });
  }
  if (packZip) {
    choices.push({ id: 'design-system', label: t('Use as the design system'), primary: true });
  }
  // A plain archive leads with "unpack": a dropped .zip/.tar explodes into member
  // assets, each re-imported through the normal library path. Kept above the design
  // route so a data zip isn't primarily offered to Design (where it errors).
  if (single && s.archive) {
    choices.push({ id: 'unpack', label: t('Unpack archive to your library'), primary: !packZip });
  }
  if (single && (s.design || s.pdf) && has('design')) {
    choices.push({ id: 'design', label: t('Edit in Design'), primary: !s.archive });
  }
  // The Design System studio door, next to the Design one so the two
  // .penpot destinations read as a pair (plan 97 §14.9). It leads only when no
  // earlier route already claimed the call-to-action, so nothing above it moves.
  if (single && s.designSystem && !packZip) {
    choices.push({
      id: 'design-system',
      label: t('Use as the design system'),
      primary: !choices.some((c) => c.primary),
    });
  }
  // Frames → timed scenes: the same design/PDF sniff can open in Design as a video
  // sequence, each frame a timed scene (free-canvas's scene-mode import consumes the
  // stash on mount). The other half of the §337 "as scenes vs replace the board" choice.
  if (single && (s.design || s.pdf) && has('design')) {
    choices.push({ id: 'sequence', label: t('Make a video from its frames') });
  }
  // A .penpot can carry per-shape export marks; the ingest bakes them through an
  // offscreen Design render, so the route needs that tool. Whether the zip
  // really is a marked-up Penpot file resolves inside the ingest (it throws a
  // user-ready message otherwise).
  if (single && s.design && has('design')) {
    choices.push({ id: 'exports', label: t('Add its marked exports to your library') });
  }
  if (single && s.pdf) {
    choices.push({ id: 'library', label: t('Add pages to your library') });
    // A guidelines PDF is the richest design-system file most teams have — its
    // artwork carries the marks and the palette, and it embeds the real font
    // programs (plan 97 §8's PDF source). It sits with the other "what is inside
    // this document" routes and never LEADS: a PDF's first meaning is a document,
    // and the sniff cannot tell guidelines from an invoice. The guard is
    // defensive — `sniffFile` never reports `designSystem` for a PDF, so the
    // branch above cannot have offered this door, but a door offered twice in one
    // sheet would be a worse bug than one line of belt and braces.
    if (!choices.some((c) => c.id === 'design-system')) {
      choices.push({ id: 'design-system', label: t('Use as the design system') });
    }
    if (has('compress-pdf')) choices.push({ id: 'compress', label: t('Compress this PDF') });
  }
  if (single && s.pptx) {
    choices.push({ id: 'library', label: t('Add slides to your library'), primary: true });
  }
  if ((single && s.media && !s.pdf && !s.pptx) || (!single && allIngestable)) {
    choices.push({ id: 'library', label: t('Add to your library'), primary: choices.length === 0 });
  }
  const unknown = single && !s.design && !s.pdf && !s.pptx && !s.media;
  // Provenance applies to media, to anything carrying C2PA-looking bytes, to
  // unknown formats — and as the last resort when no other route landed.
  if (s.media || s.c2pa || unknown || choices.length === 0) {
    choices.push({ id: 'verify', label: t('Check Content Credentials') });
  }
  return choices;
}

/**
 * The sentence above the routes. The ladder is ordered by how much it tells the
 * user: "an archive" says almost nothing, so a zip the sniff can actually name
 * (a design-system pack) is named first — otherwise the file's real destination
 * never appears in the copy at all.
 */
export function dropChooserMessage(s: Sniff, name: string, ctx: ChooserContext): string {
  if (!ctx.single) return t('{n} files are ready to import.', { n: ctx.count });
  if (s.layers) return tRaw('“{name}” is a layered image (Photoshop/GIMP).', { name });
  if (s.pdf) return tRaw('“{name}” is a PDF or Illustrator document.', { name });
  if (s.pptx) return tRaw('“{name}” is a PowerPoint deck.', { name });
  // Two doors, so the sentence names both destinations rather than leaving
  // "design file" to stand for either of them (plan 97 §14.9).
  if (s.designSystem && s.design && ctx.has('design')) {
    return tRaw('“{name}” can open in Design or install as the design system.', { name });
  }
  if (s.designSystem) return tRaw('“{name}” looks like a design system.', { name });
  if (s.archive) return tRaw('“{name}” is an archive.', { name });
  if (s.design) return tRaw('“{name}” looks like a design file.', { name });
  if (s.media) return tRaw('“{name}” is ready to import.', { name });
  return tRaw('“{name}” isn’t a format Lolly can import directly.', { name });
}

// ── the chooser sheet ──────────────────────────────────────────────────────────

/**
 * Sniff the dropped/picked file(s) and offer the applicable routes. Built on
 * choiceDialog (mountModal + .btn primitives; Escape/backdrop cancel). Multi-file
 * drops keep only the batch routes (library / verify) — the design and PDF routes
 * are single-file journeys.
 */
/** Open a dropped/shared `.lolly`: land its assets + session (reusing the beam ingest
 *  via lib/lolly-pack.ts), then navigate into the tool at the imported session. Lazy
 *  import keeps the pack/ingest code off the drop cold path. */
async function importLollyDrop(file: File, host: PickerHost): Promise<void> {
  try {
    const { ingestLollyFile } = await import('./lolly-pack.ts');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const res = await ingestLollyFile(bytes, host as unknown as BeamPackHost);
    playSfx('drop');
    announce(tRaw('Opened {name}', { name: file.name }));
    const hash = `#/tool/${res.toolId}?slot=${encodeURIComponent(res.slot)}`;
    routeToConsumer(hash, window.location.hash === hash);
  } catch (err) {
    announce(tRaw('Could not open this .lolly file: {message}', { message: (err as Error).message }), { assertive: true });
  }
}

export async function openDropChooser(
  files: File[],
  host: PickerHost,
  opts: { superseded?: () => boolean } = {},
): Promise<void> {
  if (!files.length) return;
  const picker = await import('../views/picker.ts');
  const single = files.length === 1;
  const first = files[0]!;
  const s = await sniffFile(first, single, picker);
  // A newer share superseded this one while the picker chunk / head read was in
  // flight — don't mount a stale chooser next to (or after) the replacement's.
  if (opts.superseded?.()) return;

  // A .lolly opens directly — it is unambiguous (a saved session + its assets), so it
  // skips the chooser entirely and lands the user in the tool at the imported session.
  if (s.lolly) { await importLollyDrop(first, host); return; }
  const allIngestable = files.every(
    (f) => isMediaFile(f) || picker.isPdfUpload(f) || picker.isPptxUpload(f),
  );

  const ctx: ChooserContext = { single, count: files.length, allIngestable, has: toolExists };
  const choices = dropChooserChoices(s, ctx);
  const message = dropChooserMessage(s, first.name, ctx);

  const chosen = await choiceDialog({
    title: single ? t('What should Lolly do with this file?') : t('What should Lolly do with these files?'),
    message,
    choices,
    // Scopes closeConfirmDialogs so a rapid next drop/share only supersedes a
    // still-open chooser of THIS kind — never an unrelated confirm/prompt dialog
    // open elsewhere in the app (see initShareTargetIngest's poll()).
    tag: 'drop-chooser',
  });
  if (!chosen) return;

  switch (chosen) {
    case 'layers': {
      // Parse + store per-layer assets BEFORE navigating (the dialog for
      // flat-vs-grouped lives inside), then arm the seed and go.
      try {
        const { importLayeredFileAsSeed } = await import('../views/psd-import.ts');
        const seed = await importLayeredFileAsSeed(host, first, {
          warn: (m: string) => announce(m, { assertive: true }),
        });
        if (!seed) break; // user cancelled the flat/grouped dialog
        setPendingToolSeed('layer-stack', seed);
        playSfx('drop');
        routeToConsumer('#/tool/layer-stack', onToolRoute('layer-stack'));
      } catch (err) {
        announce(tRaw('Import failed: {message}', { message: (err as Error).message }), { assertive: true });
      }
      break;
    }
    case 'flatten': {
      try {
        const { ingestLayeredFileFlattened } = await import('../views/psd-import.ts');
        await ingestLayeredFileFlattened(host, first);
        playSfx('drop');
        announce(t('Added 1 file to your library.'));
      } catch (err) {
        announce(tRaw('Upload failed: {message}', { message: (err as Error).message }), { assertive: true });
      }
      break;
    }
    case 'design':
      pendingDesign = { file: first, scenes: false };
      routeToConsumer('#/tool/design', onToolRoute('design'));
      break;
    case 'sequence':
      // "Make a video from its frames" — the same design opens in Design, but each
      // frame becomes a timed scene (plans/104 §337; Sequence Studio's old home for
      // this route retired into Design).
      pendingDesign = { file: first, scenes: true };
      routeToConsumer('#/tool/design', onToolRoute('design'));
      break;
    case 'design-system':
      // The studio's own import flow owns the parsing — colours, fonts, logos,
      // the semantic-mapping review and the PDF scan all live there — so this
      // route hands over the FILE and names the source it needs. views/start.ts
      // consumes the stash on mount (takePendingDesignSystemFile) and opens the
      // stage that file wants; the `?source=` is what it falls back to if the
      // stash has already been spent.
      pendingDesignSystemFile = first;
      routeToConsumer(
        s.pdf ? '#/start?source=pdf' : '#/start?source=file',
        /^#\/start([?/]|$)/.test(window.location.hash),
      );
      break;
    case 'compress':
      pendingToolFile = { toolId: 'compress-pdf', file: first };
      routeToConsumer('#/tool/compress-pdf', onToolRoute('compress-pdf'));
      break;
    case 'verify':
      setPendingVerify({ files });
      routeToConsumer('#/verify', /^#\/(verify|valid|v)([?/]|$)/.test(window.location.hash));
      break;
    case 'library':
      await ingestToLibrary(files, host, picker);
      break;
    case 'unpack': {
      // Explode the archive to its members, then feed them through the SAME library
      // ingest as any multi-file drop. readArchiveMembers refuses an office/OCF
      // package (never shreds a .xlsx) and enforces the member/byte caps.
      try {
        const { readArchiveMembers } = await import('./archive-ingest.ts');
        const bytes = new Uint8Array(await first.arrayBuffer());
        const members = readArchiveMembers(bytes, first.name);
        const memberFiles = members.map(
          (m) => new File([m.bytes as BlobPart], m.name.split('/').pop() || m.name),
        );
        await ingestToLibrary(memberFiles, host, picker);
      } catch (err) {
        announce(tRaw('Upload failed: {message}', { message: (err as Error).message }), { assertive: true });
      }
      break;
    }
    case 'exports':
      await ingestExportsToLibrary(first, host);
      break;
  }
}

// ── routing that survives the shell's same-route dedup ────────────────────────

/** True when the CURRENT location is already inside tool `id` — either routing
 *  form (the #/tool/<id> hash, or the canonical /t/<id> path the tool view's
 *  syncUrl rewrites the address bar to). Tool ids are [a-z0-9-], regex-safe. */
const onToolRoute = (id: string): boolean =>
  new RegExp(`^#/tool/${id}([?/]|$)`).test(window.location.hash)
  || new RegExp(`^/t/${id}([?/]|$)`).test(window.location.pathname);

/** Navigate to `hash`. Every stash this router arms is consumed at MOUNT time
 *  (free-canvas / views/tool.ts / valid.ts), but main.ts's navigate() dedupes a
 *  hash change resolving to the already-mounted route — and a share can arrive
 *  while the user is ALREADY inside the destination view. In that case ask the
 *  shell for a forced remount via its 'lolly:remount' seam so the stash is
 *  still consumed; plain drops (gallery/dashboard only) never hit it. */
function routeToConsumer(hash: string, alreadyThere: boolean): void {
  if (window.location.hash !== hash) window.location.hash = hash;
  if (alreadyThere) window.dispatchEvent(new Event('lolly:remount'));
}

/**
 * The library route — the same sequential ingest loop as lib/upload-dropzone.ts:
 * PDFs/decks convert page(s)/slide(s) to SVG assets via their lazy chunks,
 * everything else stores through storeUserUpload (downscale/sanitise/credential-
 * preserve). Sequential on purpose: parallel decodes of a big drop spike memory.
 */
async function ingestToLibrary(files: File[], host: PickerHost, picker: PickerModule): Promise<void> {
  // Drop a folder extracted from a macOS zip and its `._` AppleDouble stubs / .DS_Store
  // arrive as ordinary File drops; skip them so they never become blank "BIN" assets.
  // (The 'unpack' path's members are already filtered in readArchiveMembers; this also
  // covers the direct 'library' multi-file drop.)
  const { isIgnoredUploadName } = await import('./archive-ingest.ts');
  files = files.filter((f) => !isIgnoredUploadName(f.name));
  let stored = 0;
  for (const file of files) {
    try {
      if (picker.isPdfUpload(file)) {
        const { ingestPdfAsSvgAssets } = await import('../views/pdf-import.ts');
        stored += (await ingestPdfAsSvgAssets(host, file, {
          mode: 'multi',
          warn: (m: string) => announce(m, { assertive: true }),
        })).length;
      } else if (picker.isPptxUpload(file)) {
        const { ingestPptxAsSvgAssets } = await import('../views/pptx-import.ts');
        stored += (await ingestPptxAsSvgAssets(host, file, {
          mode: 'multi',
          warn: (m: string) => announce(m, { assertive: true }),
        })).length;
      } else {
        await picker.storeUserUpload(host, file);
        stored += 1;
      }
    } catch (err) {
      // Cap/quota errors carry a user-ready message; prefix only the rest.
      announce(
        (err as { code?: unknown }).code
          ? (err as Error).message
          : tRaw('Upload failed: {message}', { message: (err as Error).message }),
        { assertive: true },
      );
    }
  }
  if (!stored) return;
  playSfx('drop');
  announce(stored === 1
    ? t('Added 1 file to your library.')
    : t('Added {n} files to your library.', { n: stored }));
}

// The exports route — every shape marked for export in Penpot becomes stored
// library assets at its marked formats and scales. The heavy design-import chunk
// loads lazily, same as the PDF/deck routes above.
async function ingestExportsToLibrary(file: File, host: PickerHost): Promise<void> {
  try {
    const { ingestPenpotExportsAsAssets } = await import('../views/design-import.ts');
    const refs = await ingestPenpotExportsAsAssets(
      host as unknown as Parameters<typeof ingestPenpotExportsAsAssets>[0],
      file,
      { warn: (m: string) => announce(m, { assertive: true }) },
    );
    if (!refs.length) return;
    playSfx('drop');
    announce(refs.length === 1
      ? t('Added 1 export to your library.')
      : t('Added {n} exports to your library.', { n: refs.length }));
  } catch (err) {
    announce(
      (err as { code?: unknown }).code
        ? (err as Error).message
        : tRaw('Upload failed: {message}', { message: (err as Error).message }),
      { assertive: true },
    );
  }
}

// ── scoped drag-and-drop attachment ────────────────────────────────────────────

// One live attachment per root: same-route re-mounts (the gallery re-mounts
// after a catalog sync) replace theirs instead of stacking listeners.
const ATTACHED = new WeakMap<HTMLElement, () => void>();

/**
 * Attach the drop router to a view root. Only file drags are handled (text/image
 * drags keep their browser defaults untouched); while one hovers, the root gains
 * `.is-file-drag` and a small hint pill (styled by the view's own stylesheet).
 * The shell reuses one #view element across routes, so the attachment tears
 * itself down on any navigation — a tool view can never inherit it. Returns the
 * teardown for callers that want it earlier.
 */
export function attachDropRouter(rootEl: HTMLElement, host: PickerHost): () => void {
  ATTACHED.get(rootEl)?.();
  const ac = new AbortController();
  const { signal } = ac;
  let depth = 0;
  let hint: HTMLElement | null = null;

  const isFileDrag = (e: DragEvent): boolean => !!e.dataTransfer?.types?.includes('Files');
  const showHint = (on: boolean): void => {
    if (on) {
      if (!hint) {
        hint = document.createElement('div');
        hint.className = 'drop-hint';
        hint.setAttribute('aria-hidden', 'true');
        hint.textContent = t('Drop to import');
      }
      // (Re-)append: a same-route innerHTML repaint may have orphaned the pill.
      if (!hint.isConnected) rootEl.appendChild(hint);
    } else {
      depth = 0;
    }
    rootEl.classList.toggle('is-file-drag', on);
  };

  rootEl.addEventListener('dragenter', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    depth++;
    showHint(true);
  }, { signal });
  rootEl.addEventListener('dragover', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault(); // required, or the drop never fires
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  }, { signal });
  rootEl.addEventListener('dragleave', (e) => {
    if (!isFileDrag(e)) return;
    // A depth counter tracks enter/leave across child nodes so the hint
    // doesn't flicker as the pointer crosses them.
    if (--depth <= 0) showHint(false);
  }, { signal });
  rootEl.addEventListener('drop', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    showHint(false);
    const files = [...(e.dataTransfer?.files ?? [])];
    if (files.length) void openDropChooser(files, host);
  }, { signal });

  const teardown = (): void => {
    ac.abort();
    hint?.remove();
    rootEl.classList.remove('is-file-drag');
    NAV_EVENTS.forEach((ev) => window.removeEventListener(ev, teardown));
    if (ATTACHED.get(rootEl) === teardown) ATTACHED.delete(rootEl);
  };
  NAV_EVENTS.forEach((ev) => window.addEventListener(ev, teardown));
  ATTACHED.set(rootEl, teardown);
  return teardown;
}

/**
 * No-drag fallback (the welcome dialog's "Bring your design" tile): a native
 * file picker that feeds the same chooser. The input is parked on <body> and
 * removed on change/cancel.
 */
export function openDropFilePicker(host: PickerHost): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.accept = UNIVERSAL_ACCEPT;
  input.style.display = 'none';
  document.body.appendChild(input);
  const done = (): void => input.remove();
  input.addEventListener('change', () => {
    const files = [...(input.files ?? [])];
    done();
    if (files.length) void openDropChooser(files, host);
  });
  input.addEventListener('cancel', done);
  input.click();
}

// ── Android share-target ingest (ACTION_SEND → the same chooser) ──────────────

/** The share-target half of the `LollyShare` JS interface the Android shell's
 *  MainActivity registers (the same object carries the export share-OUT verb
 *  shareFile used by tauri-mobile's export override — hence the per-verb
 *  feature-detect in initShareTargetIngest, not a bare `window.LollyShare`
 *  check). Poll returns a JSON stash descriptor, or '' when nothing pends. */
interface LollyShareBridge {
  sharedFilePoll(): string;
  sharedFileChunk(i: number): string;
  sharedFileConsumed(): void;
}

/**
 * Decode the Android bridge's base64 chunks (1 MiB of raw bytes each) into one
 * contiguous buffer. `read` is injected so chunks stream straight off the JS
 * interface without first materialising a string[]. Whitespace is stripped
 * before decode (android.util.Base64.DEFAULT wraps lines; browsers' forgiving
 * base64 tolerates that, Node's atob historically didn't). Pure — exported for
 * the co-located test.
 */
export function assembleShareChunks(count: number, read: (i: number) => string): Uint8Array<ArrayBuffer> {
  const parts: Uint8Array[] = [];
  let total = 0;
  for (let i = 0; i < count; i++) {
    const bin = atob(read(i).replace(/\s+/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let j = 0; j < bin.length; j++) bytes[j] = bin.charCodeAt(j);
    parts.push(bytes);
    total += bytes.length;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/**
 * Android share-target ingest: MainActivity stashes an ACTION_SEND stream and
 * exposes it over `LollyShare`; a share arriving while the WebView is alive
 * also dispatches 'lolly-share-target' on window. Feature-detected on the poll
 * verb, so everywhere except the Android app this is a cheap no-op. A pending
 * share runs through the exact chooser a dropped file gets — the sheet is
 * body-mounted (mountModal) and every route is a hash navigation (or a forced
 * remount, see routeToConsumer), so it works from whichever view the share
 * lands on. Rapid successive shares: latest wins — a still-open chooser from
 * the previous share is dismissed (closeConfirmDialogs, scoped to the
 * 'drop-chooser' tag every openDropChooser sheet carries, so an unrelated
 * confirm/prompt dialog open elsewhere in the app is never swept up in it) or,
 * if its sniff is still in flight, superseded before it mounts; choosers are
 * never queued.
 * Call once at boot, after the first view has mounted (main.ts).
 */
export function initShareTargetIngest(host: PickerHost): void {
  const bridge = (window as unknown as { LollyShare?: Partial<LollyShareBridge> }).LollyShare;
  if (typeof bridge?.sharedFilePoll !== 'function'
    || typeof bridge.sharedFileChunk !== 'function'
    || typeof bridge.sharedFileConsumed !== 'function') return;
  const share = bridge as LollyShareBridge;
  let seq = 0;
  const poll = (): void => {
    const raw = share.sharedFilePoll();
    if (!raw) return;
    let file: File | null = null;
    try {
      const meta = JSON.parse(raw) as { name?: string; mime?: string; chunks?: number };
      const bytes = assembleShareChunks(meta.chunks ?? 0, (i) => share.sharedFileChunk(i));
      file = new File([bytes], meta.name || 'shared-file', { type: meta.mime || '' });
    } catch { /* malformed stash — still consumed below so it can't wedge future polls */ }
    share.sharedFileConsumed();
    if (!file) return;
    const mine = ++seq;
    closeConfirmDialogs('drop-chooser');
    void openDropChooser([file], host, { superseded: () => mine !== seq });
  };
  window.addEventListener('lolly-share-target', poll);
  poll(); // cold start: the launching intent was stashed before this JS booted
}
