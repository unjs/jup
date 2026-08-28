import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  opendirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UsageError } from "../../src/errors.ts";
import {
  bumpLastKnownGood,
  cacheClean,
  createTempDir,
  findInstalledVersion,
  getHomeFolder,
  getInstallFolder,
  getVersionDir,
  promote,
  readLastKnownGood,
  readHashPin,
  readInstalledSpec,
  readMarker,
  referenceWithHash,
  resolveInstallTarget,
  writeLastKnownGood,
  writeMarker,
} from "../../src/cache/store.ts";
// §15.17 moved `resolveBin` onto the cold path — it runs once per *install*,
// never on a cache hit, and the warm chunk is measured in bytes (§16.3).
import { resolveBin } from "../../src/cache/install.ts";

/**
 * `node:fs`'s ESM namespace is frozen, so `vi.spyOn` cannot touch it. The mock
 * delegates every function to the real implementation and exists purely so the
 * §14.1 fast-path test can *count* directory reads, and so the last-known-good
 * tests can inject an `EROFS` without needing a read-only filesystem.
 */
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    readdirSync: vi.fn(actual.readdirSync),
    readFileSync: vi.fn(actual.readFileSync),
    opendirSync: vi.fn(actual.opendirSync),
    writeFileSync: vi.fn(actual.writeFileSync),
    renameSync: vi.fn(actual.renameSync),
    mkdirSync: vi.fn(actual.mkdirSync),
  };
});

const fsActual = await vi.importActual<typeof import("node:fs")>("node:fs");
const mkdirSyncActual = fsActual.mkdirSync;

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "jup-store-"));
  vi.stubEnv("COREPACK_HOME", home);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});

/** Create `<store>/<name>/<version>/` with a complete `.jup` marker. */
function seedInstall(name: string, version: string, marker?: unknown): string {
  const dir = join(getInstallFolder(), name, version);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, ".jup"),
    JSON.stringify(
      marker ?? {
        locator: { name, reference: version },
        bin: { [name]: `./${name}.js` },
        hash: "sha1.ab",
      },
    ),
  );
  return dir;
}

/* -------------------------------------------------------------------------- */
/* §07.1 — home resolution                                                     */
/* -------------------------------------------------------------------------- */

describe("getHomeFolder — §07.1", () => {
  it("prefers COREPACK_HOME over everything else", () => {
    vi.stubEnv("XDG_CACHE_HOME", "/xdg");
    vi.stubEnv("LOCALAPPDATA", "/lad");
    expect(getHomeFolder()).toBe(home);
  });

  it("consults XDG_CACHE_HOME before LOCALAPPDATA — on every platform", () => {
    vi.stubEnv("COREPACK_HOME", undefined);
    vi.stubEnv("XDG_CACHE_HOME", join("/xdg", "cache"));
    vi.stubEnv("LOCALAPPDATA", join("/lad"));
    expect(getHomeFolder()).toBe(join("/xdg", "cache", "jup"));
  });

  // §15.13 point 5 redirected this row (conformance 171). Corepack honours
  // LOCALAPPDATA on POSIX, which is #673: a Linux process started through WSL
  // interop inherits it and lands its cache on /mnt/c.
  it("171: ignores LOCALAPPDATA off Windows", () => {
    vi.stubEnv("COREPACK_HOME", undefined);
    vi.stubEnv("XDG_CACHE_HOME", undefined);
    vi.stubEnv("LOCALAPPDATA", join("/lad"));

    const expected =
      process.platform === "win32" ? join("/lad", "jup") : join(homedir(), ".cache", "jup");
    expect(getHomeFolder()).toBe(expected);
  });

  it("falls back to the platform default under the user's home directory", () => {
    vi.stubEnv("COREPACK_HOME", undefined);
    vi.stubEnv("XDG_CACHE_HOME", undefined);
    vi.stubEnv("LOCALAPPDATA", undefined);
    const expected = join(
      homedir(),
      process.platform === "win32" ? join("AppData", "Local") : ".cache",
      "jup",
    );
    expect(getHomeFolder()).toBe(expected);
  });

  it("appends the v1 layout segment for the install folder", () => {
    expect(getInstallFolder()).toBe(join(home, "v1"));
  });
});

/* -------------------------------------------------------------------------- */
/* §07.2 — version directory naming                                            */
/* -------------------------------------------------------------------------- */

