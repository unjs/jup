import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ADDON_BINARIES } from "../../src/run/addon-binaries.ts";
import { addonPath, encodeExecBlock, extractAddon, loadAddon } from "../../src/run/addon.ts";

/*
 * §08.3.3 — the embedded `execve` addon. The replacement itself is exercised
 * end to end in `exec.test.ts`; this is the file's journey from the bundle to
 * `<home>` and back.
 */

let root: string;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "jup-addon-")));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const HOST = `${process.platform}-${process.arch}`;
const SUPPORTED = Object.hasOwn(ADDON_BINARIES, HOST);

describe("ADDON_BINARIES", () => {
  it("covers §02.4's POSIX hosts but Intel macOS", () => {
    expect(Object.keys(ADDON_BINARIES).sort()).toEqual([
      "darwin-arm64",
      "linux-arm64",
      "linux-x64",
    ]);
  });

  it.each(Object.entries(ADDON_BINARIES))(
    "inflates %s to the bytes its digest names",
    (_, entry) => {
      const bytes = inflateRawSync(Buffer.from(entry.deflated, "base64"));
      expect(bytes.length).toBe(entry.size);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(entry.sha256);
    },
  );
});

/**
 * The facts a 64-bit little-endian ELF shared object states about what it needs
 * to load: its program-header types, its `DT_NEEDED` entries, and the names of
 * the dynamic symbols it leaves undefined.
 */
function elfNeeds(image: Buffer): {
  segments: number[];
  needed: string[];
  undefinedSymbols: string[];
} {
  const phoff = Number(image.readBigUInt64LE(32));
  const phnum = image.readUInt16LE(56);
  const shoff = Number(image.readBigUInt64LE(40));
  const shnum = image.readUInt16LE(60);
  const segments: number[] = [];
  for (let index = 0; index < phnum; index += 1)
    segments.push(image.readUInt32LE(phoff + index * 56));

  const sections = Array.from({ length: shnum }, (_, index) => {
    const at = shoff + index * 64;
    return {
      type: image.readUInt32LE(at + 4),
      offset: Number(image.readBigUInt64LE(at + 24)),
      size: Number(image.readBigUInt64LE(at + 32)),
      link: image.readUInt32LE(at + 40),
    };
  });
  const string = (table: { offset: number }, at: number): string =>
    image.toString("latin1", table.offset + at, image.indexOf(0, table.offset + at));

  const needed: string[] = [];
  const undefinedSymbols: string[] = [];
  for (const section of sections) {
    if (section.type === 6 /* SHT_DYNAMIC */) {
      for (let at = section.offset; at < section.offset + section.size; at += 16) {
        const tag = image.readBigInt64LE(at);
        if (tag === 1n /* DT_NEEDED */) {
          needed.push(string(sections[section.link]!, Number(image.readBigUInt64LE(at + 8))));
        }
      }
    }
    if (section.type === 11 /* SHT_DYNSYM */) {
      for (let at = section.offset + 24; at < section.offset + section.size; at += 24) {
        if (image.readUInt16LE(at + 6) === 0 /* SHN_UNDEF */) {
          undefinedSymbols.push(string(sections[section.link]!, image.readUInt32LE(at)));
        }
      }
    }
  }
  return { segments, needed, undefinedSymbols };
}

describe("the Linux addons", () => {
  /*
   * One file per architecture has to serve glibc and musl alike, so it may not
   * name a C library at all: no loader, no `DT_NEEDED`, and nothing undefined
   * but the Node-API functions the loading process provides. `native/execve.zig`
   * makes its system calls itself to keep it that way.
   */
  it.each(["linux-x64", "linux-arm64"])("%s needs nothing but Node-API", (host) => {
    const entry = ADDON_BINARIES[host]!;
    const { segments, needed, undefinedSymbols } = elfNeeds(
      inflateRawSync(Buffer.from(entry.deflated, "base64")),
    );
    expect(segments).not.toContain(3); // PT_INTERP
    expect(needed).toEqual([]);
    expect(undefinedSymbols.length).toBeGreaterThan(0);
    for (const name of undefinedSymbols) expect(name).toMatch(/^napi_/);
  });
});

describe("encodeExecBlock", () => {
  it("lays out path, arguments and environment NUL-terminated, with room for the pointers", () => {
    const encoded = encodeExecBlock("/bin/x", ["x", "a b"], { A: "1", B: "" })!;
    expect(encoded.argc).toBe(2);
    expect(encoded.envc).toBe(2);
    const text = "/bin/x\0x\0a b\0A=1\0B=\0";
    expect(encoded.block.toString("latin1", 0, text.length)).toBe(text);
    expect(encoded.block.length).toBe(text.length + (5 + 3) * 8);
  });

  it("refuses a string no `execve` can carry", () => {
    expect(encodeExecBlock("/bin/x", ["x\0y"], {})).toBeUndefined();
    expect(encodeExecBlock("/bin/x", ["x"], { A: "\0" })).toBeUndefined();
  });
});

describe.runIf(SUPPORTED)("extractAddon", () => {
  it("writes this host's addon into `<home>/addon`, named by its digest", () => {
    const home = join(root, "fresh");
    vi.stubEnv("COREPACK_HOME", home);
    const file = extractAddon();
    const entry = ADDON_BINARIES[HOST]!;
    expect(file).toBe(join(home, "addon", `execve-${entry.sha256.slice(0, 16)}.node`));
    expect(file).toBe(addonPath());
    expect(createHash("sha256").update(readFileSync(file!)).digest("hex")).toBe(entry.sha256);
    expect(statSync(file!).mode & 0o777).toBe(0o644);
  });

  it("leaves a file already in place alone", () => {
    const home = join(root, "again");
    vi.stubEnv("COREPACK_HOME", home);
    const file = extractAddon()!;
    const before = statSync(file).mtimeMs;
    expect(extractAddon()).toBe(file);
    expect(statSync(file).mtimeMs).toBe(before);
  });

  it("gives up quietly on a home it cannot write", () => {
    const home = join(root, "blocked");
    writeFileSync(home, "a file where the directory would go");
    vi.stubEnv("COREPACK_HOME", home);
    expect(extractAddon()).toBeUndefined();
  });
});

describe.runIf(SUPPORTED && process.platform !== "win32")("loadAddon", () => {
  it("loads the extracted addon, whose `execve` reports a refusal instead of aborting", () => {
    vi.stubEnv("COREPACK_HOME", join(root, "load"));
    extractAddon();
    const addon = loadAddon()!;
    expect(addon).toBeDefined();

    const missing = encodeExecBlock(join(root, "does-not-exist"), ["x"], {})!;
    expect(addon.execve(missing.block, missing.argc, missing.envc, -1)).toBe(2); // ENOENT

    const data = join(root, "data");
    writeFileSync(data, "not a program\n", { mode: 0o644 });
    const denied = encodeExecBlock(data, ["x"], {})!;
    expect(addon.execve(denied.block, denied.argc, denied.envc, -1)).toBe(13); // EACCES

    // A block too short for its own counts is refused before any system call.
    expect(addon.execve(Buffer.alloc(4), 5, 0, -1)).toBe(22); // EINVAL
  });
});
