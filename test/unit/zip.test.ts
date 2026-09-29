import { randomBytes } from "node:crypto";
import { lstat, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { messages } from "../../src/errors-cold.ts";
import { extractZip } from "../../src/cache/zip.ts";
import { makeZip, zpmZip, type ZipEntryInput } from "../_fixtures/zip.ts";

/**
 * §07.4 — the zip reader behind Yarn 6's band (§02.2). It shares `tar.ts`'s
 * path, write and mode helpers, so these rows are the tar suite's rules asked
 * again of the other format, plus the ones only a zip can break: an index that
 * lies about offsets, sizes or checksums, and the format features the reader
 * declines to support.
 */

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new Blob([bytes as BlobPart]).stream();
}

function zip(entries: ZipEntryInput[]): ReadableStream<Uint8Array> {
  return streamOf(makeZip(entries));
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a rejection");
}

let dest: string;

beforeEach(async () => {
  dest = await mkdtemp(join(tmpdir(), "jup-zip-"));
});

afterEach(async () => {
  await rm(dest, { recursive: true, force: true });
});

describe("extractZip — the happy path", () => {
  it("extracts Yarn 6's layout at the archive root, keeping the executable bit", async () => {
    await extractZip(streamOf(zpmZip("#!/bin/sh\necho zpm\n")), dest);

    expect((await readdir(dest)).sort()).toEqual(["LICENSE.md", "yarn", "yarn-bin"]);
    expect(await readFile(join(dest, "yarn-bin"), "utf8")).toBe("#!/bin/sh\necho zpm\n");
    expect((await stat(join(dest, "yarn-bin"))).mode & 0o777).toBe(0o755 & ~process.umask());
    expect((await stat(join(dest, "LICENSE.md"))).mode & 0o777).toBe(0o644 & ~process.umask());
  });

  it("reads stored entries, directories and nested paths", async () => {
    await extractZip(
      zip([
        { name: "lib/", mode: 0o040755 },
        { name: "lib/a.txt", data: "stored", method: 0 },
        { name: "lib/deep/b.txt", data: "deflated" },
      ]),
      dest,
    );

    expect(await readFile(join(dest, "lib/a.txt"), "utf8")).toBe("stored");
    expect(await readFile(join(dest, "lib/deep/b.txt"), "utf8")).toBe("deflated");
  });

  it("finds the index past an archive comment", async () => {
    const bytes = makeZip([{ name: "a.txt", data: "a" }], { comment: "PK\x05\x06 not a record" });
    await extractZip(streamOf(bytes), dest);
    expect(await readFile(join(dest, "a.txt"), "utf8")).toBe("a");
  });

  it("gives a non-Unix entry the plain mode", async () => {
    await extractZip(zip([{ name: "a.exe", data: "MZ", host: 0, external: 0 }]), dest);
    expect((await stat(join(dest, "a.exe"))).mode & 0o111).toBe(0);
  });
});

describe("§07.4 rules 1 and 2 — paths", () => {
  for (const name of ["/etc/passwd", "C:\\evil.txt", "\\\\server\\share\\x", "../evil.txt"]) {
    it(`refuses '${name}', naming it verbatim`, async () => {
      const error = await rejection(extractZip(zip([{ name, data: "x" }]), dest));
      expect(error.message).toBe(messages.refusingToExtract(name));
    });
  }

  it("refuses a Windows-separator traversal", async () => {
    const error = await rejection(extractZip(zip([{ name: "a\\..\\..\\evil", data: "x" }]), dest));
    expect(error.message).toBe(messages.refusingToExtract("a\\..\\..\\evil"));
  });
});

describe("§07.4 rules 3 and 4 — entry types", () => {
  it("skips a symlink entry", async () => {
    await extractZip(
      zip([
        { name: "link", data: "/etc/passwd", mode: 0o120777 },
        { name: "a.txt", data: "a" },
      ]),
      dest,
    );
    expect(await readdir(dest)).toEqual(["a.txt"]);
  });

  it("refuses a device or FIFO entry", async () => {
    const error = await rejection(extractZip(zip([{ name: "fifo", mode: 0o010644 }]), dest));
    expect(error.message).toBe("Refusing to extract 'fifo': unsupported zip entry type");
  });
});

