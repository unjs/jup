/**
 * gzip + tar, reader and writer — §07.4, §07.10.
 *
 * A tarball is attacker-controlled input and we do not have a vendored library
 * to hide behind, so §07.4's nine safety rules are enforced here in full. They
 * are not optional.
 *
 * Format subset: ustar with GNU/PAX long-name extensions, gzip-compressed. No
 * sparse files, no other compressors.
 */

import { once } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import {
  constants as fsConstants,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import type { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import { messages } from "../errors-cold.ts";

export interface ExtractOptions {
  /** npm tarballs wrap everything in `package/`; exactly one component is removed. */
  strip: number;
  /** When set, extract only the entry whose post-strip path equals this (§07.4). */
  filter?: string;
  limits?: { maxBytes?: number; maxEntries?: number; maxRatio?: number };
}

export interface TarEntry {
  path: string;
  type: "file" | "directory" | "link" | "other";
  size: number;
  mode: number;
}

/* -------------------------------------------------------------------------- */
/* Constants                                                                    */
/* -------------------------------------------------------------------------- */

const BLOCK_SIZE = 512;

/** §07.4 rule 7 — generous ceilings for this use case. */
const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 200_000;

/**
 * §07.4 rule 7 — zip-bomb defence. Real npm tarballs sit around 2–6×; anything
 * past 100× is not a package manager. The ratio is only consulted once enough
 * bytes have been inflated for it to mean anything, so a tiny archive of highly
 * compressible text never trips it.
 */
const DEFAULT_MAX_RATIO = 100;
const RATIO_FLOOR = 4 * 1024 * 1024;

const TYPE_FILE = new Set(["0", "\0"]);
const TYPE_LINK = new Set(["1", "2"]);

/** Not a portable constant everywhere; degrades to 0 (i.e. no-op) on Windows. */
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;

let cachedUmask: number | undefined;
function getUmask(): number {
  if (cachedUmask === undefined) {
    try {
      cachedUmask = process.umask();
    } catch {
      cachedUmask = 0o022;
    }
  }
  return cachedUmask;
}

function errnoOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/* -------------------------------------------------------------------------- */
/* Path safety — §07.4 rules 1, 2 and 8                                         */
/* -------------------------------------------------------------------------- */

/** `C:\…`, `C:foo` (drive-relative) — rule 1. */
const WINDOWS_DRIVE_RE = /^[a-z]:/i;
/** `\\server\share`, `//server/share` — rule 1. */
const UNC_RE = /^[/\\]{2}/;

/**
 * §07.4 rules 1 + 2 (and, because every name funnels through here including the
 * ones that arrive via a GNU `L` block or a PAX `path` record, rule 8).
 *
 * Returns the normalised, root-relative path. Throws `refusingToExtract` for
 * anything absolute, drive-qualified, UNC-prefixed, or escaping the root. `.`
 * and `..` are resolved *here*, before the name is ever handed to the
 * filesystem.
 *
 * Both separators are treated as separators on every platform: a `..\..\evil`
 * entry is inert on POSIX but lethal on Windows, and no package manager tarball
 * has a backslash in a legitimate file name.
 */
function safePath(rawName: string): string {
  const name = rawName.replaceAll("\0", "");
  if (name.length === 0) throw new Error(messages.refusingToExtract(rawName));
  if (name.startsWith("/") || name.startsWith("\\"))
    throw new Error(messages.refusingToExtract(rawName));
  if (UNC_RE.test(name) || WINDOWS_DRIVE_RE.test(name)) {
    throw new Error(messages.refusingToExtract(rawName));
  }

  const segments: string[] = [];
  for (const segment of name.split(/[/\\]+/)) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") {
      // Escaping the root by climbing out of it — rule 2.
      if (segments.length === 0) throw new Error(messages.refusingToExtract(rawName));
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
}

/** Belt-and-braces prefix check after the join — rule 2. */
function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * §07.4 `strip` — removes exactly `count` leading components. Entries left with
 * nothing (i.e. without a leading component to strip) are dropped.
 */
function stripComponents(path: string, count: number): string | undefined {
  if (count <= 0) return path === "" ? undefined : path;
  const segments = path.split("/");
  if (segments.length <= count) return undefined;
  const stripped = segments.slice(count).join("/");
  return stripped === "" ? undefined : stripped;
}

/* -------------------------------------------------------------------------- */
/* Byte plumbing                                                                */
/* -------------------------------------------------------------------------- */

/**
 * `node:zlib`'s `createGunzip` rather than `DecompressionStream("gzip")`: it is
 * the API the plan calls for, it tolerates the trailing padding real registry
 * tarballs carry, and its `bytesWritten` gives the *compressed* byte count for
 * free, which is exactly what rule 7's expansion-ratio check needs.
 */
async function* inflate(
  source: ReadableStream<Uint8Array>,
  limits: ExtractOptions["limits"],
): AsyncGenerator<Uint8Array> {
  const maxBytes = limits?.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRatio = limits?.maxRatio ?? DEFAULT_MAX_RATIO;

  const gunzip = createGunzip();
  const reader = source.getReader();

  const pump = (async () => {
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        if (!gunzip.write(next.value)) await once(gunzip, "drain");
      }
      gunzip.end();
    } catch (error) {
      gunzip.destroy(error as Error);
    }
  })();
  // The pump lives as long as the generator; failures surface through gunzip.
  pump.catch(() => {});

  let inflated = 0;
  try {
    for await (const chunk of gunzip as AsyncIterable<Uint8Array>) {
      inflated += chunk.length;
      // Rule 7: checked as the stream flows. Afterwards the disk is already full.
      if (inflated > maxBytes) {
        throw new Error(`Refusing to extract: the archive expands past the ${maxBytes} byte limit`);
      }
      const compressed = gunzip.bytesWritten;
      if (inflated > RATIO_FLOOR && compressed > 0 && inflated > compressed * maxRatio) {
        throw new Error(
          `Refusing to extract: implausible compression ratio (${inflated} bytes from ${compressed})`,
        );
      }
      yield chunk;
    }
  } finally {
    gunzip.destroy();
    reader.cancel().catch(() => {});
    await pump.catch(() => {});
  }
}

