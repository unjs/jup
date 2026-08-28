/**
 * §15.23 — `jup.lock`.
 *
 * The conformance rows prove the pipeline end to end; these prove the rules the
 * pipeline leans on, in particular the two that are invisible from outside: an
 * exact pin never involves the file, and a damaged file degrades rather than
 * throws.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hostTarget } from "../../src/config/table.ts";
import {
  CACHE_DIRECTORY,
  CACHE_TTL_MS,
  hashFromIntegrity,
  integrityForHost,
  integrityFromHash,
  LOCKFILE_NAME,
  readCachedResolution,
  readKnownResolution,
  readLockfile,
  readResolution,
  removeCachedResolution,
  removeResolution,
  resolutionKey,
  usesLockfile,
  writeCachedResolution,
  writeResolution,
} from "../../src/project/lockfile.ts";

let dir: string;

const RANGE = { name: "pnpm", range: "^11.0.0" };
/** sha512 of nothing in particular; only its round-trip matters here. */
const HEX = "ab".repeat(64);
const HASH = `sha512.${HEX}`;

function write(content: string): void {
  writeFileSync(join(dir, LOCKFILE_NAME), content);
}

function read(): string {
  return readFileSync(join(dir, LOCKFILE_NAME), "utf8");
}

/** `<project>/node_modules/.jup`, the only place the memo is written. */
function modules(): string {
  const path = join(dir, CACHE_DIRECTORY);
  mkdirSync(path, { recursive: true });
  return path;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jup-lock-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("usesLockfile — §15.23", () => {
  it("is false for an exact version, so an exact pin never touches the file", () => {
    for (const range of ["1.22.4", "11.1.2", "4.0.0-rc.1", "1.22.4+sha1.abc"]) {
      expect(usesLockfile({ name: "yarn", range }), range).toBe(false);
    }
  });

  it("is false for a URL reference, which carries its own digest", () => {
    expect(usesLockfile({ name: "yarn", range: "https://example.test/yarn.js#sha1.ab" })).toBe(
      false,
    );
  });

  it("is true for a range or a dist-tag", () => {
    for (const range of ["^11.0.0", "6.x", "*", ">=2", "latest", "stable"]) {
      expect(usesLockfile({ name: "pnpm", range }), range).toBe(true);
    }
  });

  it("keys a resolution by the range exactly as written", () => {
    expect(resolutionKey({ name: "pnpm", range: "^11.0.0" })).toBe("pnpm@^11.0.0");
    expect(resolutionKey({ name: "pnpm", range: ">=11 <12" })).toBe("pnpm@>=11 <12");
  });
});

describe("readLockfile — §15.23", () => {
  it("returns null for a missing file", () => {
    expect(readLockfile(dir)).toBeNull();
  });

  it("returns null rather than throwing for anything it cannot use", () => {
    for (const content of [
      "{ not json",
      "[]",
      "null",
      `"a string"`,
      `{"resolutions":{}}`,
      `{"version":2,"resolutions":{}}`,
      `{"version":1}`,
      `{"version":1,"resolutions":[]}`,
    ]) {
      write(content);
      expect(readLockfile(dir), content).toBeNull();
    }
  });

  it("returns null for an unreadable file", () => {
    // A directory where the file should be fails with EISDIR, not ENOENT.
    mkdirSync(join(dir, LOCKFILE_NAME));
    expect(readLockfile(dir)).toBeNull();
  });

  it("drops individual malformed entries and keeps the rest", () => {
    write(
      JSON.stringify({
        version: 1,
        resolutions: {
          "pnpm@^11.0.0": { resolved: "11.1.2", integrity: "sha512-abc" },
          "pnpm@bad-version": { resolved: "not-a-version" },
          "pnpm@non-string": { resolved: 42 },
          "pnpm@null": null,
          "pnpm@array": [],
          "pnpm@no-integrity": { resolved: "10.5.0" },
          "pnpm@bad-integrity-type": { resolved: "10.0.0", integrity: 7 },
        },
      }),
    );

    expect(readLockfile(dir)?.resolutions).toEqual({
      "pnpm@^11.0.0": { resolved: "11.1.2", integrity: "sha512-abc" },
      "pnpm@no-integrity": { resolved: "10.5.0" },
      "pnpm@bad-integrity-type": { resolved: "10.0.0" },
    });
  });
});

describe("readResolution — §15.23", () => {
  it("returns the recorded version with its digest as a build suffix", () => {
    writeResolution(dir, RANGE, { name: "pnpm", reference: "11.1.2" }, HASH);

    expect(readResolution(dir, RANGE)).toEqual({ name: "pnpm", reference: `11.1.2+${HASH}` });
  });

  it("returns null when the recorded version no longer satisfies the range", () => {
    write(JSON.stringify({ version: 1, resolutions: { "pnpm@^11.0.0": { resolved: "10.5.0" } } }));

    expect(readResolution(dir, RANGE)).toBeNull();
  });

  it("returns null for a key nobody recorded", () => {
    writeResolution(dir, RANGE, { name: "pnpm", reference: "11.1.2" }, HASH);

    expect(readResolution(dir, { name: "pnpm", range: "^10.0.0" })).toBeNull();
  });

  it("keeps a recorded prerelease, which the lenient rule is there for", () => {
    // Under strict satisfaction `11.2.0-rc.1` fails `^11.0.0`, and every run
    // would go back to the registry for a version already recorded and installed.
    write(
      JSON.stringify({
        version: 1,
        resolutions: { "pnpm@^11.0.0": { resolved: "11.2.0-rc.1" } },
      }),
    );

    expect(readResolution(dir, RANGE)?.reference).toBe("11.2.0-rc.1");
  });

  it("stands until refreshed for a dist-tag, which has no range to violate", () => {
    write(JSON.stringify({ version: 1, resolutions: { "pnpm@latest": { resolved: "10.5.0" } } }));

    expect(readResolution(dir, { name: "pnpm", range: "latest" })?.reference).toBe("10.5.0");
  });

  it("falls back to an unpinned reference when the digest is unusable", () => {
    write(
      JSON.stringify({
        version: 1,
        resolutions: { "pnpm@^11.0.0": { resolved: "11.1.2", integrity: "nonsense" } },
      }),
    );

    expect(readResolution(dir, RANGE)?.reference).toBe("11.1.2");
  });
});

describe("writeResolution / removeResolution — §15.23", () => {
  it("writes the documented shape: two-space indent, sorted keys, trailing newline", () => {
    writeResolution(
      dir,
      { name: "pnpm", range: "^11.0.0" },
      { name: "pnpm", reference: "11.1.2" },
      HASH,
    );
    writeResolution(
      dir,
      { name: "npm", range: "10.x" },
      { name: "npm", reference: "10.9.0" },
      undefined,
    );

    expect(read()).toBe(
      `${JSON.stringify(
        {
          version: 1,
          resolutions: {
            "npm@10.x": { resolved: "10.9.0" },
            "pnpm@^11.0.0": { resolved: "11.1.2", integrity: integrityFromHash(HASH) },
          },
        },
        undefined,
        2,
      )}\n`,
    );
  });

  it("strips the build suffix from the recorded version", () => {
    writeResolution(dir, RANGE, { name: "pnpm", reference: `11.1.2+${HASH}` }, HASH);

    expect(readLockfile(dir)?.resolutions["pnpm@^11.0.0"]?.resolved).toBe("11.1.2");
  });

  it("round-trips: what it writes is what it reads back", () => {
    writeResolution(dir, RANGE, { name: "pnpm", reference: "11.1.2" }, HASH);
    const first = read();

    writeResolution(dir, RANGE, { name: "pnpm", reference: "11.1.2" }, HASH);

    expect(read()).toBe(first);
  });

  it("removes one key, and the whole file once nothing is left", () => {
    writeResolution(dir, RANGE, { name: "pnpm", reference: "11.1.2" }, HASH);
    writeResolution(
      dir,
      { name: "npm", range: "10.x" },
      { name: "npm", reference: "10.9.0" },
      HASH,
    );

    removeResolution(dir, "npm@10.x");
    expect(Object.keys(readLockfile(dir)!.resolutions)).toEqual(["pnpm@^11.0.0"]);

    removeResolution(dir, "pnpm@^11.0.0");
    expect(readLockfile(dir)).toBeNull();
    expect(() => read()).toThrow();
  });

  it("is a no-op for a key that is not recorded, and for a missing file", () => {
    expect(() => removeResolution(dir, "pnpm@^11.0.0")).not.toThrow();

    writeResolution(dir, RANGE, { name: "pnpm", reference: "11.1.2" }, HASH);
    const before = read();
    removeResolution(dir, "yarn@^1.0.0");

    expect(read()).toBe(before);
  });

  it("never throws when the project directory cannot be written", () => {
    const missing = join(dir, "gone");

    expect(() =>
      writeResolution(missing, RANGE, { name: "pnpm", reference: "11.1.2" }, HASH),
    ).not.toThrow();
  });
});

describe("the SRI codec — §15.23", () => {
  it("round-trips a hash through the spelling npm uses", () => {
    expect(integrityFromHash(HASH)).toMatch(/^sha512-[\d+/A-Za-z]+=*$/);
    expect(hashFromIntegrity(integrityFromHash(HASH)!)).toBe(HASH);
  });

  it("matches what the registry publishes, byte for byte", () => {
    // `sha512-4mgVEQ==` is `sha512` over the four bytes below, as npm spells it.
    const sri = `sha512-${Buffer.from("e2681511", "hex").toString("base64")}`;
    expect(hashFromIntegrity(sri)).toBe("sha512.e2681511");
    expect(integrityFromHash("sha512.e2681511")).toBe(sri);
  });

  it("answers undefined for anything it cannot convert", () => {
    for (const value of ["", "-", "sha512", "sha512-", "-abc", "1sha-abc"]) {
      expect(hashFromIntegrity(value), value).toBeUndefined();
    }
    for (const value of ["", ".", "sha512", "sha512.", ".abc", "sha512.xyz", "sha512.abc"]) {
      expect(integrityFromHash(value), value).toBeUndefined();
    }
  });

  it("takes the first entry of a multi-entry SRI string and drops its options", () => {
    expect(hashFromIntegrity("sha512-4mgVEQ==?foo=bar sha256-abcd")).toBe(
      hashFromIntegrity("sha512-4mgVEQ=="),
    );
  });
});

/* -------------------------------------------------------------------------- *
 * §15.28 — a per-host artifact has no single digest
 * -------------------------------------------------------------------------- */

describe("per-host resolutions — §15.28 within §15.23", () => {
  const BUN = { name: "bun", range: "^1.4.0" };
  const OTHER = "darwin-arm64" === hostTarget() ? "linux-x64" : "darwin-arm64";

  it("records the digest under this host's key, not flat", () => {
    writeResolution(dir, BUN, { name: "bun", reference: "1.4.0" }, HASH, true);

    // The version is one decision, shared. The digest is not: it describes the
    // bytes *this* machine downloaded, and a flat field would hand them to a
    // colleague on another platform as a pin their download can never match.
    expect(JSON.parse(read())).toEqual({
      version: 1,
      resolutions: {
        "bun@^1.4.0": {
          resolved: "1.4.0",
          integrity: { [hostTarget()]: `sha512-${Buffer.from(HEX, "hex").toString("base64")}` },
        },
      },
    });
  });

  it("carries other hosts' keys forward while the version stands", () => {
    const theirs =
      "sha512-Du44zebtPXJujvMLmtIxEQ6ykOhYt7L/Q+YIGVm+Yy+Pj/fpOnq60ggwIpKp/pGAFbYHNiTrA3JTjuZ9MTbZIg==";
    write(
      `${JSON.stringify({
        version: 1,
        resolutions: { "bun@^1.4.0": { resolved: "1.4.0", integrity: { [OTHER]: theirs } } },
      })}\n`,
    );

    writeResolution(dir, BUN, { name: "bun", reference: "1.4.0" }, HASH, true);

    const entry = readLockfile(dir)!.resolutions["bun@^1.4.0"]!;
    expect(entry.integrity).toHaveProperty(OTHER, theirs);
    expect(entry.integrity).toHaveProperty(hostTarget());
  });

  it("drops other hosts' keys when the version moves", () => {
    write(
      `${JSON.stringify({
        version: 1,
        resolutions: { "bun@^1.4.0": { resolved: "1.3.0", integrity: { [OTHER]: "sha512-old" } } },
      })}\n`,
    );

    writeResolution(dir, BUN, { name: "bun", reference: "1.4.0" }, HASH, true);

    // A digest taken for 1.3.0 says nothing about 1.4.0, on any host.
    expect(Object.keys(readLockfile(dir)!.resolutions["bun@^1.4.0"]!.integrity as object)).toEqual([
      hostTarget(),
    ]);
  });

  it("pins the reference on a host the file records, and only the version elsewhere", () => {
    writeResolution(dir, BUN, { name: "bun", reference: "1.4.0" }, HASH, true);

    // This host has a recorded digest, so §06.1 row 1 gets to check it.
    expect(readResolution(dir, BUN)).toEqual({ name: "bun", reference: `1.4.0+${HASH}` });

    // A host with no entry yet still resolves without a network request; what
    // verifies its download is npm's signature over its own artifact (§06.3),
    // which is the tier a native artifact always has.
    write(
      `${JSON.stringify({
        version: 1,
        resolutions: { "bun@^1.4.0": { resolved: "1.4.0", integrity: { [OTHER]: "sha512-x" } } },
      })}\n`,
    );
    expect(readResolution(dir, BUN)).toEqual({ name: "bun", reference: "1.4.0" });
  });

  it("sorts the host keys, so a new host is a one-line diff", () => {
    write(
      `${JSON.stringify({
        version: 1,
        resolutions: {
          "bun@^1.4.0": {
            resolved: "1.4.0",
            integrity: { "win32-x64": "sha512-w", "darwin-x64": "sha512-d" },
          },
        },
      })}\n`,
    );
    writeResolution(dir, BUN, { name: "bun", reference: "1.4.0" }, HASH, true);

    const keys = Object.keys(
      JSON.parse(read()).resolutions["bun@^1.4.0"].integrity as Record<string, string>,
    );
    expect(keys).toEqual([...keys].sort());
  });

  it("reads a hand-written map, and drops only the entries that are not strings", () => {
    write(
      `${JSON.stringify({
        version: 1,
        resolutions: {
          "bun@^1.4.0": { resolved: "1.4.0", integrity: { [hostTarget()]: "sha512-ok", junk: 5 } },
        },
      })}\n`,
    );

    const entry = readLockfile(dir)!.resolutions["bun@^1.4.0"]!;
    expect(entry.integrity).toEqual({ [hostTarget()]: "sha512-ok" });
    expect(integrityForHost(entry)).toBe("sha512-ok");
  });

  it("still writes a flat digest for a package manager that has one", () => {
    // The default, and the shape every existing file and every other entry uses.
    writeResolution(dir, RANGE, { name: "pnpm", reference: "11.1.2" }, HASH);
    expect(typeof readLockfile(dir)!.resolutions[resolutionKey(RANGE)]!.integrity).toBe("string");
  });

  it("drops a flat digest recorded before the band became per-host", () => {
    // pnpm 11 is a tarball with one digest; pnpm 12 is one artifact per host.
    // A file written by a build whose table stopped at 11 therefore carries a
    // flat digest for a 12 — of the wrapper package, which is not what this
    // build downloads. Reading it back as a pin would fail every machine that
    // had run that build, on a file the user committed, so the version stands
    // and the digest does not (§15.28). npm's signature over the host's own
    // artifact is what verifies the bytes instead (§06.3).
    const range = { name: "pnpm", range: "12" };
    write(
      `${JSON.stringify({
        version: 1,
        resolutions: { "pnpm@12": { resolved: "12.0.0", integrity: `sha512-${"ab".repeat(43)}=` } },
      })}\n`,
    );

    expect(readResolution(dir, range)).toEqual({ name: "pnpm", reference: "12.0.0" });

    // The same file, one major down, is a flat digest that *is* this host's
    // fact — so the guard is about the band and not about the shape.
    write(
      `${JSON.stringify({
        version: 1,
        resolutions: { "pnpm@^11.0.0": { resolved: "11.1.2", integrity: integrityFromHash(HASH) } },
      })}\n`,
    );
    expect(readResolution(dir, RANGE)).toEqual({ name: "pnpm", reference: `11.1.2+${HASH}` });
  });
});

describe("the resolution cache — §15.23", () => {
  it("writes into node_modules/.jup, with an expiry a day out", () => {
    const now = 1_700_000_000_000;
    modules();

    writeCachedResolution(dir, RANGE, { name: "pnpm", reference: "11.1.2" }, HASH, false, now);

    // The path is the whole point of the directory: npm reads a visible entry in
    // `node_modules` as an installed package and deletes it on the next
    // `install`, so a memo at `node_modules/jup.lock` never survives to expire.
    expect(existsSync(join(dir, "node_modules", ".jup", LOCKFILE_NAME))).toBe(true);
    expect(existsSync(join(dir, "node_modules", LOCKFILE_NAME))).toBe(false);

    expect(readLockfile(join(dir, CACHE_DIRECTORY))?.resolutions["pnpm@^11.0.0"]).toEqual({
      resolved: "11.1.2",
      integrity: integrityFromHash(HASH),
      expires: now + CACHE_TTL_MS,
    });
    // The project's own file is not what this writes.
    expect(readLockfile(dir)).toBeNull();
  });

  it("creates its own .jup directory inside a node_modules that is already there", () => {
    mkdirSync(join(dir, "node_modules"));

    writeCachedResolution(dir, RANGE, { name: "pnpm", reference: "11.1.2" }, HASH);

    expect(readCachedResolution(dir, RANGE)?.locator.reference).toBe(`11.1.2+${HASH}`);
  });

  it("leaves no stray temp file beside the memo it wrote", () => {
    modules();
    writeCachedResolution(dir, RANGE, { name: "pnpm", reference: "11.1.2" }, HASH);

    // The rename is only atomic within one directory, so the temp must be in
    // `.jup` too — and must be gone once the write has landed.
    expect(readdirSync(join(dir, "node_modules", ".jup"))).toEqual([LOCKFILE_NAME]);
  });

  it("writes nothing at all when node_modules is absent", () => {
    writeCachedResolution(dir, RANGE, { name: "pnpm", reference: "11.1.2" }, HASH);

    expect(readCachedResolution(dir, RANGE)).toBeNull();
    // Not the directory either: it belongs to the package manager.
    expect(existsSync(join(dir, "node_modules"))).toBe(false);
  });

  it("declines a node_modules that is a file rather than a directory", () => {
    writeFileSync(join(dir, "node_modules"), "not a directory\n");

    expect(() =>
      writeCachedResolution(dir, RANGE, { name: "pnpm", reference: "11.1.2" }, HASH),
    ).not.toThrow();
    expect(readCachedResolution(dir, RANGE)).toBeNull();
  });

  it("declines a .jup that is a file rather than a directory", () => {
    mkdirSync(join(dir, "node_modules"));
    writeFileSync(join(dir, CACHE_DIRECTORY), "not a directory\n");

    expect(() =>
      writeCachedResolution(dir, RANGE, { name: "pnpm", reference: "11.1.2" }, HASH),
    ).not.toThrow();
    expect(readCachedResolution(dir, RANGE)).toBeNull();
  });

  it("reads back a live entry, and reports an aged-out one as expired", () => {
    const now = 1_700_000_000_000;
    modules();
    writeCachedResolution(dir, RANGE, { name: "pnpm", reference: "11.1.2" }, HASH, false, now);

    expect(readCachedResolution(dir, RANGE, now + 1000)).toEqual({
      locator: { name: "pnpm", reference: `11.1.2+${HASH}` },
      expired: false,
    });
    // Still returned once it ages out: an expired memo beats no answer when the
    // registry cannot be reached, and the caller decides what to do with it.
    expect(readCachedResolution(dir, RANGE, now + CACHE_TTL_MS + 1)?.expired).toBe(true);
  });

  it("treats a stamp further out than one window as expired", () => {
    // A `node_modules` restored from an image, or written under a clock that ran
    // fast: this build never writes such a stamp, and believing one would pin the
    // range with no request for as long as it says.
    const now = 1_700_000_000_000;
    writeFileSync(
      join(modules(), LOCKFILE_NAME),
      `${JSON.stringify({
        version: 1,
        resolutions: {
          "pnpm@^11.0.0": { resolved: "11.1.2", expires: now + CACHE_TTL_MS + 1 },
        },
      })}\n`,
    );

    expect(readCachedResolution(dir, RANGE, now)?.expired).toBe(true);
    // Still the answer of last resort, exactly like any other expired memo.
    expect(readCachedResolution(dir, RANGE, now)?.locator.reference).toBe("11.1.2");
    // The boundary itself is what a write made at `now` produces, and stands.
    expect(readCachedResolution(dir, RANGE, now + 1)?.expired).toBe(false);
  });

  it("treats an entry with no expiry as already expired", () => {
    writeFileSync(
      join(modules(), LOCKFILE_NAME),
      `{"version":1,"resolutions":{"pnpm@^11.0.0":{"resolved":"11.1.2"}}}\n`,
    );

    expect(readCachedResolution(dir, RANGE)?.expired).toBe(true);
  });

  it("applies the same range test as the recorded file", () => {
    const now = 1_700_000_000_000;
    modules();
    writeCachedResolution(dir, RANGE, { name: "pnpm", reference: "10.5.0" }, undefined, false, now);

    expect(readCachedResolution(dir, RANGE, now + 1000)).toBeNull();
  });

  it("is dropped alongside the recorded entry it shadows", () => {
    modules();
    writeResolution(dir, RANGE, { name: "pnpm", reference: "11.1.2" }, HASH);
    writeCachedResolution(dir, RANGE, { name: "pnpm", reference: "11.1.2" }, HASH);

    removeResolution(dir, resolutionKey(RANGE));

    expect(readLockfile(dir)).toBeNull();
    expect(readCachedResolution(dir, RANGE)).toBeNull();
  });

  it("can be dropped on its own, leaving the recorded decision standing", () => {
    // What `use` and `up` do to the key they have just recorded: the memo is a
    // note about what the registry said *before* that decision, and it answers
    // alone wherever the committed file is not visible.
    modules();
    writeResolution(dir, RANGE, { name: "pnpm", reference: "11.1.2" }, HASH);
    writeCachedResolution(dir, RANGE, { name: "pnpm", reference: "11.0.0" }, undefined);

    removeCachedResolution(dir, resolutionKey(RANGE));

    expect(readCachedResolution(dir, RANGE)).toBeNull();
    expect(readResolution(dir, RANGE)?.reference).toBe(`11.1.2+${HASH}`);
  });
});

describe("readKnownResolution — §15.23's read order", () => {
  const LOCATOR = { name: "pnpm", reference: "11.1.2" };

  it("prefers the recorded resolution and does not read the memo at all", () => {
    modules();
    writeResolution(dir, RANGE, LOCATOR, HASH);
    writeCachedResolution(dir, RANGE, { name: "pnpm", reference: "11.0.0" }, undefined);

    const known = readKnownResolution(dir, RANGE);

    expect(known.locator?.reference).toBe(`11.1.2+${HASH}`);
    // A committed decision outranks a memo, so the memo is not even reported.
    expect(known.cached).toBeNull();
  });

  it("falls back to a live memo", () => {
    const now = 1_700_000_000_000;
    modules();
    writeCachedResolution(dir, RANGE, LOCATOR, HASH, false, now);

    expect(readKnownResolution(dir, RANGE, now + 1000).locator?.reference).toBe(`11.1.2+${HASH}`);
  });

  it("answers null for an expired memo, and still hands it back", () => {
    const now = 1_700_000_000_000;
    modules();
    writeCachedResolution(dir, RANGE, LOCATOR, HASH, false, now);

    const known = readKnownResolution(dir, RANGE, now + CACHE_TTL_MS + 1);

    // Nothing to run on without asking — but the stale answer survives for the
    // caller that has to degrade rather than block (§15.23, §04.4).
    expect(known.locator).toBeNull();
    expect(known.cached).toEqual({
      locator: { ...LOCATOR, reference: `11.1.2+${HASH}` },
      expired: true,
    });
  });

  it("answers null for a project with neither file", () => {
    expect(readKnownResolution(dir, RANGE)).toEqual({ locator: null, cached: null });
  });
});