describe("getVersionDir — §07.2", () => {
  it("uses the plain version for an unadorned reference", () => {
    expect(getVersionDir({ name: "yarn", reference: "1.22.22" })).toBe("1.22.22");
  });

  it("collapses hash-suffixed references onto one directory", () => {
    const a = getVersionDir({ name: "yarn", reference: "4.1.0+sha224.aaaa" });
    const b = getVersionDir({ name: "yarn", reference: "4.1.0+sha512.bbbb" });
    expect(a).toBe("4.1.0");
    expect(b).toBe("4.1.0");
  });

  it("keeps a prerelease tag, which is part of the version", () => {
    expect(getVersionDir({ name: "yarn", reference: "4.0.0-rc.1+sha1.cc" })).toBe("4.0.0-rc.1");
  });

  it("encodes a URL reference as a single path segment, minus its fragment", () => {
    const url = "https://example.com/path/yarn.js?v=1";
    expect(getVersionDir({ name: "yarn", reference: `${url}#sha224.deadbeef` })).toBe(
      encodeURIComponent(url),
    );
    expect(getVersionDir({ name: "yarn", reference: url })).toBe(encodeURIComponent(url));
    expect(getVersionDir({ name: "yarn", reference: url })).not.toContain("/");
  });
});

/* -------------------------------------------------------------------------- */
/* §07.2 — the marker, the entire warm path                                    */
/* -------------------------------------------------------------------------- */

describe("readMarker / writeMarker — §07.2", () => {
  it("round-trips a marker", () => {
    const dir = join(getInstallFolder(), "yarn", "4.1.0");
    mkdirSync(dir, { recursive: true });
    const marker = {
      locator: { name: "yarn", reference: "4.1.0+sha224.abcd" },
      bin: { yarn: "./bin/yarn.js" },
      hash: "sha224.abcd",
    };
    writeMarker(dir, marker);
    expect(readMarker(dir)).toEqual(marker);
  });

  it("returns null on ENOENT so the caller proceeds to download", () => {
    expect(readMarker(join(getInstallFolder(), "yarn", "9.9.9"))).toBeNull();
  });

  it("propagates a corrupt marker rather than silently re-downloading", () => {
    const dir = join(getInstallFolder(), "yarn", "4.1.0");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".jup"), "{ truncated");
    expect(() => readMarker(dir)).toThrow(SyntaxError);
  });
});

/* -------------------------------------------------------------------------- */
/* §15.11 — the cache hit checks the pin                                       */
/* -------------------------------------------------------------------------- */

/** How many of the recorded `readFileSync` calls asked for a `.jup`. */
function markerReads(mock: { mock: { calls: unknown[][] } }): number {
  return mock.mock.calls.filter((call) => String(call[0]).endsWith(".jup")).length;
}

describe("readHashPin — §02.1", () => {
  it("reads a build suffix, defaulting the algorithm to sha512", () => {
    expect(readHashPin("4.1.0", ["sha224", "abcd"])).toEqual({ algo: "sha224", digest: "abcd" });
    expect(readHashPin("4.1.0", [])).toEqual({ algo: "sha512", digest: undefined });
  });

  it("reads a URL reference's fragment", () => {
    expect(readHashPin("https://example.com/yarn.js#sha256.abcd")).toEqual({
      algo: "sha256",
      digest: "abcd",
    });
    expect(readHashPin("https://example.com/yarn.js")).toEqual({ algo: "sha512" });
  });
});

