/**
 * An independent gzip+ustar writer for the conformance harness.
 *
 * Deliberately *not* `src/tar.ts`'s own writer: a conformance suite that builds
 * its fixtures with the implementation under test can only ever prove the
 * implementation agrees with itself. This is ~80 lines of plain ustar, which is
 * cheap enough to keep separate.
 */

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

const BLOCK = 512;

export interface TarEntryInput {
  path: string;
  content?: string | Uint8Array;
  mode?: number;
  type?: "file" | "directory";
}

function pad(size: number): number {
  return (BLOCK - (size % BLOCK)) % BLOCK;
}

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

function header(entry: Required<Pick<TarEntryInput, "path" | "mode" | "type">>, size: number) {
  const block = Buffer.alloc(BLOCK);
  const name = entry.type === "directory" ? `${entry.path.replace(/\/$/, "")}/` : entry.path;
  if (Buffer.byteLength(name) > 100) {
    throw new Error(`Harness tarball entry name too long for ustar: ${name}`);
  }

  block.write(name, 0, "utf8");
  block.write(octal(entry.mode, 8), 100, "latin1");
  block.write(octal(0, 8), 108, "latin1");
  block.write(octal(0, 8), 116, "latin1");
  block.write(octal(size, 12), 124, "latin1");
  block.write(octal(0, 12), 136, "latin1");
  block.write(entry.type === "directory" ? "5" : "0", 156, "latin1");
  block.write("ustar\0" + "00", 257, "latin1");

  // The checksum is computed with its own eight bytes read as spaces.
  block.write("        ", 148, "latin1");
  let checksum = 0;
  for (const byte of block) checksum += byte;
  block.write(`${(checksum & 0o777_777).toString(8).padStart(6, "0")}\0 `, 148, "latin1");

  return block;
}

/** A gzip-compressed ustar archive holding exactly these entries, in order. */
export function makeTarball(entries: TarEntryInput[]): Uint8Array {
  const chunks: Buffer[] = [];

  for (const entry of entries) {
    const type = entry.type ?? "file";
    const content = entry.content ?? "";
    const body =
      type === "directory"
        ? Buffer.alloc(0)
        : typeof content === "string"
          ? Buffer.from(content, "utf8")
          : Buffer.from(content);
    const mode = entry.mode ?? (type === "directory" ? 0o755 : 0o644);

    chunks.push(
      header({ path: entry.path, mode, type }, body.length),
      body,
      Buffer.alloc(pad(body.length)),
    );
  }

  // Two zero blocks terminate the archive.
  chunks.push(Buffer.alloc(BLOCK * 2));
  return gzipSync(Buffer.concat(chunks), { level: 9 });
}

/** The npm layout: every path lives under a single `package/` component (§07.4 strips it). */
export function npmTarball(files: Record<string, string>): Uint8Array {
  return makeTarball(
    Object.entries(files).map(([path, content]) => ({
      path: `package/${path}`,
      content,
      mode: path.includes("bin/") ? 0o755 : 0o644,
    })),
  );
}

export function hashOf(bytes: Uint8Array, algo = "sha512"): string {
  return createHash(algo).update(bytes).digest("hex");
}

/** `sha512-<base64>`, the shape `dist.integrity` uses. */
export function sriOf(bytes: Uint8Array, algo = "sha512"): string {
  return `${algo}-${createHash(algo).update(bytes).digest("base64")}`;
}