/** Pull-based byte reader over an async chunk source. */
class ByteReader {
  readonly #iterator: AsyncIterator<Uint8Array>;
  #chunks: Uint8Array[] = [];
  #length = 0;
  #done = false;

  constructor(source: AsyncIterable<Uint8Array>) {
    this.#iterator = source[Symbol.asyncIterator]();
  }

  async #pull(): Promise<boolean> {
    if (this.#done) return false;
    const next = await this.#iterator.next();
    if (next.done) {
      this.#done = true;
      return false;
    }
    if (next.value.length > 0) {
      this.#chunks.push(next.value);
      this.#length += next.value.length;
    }
    return true;
  }

  #take(count: number): Uint8Array {
    const first = this.#chunks[0]!;
    if (first.length >= count) {
      const head = first.subarray(0, count);
      if (first.length === count) this.#chunks.shift();
      else this.#chunks[0] = first.subarray(count);
      this.#length -= count;
      return head;
    }
    const out = new Uint8Array(count);
    let filled = 0;
    while (filled < count) {
      const chunk = this.#chunks[0]!;
      const size = Math.min(chunk.length, count - filled);
      out.set(chunk.subarray(0, size), filled);
      if (size === chunk.length) this.#chunks.shift();
      else this.#chunks[0] = chunk.subarray(size);
      filled += size;
    }
    this.#length -= count;
    return out;
  }

  /** Exactly `count` bytes; `undefined` at a clean end of stream. */
  async read(count: number): Promise<Uint8Array | undefined> {
    while (this.#length < count) {
      if (!(await this.#pull())) break;
    }
    if (this.#length === 0) return undefined;
    if (this.#length < count) throw new Error(`Truncated tar archive`);
    return this.#take(count);
  }

  /** Whatever is buffered, up to `max` bytes. */
  async readSome(max: number): Promise<Uint8Array | undefined> {
    while (this.#length === 0) {
      if (!(await this.#pull())) return undefined;
    }
    return this.#take(Math.min(max, this.#chunks[0]!.length));
  }

  async skip(count: number): Promise<void> {
    let remaining = count;
    while (remaining > 0) {
      const chunk = await this.readSome(remaining);
      if (chunk === undefined) throw new Error(`Truncated tar archive`);
      remaining -= chunk.length;
    }
  }

  async dispose(): Promise<void> {
    this.#chunks = [];
    this.#length = 0;
    await this.#iterator.return?.();
  }
}

/* -------------------------------------------------------------------------- */
/* Header decoding                                                              */
/* -------------------------------------------------------------------------- */

function decodeString(block: Uint8Array, offset: number, length: number): string {
  const field = block.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return Buffer.from(end === -1 ? field : field.subarray(0, end)).toString("utf8");
}

function decodeNumber(block: Uint8Array, offset: number, length: number): number {
  const field = block.subarray(offset, offset + length);
  const first = field[0] ?? 0;
  if ((first & 0x80) !== 0) {
    // GNU base-256 encoding (used for sizes past 8 GiB and for negative ids).
    let value = 0;
    for (let index = 1; index < field.length; index++) value = value * 256 + field[index]!;
    return value;
  }
  let text = "";
  for (const byte of field) {
    if (byte === 0 || byte === 0x20) {
      if (text.length > 0) break;
      continue;
    }
    text += String.fromCodePoint(byte);
  }
  if (text.length === 0) return 0;
  const value = Number.parseInt(text, 8);
  if (!Number.isFinite(value)) throw new Error(`Invalid tar header`);
  return value;
}

function isZeroBlock(block: Uint8Array): boolean {
  return block.every((byte) => byte === 0);
}

function checksumMatches(block: Uint8Array): boolean {
  const stored = decodeNumber(block, 148, 8);
  let unsigned = 0;
  let signed = 0;
  for (let index = 0; index < BLOCK_SIZE; index++) {
    const byte = index >= 148 && index < 156 ? 0x20 : block[index]!;
    unsigned += byte;
    signed += byte > 127 ? byte - 256 : byte;
  }
  return stored === unsigned || stored === signed;
}

/**
 * §07.4 rule 9 — records we do not understand are ignored, never fatal. A
 * malformed record simply ends the scan of that header.
 */
function parsePax(data: Uint8Array): Map<string, string> {
  const records = new Map<string, string>();
  let offset = 0;
  while (offset < data.length) {
    let cursor = offset;
    while (cursor < data.length && data[cursor] !== 0x20) cursor++;
    if (cursor >= data.length) break;
    const length = Number.parseInt(
      Buffer.from(data.subarray(offset, cursor)).toString("latin1"),
      10,
    );
    if (!Number.isInteger(length) || length <= 0 || offset + length > data.length) break;
    const text = Buffer.from(data.subarray(cursor + 1, offset + length))
      .toString("utf8")
      .replace(/\n$/, "");
    const equals = text.indexOf("=");
    if (equals > 0) records.set(text.slice(0, equals), text.slice(equals + 1));
    offset += length;
  }
  return records;
}

interface RawEntry {
  /** The decoded name, PAX/GNU long-name override already applied. */
  name: string;
  type: TarEntry["type"];
  size: number;
  /** Raw header mode, unmasked. */
  mode: number;
}

/** Body of the entry currently being visited. Anything left over is drained. */
class EntryBody {
  remaining: number;
  // Assigned explicitly rather than declared as a parameter property: Node's
  // type-stripping mode rejects those, and the conformance suite runs the
  // sources directly with `node src/bin.ts`.
  readonly #reader: ByteReader;

  constructor(reader: ByteReader, size: number) {
    this.#reader = reader;
    this.remaining = size;
  }

  async *chunks(): AsyncGenerator<Uint8Array> {
    while (this.remaining > 0) {
      const chunk = await this.#reader.readSome(this.remaining);
      if (chunk === undefined) throw new Error(`Truncated tar archive`);
      this.remaining -= chunk.length;
      yield chunk;
    }
  }

  async collect(): Promise<Uint8Array> {
    const parts: Uint8Array[] = [];
    for await (const chunk of this.chunks()) parts.push(chunk);
    return Buffer.concat(parts);
  }

  async drain(): Promise<void> {
    if (this.remaining > 0) {
      await this.#reader.skip(this.remaining);
      this.remaining = 0;
    }
  }
}

function classify(typeflag: string, name: string): TarEntry["type"] {
  if (typeflag === "5") return "directory";
  if (TYPE_LINK.has(typeflag)) return "link";
  if (TYPE_FILE.has(typeflag)) return name.endsWith("/") ? "directory" : "file";
  return "other";
}

/**
 * The single tar reader both `extract` and `listEntries` are built on. Metadata
 * blocks (GNU `L`/`K`, PAX `x`/`X`/`g`) are consumed here; the visitor only ever
 * sees real entries.
 */
async function walk(
  stream: ReadableStream<Uint8Array>,
  limits: ExtractOptions["limits"],
  visit: (entry: RawEntry, body: EntryBody) => Promise<void>,
): Promise<void> {
  const maxEntries = limits?.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const reader = new ByteReader(inflate(stream, limits));

  let longName: string | undefined;
  let pax: Map<string, string> | undefined;
  let entries = 0;

  try {
    for (;;) {
      const header = await reader.read(BLOCK_SIZE);
      if (header === undefined) break;
      // The end-of-archive marker; anything after it is padding.
      if (isZeroBlock(header)) break;
      if (!checksumMatches(header)) throw new Error(`Invalid tar header`);

      const typeflag = String.fromCodePoint(header[156] ?? 0);
      let size = decodeNumber(header, 124, 12);
      if (!Number.isInteger(size) || size < 0) throw new Error(`Invalid tar header`);
      // `padding` is always applied to the size actually used to read the body,
      // never to the header's copy of it: a PAX `size` record overrides the
      // header below, and a POSIX-conformant writer may leave the ustar field at
      // 0 when it does. Padding one to a block boundary while reading the other
      // leaves the stream mid-block, and the *next* header fails its checksum.

      if (typeflag === "L" || typeflag === "K") {
        // GNU long name / long link name: the body names the *next* entry.
        const body = new EntryBody(reader, size);
        const value = Buffer.from(await body.collect())
          .toString("utf8")
          .replaceAll("\0", "");
        await reader.skip(padding(size));
        if (typeflag === "L") longName = value;
        continue;
      }

      if (typeflag === "x" || typeflag === "X") {
        const body = new EntryBody(reader, size);
        pax = parsePax(await body.collect());
        await reader.skip(padding(size));
        continue;
      }

      if (typeflag === "g") {
        // Global extended headers are ignored wholesale (rule 9).
        await reader.skip(size + padding(size));
        continue;
      }

      const prefix = decodeString(header, 345, 155);
      const base = decodeString(header, 0, 100);
      let name = prefix.length > 0 ? `${prefix}/${base}` : base;
      if (longName !== undefined) name = longName;
      const paxPath = pax?.get("path");
      if (paxPath !== undefined) name = paxPath;
      // A PAX `size` record supersedes the header field entirely — including for
      // the block padding applied below, which is why that `skip` is deferred.
      // An unparseable or unsafe value is ignored rather than trusted (rule 9).
      const paxSize = pax?.get("size");
      if (paxSize !== undefined && /^\d+$/.test(paxSize)) {
        const parsed = Number.parseInt(paxSize, 10);
        if (Number.isSafeInteger(parsed)) size = parsed;
      }
      longName = undefined;
      pax = undefined;

      entries++;
      if (entries > maxEntries) {
        throw new Error(`Refusing to extract: the archive holds more than ${maxEntries} entries`);
      }

      const body = new EntryBody(reader, size);
      await visit(
        { name, type: classify(typeflag, name), size, mode: decodeNumber(header, 100, 8) & 0o7777 },
        body,
      );
      await body.drain();
      await reader.skip(padding(size));
    }
  } finally {
    await reader.dispose();
  }
}

/* -------------------------------------------------------------------------- */
/* extract                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * §07.4 rule 6 — one rule, stated once: the header contributes **only** its
 * executable bit, and the mode written is that bit applied to a fixed ceiling.
 * setuid, setgid and sticky can never survive, because they are not in the
 * ceiling to begin with.
 *
 * The ceiling is a constant, not `0o666`/`0o777` narrowed by the umask. A umask
 * is a process-local preference an attacker can arrange to be `0` — Docker base
 * images and some CI runners run with exactly that — and under it the old
 * formula made every extracted file and directory world-writable. That is not a
 * cosmetic problem here: §08.2's warm path `import()`s `bin/*.cjs` straight out
 * of the store with no second hash check, so a group- or world-writable install
 * lets any local user choose what the next `pnpm` run executes. The umask still
 * narrows the result — a stricter umask is honoured — but it can only ever
 * subtract.
 */
const FILE_MODE_EXECUTABLE = 0o755;
const FILE_MODE_PLAIN = 0o644;
const DIR_MODE = 0o755;

function fileMode(headerMode: number): number {
  const executable = (headerMode & 0o111) !== 0;
  return (executable ? FILE_MODE_EXECUTABLE : FILE_MODE_PLAIN) & ~getUmask();
}

function dirMode(): number {
  return DIR_MODE & ~getUmask();
}

/**
 * Creates every missing component of `relativeDir` under `root`, one level at a
 * time, refusing to walk *through* a symlink (§07.4 rule 5's sibling case): a
 * planted link is removed rather than followed.
 */
async function ensureDir(root: string, relativeDir: string, made: Set<string>): Promise<void> {
  let current = root;
  for (const segment of relativeDir.split("/")) {
    if (segment.length === 0) continue;
    current = join(current, segment);
    if (made.has(current)) continue;
    let info = await lstat(current).catch(() => undefined);
    if (info !== undefined && !info.isDirectory()) {
      // A symlink (or a stray file) standing where we need a directory.
      await unlink(current);
      info = undefined;
    }
    if (info === undefined) {
      await mkdir(current, { mode: dirMode() }).catch((error: unknown) => {
        if (errnoOf(error) !== "EEXIST") throw error;
      });
    }
    made.add(current);
  }
}

async function writeFile(target: string, mode: number, body: EntryBody): Promise<void> {
  // §07.4 rule 5: O_NOFOLLOW, because a prior entry (or another process) could
  // have planted a symlink here and a plain open would write through it.
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | O_NOFOLLOW;
  let handle;
  try {
    handle = await open(target, flags, mode);
  } catch (error) {
    const code = errnoOf(error);
    if (code !== "ELOOP" && code !== "EEXIST") throw error;
    // Never followed, so the link's target is untouched: drop the link itself.
    await unlink(target);
    handle = await open(target, flags, mode);
  }
  try {
    for await (const chunk of body.chunks()) await handle.write(chunk);
    // Mode is only applied by open() on creation; this is fd-based, so it cannot
    // be redirected by a racing symlink.
    await handle.chmod(mode);
  } finally {
    await handle.close();
  }
}

/**
 * Extract into `destDir`, enforcing every §07.4 rule: no absolute/drive/UNC
 * paths, no path escaping the root, link entries skipped, non file/dir types
 * rejected, `O_NOFOLLOW` on create, mode clamped to `0o755`/`0o644` (`0o755` for
 * directories) minus the umask with no setuid/setgid/sticky, and
 * byte/entry/ratio caps checked **as you go**
 * rather than afterwards.
 */
export async function extract(
  stream: ReadableStream<Uint8Array>,
  destDir: string,
  options: ExtractOptions,
): Promise<void> {
  const root = resolve(destDir);
  const made = new Set<string>();
  await mkdir(root, { recursive: true });

  await walk(stream, options.limits, async (entry, body) => {
    // Rules 1, 2 and 8 — every name, however it arrived, goes through here.
    const safe = safePath(entry.name);

    // Rule 3: link entries are skipped outright. The package managers we ship
    // need none, and a link is the cheapest way out of the extraction root.
    if (entry.type === "link") return;

    // Rule 4: no character devices, block devices or FIFOs.
    if (entry.type === "other") {
      throw new Error(`Refusing to extract '${entry.name}': unsupported tar entry type`);
    }

    const stripped = stripComponents(safe, options.strip);
    if (stripped === undefined) return;

    if (options.filter !== undefined) {
      if (entry.type !== "file" || stripped !== options.filter) return;
    }

    const target = join(root, stripped);
    if (!isInside(root, target)) throw new Error(messages.refusingToExtract(entry.name));

    if (entry.type === "directory") {
      await ensureDir(root, stripped, made);
      return;
    }

    const slash = stripped.lastIndexOf("/");
    if (slash !== -1) await ensureDir(root, stripped.slice(0, slash), made);
    await writeFile(target, fileMode(entry.mode), body);
  });

  if (options.filter !== undefined) await promoteFilteredEntry(root, options.filter);
}

/**
 * §07.4's single-file filter tail: `tmp/<binPath>` becomes `tmp/<basename>`.
 * `ENOENT` means the entry was never in the archive; `EEXIST`/`ENOTEMPTY` means
 * another process got there first, which is a benign race.
 */
async function promoteFilteredEntry(root: string, filter: string): Promise<void> {
  const safe = safePath(filter);
  const source = join(root, safe);
  const destination = join(root, basename(safe));
  if (source === destination) {
    const info = await stat(source).catch((error: unknown) => {
      if (errnoOf(error) === "ENOENT") return undefined;
      throw error;
    });
    if (info === undefined) throw new Error(messages.cannotLocateBinInTarball(filter));
    return;
  }
  try {
    await rename(source, destination);
  } catch (error) {
    const code = errnoOf(error);
    if (code === "ENOENT") throw new Error(messages.cannotLocateBinInTarball(filter));
    if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
    await rm(source, { force: true, recursive: true });
  }
}

/* -------------------------------------------------------------------------- */
/* listEntries                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Entry listing without writing anything — used to validate `pack` archives
 * (§07.10). Paths are returned as the archive spells them: this is a lister,
 * and the validation it feeds only reads path segments. The caller still hands
 * the archive to `extract`, which is where the §07.4 rules bite.
 */
export async function listEntries(stream: ReadableStream<Uint8Array>): Promise<TarEntry[]> {
  const entries: TarEntry[] = [];
  await walk(stream, undefined, async (entry) => {
    entries.push({ path: entry.name, type: entry.type, size: entry.size, mode: entry.mode });
  });
  return entries;
}

/* -------------------------------------------------------------------------- */
/* create                                                                       */
/* -------------------------------------------------------------------------- */

function writeOctal(block: Uint8Array, offset: number, length: number, value: number): void {
  const text = value
    .toString(8)
    .padStart(length - 1, "0")
    .slice(-(length - 1));
  Buffer.from(block.buffer, block.byteOffset, block.byteLength).write(
    text + "\0",
    offset,
    "latin1",
  );
}

function buildHeader(
  name: string,
  options: {
    mode: number;
    size: number;
    mtime: number;
    typeflag: string;
  },
): Uint8Array {
  const block = new Uint8Array(BLOCK_SIZE);
  const view = Buffer.from(block.buffer, block.byteOffset, block.byteLength);
  // Bounded by *bytes*, not code units: a long or multi-byte name is carried by
  // the PAX header written alongside this one.
  view.write(name, 0, 100, "utf8");
  writeOctal(block, 100, 8, options.mode & 0o7777);
  writeOctal(block, 108, 8, 0);
  writeOctal(block, 116, 8, 0);
  writeOctal(block, 124, 12, options.size);
  writeOctal(block, 136, 12, options.mtime);
  view.write(options.typeflag, 156, "latin1");
  view.write("ustar\0" + "00", 257, "latin1");

  // The checksum is computed with its own field read as spaces, and stored as
  // six octal digits followed by NUL and a space.
  view.fill(0x20, 148, 156);
  let checksum = 0;
  for (const byte of block) checksum += byte;
  view.write(`${(checksum & 0o777_777).toString(8).padStart(6, "0")}\0 `, 148, "latin1");
  return block;
}

async function push(target: Writable, chunk: Uint8Array): Promise<void> {
  if (!target.write(chunk)) await once(target, "drain");
}

function padding(size: number): number {
  return (BLOCK_SIZE - (size % BLOCK_SIZE)) % BLOCK_SIZE;
}

/** ustar names are capped at 100 bytes; longer ones ride in a PAX `x` header. */
async function writeEntryHeader(
  target: Writable,
  name: string,
  options: { mode: number; size: number; mtime: number; typeflag: string },
): Promise<void> {
  if (Buffer.byteLength(name, "utf8") > 100) {
    const value = `path=${name}\n`;
    let length = Buffer.byteLength(value, "utf8") + 2;
    while (Buffer.byteLength(`${length} ${value}`, "utf8") !== length) {
      length = Buffer.byteLength(`${length} ${value}`, "utf8");
    }
    const record = Buffer.from(`${length} ${value}`, "utf8");
    await push(
      target,
      buildHeader("PaxHeader", {
        mode: 0o644,
        size: record.length,
        mtime: options.mtime,
        typeflag: "x",
      }),
    );
    await push(target, record);
    if (padding(record.length) > 0) await push(target, new Uint8Array(padding(record.length)));
  }
  await push(target, buildHeader(name, options));
}

async function addPath(target: Writable, absolute: string, name: string): Promise<void> {
  const info = await lstat(absolute);
  const mtime = Math.floor(info.mtimeMs / 1000);
  if (info.isSymbolicLink()) return; // We never extract links, so we never write them.
  if (info.isDirectory()) {
    await writeEntryHeader(target, name.endsWith("/") ? name : `${name}/`, {
      mode: info.mode & 0o777,
      size: 0,
      mtime,
      typeflag: "5",
    });
    for (const child of (await readdir(absolute)).sort()) {
      await addPath(target, join(absolute, child), `${name}/${child}`);
    }
    return;
  }
  if (!info.isFile()) return;
  await writeEntryHeader(target, name, {
    mode: info.mode & 0o777,
    size: info.size,
    mtime,
    typeflag: "0",
  });
  let written = 0;
  for await (const chunk of createReadStream(absolute)) {
    const bytes = chunk as Uint8Array;
    written += bytes.length;
    if (written > info.size) throw new Error(`${absolute} changed size while being packed`);
    await push(target, bytes);
  }
  if (written !== info.size) throw new Error(`${absolute} changed size while being packed`);
  if (padding(info.size) > 0) await push(target, new Uint8Array(padding(info.size)));
}

/** gzip tar rooted at `cwd`, containing `paths`. Used by `jup pack`. */
export async function create(cwd: string, paths: string[], outPath: string): Promise<void> {
  const root = resolve(cwd);
  const gzip = createGzip();
  const done = pipeline(gzip, createWriteStream(outPath));
  try {
    for (const path of paths) {
      const name = safePath(path);
      await addPath(gzip, join(root, name), name);
    }
    // Two zero blocks close the archive.
    await push(gzip, new Uint8Array(BLOCK_SIZE * 2));
    gzip.end();
  } catch (error) {
    gzip.destroy(error as Error);
    await done.catch(() => {});
    throw error;
  }
  await done;
}