describe("resolveInstallTarget — §15.11's cache-hit check", () => {
  /** A complete install of `<name>/<version>` whose marker records `hash`. */
  function seed(name: string, version: string, hash: string): string {
    const dir = join(getInstallFolder(), name, version);
    mkdirSync(dir, { recursive: true });
    writeMarker(dir, { locator: { name, reference: version }, bin: { [name]: "./x.js" }, hash });
    return dir;
  }

  it("is a hit when nothing is pinned", () => {
    const dir = seed("pnpm", "9.0.0", "sha512.aaaa");
    const found = resolveInstallTarget({ name: "pnpm", reference: "9.0.0" });
    expect(found.location).toBe(dir);
    expect(found.installed?.hash).toBe("sha512.aaaa");
  });

  it("is a hit when the marker carries exactly the pinned digest", () => {
    const dir = seed("pnpm", "9.0.0", "sha512.aaaa");
    const found = resolveInstallTarget({ name: "pnpm", reference: "9.0.0+sha512.aaaa" });
    expect(found.location).toBe(dir);
    expect(found.installed).not.toBeNull();
  });

  it("does not adopt an artifact installed under a different digest", () => {
    // The hole traced against the built binary and recorded against P12:
    // §07.2 gives both references one directory, and corepack re-attaches the
    // marker's hash to the locator instead of comparing it, so the second
    // project silently runs the first project's bytes.
    seed("pnpm", "9.0.0", "sha512.aaaa");
    const found = resolveInstallTarget({ name: "pnpm", reference: "9.0.0+sha512.bbbb" });

    expect(found.installed).toBeNull();
    expect(found.location).toBe(join(getInstallFolder(), "pnpm", "9.0.0+sha512.bbbb"));
  });

  it("does not adopt one recorded under a different algorithm either", () => {
    seed("pnpm", "9.0.0", "sha512.aaaa");
    const found = resolveInstallTarget({ name: "pnpm", reference: "9.0.0+sha256.aaaa" });
    expect(found.installed).toBeNull();
    expect(found.location).toBe(join(getInstallFolder(), "pnpm", "9.0.0+sha256.aaaa"));
  });

  it("hits the pin-qualified directory once it exists", () => {
    seed("pnpm", "9.0.0", "sha512.aaaa");
    const qualified = seed("pnpm", "9.0.0+sha512.bbbb", "sha512.bbbb");

    const found = resolveInstallTarget({ name: "pnpm", reference: "9.0.0+sha512.bbbb" });
    expect(found.location).toBe(qualified);
    expect(found.installed?.hash).toBe("sha512.bbbb");
    // And the unqualified reference still gets the unqualified entry.
    expect(readInstalledSpec({ name: "pnpm", reference: "9.0.0" })?.hash).toBe("sha512.aaaa");
  });

  it("refuses a qualified directory whose marker was tampered with", () => {
    seed("pnpm", "9.0.0", "sha512.aaaa");
    seed("pnpm", "9.0.0+sha512.bbbb", "sha512.cccc");

    expect(() => resolveInstallTarget({ name: "pnpm", reference: "9.0.0+sha512.bbbb" })).toThrow(
      /Mismatch hashes/,
    );
  });

  it("normalises the algorithm's case, since the marker is always lower case", () => {
    const dir = seed("pnpm", "9.0.0", "sha512.aaaa");
    expect(resolveInstallTarget({ name: "pnpm", reference: "9.0.0+SHA512.aaaa" }).location).toBe(
      dir,
    );
  });

  it("checks a URL reference's fragment the same way", () => {
    const url = "https://example.com/yarn.js";
    const dir = join(getInstallFolder(), "yarn", encodeURIComponent(url));
    mkdirSync(dir, { recursive: true });
    writeMarker(dir, { locator: { name: "yarn", reference: url }, hash: "sha256.aaaa" });

    expect(readInstalledSpec({ name: "yarn", reference: `${url}#sha256.aaaa` })).not.toBeNull();
    expect(readInstalledSpec({ name: "yarn", reference: `${url}#sha256.bbbb` })).toBeNull();
  });

  it("reads exactly one marker on the warm path (§01.3)", () => {
    seed("pnpm", "9.0.0", "sha512.aaaa");

    // §01.3 budgets one `.jup` read for a warm, exactly-pinned run, and
    // §15.11's check must not turn that into two. The second read exists only
    // for a reference the cached marker cannot vouch for.
    const readFileSyncMock = vi.mocked(readFileSync);
    readFileSyncMock.mockClear();
    expect(readInstalledSpec({ name: "pnpm", reference: "9.0.0+sha512.aaaa" })).not.toBeNull();
    expect(markerReads(readFileSyncMock)).toBe(1);

    readFileSyncMock.mockClear();
    expect(readInstalledSpec({ name: "pnpm", reference: "9.0.0+sha512.bbbb" })).toBeNull();
    expect(markerReads(readFileSyncMock)).toBe(2);
  });
});

describe("referenceWithHash — §07.6 step 3", () => {
  it("attaches the installed artifact's hash to a bare version", () => {
    expect(referenceWithHash("yarn", "4.1.0", "sha224.abcd")).toBe("4.1.0+sha224.abcd");
  });

  it("replaces an existing suffix rather than keeping it or appending a second", () => {
    // §07.6 — the hash of the bytes actually on disk always wins, so a stale
    // suffix carried in from `lastKnownGood.json` or the embedded table's
    // `default` is overwritten, never doubled up.
    expect(referenceWithHash("yarn", "4.1.0+sha1.stale", "sha224.abcd")).toBe("4.1.0+sha224.abcd");
    expect(referenceWithHash("yarn", "1.22.22+sha512.same", "sha512.same")).toBe(
      "1.22.22+sha512.same",
    );
  });

  it("leaves a URL reference alone — it carries its own `#algo.digest`", () => {
    const url = "https://example.com/yarn.js#sha224.abcd";
    expect(referenceWithHash("yarn", url, "sha512.other")).toBe(url);
  });

  /**
   * §15.28 — the choke point for "a per-host digest never travels".
   *
   * Every caller of this function writes the result somewhere that outlives the
   * machine: `packageManager` is committed, and `lastKnownGood.json` is copied
   * into container images and warmed caches (§03 of the CI guide). A digest
   * taken here is true of one platform's artifact only, and §06.1 row 1 reads a
   * reference-borne digest as an explicit pin — so carrying it turns the
   * *correct* artifact into a hash mismatch everywhere else. This is the test
   * that keeps the four sites in §15.28's list agreeing, because it is the one
   * function all of them go through.
   */
  it("declines to attach a per-host digest, keeping the bare version", () => {
    expect(referenceWithHash("bun", "1.4.0", "sha512.abcd")).toBe("1.4.0");
    expect(referenceWithHash("deno", "2.9.5", "sha512.abcd")).toBe("2.9.5");
    // And it strips one that arrived from somewhere else — which is how a
    // `lastKnownGood.json` written by a build that got this wrong heals.
    expect(referenceWithHash("deno", "2.9.5+sha512.wrong", "sha512.abcd")).toBe("2.9.5");
  });
});