describe("§07.4 rule 5 — never follow a planted symlink", () => {
  it("replaces the link instead of writing through it", async () => {
    const outside = join(dest, "..", `jup-zip-victim-${process.pid}.txt`);
    await writeFile(outside, "SAFE");
    try {
      await symlink(outside, join(dest, "yarn-bin"));
      await extractZip(zip([{ name: "yarn-bin", data: "PWNED" }]), dest);

      expect(await readFile(outside, "utf8")).toBe("SAFE");
      expect((await lstat(join(dest, "yarn-bin"))).isSymbolicLink()).toBe(false);
    } finally {
      await rm(outside, { force: true });
    }
  });
});

describe("§07.4 rule 6 — mode masking", () => {
  it("drops setuid, setgid, sticky and write bits the archive asks for", async () => {
    await extractZip(
      zip([
        { name: "suid", data: "x", mode: 0o104777 },
        { name: "plain", data: "x", mode: 0o100666 },
      ]),
      dest,
    );
    expect((await stat(join(dest, "suid"))).mode & 0o7777).toBe(0o755 & ~process.umask());
    expect((await stat(join(dest, "plain"))).mode & 0o7777).toBe(0o644 & ~process.umask());
  });
});

describe("§07.4 rule 7 — bounded input and output", () => {
  it("refuses an archive past the in-memory cap as it arrives", async () => {
    const error = await rejection(
      extractZip(zip([{ name: "noise", data: randomBytes(4096) }]), dest, {
        limits: { maxArchiveBytes: 1024 },
      }),
    );
    expect(error.message).toBe("Refusing to extract: the archive exceeds the 1024 byte limit");
  });

  it("refuses declared sizes past maxBytes before inflating anything", async () => {
    const error = await rejection(
      extractZip(zip([{ name: "a", data: "x".repeat(2048) }]), dest, {
        limits: { maxBytes: 1024 },
      }),
    );
    expect(error.message).toBe("Refusing to extract: the archive expands past the 1024 byte limit");
    expect(await readdir(dest)).toEqual([]);
  });

  it("refuses an implausible expansion ratio", async () => {
    const bomb = makeZip([{ name: "bomb.bin", data: Buffer.alloc(16 * 1024 * 1024) }]);
    const error = await rejection(extractZip(streamOf(bomb), dest));
    expect(error.message).toMatch(/^Refusing to extract: implausible compression ratio/);
  });

  it("refuses more entries than maxEntries", async () => {
    const error = await rejection(
      extractZip(
        zip([
          { name: "a", data: "a" },
          { name: "b", data: "b" },
        ]),
        dest,
        { limits: { maxEntries: 1 } },
      ),
    );
    expect(error.message).toBe("Refusing to extract: the archive holds more than 1 entries");
  });

  it("stops an entry that inflates past the size its header declares", async () => {
    const error = await rejection(
      extractZip(zip([{ name: "liar", data: "x".repeat(4096), size: 16 }]), dest),
    );
    expect(error.message).toBe(
      "Refusing to extract: invalid zip archive ('liar' does not inflate to its declared size)",
    );
  });
});

describe("a lying or unsupported index", () => {
  it("refuses a CRC mismatch", async () => {
    const error = await rejection(extractZip(zip([{ name: "a", data: "a", crc: 1 }]), dest));
    expect(error.message).toBe("Refusing to extract: invalid zip archive ('a' fails its CRC)");
  });

  it("refuses an entry whose data runs into the central directory", async () => {
    const error = await rejection(
      extractZip(
        zip([{ name: "a", data: "a", method: 0, size: 1 << 20, compressedSize: 1 << 20 }]),
        dest,
      ),
    );
    expect(error.message).toBe(
      "Refusing to extract: invalid zip archive ('a' runs past the central directory)",
    );
  });

  it("refuses a buffer with no end-of-central-directory record", async () => {
    const error = await rejection(extractZip(streamOf(Buffer.from("not a zip at all")), dest));
    expect(error.message).toBe(
      "Refusing to extract: invalid zip archive (no end-of-central-directory record)",
    );
  });

  it("refuses encrypted entries and unknown compression methods by name", async () => {
    expect(
      (await rejection(extractZip(zip([{ name: "a", data: "a", flags: 0x0801 }]), dest))).message,
    ).toBe("Refusing to extract: unsupported zip archive ('a' is encrypted)");
    expect(
      (await rejection(extractZip(zip([{ name: "a", data: "a", method: 12 }]), dest))).message,
    ).toBe("Refusing to extract: unsupported zip archive ('a' uses compression method 12)");
  });

  it("refuses zip64", async () => {
    const error = await rejection(
      extractZip(zip([{ name: "a", data: "a", size: 0xffffffff }]), dest),
    );
    expect(error.message).toBe("Refusing to extract: unsupported zip archive (zip64)");
  });
});
