import { Buffer } from "node:buffer";
import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { messages } from "../../src/errors.ts";
import { create, extract, listEntries } from "../../src/cache/tar.ts";

/* -------------------------------------------------------------------------- */
/* In-memory tarball construction — friendly and hostile alike                  */
/* -------------------------------------------------------------------------- */

interface Entry {
  name: string;
  body?: string | Uint8Array;
  /** Overrides the real body length; used to build truncated archives. */
  size?: number;
  mode?: number;
  typeflag?: string;
  linkname?: string;
  prefix?: string;
  badChecksum?: boolean;
}

function makeHeader(entry: Entry, size: number): Buffer {
  const block = Buffer.alloc(512);
  block.write(entry.name.slice(0, 100), 0, "utf8");
  block.write(`${(entry.mode ?? 0o644).toString(8).padStart(7, "0")}\0`, 100, "latin1");
  block.write("0000000\0", 108, "latin1");
  block.write("0000000\0", 116, "latin1");
  block.write(`${size.toString(8).padStart(11, "0")}\0`, 124, "latin1");
  block.write("00000000000\0", 136, "latin1");
  block.fill(0x20, 148, 156);
  block.write(entry.typeflag ?? "0", 156, "latin1");
  if (entry.linkname) block.write(entry.linkname.slice(0, 100), 157, "utf8");
  block.write("ustar\0" + "00", 257, "latin1");
  if (entry.prefix) block.write(entry.prefix.slice(0, 155), 345, "utf8");
  let checksum = 0;
  for (const byte of block) checksum += byte;
  if (entry.badChecksum) checksum += 1;
  block.write(`${(checksum & 0o777_777).toString(8).padStart(6, "0")}\0 `, 148, "latin1");
  return block;
}