/* -------------------------------------------------------------------------- */
/* §14.1 — the exact-version fast path                                         */
/* -------------------------------------------------------------------------- */

describe("findInstalledVersion — the §14.1 exact-version fast path", () => {
  beforeEach(() => {
    vi.mocked(readdirSync).mockClear();
    vi.mocked(opendirSync).mockClear();
  });

  /** The budget guard: an exact pin must never read a directory (§01.3, §16.3). */
  function expectNoDirectoryRead(): void {
    expect(readdirSync).not.toHaveBeenCalled();
    expect(opendirSync).not.toHaveBeenCalled();
  }

  it("stats the marker directly, without opening the store directory", () => {
    seedInstall("yarn", "1.0.0");
    seedInstall("yarn", "2.2.2");
    seedInstall("yarn", "3.0.0");

    expect(findInstalledVersion("yarn", "2.2.2")).toBe("2.2.2");
    expectNoDirectoryRead();
  });

  it("misses without a directory read when the marker is absent", () => {
    // The version directory exists but the install never completed.
    mkdirSync(join(getInstallFolder(), "yarn", "2.2.2"), { recursive: true });

    expect(findInstalledVersion("yarn", "2.2.2")).toBeNull();
    expectNoDirectoryRead();
  });

  it("misses without a directory read when nothing is installed at all", () => {
    expect(findInstalledVersion("yarn", "2.2.2")).toBeNull();
    expectNoDirectoryRead();
  });

  it("strips the build suffix before probing, and returns the plain version", () => {
    // §15.11 redirected this row: the directory is still the plain version, but
    // a hash-bearing reference is a *hit* only when the marker records that very
    // digest — the probe used to answer from the directory name alone, which is
    // how two references differing only in their hash came to share one install.
    seedInstall("yarn", "4.1.0", {
      locator: { name: "yarn", reference: "4.1.0+sha224.deadbeef" },
      bin: { yarn: "./yarn.js" },
      hash: "sha224.deadbeef",
    });

    expect(findInstalledVersion("yarn", "4.1.0+sha224.deadbeef")).toBe("4.1.0");
    expectNoDirectoryRead();
  });

  it("answers a miss when the installed marker records a different digest (§15.11)", () => {
    seedInstall("yarn", "4.1.0");

    expect(findInstalledVersion("yarn", "4.1.0+sha224.deadbeef")).toBeNull();
    // A miss, not a directory scan: the answer still costs one file, and the
    // caller falls through to §04.1 step 5 with its pin intact.
    expectNoDirectoryRead();
  });

  it("routes to the pin-qualified directory when that is where the artifact went", () => {
    seedInstall("yarn", "4.1.0");
    seedInstall("yarn", "4.1.0+sha224.deadbeef", {
      locator: { name: "yarn", reference: "4.1.0+sha224.deadbeef" },
      bin: { yarn: "./yarn.js" },
      hash: "sha224.deadbeef",
    });

    // The *pinned* reference comes back, because the bare version would send the
    // caller to the directory that just failed to prove the pin.
    expect(findInstalledVersion("yarn", "4.1.0+sha224.deadbeef")).toBe("4.1.0+sha224.deadbeef");
    expectNoDirectoryRead();
  });

  it("takes the fast path for an exact prerelease too", () => {
    seedInstall("yarn", "4.0.0-rc.1");

    expect(findInstalledVersion("yarn", "4.0.0-rc.1")).toBe("4.0.0-rc.1");
    expectNoDirectoryRead();
  });
});

/* -------------------------------------------------------------------------- */
/* §04.3 + §14.2 — the range probe                                             */
/* -------------------------------------------------------------------------- */

