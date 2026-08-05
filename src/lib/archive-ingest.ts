// SPDX-License-Identifier: MPL-2.0
/**
 * Explode a dropped plain archive (.zip / .tar / .tar.gz) into its member files so
 * each can be re-imported as its own asset. The counterpart to the engine's archive
 * WRITERS (storeZip / packTar); this is the read side that makes ZIP and tar
 * round-trip in the shell.
 *
 * The load-bearing guard: a zip is only exploded once `classifyZipBytes` confirms it
 * is a PLAIN archive. An OOXML/OCF package (.xlsx/.docx/.pptx/.epub/.odt) shares the
 * PK magic, so shredding one into raw XML parts would be a data-loss bug — those get
 * a clear "route it to its own reader" error instead. Members are bounded by a count
 * and an aggregate-byte cap (zip-bomb defence), mirroring xlsx-import's budget.
 */

import { readZip, readTar, readTarGz, sniffContainer } from '@lolly/engine';
import { classifyZipBytes } from './zip-classify.ts';

/** Most members a single archive may explode into. */
export const MAX_ARCHIVE_MEMBERS = 200;
/** Aggregate uncompressed bytes an archive may expand to before we refuse it. */
export const MAX_ARCHIVE_TOTAL_BYTES = 256 * 1024 * 1024;

export interface ArchiveMember {
  /** The member's path within the archive (directories stripped by the readers). */
  name: string;
  bytes: Uint8Array;
}

/** Thrown with a user-facing message when the bytes are not a plain archive, or bust a cap. */
export class ArchiveIngestError extends Error {}

const isTarGzName = (name: string): boolean => /\.(tar\.gz|tgz)$/i.test(name);

/**
 * OS bookkeeping junk that rides along in an archive (or a dragged folder) but is not a
 * user asset. A macOS-made zip carries a `__MACOSX/` tree of `._name` AppleDouble
 * resource-fork stubs beside every real file, plus `.DS_Store`; Windows adds `Thumbs.db`
 * / `desktop.ini`. Left unfiltered, each became its own unreadable "VECTOR .bin" upload
 * (an `._foo.svg` matches the .svg extension test yet holds AppleDouble binary, so it
 * sanitises to nothing and renders blank). Skip them everywhere files are ingested.
 */
export function isIgnoredUploadName(name: string): boolean {
  const base = name.split('/').pop() || name;
  return /(^|\/)__MACOSX(\/|$)/.test(name)
    || base.startsWith('._')
    || base === '.DS_Store'
    || base === 'Thumbs.db'
    || base === 'desktop.ini';
}

/**
 * Read the member files of a plain archive. `filename` disambiguates a `.tar.gz`
 * (gunzip then untar) from a bare gzip. Throws `ArchiveIngestError` when the input
 * is an OOXML/OCF package (route it to its own reader), an unsupported/corrupt
 * archive, or busts the member/byte caps.
 */
export function readArchiveMembers(bytes: Uint8Array, filename: string): ArchiveMember[] {
  const kind = sniffContainer(bytes);
  let raw: { name: string; bytes: Uint8Array }[];

  if (kind === 'zip') {
    // Never shred an office/OCF package that merely shares the PK magic.
    const zipKind = classifyZipBytes(bytes);
    if (zipKind !== 'archive') {
      throw new ArchiveIngestError(
        zipKind
          ? `That looks like a ${zipKind.toUpperCase()} file, not a plain archive — open it with its own importer.`
          : 'That ZIP could not be read (it may be encrypted or use an unsupported format).',
      );
    }
    raw = readZip(bytes);
  } else if (kind === 'tar') {
    // TarFile carries `.data`; normalise to the shared { name, bytes } shape.
    raw = readTar(bytes).map((f) => ({ name: f.name, bytes: f.data }));
  } else if (kind === 'gzip' && isTarGzName(filename)) {
    raw = readTarGz(bytes).map((f) => ({ name: f.name, bytes: f.data }));
  } else {
    throw new ArchiveIngestError('That file is not a ZIP or tar archive.');
  }

  const members: ArchiveMember[] = [];
  let total = 0;
  for (const e of raw) {
    if (!e.name || e.name.endsWith('/') || e.bytes.length === 0) continue; // dirs / empties
    if (isIgnoredUploadName(e.name)) continue;                             // macOS/Windows junk
    members.push(e);
    total += e.bytes.length;
    if (members.length > MAX_ARCHIVE_MEMBERS) {
      throw new ArchiveIngestError(`That archive has more than ${MAX_ARCHIVE_MEMBERS} files — unpack it on your device first.`);
    }
    if (total > MAX_ARCHIVE_TOTAL_BYTES) {
      throw new ArchiveIngestError('That archive expands to more than 256 MB — unpack it on your device first.');
    }
  }
  if (members.length === 0) throw new ArchiveIngestError('That archive has no files to import.');
  return members;
}

/**
 * True when this file is a plain archive we can explode, decided by NAME only — the
 * cheap rung for the drop chooser (the authoritative byte check happens in
 * `readArchiveMembers` when the user commits). `.penpot`/`.fig`/`.idml`/`.indd` are
 * design bundles routed elsewhere, so they are excluded even though they are zips.
 */
export function looksLikePlainArchiveName(name: string): boolean {
  if (/\.(penpot|fig|idml|indd)$/i.test(name)) return false;
  return /\.(zip|tar|tar\.gz|tgz)$/i.test(name);
}

/**
 * Expand any plain-archive files (by name) in `files` into their member files,
 * leaving every other file untouched — the shared pre-pass for the auto-ingest
 * paths (the catalogue/#start dropzone, the picker file-input) that have no chooser.
 * A file that looks like an archive by name but is not a plain archive (a renamed
 * office package, a corrupt or encrypted zip) is kept as-is so the normal ingest
 * path handles or reports it. Only archive-named files are read; others pass through
 * without a byte read.
 */
export async function expandArchiveFiles(files: File[]): Promise<File[]> {
  const out: File[] = [];
  for (const file of files) {
    if (!looksLikePlainArchiveName(file.name)) {
      out.push(file);
      continue;
    }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      for (const m of readArchiveMembers(bytes, file.name)) {
        out.push(new File([m.bytes as BlobPart], m.name.split('/').pop() || m.name));
      }
    } catch {
      out.push(file); // not a plain archive after all — let the caller's path deal with it
    }
  }
  return out;
}