function tar(entries: Entry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const body =
      typeof entry.body === "string"
        ? Buffer.from(entry.body, "utf8")
        : Buffer.from(entry.body ?? []);
    parts.push(makeHeader(entry, entry.size ?? body.length));
    if (body.length > 0) {
      parts.push(body);
      const padding = (512 - (body.length % 512)) % 512;
      if (padding > 0) parts.push(Buffer.alloc(padding));
    }
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

/** A PAX extended header whose records apply to the entry that follows it. */
function pax(records: string[]): Entry {
  const body = records
    .map((record) => {
      const value = `${record}\n`;
      let length = Buffer.byteLength(value) + 2;
      while (Buffer.byteLength(`${length} ${value}`) !== length) {
        length = Buffer.byteLength(`${length} ${value}`);
      }
      return `${length} ${value}`;
    })
    .join("");
  return { name: "PaxHeader", typeflag: "x", body };
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new Blob([bytes as BlobPart]).stream();
}

function gzipStream(entries: Entry[]): ReadableStream<Uint8Array> {
  return streamOf(gzipSync(tar(entries)));
}

const NPM_TARBALL: Entry[] = [
  { name: "package/", typeflag: "5", mode: 0o755 },
  { name: "package/package.json", body: `{"name":"yarn"}`, mode: 0o644 },
  { name: "package/bin/", typeflag: "5", mode: 0o755 },
  { name: "package/bin/yarn.js", body: `#!/usr/bin/env node\n`, mode: 0o755 },
  { name: "README.md", body: `top level, no leading component`, mode: 0o644 },
];

async function exists(path: string): Promise<boolean> {
  return await stat(path).then(
    () => true,
    () => false,
  );
}

let dest: string;

beforeEach(async () => {
  dest = await mkdtemp(join(tmpdir(), "pipack-tar-"));
});

afterEach(async () => {
  await rm(dest, { recursive: true, force: true });
});

/* -------------------------------------------------------------------------- */

describe("extract — the happy path", () => {
  it("strips exactly one leading component and drops entries without one", async () => {
    await extract(gzipStream(NPM_TARBALL), dest, { strip: 1 });

    expect(await readFile(join(dest, "package.json"), "utf8")).toBe(`{"name":"yarn"}`);
    expect(await readFile(join(dest, "bin/yarn.js"), "utf8")).toBe(`#!/usr/bin/env node\n`);
    // `package/` itself strips to nothing, and `README.md` has no leading component.
    expect(await exists(join(dest, "package"))).toBe(false);
    expect(await exists(join(dest, "README.md"))).toBe(false);
  });

  it("takes only the executable bit from the header mode", async () => {
    await extract(gzipStream(NPM_TARBALL), dest, { strip: 1 });

    const script = await stat(join(dest, "bin/yarn.js"));
    const manifest = await stat(join(dest, "package.json"));
    expect(script.mode & 0o111).not.toBe(0);
    expect(manifest.mode & 0o111).toBe(0);
  });

  it("reassembles ustar prefix/name pairs", async () => {
    await extract(gzipStream([{ name: "deep/file.js", prefix: "package", body: "ok" }]), dest, {
      strip: 1,
    });
    expect(await readFile(join(dest, "deep/file.js"), "utf8")).toBe("ok");
  });

  it("rejects a header with a broken checksum", async () => {
    await expect(
      extract(gzipStream([{ name: "package/a.js", body: "x", badChecksum: true }]), dest, {
        strip: 1,
      }),
    ).rejects.toThrow(`Invalid tar header`);
  });
});

/* -------------------------------------------------------------------------- */
/* §07.4 rules 1–9, one hostile tarball at a time                               */
/* -------------------------------------------------------------------------- */

describe("§07.4 rule 1 — absolute paths", () => {
  it.for([
    ["/etc/passwd"],
    ["C:\\Windows\\System32\\evil.dll"],
    ["C:evil.js"],
    ["\\\\server\\share\\evil.js"],
    ["//server/share/evil.js"],
    ["\\etc\\passwd"],
  ])("refuses %s", async ([name]) => {
    await expect(
      extract(gzipStream([{ name: name!, body: "pwned" }]), dest, { strip: 0 }),
    ).rejects.toThrow(messages.refusingToExtract(name!));
  });
});

describe("§07.4 rule 2 — escaping the extraction root", () => {
  it("refuses a `../` traversal, naming the entry verbatim", async () => {
    await expect(
      extract(gzipStream([{ name: "package/../../evil.js", body: "pwned" }]), dest, { strip: 1 }),
    ).rejects.toThrow(
      `Refusing to extract 'package/../../evil.js': path escapes the extraction directory`,
    );
  });

  it("refuses a bare `..` entry", async () => {
    await expect(
      extract(gzipStream([{ name: "../evil.js", body: "pwned" }]), dest, { strip: 0 }),
    ).rejects.toThrow(messages.refusingToExtract("../evil.js"));
  });

  it("refuses a Windows-separator traversal", async () => {
    await expect(
      extract(gzipStream([{ name: "package\\..\\..\\evil.js", body: "pwned" }]), dest, {
        strip: 1,
      }),
    ).rejects.toThrow(messages.refusingToExtract("package\\..\\..\\evil.js"));
  });

  it("keeps an interior `..` that stays inside the root", async () => {
    await extract(gzipStream([{ name: "package/a/../b.js", body: "fine" }]), dest, { strip: 1 });
    expect(await readFile(join(dest, "b.js"), "utf8")).toBe("fine");
  });

  it("writes nothing before refusing", async () => {
    await expect(
      extract(
        gzipStream([
          { name: "package/ok.js", body: "ok" },
          { name: "package/../../evil.js", body: "pwned" },
        ]),
        dest,
        { strip: 1 },
      ),
    ).rejects.toThrow(/path escapes/);
    expect(await exists(join(dest, "..", "evil.js"))).toBe(false);
  });
});

describe("§07.4 rule 3 — link entries", () => {
  it("skips a symlink entry pointing outside the root", async () => {
    const outside = join(dest, "..", `pipack-outside-${process.pid}.txt`);
    await writeFile(outside, "SAFE");
    try {
      await extract(
        gzipStream([
          { name: "package/escape", typeflag: "2", linkname: "../../../../etc/passwd" },
          { name: "package/ok.js", body: "ok" },
        ]),
        dest,
        { strip: 1 },
      );
      expect(await exists(join(dest, "escape"))).toBe(false);
      expect(await readFile(join(dest, "ok.js"), "utf8")).toBe("ok");
      expect(await readFile(outside, "utf8")).toBe("SAFE");
    } finally {
      await rm(outside, { force: true });
    }
  });

  it("skips hardlink entries", async () => {
    await extract(
      gzipStream([
        { name: "package/a.js", body: "a" },
        { name: "package/b.js", typeflag: "1", linkname: "package/a.js" },
      ]),
      dest,
      { strip: 1 },
    );
    expect(await exists(join(dest, "b.js"))).toBe(false);
  });

  it("still refuses a link entry whose own path escapes", async () => {
    await expect(
      extract(gzipStream([{ name: "package/../../link", typeflag: "2", linkname: "x" }]), dest, {
        strip: 1,
      }),
    ).rejects.toThrow(/path escapes/);
  });
});

describe("§07.4 rule 4 — entry types", () => {
  it.for([
    ["3", "character device"],
    ["4", "block device"],
    ["6", "fifo"],
  ])("refuses typeflag %s (%s)", async ([typeflag]) => {
    await expect(
      extract(gzipStream([{ name: "package/dev", typeflag: typeflag! }]), dest, { strip: 1 }),
    ).rejects.toThrow(/unsupported tar entry type/);
  });
});

describe("§07.4 rule 5 — never follow a planted symlink", () => {
  it("replaces the link instead of writing through it", async () => {
    const outside = join(dest, "..", `pipack-victim-${process.pid}.txt`);
    await writeFile(outside, "SAFE");
    try {
      await symlink(outside, join(dest, "evil.js"));
      await extract(gzipStream([{ name: "package/evil.js", body: "PWNED" }]), dest, { strip: 1 });

      expect(await readFile(outside, "utf8")).toBe("SAFE");
      expect(await readFile(join(dest, "evil.js"), "utf8")).toBe("PWNED");
      expect((await lstat(join(dest, "evil.js"))).isSymbolicLink()).toBe(false);
    } finally {
      await rm(outside, { force: true });
    }
  });

  it("replaces a symlinked parent directory instead of descending through it", async () => {
    const outside = await mkdtemp(join(tmpdir(), "pipack-victim-dir-"));
    try {
      await symlink(outside, join(dest, "bin"));
      await extract(gzipStream([{ name: "package/bin/yarn.js", body: "PWNED" }]), dest, {
        strip: 1,
      });

      expect(await exists(join(outside, "yarn.js"))).toBe(false);
      expect((await lstat(join(dest, "bin"))).isDirectory()).toBe(true);
      expect(await readFile(join(dest, "bin/yarn.js"), "utf8")).toBe("PWNED");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe("§07.4 rule 6 — mode masking", () => {
  it("drops setuid, setgid and sticky bits", async () => {
    await extract(
      gzipStream([
        { name: "package/suid", body: "x", mode: 0o4755 },
        { name: "package/sgid", body: "x", mode: 0o2644 },
        { name: "package/sticky", body: "x", mode: 0o1777 },
      ]),
      dest,
      { strip: 1 },
    );

    for (const name of ["suid", "sgid", "sticky"]) {
      const info = await stat(join(dest, name));
      expect(info.mode & 0o7000).toBe(0);
      expect(info.mode & 0o777).toBe((info.mode & 0o111 ? 0o777 : 0o666) & ~process.umask());
    }
    expect((await stat(join(dest, "sgid"))).mode & 0o111).toBe(0);
  });
});

describe("§07.4 rule 7 — bounded output", () => {
  it("refuses an implausible expansion ratio before filling the disk", async () => {
    // 16 MiB of zeroes gzips to a few kilobytes: a ~1000x expansion.
    const bomb = tar([{ name: "package/bomb.bin", body: Buffer.alloc(16 * 1024 * 1024) }]);
    const compressed = gzipSync(bomb);
    expect(compressed.length).toBeLessThan(128 * 1024);

    await expect(extract(streamOf(compressed), dest, { strip: 1 })).rejects.toThrow(
      /implausible compression ratio/,
    );

    const written = await stat(join(dest, "bomb.bin")).catch(() => undefined);
    // Detected mid-stream: far less than the 16 MiB the archive promised.
    expect(written?.size ?? 0).toBeLessThan(8 * 1024 * 1024);
  });

  it("refuses to inflate past maxBytes", async () => {
    await expect(
      extract(gzipStream([{ name: "package/a.js", body: "x".repeat(4096) }]), dest, {
        strip: 1,
        limits: { maxBytes: 1024 },
      }),
    ).rejects.toThrow(/expands past the 1024 byte limit/);
  });

  it("refuses to walk past maxEntries", async () => {
    await expect(
      extract(
        gzipStream([
          { name: "package/a.js", body: "a" },
          { name: "package/b.js", body: "b" },
          { name: "package/c.js", body: "c" },
        ]),
        dest,
        { strip: 1, limits: { maxEntries: 2 } },
      ),
    ).rejects.toThrow(/more than 2 entries/);
  });
});

describe("§07.4 rules 8 and 9 — long names and unknown PAX records", () => {
  it("refuses a PAX long name that decodes to a traversal", async () => {
    const evil = `../../${"a".repeat(120)}/evil.js`;
    await expect(
      extract(
        gzipStream([pax([`path=${evil}`]), { name: "package/decoy.js", body: "pwned" }]),
        dest,
        { strip: 1 },
      ),
    ).rejects.toThrow(messages.refusingToExtract(evil));
    expect(await exists(join(dest, "decoy.js"))).toBe(false);
  });

  it("refuses a PAX long name that decodes to an absolute path", async () => {
    await expect(
      extract(
        gzipStream([
          pax([`path=/etc/${"b".repeat(120)}`]),
          { name: "package/decoy.js", body: "x" },
        ]),
        dest,
        { strip: 1 },
      ),
    ).rejects.toThrow(/path escapes the extraction directory/);
  });

  it("refuses a GNU `L` long name that decodes to a traversal", async () => {
    await expect(
      extract(
        gzipStream([
          { name: "././@LongLink", typeflag: "L", body: `../../${"c".repeat(120)}/evil.js\0` },
          { name: "package/decoy.js", body: "pwned" },
        ]),
        dest,
        { strip: 1 },
      ),
    ).rejects.toThrow(/path escapes the extraction directory/);
  });

  it("honours a benign PAX long name and ignores unknown records", async () => {
    const long = `package/${"n".repeat(150)}.js`;
    await extract(
      gzipStream([
        pax([`path=${long}`, `SCHILY.xattr.user.foo=bar`, `mtime=1699999999.0`, `garbage`]),
        { name: "package/truncated", body: "long-name" },
      ]),
      dest,
      { strip: 1 },
    );
    expect(await readFile(join(dest, `${"n".repeat(150)}.js`), "utf8")).toBe("long-name");
  });

  it("ignores PAX global headers", async () => {
    const global = { ...pax([`comment=hello`]), typeflag: "g" };
    await extract(gzipStream([global, { name: "package/ok.js", body: "ok" }]), dest, { strip: 1 });
    expect(await readFile(join(dest, "ok.js"), "utf8")).toBe("ok");
  });

  /*
   * A POSIX-conformant pax writer may put the real length in a `size` record and
   * leave the ustar header field at 0. Reading the body at one size while
   * skipping the block padding computed from the other leaves the reader
   * mid-block, and the *next* header then fails its checksum.
   */
  it("stays block-aligned when a PAX size record overrides the header", async () => {
    const body = "x".repeat(600); // Two data blocks, 424 bytes of padding.
    const entries = [
      pax([`size=${body.length}`]),
      { name: "package/big.js", body, size: 0 },
      { name: "package/after.js", body: "after" },
    ];

    await extract(gzipStream(entries), dest, { strip: 1 });

    expect(await readFile(join(dest, "big.js"), "utf8")).toBe(body);
    // The entry after the misaligned one is the real assertion.
    expect(await readFile(join(dest, "after.js"), "utf8")).toBe("after");

    const listed = await listEntries(gzipStream(entries));
    expect(listed.map((entry) => entry.path)).toEqual(["package/big.js", "package/after.js"]);
    expect(listed[0]!.size).toBe(body.length);
  });

  it("ignores a PAX size record that is not a safe integer", async () => {
    const entries = [
      pax([`size=99999999999999999999`]),
      { name: "package/ok.js", body: "ok" },
      { name: "package/after.js", body: "after" },
    ];

    await extract(gzipStream(entries), dest, { strip: 1 });

    expect(await readFile(join(dest, "ok.js"), "utf8")).toBe("ok");
    expect(await readFile(join(dest, "after.js"), "utf8")).toBe("after");
  });
});

/* -------------------------------------------------------------------------- */
/* Single-file filter                                                           */
/* -------------------------------------------------------------------------- */

describe("the single-file filter", () => {
  it("extracts only the filtered entry and renames it to its basename", async () => {
    await extract(gzipStream(NPM_TARBALL), dest, { strip: 1, filter: "bin/yarn.js" });

    expect(await readFile(join(dest, "yarn.js"), "utf8")).toBe(`#!/usr/bin/env node\n`);
    expect(await exists(join(dest, "package.json"))).toBe(false);
    expect(await exists(join(dest, "bin/yarn.js"))).toBe(false);
  });

  it("accepts a filter with no directory component", async () => {
    await extract(gzipStream([{ name: "package/yarn.js", body: "solo" }]), dest, {
      strip: 1,
      filter: "yarn.js",
    });
    expect(await readFile(join(dest, "yarn.js"), "utf8")).toBe("solo");
  });

  it("reports a missing entry with the §12.8 message", async () => {
    await expect(
      extract(gzipStream(NPM_TARBALL), dest, { strip: 1, filter: "bin/pnpm.cjs" }),
    ).rejects.toThrow(messages.cannotLocateBinInTarball("bin/pnpm.cjs"));
  });

  it("reports a missing entry when the filter has no directory component", async () => {
    await expect(
      extract(gzipStream(NPM_TARBALL), dest, { strip: 1, filter: "pnpm.cjs" }),
    ).rejects.toThrow(`Cannot locate 'pnpm.cjs' in downloaded tarball`);
  });

  it("still enforces the safety rules on skipped entries", async () => {
    await expect(
      extract(
        gzipStream([
          { name: "package/../../evil.js", body: "pwned" },
          { name: "package/bin/yarn.js", body: "y" },
        ]),
        dest,
        { strip: 1, filter: "bin/yarn.js" },
      ),
    ).rejects.toThrow(/path escapes/);
  });
});

/* -------------------------------------------------------------------------- */
/* listEntries and create                                                       */
/* -------------------------------------------------------------------------- */

describe("listEntries", () => {
  it("reports entries without writing anything", async () => {
    const entries = await listEntries(gzipStream(NPM_TARBALL));

    expect(entries.map((entry) => entry.path)).toEqual([
      "package/",
      "package/package.json",
      "package/bin/",
      "package/bin/yarn.js",
      "README.md",
    ]);
    expect(entries[0]!.type).toBe("directory");
    expect(entries[1]!).toMatchObject({ type: "file", size: 15 });
    expect(await exists(join(dest, "package"))).toBe(false);
  });

  it("classifies link and device entries without throwing", async () => {
    const entries = await listEntries(
      gzipStream([
        { name: "a", typeflag: "2", linkname: "b" },
        { name: "b", typeflag: "1", linkname: "a" },
        { name: "c", typeflag: "3" },
      ]),
    );
    expect(entries.map((entry) => entry.type)).toEqual(["link", "link", "other"]);
  });
});

describe("create", () => {
  let source: string;

  beforeEach(async () => {
    source = await mkdtemp(join(tmpdir(), "pipack-tar-src-"));
    await mkdir(join(source, "yarn/2.2.2/bin"), { recursive: true });
    await writeFile(join(source, "yarn/2.2.2/.corepack"), `{"locator":{"name":"yarn"}}`);
    await writeFile(join(source, "yarn/2.2.2/bin/yarn.js"), "console.log(1)\n", { mode: 0o755 });
    await writeFile(join(source, `yarn/2.2.2/${"deep".repeat(40)}.js`), "long");
  });

  afterEach(async () => {
    await rm(source, { recursive: true, force: true });
  });

  it("round-trips through listEntries and extract", async () => {
    const archive = join(source, "corepack.tgz");
    await create(source, ["yarn/2.2.2"], archive);

    const listed = await listEntries(streamOf(await readFile(archive)));
    expect(listed.map((entry) => entry.path)).toContain("yarn/2.2.2/.corepack");
    expect(listed.map((entry) => entry.path)).toContain("yarn/2.2.2/bin/yarn.js");
    // The >100 byte name survives via a PAX header rather than being truncated.
    expect(listed.map((entry) => entry.path)).toContain(`yarn/2.2.2/${"deep".repeat(40)}.js`);
    expect(listed.some((entry) => entry.path === "yarn/2.2.2/" && entry.type === "directory")).toBe(
      true,
    );

    await extract(streamOf(await readFile(archive)), dest, { strip: 0 });
    expect(await readFile(join(dest, "yarn/2.2.2/.corepack"), "utf8")).toBe(
      `{"locator":{"name":"yarn"}}`,
    );
    expect(await readFile(join(dest, "yarn/2.2.2/bin/yarn.js"), "utf8")).toBe("console.log(1)\n");
    expect(await readFile(join(dest, `yarn/2.2.2/${"deep".repeat(40)}.js`), "utf8")).toBe("long");
    expect((await stat(join(dest, "yarn/2.2.2/bin/yarn.js"))).mode & 0o111).not.toBe(0);
  });

  it("never packs a symlink", async () => {
    await symlink("/etc/passwd", join(source, "yarn/2.2.2/escape"));
    const archive = join(source, "corepack.tgz");
    await create(source, ["yarn/2.2.2"], archive);

    const listed = await listEntries(streamOf(await readFile(archive)));
    expect(listed.some((entry) => entry.path.endsWith("escape"))).toBe(false);
  });
});