describe("findInstalledVersion — the range probe (§04.3, §14.2)", () => {
  it("returns the highest matching installed version", () => {
    for (const version of ["1.0.0", "1.5.0", "1.22.22", "2.0.0"]) seedInstall("yarn", version);
    expect(findInstalledVersion("yarn", "^1.0.0")).toBe("1.22.22");
    expect(findInstalledVersion("yarn", ">=1.0.0")).toBe("2.0.0");
  });

  it("scans the directory for a genuine range", () => {
    seedInstall("yarn", "1.0.0");
    vi.mocked(readdirSync).mockClear();
    expect(findInstalledVersion("yarn", "^1.0.0")).toBe("1.0.0");
    expect(readdirSync).toHaveBeenCalled();
  });

  it("skips dot-entries such as macOS's .DS_Store", () => {
    seedInstall("yarn", "1.0.0");
    writeFileSync(join(getInstallFolder(), "yarn", ".DS_Store"), "");
    mkdirSync(join(getInstallFolder(), "yarn", ".hidden"), { recursive: true });

    expect(findInstalledVersion("yarn", "*")).toBe("1.0.0");
  });

  it("§14.2 — matches a prerelease directory through a stable range", () => {
    seedInstall("yarn", "4.0.0-rc.1");
    expect(findInstalledVersion("yarn", ">=2.0.0")).toBe("4.0.0-rc.1");
  });

  it("prefers a stable release over a prerelease of the same version", () => {
    seedInstall("pnpm", "9.0.0-alpha.1");
    seedInstall("pnpm", "9.0.0");
    expect(findInstalledVersion("pnpm", "^9.0.0")).toBe("9.0.0");
  });

  it("returns null when nothing matches, and when the package dir is missing", () => {
    seedInstall("yarn", "1.0.0");
    expect(findInstalledVersion("yarn", "^3.0.0")).toBeNull();
    expect(findInstalledVersion("pnpm", "^3.0.0")).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* §07.4/§07.5 — temp directories and atomic promotion                         */
/* -------------------------------------------------------------------------- */

describe("createTempDir — §07.4", () => {
  it("creates the temp inside the install folder, on the same filesystem", () => {
    const tmp = createTempDir();
    expect(dirname(tmp)).toBe(getInstallFolder());
    expect(statSync(tmp).isDirectory()).toBe(true);
    expect(tmp).toMatch(/[\\/]jup-\d+-[\da-f]{8}$/);
  });

  it("creates the install folder on demand and hands out unique names", () => {
    rmSync(home, { recursive: true, force: true });
    const a = createTempDir();
    const b = createTempDir();
    expect(a).not.toBe(b);
  });

  it("reports EACCES on the install folder with §12.8's verbatim message", () => {
    const denied = Object.assign(new Error("permission denied"), { code: "EACCES" });
    vi.mocked(mkdirSync).mockImplementationOnce(() => {
      throw denied;
    });

    expect(() => createTempDir()).toThrow(UsageError);
    expect(() => createTempDir()).not.toThrow(); // the mock was one-shot
  });

  it("reports EACCES on the temp directory itself the same way", () => {
    const denied = Object.assign(new Error("permission denied"), { code: "EACCES" });
    // First call is `mkdir -p <install>`; the second creates the temp.
    vi.mocked(mkdirSync)
      .mockImplementationOnce(mkdirSyncActual)
      .mockImplementationOnce(() => {
        throw denied;
      });

    try {
      createTempDir();
      expect.unreachable("expected a UsageError");
    } catch (error) {
      expect(error).toBeInstanceOf(UsageError);
      expect((error as Error).message).toBe(
        `Failed to create cache directory. Please ensure the user has write access to the target directory (${getInstallFolder()}). If the user's home directory does not exist, create it first.`,
      );
    }
  });

  it("propagates a filesystem failure that is not EACCES", () => {
    const broken = Object.assign(new Error("no space"), { code: "ENOSPC" });
    vi.mocked(mkdirSync).mockImplementationOnce(() => {
      throw broken;
    });
    expect(() => createTempDir()).toThrow(broken);
  });
});

describe("promote — §07.5", () => {
  it("renames the temp into place, creating the parent", () => {
    const tmp = createTempDir();
    writeFileSync(join(tmp, "yarn.js"), "console.log(1)");
    const dest = join(getInstallFolder(), "yarn", "4.1.0");

    promote(tmp, dest);

    expect(readFileSync(join(dest, "yarn.js"), "utf8")).toBe("console.log(1)");
    expect(() => statSync(tmp)).toThrow();
  });

  it("treats losing the race as a win: the temp is discarded, the winner kept", () => {
    const dest = join(getInstallFolder(), "yarn", "4.1.0");
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "yarn.js"), "winner");

    const tmp = createTempDir();
    writeFileSync(join(tmp, "yarn.js"), "loser");

    expect(() => promote(tmp, dest)).not.toThrow();

    expect(readFileSync(join(dest, "yarn.js"), "utf8")).toBe("winner");
    expect(() => statSync(tmp)).toThrow();
  });

  it("never creates a lockfile (§07.5, §16.6)", () => {
    const tmp = createTempDir();
    writeFileSync(join(tmp, "yarn.js"), "x");
    promote(tmp, join(getInstallFolder(), "yarn", "4.1.0"));

    const entries = readdirSync(getInstallFolder());
    expect(entries).toEqual(["yarn"]);
  });

  it("propagates an unrelated rename failure", () => {
    const tmp = createTempDir();
    const failure = Object.assign(new Error("nope"), { code: "EXDEV" });
    vi.mocked(renameSync).mockImplementationOnce(() => {
      throw failure;
    });
    expect(() => promote(tmp, join(getInstallFolder(), "yarn", "4.1.0"))).toThrow(failure);
  });
});

/* -------------------------------------------------------------------------- */
/* §04.4 + §14.3 — last known good                                             */
/* -------------------------------------------------------------------------- */

describe("readLastKnownGood — §04.4, forgiving in every direction", () => {
  const lkgPath = () => join(home, "lastKnownGood.json");

  it("returns {} when the file is missing", () => {
    expect(readLastKnownGood()).toEqual({});
  });

  it("returns {} when the file is unreadable", () => {
    mkdirSync(lkgPath()); // EISDIR on read
    expect(readLastKnownGood()).toEqual({});
  });

  it("returns {} for invalid JSON", () => {
    writeFileSync(lkgPath(), "{");
    expect(readLastKnownGood()).toEqual({});
  });

  it("returns {} for a falsy document", () => {
    writeFileSync(lkgPath(), "null");
    expect(readLastKnownGood()).toEqual({});
  });

  it("returns {} for a non-object document", () => {
    writeFileSync(lkgPath(), "42");
    expect(readLastKnownGood()).toEqual({});
    writeFileSync(lkgPath(), '"yarn@1.0.0"');
    expect(readLastKnownGood()).toEqual({});
  });

  it("drops individual non-string entries and keeps the rest", () => {
    writeFileSync(lkgPath(), JSON.stringify({ yarn: "1.22.22", pnpm: 5, npm: null }));
    expect(readLastKnownGood()).toEqual({ yarn: "1.22.22" });
  });

  it("reads a well-formed file", () => {
    writeFileSync(lkgPath(), JSON.stringify({ yarn: "1.22.22+sha1.ac34" }));
    expect(readLastKnownGood()).toEqual({ yarn: "1.22.22+sha1.ac34" });
  });
});

describe("writeLastKnownGood — §14.3, atomic", () => {
  const lkgPath = () => join(home, "lastKnownGood.json");

  it("writes a temp file in the same directory and renames over the target", () => {
    writeLastKnownGood({ yarn: "1.22.22" });

    const written = vi
      .mocked(writeFileSync)
      .mock.calls.map((call) => String(call[0]))
      .filter((path) => path.startsWith(lkgPath()));
    expect(written).toHaveLength(1);
    // The write never touched the target itself...
    expect(written[0]).not.toBe(lkgPath());
    expect(dirname(written[0]!)).toBe(home);
    // ...the rename did.
    expect(renameSync).toHaveBeenCalledWith(written[0], lkgPath());

    expect(readFileSync(lkgPath(), "utf8")).toBe(
      `${JSON.stringify({ yarn: "1.22.22" }, null, 2)}\n`,
    );
    // No debris left behind.
    expect(readdirSync(home)).toEqual(["lastKnownGood.json"]);
  });

  it("round-trips through readLastKnownGood, and overwrites cleanly", () => {
    writeLastKnownGood({ yarn: "1.0.0" });
    writeLastKnownGood({ yarn: "1.22.22", pnpm: "9.0.0" });
    expect(readLastKnownGood()).toEqual({ yarn: "1.22.22", pnpm: "9.0.0" });
    expect(readdirSync(home)).toEqual(["lastKnownGood.json"]);
  });

  it("creates the home folder on demand (test 104)", () => {
    rmSync(home, { recursive: true, force: true });
    writeLastKnownGood({ yarn: "1.0.0" });
    expect(readLastKnownGood()).toEqual({ yarn: "1.0.0" });
  });

  it("swallows EROFS silently and leaves no temp behind", () => {
    const readOnly = Object.assign(new Error("read-only file system"), { code: "EROFS" });
    vi.mocked(writeFileSync).mockImplementationOnce(() => {
      throw readOnly;
    });

    expect(() => writeLastKnownGood({ yarn: "1.22.22" })).not.toThrow();
    expect(readdirSync(home)).toEqual([]);
  });

  it("swallows a failing rename too, cleaning up the temp", () => {
    const readOnly = Object.assign(new Error("read-only file system"), { code: "EROFS" });
    vi.mocked(renameSync).mockImplementationOnce(() => {
      throw readOnly;
    });

    expect(() => writeLastKnownGood({ yarn: "1.22.22" })).not.toThrow();
    expect(readdirSync(home)).toEqual([]);
  });

  it("propagates a failure that is not a filesystem error", () => {
    const bug = new TypeError("bug");
    vi.mocked(writeFileSync).mockImplementationOnce(() => {
      throw bug;
    });
    expect(() => writeLastKnownGood({ yarn: "1.22.22" })).toThrow(bug);
  });
});

/* -------------------------------------------------------------------------- */
/* §07.7 — resolving bin                                                       */
/* -------------------------------------------------------------------------- */

describe("resolveBin — §07.7", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = createTempDir();
  });

  it("single file: names the file under the locator's own name", () => {
    // §15.41 retired the last band that produced a single file, so this branch is
    // reached only by a URL reference to a `.js`. The marker names the file, not
    // just the binary — corepack's `BinList` left `resolveBinPath` to recover it
    // from the download URL a second time; §02.4 gives jup no such form.
    expect(
      resolveBin(tmp, { name: "yarn", reference: "https://example.com/yarn.js" }, "yarn.js"),
    ).toEqual({ yarn: "yarn.js" });
  });

  it("single file: the table is not consulted, even for a name it knows", () => {
    // A URL reference carries no version, so there is no band to read and
    // nothing to disagree with. The file the download produced is the answer.
    expect(
      resolveBin(tmp, { name: "npm", reference: "https://example.com/npm-cli.js" }, "npm-cli.js"),
    ).toEqual({ npm: "npm-cli.js" });
  });

  it("tarball: the package's own bin wins over the band that covers it (§15.17)", () => {
    // The inversion. pnpm 11 *is* inside a declared band, and the band's paths
    // exist in the shipped table — but the package says its entry point moved,
    // and the package is the thing that knows.
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({ name: "pnpm", bin: { pnpm: "./dist/pnpm.mjs", pnpx: "./dist/pnpx.mjs" } }),
    );
    expect(resolveBin(tmp, { name: "pnpm", reference: "11.1.2" })).toEqual({
      pnpm: "./dist/pnpm.mjs",
      pnpx: "./dist/pnpx.mjs",
    });
  });

  it("tarball: falls back to the band when the package declares no bin", () => {
    writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "pnpm" }));
    expect(resolveBin(tmp, { name: "pnpm", reference: "11.1.2" })).toEqual({
      pnpm: "./bin/pnpm.mjs",
      pnpx: "./bin/pnpx.mjs",
    });
  });

  it("tarball: falls back to the band when there is no package.json at all", () => {
    // Tolerant by design: reading the manifest is now unconditional, and an
    // unreadable one must not turn an install that worked into an `ENOENT`.
    expect(resolveBin(tmp, { name: "pnpm", reference: "11.1.2" })).toEqual({
      pnpm: "./bin/pnpm.mjs",
      pnpx: "./bin/pnpx.mjs",
    });

    writeFileSync(join(tmp, "package.json"), "{ not json");
    expect(resolveBin(tmp, { name: "pnpm", reference: "11.1.2" })).toEqual({
      pnpm: "./bin/pnpm.mjs",
      pnpx: "./bin/pnpx.mjs",
    });
  });

  it("tarball: reads the package's own bin map", () => {
    // Yarn Berry, which since §15.41 is an ordinary `@yarnpkg/cli-dist` tarball
    // like every other entry, described by its own manifest.
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({ name: "@yarnpkg/cli-dist", bin: { yarn: "./bin/yarn.js" } }),
    );
    expect(resolveBin(tmp, { name: "yarn", reference: "4.1.0" })).toEqual({
      yarn: "./bin/yarn.js",
    });
  });

  it("tarball: a string bin becomes { <package name>: <path> }", () => {
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({ name: "@yarnpkg/cli-dist", bin: "./bin/yarn.js" }),
    );
    expect(resolveBin(tmp, { name: "yarn", reference: "4.1.0" })).toEqual({
      "@yarnpkg/cli-dist": "./bin/yarn.js",
    });
  });

  it("tarball: §14.13 — a package `bin` that escapes the install is refused", () => {
    // The values here come from a downloaded `package.json`, so §14.13 confines
    // them before they reach the marker. `exec.resolveBinPath` checks again at
    // the point of use, but failing here is what keeps the escaping path out of
    // the store at all.
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({ name: "@yarnpkg/cli-dist", bin: { yarn: "../../../../evil.js" } }),
    );
    expect(() => resolveBin(tmp, { name: "yarn", reference: "4.1.0" })).toThrow(
      "The bin path '../../../../evil.js' declared by yarn@4.1.0 escapes its installation directory",
    );

    // An absolute path is the same escape, spelled differently.
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({ name: "@yarnpkg/cli-dist", bin: "/etc/passwd" }),
    );
    expect(() => resolveBin(tmp, { name: "yarn", reference: "4.1.0" })).toThrow(
      "escapes its installation directory",
    );
  });

  it("tarball: a path that merely *looks* like an escape is kept (§14.13)", () => {
    // The control: `..` inside the install is not an escape, and a check written
    // as "does the string contain `..`" would refuse this one.
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({ name: "@yarnpkg/cli-dist", bin: { yarn: "./bin/../bin/yarn.js" } }),
    );
    expect(resolveBin(tmp, { name: "yarn", reference: "4.1.0" })).toEqual({
      yarn: "./bin/../bin/yarn.js",
    });
  });

  it("tarball: a URL reference has no band to fall back to", () => {
    // No version, so no band — §02.3's fall-forward guess is exactly what §15.17
    // keeps out of the marker. With nothing in the package, that is an error.
    //
    // Since §15.41 this is the *only* way to reach §12.8: every band in the table
    // declares a usable `BinSpec`, so a banded version always has a fallback.
    // Yarn Berry used to be the counter-example, its band declaring a list of
    // names rather than paths.
    writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "pnpm" }));
    expect(() =>
      resolveBin(tmp, { name: "pnpm", reference: "https://example.com/pnpm.tgz" }),
    ).toThrow("Unable to locate bin in package.json");
  });
});

