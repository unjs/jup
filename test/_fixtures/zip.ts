/**
 * A zip writer for the suites that exercise `src/cache/zip.ts` — the shape Yarn
 * 6 publishes (§02.2), built here rather than committed so a fixture can be
 * regenerated and, more to the point, *forged*: every header field an extractor
 * must distrust can be overridden per entry.
 */

import { crc32, deflateRawSync } from "node:zlib";

export interface ZipEntryInput {
  name: string;
  data?: string | Uint8Array;
  /** Unix mode, file type bits included; defaults to a regular 0o644 file. */
  mode?: number;
  /** 8 (deflate, the default) or 0 (stored); anything else is written as given. */
  method?: number;
  /** "version made by" high byte; 3 (Unix) by default. */
  host?: number;
  flags?: number;
  /** Header lies, for the hostile-archive rows. */
  crc?: number;
  size?: number;
  compressedSize?: number;
  /** Raw external attributes, overriding `mode`. */
  external?: number;
}

export function makeZip(entries: ZipEntryInput[], options: { comment?: string } = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const raw = Buffer.from(entry.data ?? "");
    const method = entry.method ?? 8;
    const body = method === 8 ? deflateRawSync(raw) : raw;
    const crc = entry.crc ?? crc32(raw);
    const size = entry.size ?? raw.length;
    const compressedSize = entry.compressedSize ?? body.length;
    const flags = entry.flags ?? 0x0800;
    const external = entry.external ?? ((entry.mode ?? 0o100644) << 16) >>> 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(compressedSize >>> 0, 18);
    local.writeUInt32LE(size >>> 0, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt8(30, 4);
    central.writeUInt8(entry.host ?? 3, 5);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc >>> 0, 16);
    central.writeUInt32LE(compressedSize >>> 0, 20);
    central.writeUInt32LE(size >>> 0, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(external >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + body.length;
  }

  const directory = Buffer.concat(centrals);
  const comment = Buffer.from(options.comment ?? "", "utf8");
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(comment.length, 20);

  return Buffer.concat([...locals, directory, end, comment]);
}

/** What Yarn 6 publishes for one host: `yarn-bin` is the package manager itself. */
export function zpmZip(script: string): Buffer {
  return makeZip([
    { name: "yarn-bin", data: script, mode: 0o100755 },
    { name: "yarn", data: "#!/bin/sh\necho switch\n", mode: 0o100755 },
    { name: "LICENSE.md", data: "license\n" },
  ]);
}
