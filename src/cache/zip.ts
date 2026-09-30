/**
 * zip reader — §07.4, for the one band that ships zip files (Yarn 6, §02.2).
 *
 * A zip is as attacker-controlled as a tarball, and §07.4's rules are enforced
 * here with `tar.ts`'s own helpers, so the two extractors cannot disagree about
 * what a safe path, a safe write or a safe mode is. What differs is the format:
 * a zip's authoritative index — the central directory — sits at the *end*, and
 * the local headers before it may defer their sizes to a trailing descriptor.
 * So the archive is buffered whole, under a cap checked as bytes arrive, and
 * then read from its index, which is also the only reading a zip tool agrees on.
 *
 * Format subset: one disk, no zip64, no encryption, stored or deflated entries.
 * Anything else is refused by name rather than half-read.
 */

const { mkdir } = process.getBuiltinModule("node:fs/promises");
const { join, resolve } = process.getBuiltinModule("node:path");
const { crc32, inflateRaw: inflateRawCallback } = process.getBuiltinModule("node:zlib");
import { messages } from "../errors-cold.ts";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_MAX_RATIO,
  ensureDir,
  expansionRefusal,
  type ExtractOptions,
  fileMode,
  isInside,
  RATIO_FLOOR,
  safePath,
  writeFile,
} from "./tar.ts";

function inflateRaw(input: Buffer, maxOutputLength: number): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    inflateRawCallback(input, { maxOutputLength }, (error, result) =>
      error === null ? resolvePromise(result) : reject(error),
    );
  });
}

/**
 * §07.4 rule 7, for the bytes held in memory before the index can be read.
 * Yarn 6's archives are ~17 MB; this is the tarball path's output ceiling
 * halved, since a zip deflates to at least that much.
 */
const DEFAULT_MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;

export interface ZipOptions {
  limits?: ExtractOptions["limits"] & { maxArchiveBytes?: number };
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_SIZE = 22;
const CENTRAL_SIZE = 46;
const LOCAL_SIZE = 30;

/** General-purpose flag bits: 0 is encryption, 6 strong encryption, 11 UTF-8 names. */
const FLAG_ENCRYPTED = 0x0001;
const FLAG_STRONG_ENCRYPTION = 0x0040;
const FLAG_UTF8 = 0x0800;

const METHOD_STORED = 0;
const METHOD_DEFLATED = 8;

/** "version made by" high byte: the host whose attributes the entry carries. */
const HOST_UNIX = 3;
/** The MS-DOS directory attribute, the only one read from a non-Unix entry. */
const DOS_DIRECTORY = 0x10;

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

interface ZipEntry {
  name: string;
  type: "file" | "directory" | "link" | "other";
  /** Unix mode bits, or 0 when the entry carries none. */
  mode: number;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  dataOffset: number;
}

function invalid(detail: string): Error {
  return new Error(`Refusing to extract: invalid zip archive (${detail})`);
}

function unsupported(detail: string): Error {
  return new Error(`Refusing to extract: unsupported zip archive (${detail})`);
}

/** Rule 7 — the whole archive, refused the moment it passes `max`. */
async function readAll(stream: ReadableStream<Uint8Array>, max: number): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > max) {
        throw new Error(`Refusing to extract: the archive exceeds the ${max} byte limit`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, length);
}

/**
 * The end-of-central-directory record: the last signature whose comment runs
 * exactly to the end of the file. Exactly, so a signature inside a comment
 * cannot pose as the record.
 */
function findEndOfCentralDirectory(archive: Buffer): number {
  const lowest = Math.max(0, archive.length - EOCD_SIZE - 0xffff);
  for (let offset = archive.length - EOCD_SIZE; offset >= lowest; offset--) {
    if (
      archive.readUInt32LE(offset) === EOCD_SIGNATURE &&
      offset + EOCD_SIZE + archive.readUInt16LE(offset + 20) === archive.length
    ) {
      return offset;
    }
  }
  throw invalid("no end-of-central-directory record");
}

function classify(name: string, host: number, external: number): Pick<ZipEntry, "type" | "mode"> {
  const mode = host === HOST_UNIX ? external >>> 16 : 0;
  const format = mode & S_IFMT;
  if (format === S_IFLNK) return { type: "link", mode };
  if (format !== 0 && format !== S_IFREG && format !== S_IFDIR) return { type: "other", mode };
  const directory =
    name.endsWith("/") ||
    format === S_IFDIR ||
    (host !== HOST_UNIX && (external & DOS_DIRECTORY) !== 0);
  return { type: directory ? "directory" : "file", mode };
}