/* -------------------------------------------------------------------------- */
/* §07.9 — cache clean                                                         */
/* -------------------------------------------------------------------------- */

describe("cacheClean — §07.9 (test 95)", () => {
  it("removes <home>/v1 but spares lastKnownGood.json", () => {
    seedInstall("yarn", "2.2.2");
    writeLastKnownGood({ yarn: "2.2.2" });

    cacheClean();

    expect(() => statSync(getInstallFolder())).toThrow();
    expect(readLastKnownGood()).toEqual({ yarn: "2.2.2" });
  });

  it("is a no-op the second time (missing directory is not an error)", () => {
    seedInstall("yarn", "2.2.2");
    cacheClean();
    expect(() => cacheClean()).not.toThrow();
  });
});

/* ------------------------------------------------------------------ *
 * §04.7 — the last-known-good auto-bump (tests 97–100)
 *
 * The bump lives in `store` because both callers — `resolve`'s §04 pipeline and
 * `install`'s §07.6 promotion — sit above it in §16.10's layering. These tests
 * moved here with it; they were previously written against a second, unimported
 * copy in `resolve`, so nothing they asserted was ever reached at runtime.
 * ------------------------------------------------------------------ */

describe("bumpLastKnownGood (§04.7)", () => {
  beforeEach(() => {
    // The ambient environment must not decide whether the bump runs.
    vi.stubEnv("COREPACK_DEFAULT_TO_LATEST", undefined);
  });

  function seedLastKnownGood(entries: Record<string, string>): void {
    writeFileSync(join(home, "lastKnownGood.json"), `${JSON.stringify(entries, null, 2)}\n`);
  }

  function readLastKnownGoodFile(): Record<string, string> | null {
    const path = join(home, "lastKnownGood.json");
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
  }

  it("advances within the same major (test 97)", () => {
    seedLastKnownGood({ yarn: "1.0.0" });

    bumpLastKnownGood({ name: "yarn", reference: "1.22.4+sha1.deadbeef" });
    expect(readLastKnownGoodFile()).toEqual({ yarn: "1.22.4+sha1.deadbeef" });
  });

  it("leaves a different major alone (test 99)", () => {
    seedLastKnownGood({ yarn: "1.22.4" });

    bumpLastKnownGood({ name: "yarn", reference: "2.2.2" });
    expect(readLastKnownGoodFile()).toEqual({ yarn: "1.22.4" });
  });

  it("never moves downward", () => {
    seedLastKnownGood({ yarn: "1.22.4" });

    bumpLastKnownGood({ name: "yarn", reference: "1.10.0" });
    expect(readLastKnownGoodFile()).toEqual({ yarn: "1.22.4" });
  });

  it("does not write when only the build suffix differs", () => {
    seedLastKnownGood({ yarn: "1.22.4+sha1.aaaa" });

    bumpLastKnownGood({ name: "yarn", reference: "1.22.4+sha1.bbbb" });
    expect(readLastKnownGoodFile()).toEqual({ yarn: "1.22.4+sha1.aaaa" });
  });

  it("writes nothing when there is no existing entry (test 100)", () => {
    bumpLastKnownGood({ name: "yarn", reference: "1.22.4" });
    expect(readLastKnownGoodFile()).toBeNull();

    seedLastKnownGood({ pnpm: "10.0.0" });
    bumpLastKnownGood({ name: "yarn", reference: "1.22.4" });
    expect(readLastKnownGoodFile()).toEqual({ pnpm: "10.0.0" });
  });

  it("does nothing when COREPACK_DEFAULT_TO_LATEST=0", () => {
    seedLastKnownGood({ yarn: "1.0.0" });
    vi.stubEnv("COREPACK_DEFAULT_TO_LATEST", "0");

    bumpLastKnownGood({ name: "yarn", reference: "1.22.4" });
    expect(readLastKnownGoodFile()).toEqual({ yarn: "1.0.0" });
  });

  it("ignores URL references and unknown names", () => {
    seedLastKnownGood({ yarn: "1.0.0", cutlery: "1.0.0" });

    bumpLastKnownGood({ name: "yarn", reference: "https://example.com/yarn.js" });
    bumpLastKnownGood({ name: "cutlery", reference: "2.0.0" });
    expect(readLastKnownGoodFile()).toEqual({ yarn: "1.0.0", cutlery: "1.0.0" });
  });

  it("ignores an unparseable recorded entry", () => {
    seedLastKnownGood({ yarn: "not-a-version" });

    bumpLastKnownGood({ name: "yarn", reference: "1.22.4" });
    expect(readLastKnownGoodFile()).toEqual({ yarn: "not-a-version" });
  });
});