/** The central directory, every offset and size in it checked against the buffer. */
function readEntries(archive: Buffer, maxEntries: number): ZipEntry[] {
  const end = findEndOfCentralDirectory(archive);
  const disk = archive.readUInt16LE(end + 4);
  const directoryDisk = archive.readUInt16LE(end + 6);
  const onDisk = archive.readUInt16LE(end + 8);
  const total = archive.readUInt16LE(end + 10);
  const directorySize = archive.readUInt32LE(end + 12);
  const directoryOffset = archive.readUInt32LE(end + 16);

  if (total === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    throw unsupported("zip64");
  }
  if (disk !== 0 || directoryDisk !== 0 || onDisk !== total) throw unsupported("multi-disk");
  if (total > maxEntries) {
    throw new Error(`Refusing to extract: the archive holds more than ${maxEntries} entries`);
  }
  const directoryEnd = directoryOffset + directorySize;
  if (directoryEnd > end) throw invalid("central directory out of bounds");

  const entries: ZipEntry[] = [];
  let offset = directoryOffset;
  for (let index = 0; index < total; index++) {
    if (
      offset + CENTRAL_SIZE > directoryEnd ||
      archive.readUInt32LE(offset) !== CENTRAL_SIGNATURE
    ) {
      throw invalid("bad central directory entry");
    }
    const host = archive.readUInt8(offset + 5);
    const flags = archive.readUInt16LE(offset + 8);
    const method = archive.readUInt16LE(offset + 10);
    const crc = archive.readUInt32LE(offset + 16);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const size = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const external = archive.readUInt32LE(offset + 38);
    const localOffset = archive.readUInt32LE(offset + 42);

    const next = offset + CENTRAL_SIZE + nameLength + extraLength + commentLength;
    if (next > directoryEnd) throw invalid("central directory entry out of bounds");
    const name = archive.toString(
      (flags & FLAG_UTF8) !== 0 ? "utf8" : "latin1",
      offset + CENTRAL_SIZE,
      offset + CENTRAL_SIZE + nameLength,
    );

    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) {
      throw unsupported("zip64");
    }
    if ((flags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION)) !== 0) {
      throw unsupported(`'${name}' is encrypted`);
    }
    if (method !== METHOD_STORED && method !== METHOD_DEFLATED) {
      throw unsupported(`'${name}' uses compression method ${method}`);
    }
    if (method === METHOD_STORED && compressedSize !== size) {
      throw invalid(`'${name}' is stored with two different sizes`);
    }

    // The local header's own name and extra field lengths decide where the
    // data starts; they need not match the central directory's.
    if (
      localOffset + LOCAL_SIZE > directoryOffset ||
      archive.readUInt32LE(localOffset) !== LOCAL_SIGNATURE
    ) {
      throw invalid(`bad local header for '${name}'`);
    }
    const dataOffset =
      localOffset +
      LOCAL_SIZE +
      archive.readUInt16LE(localOffset + 26) +
      archive.readUInt16LE(localOffset + 28);
    if (dataOffset + compressedSize > directoryOffset) {
      throw invalid(`'${name}' runs past the central directory`);
    }

    entries.push({
      name,
      ...classify(name, host, external),
      method,
      crc,
      compressedSize,
      size,
      dataOffset,
    });
    offset = next;
  }
  return entries;
}

/** One entry's bytes: bounded by its declared size, then checked against it and its CRC. */
async function contents(archive: Buffer, entry: ZipEntry): Promise<Buffer> {
  const raw = archive.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
  let data: Buffer;
  if (entry.method === METHOD_STORED) {
    data = raw;
  } else {
    try {
      // `maxOutputLength` stops the inflate itself at the declared size, so a
      // lying header costs a refusal rather than the memory it claims not to.
      data = await inflateRaw(raw, Math.max(1, entry.size));
    } catch {
      throw invalid(`'${entry.name}' does not inflate to its declared size`);
    }
  }
  if (data.length !== entry.size) {
    throw invalid(`'${entry.name}' does not inflate to its declared size`);
  }
  if (crc32(data) >>> 0 !== entry.crc) throw invalid(`'${entry.name}' fails its CRC`);
  return data;
}

/**
 * Extract into `destDir` under every §07.4 rule: rules 1, 2 and 8 through
 * `safePath` and `isInside`, link entries skipped (3), special files refused
 * (4), writes that never follow a symlink (5), the fixed mode ceiling with only
 * the executable bit taken from the archive (6), and rule 7's caps — on the
 * archive held in memory, on the entry count, on every entry's declared and
 * actual size, and on the expansion ratio — all checked before the bytes they
 * limit are produced. Entries sit at the archive root, so nothing is stripped.
 */
export async function extractZip(
  stream: ReadableStream<Uint8Array>,
  destDir: string,
  options: ZipOptions = {},
): Promise<void> {
  const maxBytes = options.limits?.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRatio = options.limits?.maxRatio ?? DEFAULT_MAX_RATIO;
  const archive = await readAll(
    stream,
    options.limits?.maxArchiveBytes ?? DEFAULT_MAX_ARCHIVE_BYTES,
  );
  const entries = readEntries(archive, options.limits?.maxEntries ?? DEFAULT_MAX_ENTRIES);

  // Rule 7, decided from the index before a byte is inflated: the sizes it
  // declares are what `contents` then holds every entry to.
  let declared = 0;
  for (const entry of entries) {
    declared += entry.size;
    if (declared > maxBytes) throw new Error(expansionRefusal(maxBytes));
  }
  if (declared > RATIO_FLOOR && declared > archive.length * maxRatio) {
    throw new Error(
      `Refusing to extract: implausible compression ratio (${declared} bytes from ${archive.length})`,
    );
  }

  const root = resolve(destDir);
  const made = new Set<string>();
  await mkdir(root, { recursive: true });

  for (const entry of entries) {
    const safe = safePath(entry.name);
    if (entry.type === "link") continue;
    if (entry.type === "other") {
      throw new Error(`Refusing to extract '${entry.name}': unsupported zip entry type`);
    }
    // A bare `./` or `a/..` normalises to the root itself, which holds nothing.
    if (safe === "") continue;

    const target = join(root, safe);
    if (!isInside(root, target)) throw new Error(messages.refusingToExtract(entry.name));

    if (entry.type === "directory") {
      await ensureDir(root, safe, made);
      continue;
    }

    const data = await contents(archive, entry);
    const slash = safe.lastIndexOf("/");
    if (slash !== -1) await ensureDir(root, safe.slice(0, slash), made);
    await writeFile(target, fileMode(entry.mode), [data]);
  }
}
