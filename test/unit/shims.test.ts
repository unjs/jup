import { execFile } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  lutimesSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { messages, UsageError } from "../../src/errors-cold.ts";
import { DEFINITIONS, getBinariesFor } from "../../src/config/table.ts";
import {
  BUILT_ENTRY_SPECIFIER,
  CLI_ENTRY_NAME,
  findCliEntry,
  STUB_FOLDER_NAME,
} from "../../src/utils/self.ts";
import {
  bakedInterpreter,
  cliEntrySource,
  chooseInstallDirectory,
  cliEntryNotWritable,
  cmdDisable,
  cmdEnable,
  type DisplacedEntry,
  generatePosixLink,
  generateWin32Link,
  interpreterOnlyInStore,
  interpreterPath,
  pathExportLine,
  perUserShimDirectory,
  readDisplacedRecord,
  rehashNotice,
  removePosixLink,
  removeWin32Link,
  restoreDisplaced,
  resolveInstallDirectory,
  restoreFailed,
  shimDirectoryFallback,
  shimDirectoryNotOnPath,
  shimDirectoryPreferred,
  shimDirectoryNotWritable,
  shimShadowed,
  shimSource,
  SHIM_MARKER,
  stubNameFor,
  systemAndInstallDirectory,
  stubNotExecutable,
  stubNotWritable,
  targetBinaries,
  verifyOnPath,
  whichFile,
} from "../../src/commands/shims.ts";
import { isOurShim, shimDirectoryCandidates, systemShimDirectory } from "../../src/run/exec.ts";
import { writeStubFolder } from "../../build.config.ts";

const execFileAsync = promisify(execFile);

/**
 * `dist` stands in for the folder `enable` writes stubs into and finds the entry
 * module beside — `src/` from a source checkout, `bin/` from a published
 * install. Pointing the tests at a temporary one keeps the generated stubs
 * (`<dist>/yarn.mjs`, …) out of the repository, and lets the end-to-end test
 * substitute a fake library entry for `main.ts`, which is another task's file.
 */
let root: string;
let dist: string;
/** §10.2's file, which ships beside the stubs rather than anywhere else. */
let cliEntry: string;
let binDir: string;
/** §10.5's per-user default, redirected into the fixture. */
let perUserBin: string;
/** §10.5's Windows spelling, redirected into the fixture. */
let localAppData: string;
let corepackHome: string;
let warn: ReturnType<typeof vi.spyOn>;

const ENTRY_SOURCE = `export async function runMain(argv) {
  const injected = Object.keys(process.env)
    .filter((key) => key.startsWith("COREPACK_") || key.startsWith("JUP_"))
    .sort();
  process.stdout.write(JSON.stringify({ argv, injected }));
  return { code: 0 };
}
`;

/**
 * §10.3 — the relative symlink target `enable` must install for a binary name,
 * and the same path §10.4's Windows wrappers cite.
 *
 * One helper for both platforms, because there is one stub per name on both.
 */
function expectedTarget(binName: string, from = binDir): string {
  return relative(from, join(dist, stubNameFor(binName)));
}

/** The stub `enable <binName>` writes and links — §10.3's target, absolute. */
function stubPath(binName: string): string {
  return join(dist, stubNameFor(binName));
}

function write(file: string, content: string, mode = 0o644): void {
  writeFileSync(file, content);
  chmodSync(file, mode);
}

/**
 * `enable` leaves a different shape behind on each platform: §10.3's relative
 * symlink to the name's own stub, or §10.4's three regular files citing it.
 * Rows that only care *that* the name was taken assert through this rather than
 * reaching for `readlink`, which is `EINVAL` on a Windows wrapper.
 */
function expectShim(dir: string, binName: string): void {
  if (process.platform === "win32") {
    for (const extension of ["", ".cmd", ".ps1"]) {
      expect(existsSync(join(dir, `${binName}${extension}`))).toBe(true);
    }
    expect(readFileSync(join(dir, `${binName}.cmd`), "utf8")).toContain(
      expectedTarget(binName, dir).replaceAll("/", "\\"),
    );
    return;
  }
  expect(lstatSync(join(dir, binName)).isSymbolicLink()).toBe(true);
  expect(readlinkSync(join(dir, binName))).toBe(expectedTarget(binName, dir));
}

/**
 * The extension a `PATH` lookup produces on Windows. `PATHEXT` never contains
 * the empty extension, and it is spelled in capitals; `whichFile` returns the
 * candidate it built, so `yarn.cmd` on disk comes back as `yarn.CMD`. Windows
 * paths are case-insensitive, so a fixture written under this name is the same
 * file the tool would find under any other spelling of it.
 */
const PATH_EXTENSION = process.platform === "win32" ? ".CMD" : "";

/**
 * §10's shims are `chmod 0o755`, but Windows has no POSIX mode bits: `chmod`
 * there toggles the read-only attribute and nothing else, and `lstat` reports
 * `0o666` for anything writable. The bit is asserted where it means something,
 * and the file is asserted to exist everywhere.
 */
function expectMode(file: string, mode: number): void {
  if (process.platform === "win32") {
    expect(existsSync(file)).toBe(true);
    return;
  }
  expect(lstatSync(file).mode & 0o777).toBe(mode);
}

beforeEach(() => {
  // realpath: macOS puts the temp directory behind a symlink, and `enable`
  // resolves the install directory (§10.5) before computing relative targets.
  root = realpathSync(mkdtempSync(join(tmpdir(), "jup-shims-")));
  dist = join(root, "dist");
  cliEntry = join(dist, "jup.mjs");
  // Not `<root>/bin`: `HOME` is stubbed to `root` below, so that name is
  // §10.5's `~/bin` alternate and this directory is meant to be an
  // unrelated one the `--install-directory` rows point at.
  binDir = join(root, "other-bin");
  // §10.5's per-user default is platform-specific, and so is the variable that
  // moves it: Linux and the BSDs honour `XDG_BIN_HOME`, macOS has no XDG
  // convention and is always `~/.local/bin`, Windows reads `%LOCALAPPDATA%`.
  // `HOME` and `USERPROFILE` are stubbed to `root` below, so every spelling
  // stays inside the fixture. This is `perUserShims()` from the conformance
  // harness, inline: this file predates it and imports nothing from there.
  localAppData = join(root, "AppData", "Local");
  perUserBin =
    process.platform === "win32"
      ? join(localAppData, "jup", "bin")
      : process.platform === "darwin"
        ? join(root, ".local", "bin")
        : join(root, "xdg-bin");
  corepackHome = join(root, "corepack-home");
  mkdirSync(dist);
  mkdirSync(binDir);
  writeFileSync(join(dist, "package.json"), `{"type":"module"}\n`);
  writeFileSync(join(dist, "index.mjs"), ENTRY_SOURCE);

  // §10.5 — the per-user default is a *real* directory under the user's home,
  // so every test that exercises it must be redirected first. `os.homedir()`
  // reads `HOME` on POSIX and `USERPROFILE` on Windows.
  vi.stubEnv("HOME", root);
  vi.stubEnv("USERPROFILE", root);
  vi.stubEnv("XDG_BIN_HOME", perUserBin);
  vi.stubEnv("LOCALAPPDATA", localAppData);
  vi.stubEnv("JUP_SHIM_DIRECTORY", undefined);
  vi.stubEnv("COREPACK_HOME", corepackHome);
  // Both candidate directories are on `PATH`, so §10.5's verification is
  // satisfied and a successful `enable` stays silent.
  vi.stubEnv("PATH", `${binDir}${delimiter}${perUserBin}`);

  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe("target set (§10.7)", () => {
  // §10.7 redirected this row: npm used to be excluded by default. Its
  // `aube` joins it — a package manager, so it is in the default set; `bun` and
  // `deno` are runtimes and stay out (`shimByDefault: false`).
  it("117: defaults to every package manager, npm included", () => {
    expect(targetBinaries([])).toEqual([
      "npm",
      "npx",
      "pnpm",
      "pnpx",
      "yarn",
      "yarnpkg",
      "aube",
      "aubr",
      "aubx",
    ]);
  });

  it("175: --exclude npm restores the old default", () => {
    expect(targetBinaries([], ["npm"])).toEqual([
      "pnpm",
      "pnpx",
      "yarn",
      "yarnpkg",
      "aube",
      "aubr",
      "aubx",
    ]);
  });

  it("expands a single name to its full binary set", () => {
    expect(targetBinaries(["yarn"])).toEqual(["yarn", "yarnpkg"]);
    expect(targetBinaries(["npm"])).toEqual(["npm", "npx"]);
  });

  it("filters an explicit name too, and can end up empty", () => {
    expect(targetBinaries(["yarn", "pnpm"], ["pnpm"])).toEqual(["yarn", "yarnpkg"]);
    expect(targetBinaries(["yarn"], ["yarn"])).toEqual([]);
  });

  it("130: rejects a name that is not a package manager", () => {
    expect(() => targetBinaries(["cargo"])).toThrow(UsageError);
    expect(() => targetBinaries(["cargo"])).toThrow(messages.invalidPackageManagerName("cargo"));
    // …on either side of the flag.
    expect(() => targetBinaries([], ["cargo"])).toThrow(
      messages.invalidPackageManagerName("cargo"),
    );
    // Not fooled by inherited properties.
    expect(() => targetBinaries(["constructor"])).toThrow(
      messages.invalidPackageManagerName("constructor"),
    );
  });
});

describe("install directory resolution (§10.5)", () => {
  it("uses --install-directory as given, realpathed for enable only", () => {
    const linkedBin = join(root, "linked-bin");
    symlinkSync(binDir, linkedBin);

    expect(resolveInstallDirectory({ installDirectory: linkedBin }, true)).toBe(binDir);
    expect(resolveInstallDirectory({ installDirectory: linkedBin }, false)).toBe(linkedBin);
  });

  it("falls back to JUP_SHIM_DIRECTORY, then to the per-user default", () => {
    expect(resolveInstallDirectory({}, false)).toBe(perUserBin);

    const configured = join(root, "configured");
    vi.stubEnv("JUP_SHIM_DIRECTORY", configured);
    expect(resolveInstallDirectory({}, false)).toBe(configured);

    // --install-directory still outranks the variable.
    expect(resolveInstallDirectory({ installDirectory: binDir }, false)).toBe(binDir);
  });

  it.skipIf(process.platform === "win32")(
    "171: honours XDG_BIN_HOME on Linux, ignores it on macOS, and never reads LOCALAPPDATA",
    () => {
      vi.stubEnv("LOCALAPPDATA", "/mnt/c/Users/someone/AppData/Local");
      // §10.5 — `LOCALAPPDATA` is Windows-only, so #673's WSL-interop
      // value must not move this on either platform.
      expect(perUserShimDirectory()).toBe(perUserBin);

      vi.stubEnv("XDG_BIN_HOME", undefined);
      // Linux and the BSDs fall back to `~/.local/bin` from here; macOS was
      // never anywhere else, because it has no XDG convention to honour.
      expect(perUserShimDirectory()).toBe(join(root, ".local", "bin"));
    },
  );

  it("no longer looks itself up on PATH — that is what #71 is about", () => {
    // A `jup` sitting in a directory on `PATH` used to *be* the answer.
    // §10.5 replaced that chain wholesale; the old behaviour is
    // reachable only by naming the directory.
    write(join(binDir, "jup"), "#!/bin/sh\n", 0o755);
    expect(resolveInstallDirectory({}, false)).toBe(perUserBin);
  });
});

/**
 * §10.5 — the system directory.
 *
 * Nothing here writes to `/usr/local/bin`: every row is either a pure resolution
 * (no filesystem at all) or a refusal that happens before anything is created.
 * The end-to-end halves — `root` reaching it, and `disable --system` restoring
 * what it displaced — are conformance rows 266 and 270, which run only inside a
 * container for exactly that reason.
 */
describe("the system directory (§10.5)", () => {
  const IS_WIN32 = process.platform === "win32";
  // Spelled out rather than imported: a row asserts what §10.5 says,
  // not what the implementation computed.
  const systemDir = IS_WIN32
    ? join(process.env.ProgramData ?? "C:\\ProgramData", "jup", "bin")
    : "/usr/local/bin";

  /** Could this process write there? The Homebrew-on-Intel case, and `root`. */
  function canWrite(directory: string): boolean {
    try {
      accessSync(directory, fsConstants.W_OK);
      return true;
    } catch {
      return false;
    }
  }

  it("resolves to the platform's machine-wide directory", () => {
    expect(systemShimDirectory()).toBe(systemDir);
  });

  it.skipIf(!IS_WIN32)("is nothing at all when %ProgramData% is unset", () => {
    vi.stubEnv("ProgramData", undefined);
    expect(systemShimDirectory()).toBeUndefined();
  });

  // Two rows rather than one branch: `process.getuid` does not exist on Windows,
  // so there is nothing to spy on there — `vi.spyOn` throws rather than mocking
  // a property that is not defined on the object.
  it.skipIf(IS_WIN32)("is a candidate only for root, and only last", () => {
    const uid = vi.spyOn(process, "getuid");

    uid.mockReturnValue(1000);
    expect(shimDirectoryCandidates()).not.toContain(systemDir);

    uid.mockReturnValue(0);
    const asRoot = shimDirectoryCandidates();
    // Last: a per-user directory already on `PATH` is still the better answer.
    expect(asRoot.at(-1)).toBe(systemDir);
    expect(asRoot[0]).toBe(perUserBin);
  });

  it.skipIf(!IS_WIN32)("is never a candidate on Windows, whoever is running", () => {
    // One candidate, and no uid to test: point 8 adds nothing there.
    expect(shimDirectoryCandidates()).not.toContain(systemDir);
  });

  it("--system names it, outranking JUP_SHIM_DIRECTORY", () => {
    vi.stubEnv("JUP_SHIM_DIRECTORY", binDir);

    // `named`, so none of point 6's selection runs against it: no gate, no
    // `PATH` preference, no continuity scan — and no filesystem access here.
    expect(chooseInstallDirectory({ system: true })).toEqual({
      directory: systemDir,
      named: true,
    });
    // §10.5 — `disable` and `info` resolve it too, or a non-root
    // `enable --system` would leave shims nothing could remove.
    expect(resolveInstallDirectory({ system: true }, false)).toBe(systemDir);
  });

  it("269: refuses --system together with --install-directory", async () => {
    await expect(
      cmdEnable(["--system", `--install-directory=${binDir}`, "yarn"], dist),
    ).rejects.toThrow(UsageError);
    await expect(cmdDisable(["--system", "--install-directory", binDir, "yarn"])).rejects.toThrow(
      systemAndInstallDirectory(),
    );
    expect(existsSync(join(binDir, "yarn"))).toBe(false);
  });

  /**
   * 268 — the one directory `enable` never falls back out of.
   *
   * Skipped where the suite could actually write there: as `root`, and on a
   * Homebrew-on-Intel Mac, where `/usr/local/bin` belongs to the installing
   * user. Row 268 is the refusal, and there is nothing to refuse there.
   */
  it.skipIf(IS_WIN32 || process.getuid?.() === 0 || canWrite("/usr/local/bin"))(
    "fails rather than falling back to the per-user default",
    async () => {
      await expect(cmdEnable(["--system", "yarn"], dist)).rejects.toThrow(
        shimDirectoryNotWritable(systemDir),
      );
      expect(existsSync(join(perUserBin, "yarn"))).toBe(false);
    },
  );
});

/**
 * §10.5 — `PATH` chooses among a closed list; it never supplies a
 * candidate. Windows has one candidate and therefore no preference at all, which
 * is why every row here skips it.
 */
describe.skipIf(process.platform === "win32")("the PATH preference (§10.5)", () => {
  /** The `<home>/bin` alternate. `HOME` is stubbed to `root`. */
  let homeBin: string;

  beforeEach(() => {
    homeBin = join(root, "bin");
  });

  it("does nothing at all while the default is on PATH", () => {
    mkdirSync(homeBin);
    vi.stubEnv("PATH", `${homeBin}${delimiter}${perUserBin}`);

    expect(chooseInstallDirectory({})).toEqual({ directory: perUserBin });
  });

  it("246: prefers <home>/bin when the default is not on PATH and it is", () => {
    mkdirSync(homeBin);
    vi.stubEnv("PATH", homeBin);

    expect(chooseInstallDirectory({})).toEqual({
      directory: homeBin,
      preferredOver: perUserBin,
    });
    expect(shimDirectoryPreferred(perUserBin, homeBin)).toBe(
      `! ${perUserBin} is not on your PATH; installing shims to ${homeBin} instead`,
    );
  });

  it("247: never adopts a writable non-candidate, however early it sits (#71)", () => {
    // `binDir` is writable, exists, and is the only thing on `PATH` — which is
    // exactly the shape "the first writable directory on PATH" would take, and
    // exactly the shape that put corepack's shims beside `node`.
    write(join(binDir, "jup"), "#!/bin/sh\n", 0o755);
    vi.stubEnv("PATH", binDir);

    expect(chooseInstallDirectory({})).toEqual({ directory: perUserBin });
  });

  it("248: skips an alternate that is absent, and creates nothing", () => {
    vi.stubEnv("PATH", homeBin);

    expect(chooseInstallDirectory({})).toEqual({ directory: perUserBin });
    expect(existsSync(homeBin)).toBe(false);
  });

  it("248: skips an alternate that is group- or world-writable", () => {
    mkdirSync(homeBin);
    vi.stubEnv("PATH", homeBin);

    for (const mode of [0o775, 0o777]) {
      chmodSync(homeBin, mode);
      expect(chooseInstallDirectory({})).toEqual({ directory: perUserBin });
    }

    chmodSync(homeBin, 0o755);
    expect(chooseInstallDirectory({}).directory).toBe(homeBin);
  });

  it("does not count an empty or relative PATH entry", () => {
    mkdirSync(homeBin);
    const cwd = process.cwd();
    try {
      // An empty entry means the cwd and `bin` means a directory that moves with
      // it. From `$HOME` both *resolve* to the alternate, and neither may count.
      process.chdir(root);
      vi.stubEnv("PATH", `${delimiter}bin`);
      expect(chooseInstallDirectory({})).toEqual({ directory: perUserBin });
    } finally {
      process.chdir(cwd);
    }
  });

  it("--install-directory and JUP_SHIM_DIRECTORY still outrank it", () => {
    mkdirSync(homeBin);
    vi.stubEnv("PATH", homeBin);

    // `named` is what lets `cmdEnable` skip the second selection: with nothing
    // named, the directory already chosen *is* point 2's fallback.
    expect(chooseInstallDirectory({ installDirectory: binDir })).toEqual({
      directory: binDir,
      named: true,
    });
    vi.stubEnv("JUP_SHIM_DIRECTORY", binDir);
    expect(chooseInstallDirectory({})).toEqual({ directory: binDir, named: true });
  });

  it("runs the selection once: a named directory leaves an alternate untouched", async () => {
    mkdirSync(homeBin);
    vi.stubEnv("PATH", homeBin);
    // Point 2's probe creates and unlinks a file, which moves the directory's
    // mtime. Backdating it makes "was this directory written to?" observable —
    // and the answer must be no, because `--install-directory` was given and
    // succeeded, so the alternate is never a candidate for anything.
    const past = new Date(Date.now() - 60_000);
    utimesSync(homeBin, past, past);

    expect(await cmdEnable([`--install-directory=${binDir}`, "yarn"], dist)).toBe(0);

    expect(statSync(homeBin).mtimeMs).toBe(past.getTime());
    expect(existsSync(join(binDir, "yarn"))).toBe(true);
  });

  it("249: continuity outranks it, and point 7 reads no PATH at all", async () => {
    mkdirSync(homeBin);
    // A first `enable`, while nothing was on `PATH` to prefer.
    vi.stubEnv("PATH", "");
    expect(await cmdEnable(["yarn"], dist)).toBe(0);
    expect(existsSync(join(perUserBin, "yarn"))).toBe(true);

    // Now the alternate appears on `PATH`. The shims do not move: a second set
    // is worse than one set in a suboptimal place.
    vi.stubEnv("PATH", homeBin);
    expect(chooseInstallDirectory({})).toEqual({ directory: perUserBin });

    // And `disable`/`info` find them with no `PATH` whatsoever.
    vi.stubEnv("PATH", "");
    expect(resolveInstallDirectory({}, false)).toBe(perUserBin);
  });

  it("249: and finds them in the alternate, from a shell that never had it on PATH", async () => {
    mkdirSync(homeBin);
    expect(await cmdEnable([`--install-directory=${homeBin}`, "yarn"], dist)).toBe(0);

    vi.stubEnv("PATH", perUserBin);
    expect(resolveInstallDirectory({}, false)).toBe(homeBin);
  });
});

describe("enable (§10.3)", () => {
  it("117: creates shims for every package manager in the per-user directory", async () => {
    const exitCode = await cmdEnable([], dist);

    expect(exitCode).toBe(0);
    expect(warn).not.toHaveBeenCalled();
    // §10.7 redirected this row: npm and npx are now in the default set.
    for (const binName of ["npm", "npx", "pnpm", "pnpx", "yarn", "yarnpkg"]) {
      expectShim(perUserBin, binName);
    }
  });

  it("175: --exclude npm leaves npm and npx alone", async () => {
    expect(await cmdEnable(["--exclude", "npm"], dist)).toBe(0);

    expect(existsSync(join(perUserBin, "yarn"))).toBe(true);
    expect(existsSync(join(perUserBin, "npm"))).toBe(false);
    expect(existsSync(join(perUserBin, "npx"))).toBe(false);
  });

  it("175: --exclude=a,b is accepted too", async () => {
    expect(await cmdEnable(["--exclude=npm,pnpm"], dist)).toBe(0);

    expect(existsSync(join(perUserBin, "yarn"))).toBe(true);
    expect(existsSync(join(perUserBin, "npm"))).toBe(false);
    expect(existsSync(join(perUserBin, "pnpm"))).toBe(false);
  });

  it("118: honours --install-directory", async () => {
    expect(await cmdEnable(["--install-directory", binDir], dist)).toBe(0);
    expectShim(binDir, "yarn");
  });

  it("119: a single named package manager expands to its binaries only", async () => {
    expect(await cmdEnable([`--install-directory=${binDir}`, "yarn"], dist)).toBe(0);

    expect(existsSync(join(binDir, "yarn"))).toBe(true);
    expect(existsSync(join(binDir, "yarnpkg"))).toBe(true);
    expect(existsSync(join(binDir, "pnpm"))).toBe(false);
  });

  it("creates the install directory when it does not exist", async () => {
    const fresh = join(root, "not", "there", "yet");

    expect(await cmdEnable([`--install-directory=${fresh}`, "yarn"], dist)).toBe(0);

    expectShim(fresh, "yarn");
  });

  // §10.4 is explicit that Windows has no idempotency short-circuit: all three
  // wrappers are rewritten on every run. The claim is POSIX's alone.
  it.skipIf(process.platform === "win32")(
    "122: is idempotent — an already-correct symlink is not rewritten",
    async () => {
      await cmdEnable([`--install-directory=${binDir}`, "yarn"], dist);

      const file = join(binDir, "yarn");
      const stub = stubPath("yarn");
      const past = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
      lutimesSync(file, past, past);
      lutimesSync(stub, past, past);
      const before = lstatSync(file);

      await cmdEnable([`--install-directory=${binDir}`, "yarn"], dist);

      const after = lstatSync(file);
      expect(after.mtime.getTime()).toBe(past.getTime());
      expect(after.mtimeMs).toBe(before.mtimeMs);
      expect(after.ino).toBe(before.ino);
      // The stub itself is left alone too, so a read-only dist folder still works.
      expect(lstatSync(stub).mtime.getTime()).toBe(past.getTime());
    },
  );

  // §10.3 — the execute bit that decides whether the name runs is on the stub,
  // because a shim is a symlink and a symlink has no mode of its own. `npm
  // pack` re-applies that bit to the package's `bin` targets alone, so every
  // stub in a published tarball arrives `0o644` — and the comparison above,
  // which is right about the *content*, used to leave it there.
  it.skipIf(process.platform === "win32")(
    "254: chmods a stub that arrived without the execute bit, without rewriting it",
    async () => {
      expect(await cmdEnable([`--install-directory=${binDir}`, "yarn"], dist)).toBe(0);

      const stub = stubPath("yarn");
      // The published shape. The mtime goes back far enough that a rewrite —
      // rather than the chmod §10.3 property 5 asks for — would show below.
      chmodSync(stub, 0o644);
      const past = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
      utimesSync(stub, past, past);

      expect(await cmdEnable([`--install-directory=${binDir}`, "yarn"], dist)).toBe(0);

      expectMode(stub, 0o755);
      expect(statSync(stub).mtime.getTime()).toBe(past.getTime());
      // And the shim still points at it, so what was repaired is the file the
      // kernel checks when the name is executed.
      expect(readlinkSync(join(binDir, "yarn"))).toBe(expectedTarget("yarn"));
      expect(warn).not.toHaveBeenCalled();
    },
  );

  it.skipIf(process.platform === "win32")(
    "254: leaves an already-executable stub alone, the chmod included",
    async () => {
      expect(await cmdEnable([`--install-directory=${binDir}`, "yarn"], dist)).toBe(0);

      const stub = stubPath("yarn");
      chmodSync(stub, 0o755);
      // `ctime` is what a chmod moves, and the only thing it moves when the mode
      // it writes is the mode already there. §10.3 property 4 and §10.8 both
      // want a warm `enable` over a correct installation to write nothing at
      // all, which is why the mode is compared before it is set.
      const before = statSync(stub).ctimeMs;

      expect(await cmdEnable([`--install-directory=${binDir}`, "yarn"], dist)).toBe(0);

      expect(statSync(stub).ctimeMs).toBe(before);
    },
  );

  // §10.3 says "only when the execute bits are missing", and a stub the caller
  // can already run has none missing that matter. Demanding all three (`mode &
  // 0o111) === 0o111`) turned every mode a non-zero umask produces — `chmod +x`
  // under `umask 077` lands exactly here — into either a write on every warm
  // `enable` or, on an install owned by somebody else, an `EPERM` that fails the
  // whole command over a stub that works.
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "254: leaves a stub the caller can execute alone, whatever the group and other bits",
    async () => {
      expect(await cmdEnable([`--install-directory=${binDir}`, "yarn"], dist)).toBe(0);

      const stub = stubPath("yarn");
      for (const mode of [0o744, 0o750, 0o700]) {
        chmodSync(stub, mode);
        const before = statSync(stub).ctimeMs;

        expect(await cmdEnable([`--install-directory=${binDir}`, "yarn"], dist)).toBe(0);

        // Neither chmod'd nor rewritten: the bit that decides whether the name
        // runs is already there.
        expectMode(stub, mode);
        expect(statSync(stub).ctimeMs).toBe(before);
      }
      expect(warn).not.toHaveBeenCalled();
    },
  );

  it("123: corrects a symlink pointing elsewhere", async () => {
    const file = join(binDir, "yarn");
    symlinkSync(join(root, "somewhere-else"), file);

    await generatePosixLink(binDir, dist, "yarn");

    expect(readlinkSync(file)).toBe(expectedTarget("yarn"));
    expect(warn).not.toHaveBeenCalled();
  });

  it("detects a dangling symlink as a symlink, not as a missing file (lstat, not stat)", async () => {
    const file = join(binDir, "yarn");
    symlinkSync(join(root, "gone"), file);
    // The premise: `stat` would report this entry as absent…
    expect(existsSync(file)).toBe(false);
    // …while `lstat` sees the symlink that is really there.
    expect(lstatSync(file).isSymbolicLink()).toBe(true);

    await expect(generatePosixLink(binDir, dist, "yarn")).resolves.toBe(file);

    expect(readlinkSync(file)).toBe(expectedTarget("yarn"));
  });

  it("173: replaces a shim whose target no longer exists (§10.3, #751)", async () => {
    // #751's exact shape: Node 25 stopped bundling corepack, so the stub the
    // shim points at is gone while the shim itself survives.
    const staleDist = join(root, "old-dist");
    mkdirSync(staleDist);
    const file = join(binDir, "yarn");
    symlinkSync(join(staleDist, "yarn.mjs"), file);
    rmSync(staleDist, { recursive: true });

    expect(await cmdEnable([`--install-directory=${binDir}`, "yarn"], dist)).toBe(0);

    expect(warn).not.toHaveBeenCalled();
    expectShim(binDir, "yarn");
    // Nothing was recorded as displaced: a stale shim of ours is not a foreign
    // binary (§10.6).
    expect(readDisplacedRecord()).toEqual([]);
  });

  it("121: refuses to replace a foreign regular file (§10.6)", async () => {
    const file = join(binDir, "pnpm");
    const foreign = "#!/bin/sh\n# a real pnpm, installed by something else\nexit 3\n";
    write(file, foreign, 0o755);

    expect(await cmdEnable([`--install-directory=${binDir}`, "pnpm"], dist)).toBe(0);

    expect(warn).toHaveBeenCalledWith(messages.shimNotOurs("pnpm", file));
    expect(readFileSync(file, "utf8")).toBe(foreign);
    expect(lstatSync(file).isSymbolicLink()).toBe(false);
    // The other binary of the same package manager is still installed.
    expectShim(binDir, "pnpx");
    // Nothing was displaced, so nothing was recorded.
    expect(readDisplacedRecord()).toEqual([]);
  });

  it("120: replaces that file when --force is given (§10.6)", async () => {
    const file = join(binDir, "pnpm");
    write(file, "#!/bin/sh\nexit 3\n", 0o755);

    expect(await cmdEnable([`--install-directory=${binDir}`, "--force", "pnpm"], dist)).toBe(0);

    expect(warn).not.toHaveBeenCalled();
    expectShim(binDir, "pnpm");
  });

  it("replaces one of our own stubs left as a regular file, without --force", async () => {
    const file = join(binDir, "yarn");
    write(file, shimSource("index.mjs", "yarn"), 0o755);

    await generatePosixLink(binDir, dist, "yarn");

    expect(warn).not.toHaveBeenCalled();
    expect(readlinkSync(file)).toBe(expectedTarget("yarn"));
  });

  // §10.3 scopes the Yarn Switch guard to POSIX, and `generateWin32Link` says so
  // in as many words: on Windows the same install is a foreign entry like any
  // other and is refused by §10.6 with its own message. Row 128 is the
  // Windows half of this pair.
  it.skipIf(process.platform === "win32")(
    "124: leaves a Yarn Switch install alone, warns, and exits 0",
    async () => {
      const switchBin = join(root, "switch", "bin");
      mkdirSync(switchBin, { recursive: true });
      write(join(switchBin, "yarn"), "#!/bin/sh\n", 0o755);

      const file = join(binDir, "yarn");
      symlinkSync(join(switchBin, "yarn"), file);

      expect(await cmdEnable([`--install-directory=${binDir}`, "yarn"], dist)).toBe(0);

      expect(warn).toHaveBeenCalledWith(messages.yarnSwitchSkip("yarn", file));
      expect(warn).toHaveBeenCalledTimes(1);
      expect(`${messages.yarnSwitchSkip("yarn", file)}\n`).toMatch(
        /^yarn is already installed in .+ and points to a Yarn Switch install - skipping\n$/,
      );
      expect(readlinkSync(file)).toBe(join(switchBin, "yarn"));
      // `yarnpkg` is a different entry and is installed normally.
      expect(readlinkSync(join(binDir, "yarnpkg"))).toBe(expectedTarget("yarnpkg"));
    },
  );

  it("130: rejects an invalid package manager name before touching the filesystem", async () => {
    await expect(cmdEnable([`--install-directory=${binDir}`, "cargo"], dist)).rejects.toThrow(
      messages.invalidPackageManagerName("cargo"),
    );
    expect(existsSync(join(binDir, "yarn"))).toBe(false);
  });

  it("errors when the dist folder holds no entry module", async () => {
    // Nested twice: the lookup also probes `../dist` for the published layout,
    // and a folder directly under `root` would find the fixture's own.
    const empty = join(root, "empty", "bin");
    mkdirSync(empty, { recursive: true });

    await expect(cmdEnable([`--install-directory=${binDir}`, "yarn"], empty)).rejects.toThrow(
      messages.assertStubFolderMissing(),
    );
  });

  it("rejects a flag with no argument", async () => {
    await expect(cmdEnable(["--install-directory"], dist)).rejects.toThrow(UsageError);
    await expect(cmdEnable(["--exclude"], dist)).rejects.toThrow(UsageError);
  });

  it("runs the package manager through the generated shim", async () => {
    await generatePosixLink(binDir, dist, "yarn");

    // A child environment with none of the tool's own variables in it, so
    // whatever the stub reports having is the stub's doing and not the
    // developer's shell.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !key.startsWith("COREPACK_") && !key.startsWith("JUP_"),
      ),
    );
    const { stdout } = await execFileAsync(
      process.execPath,
      [join(binDir, "yarn"), "add", "lodash"],
      { env },
    );

    expect(JSON.parse(stdout)).toEqual({
      argv: ["yarn", "add", "lodash"],
      // §10.1 — the stub baked in the binary name and nothing else. It used to
      // default the download prompt too, which is what made the same command
      // behave differently through a shim than through `jup` (#550); §05.4
      // removed the setting rather than the disagreement.
      injected: [],
    });
    // The stub is executable in its own right, for the `#!/usr/bin/env node` path.
    expectMode(stubPath("yarn"), 0o755);
  });

  /**
   * §08.4, through the stub rather than through `bin.ts`.
   *
   * The entry here stands in for an in-process handover: `runMain` answers `0`
   * to mean "handed over", and the package manager it handed to claims its exit
   * code from a `beforeExit` hook that fires only if nothing has claimed one
   * yet. A stub that assigned the `0` would make that hook decline, and the run
   * would exit 0. The generated stub is what occupies `yarn`, `npm` and `pnpm`
   * on `PATH` after `enable`, so it needs its own row: `bin.ts` getting this
   * right says nothing about the file every shimmed invocation actually runs.
   */
  it("leaves the exit code to the package manager the handover ran", async () => {
    writeFileSync(
      join(dist, "index.mjs"),
      `export async function runMain() {
  process.once("beforeExit", () => { if (process.exitCode === undefined) process.exitCode = 42; });
  return { code: 0 };
}
`,
    );
    await generatePosixLink(binDir, dist, "yarn");

    // `execFile` rejects on a non-zero exit, carrying the code on the error.
    const failure = (await execFileAsync(process.execPath, [join(binDir, "yarn")]).catch(
      (error: unknown) => error,
    )) as { code?: number };

    expect(failure.code).toBe(42);
  });
});

// §10.5's fallback and §10.8's refusal are real on Windows, but nothing here
// can put the fixture in the state that triggers them: `chmod` on that platform
// toggles the read-only *file* attribute and has no effect on a directory, so a
// `0o555` directory stays writable and `enable` correctly declines to fall back.
// Reproducing it would mean denying a WRITE_DATA ACE through `icacls`, which is
// a different test than this one. Same reason `getuid() === 0` is skipped:
// root ignores the mode too.
describe.skipIf(process.platform === "win32")(
  "read-only install directories (§10.5, §10.8)",
  () => {
    it.skipIf(process.getuid?.() === 0)(
      "170: falls back to the per-user directory and says so",
      async () => {
        const readOnly = join(root, "read-only");
        mkdirSync(readOnly);
        chmodSync(readOnly, 0o555);

        try {
          expect(await cmdEnable([`--install-directory=${readOnly}`, "yarn"], dist)).toBe(0);

          expect(warn).toHaveBeenCalledWith(shimDirectoryFallback(readOnly, perUserBin));
          expect(shimDirectoryFallback(readOnly, perUserBin)).toBe(
            `! ${readOnly} is not writable; installing shims to ${perUserBin} instead`,
          );
          expectShim(perUserBin, "yarn");
          expect(existsSync(join(readOnly, "yarn"))).toBe(false);
        } finally {
          chmodSync(readOnly, 0o755);
        }
      },
    );

    it.skipIf(process.getuid?.() === 0)(
      "gives up with an actionable message when the fallback is unwritable too (§10.8)",
      async () => {
        const readOnly = join(root, "read-only-2");
        mkdirSync(readOnly);
        mkdirSync(perUserBin, { recursive: true });
        chmodSync(readOnly, 0o555);
        chmodSync(perUserBin, 0o555);

        try {
          await expect(
            cmdEnable([`--install-directory=${readOnly}`, "yarn"], dist),
          ).rejects.toThrow(shimDirectoryNotWritable(perUserBin));
          await expect(
            cmdEnable([`--install-directory=${readOnly}`, "yarn"], dist),
          ).rejects.toThrow(UsageError);
        } finally {
          chmodSync(readOnly, 0o755);
          chmodSync(perUserBin, 0o755);
        }
      },
    );

    it.skipIf(process.getuid?.() === 0)(
      "does not announce a fallback when the per-user directory is itself the target",
      async () => {
        mkdirSync(perUserBin, { recursive: true });
        chmodSync(perUserBin, 0o555);

        try {
          await expect(cmdEnable(["yarn"], dist)).rejects.toThrow(
            shimDirectoryNotWritable(perUserBin),
          );
          expect(warn).not.toHaveBeenCalled();
        } finally {
          chmodSync(perUserBin, 0o755);
        }
      },
    );
  },
);

describe("verifying that enable took effect (§10.5)", () => {
  it("172: prints the exact line to add when the directory is not on PATH", async () => {
    vi.stubEnv("PATH", binDir);

    expect(await cmdEnable(["yarn"], dist)).toBe(0);

    expect(warn).toHaveBeenCalledWith(shimDirectoryNotOnPath(perUserBin));
    // §10.5 spells the line for the shell the user is in, so the row
    // asks for that spelling rather than hardcoding `sh`'s.
    expect(shimDirectoryNotOnPath(perUserBin)).toContain(pathExportLine(perUserBin));
    expect(shimDirectoryNotOnPath(perUserBin)).toContain("hash -r");
    // Warning, not failure — the shims are on disk either way.
    expectShim(perUserBin, "yarn");
  });

  it("195: warns, naming the winner, when something else on PATH shadows the shim", async () => {
    // A rival version manager, earlier on `PATH` than our shim directory.
    const volta = join(root, "volta");
    mkdirSync(volta);
    const rival = join(volta, `yarn${PATH_EXTENSION}`);
    write(rival, "#!/bin/sh\necho volta\n", 0o755);
    vi.stubEnv("PATH", `${volta}${delimiter}${perUserBin}`);

    expect(await cmdEnable(["yarn"], dist)).toBe(0);

    expect(warn).toHaveBeenCalledWith(shimShadowed("yarn", rival, join(perUserBin, "yarn")));
    expect(warn).toHaveBeenCalledWith(rehashNotice());
    expect(shimShadowed("yarn", "/v/yarn", "/s/yarn")).toBe(
      `! yarn on PATH resolves to /v/yarn, not the shim just installed at /s/yarn. Another version manager may be shadowing it.`,
    );
  });

  it("says nothing when the shim itself is what PATH resolves to", () => {
    write(join(binDir, `yarn${PATH_EXTENSION}`), "#!/bin/sh\n", 0o755);

    verifyOnPath(binDir, [["yarn", join(binDir, "yarn")]]);

    expect(warn).not.toHaveBeenCalled();
  });

  it("whichFile returns the winning path, not its directory", () => {
    const winner = join(binDir, `yarn${PATH_EXTENSION}`);
    write(winner, "#!/bin/sh\n", 0o755);
    expect(whichFile("yarn")).toBe(winner);
    expect(whichFile("nothing-of-that-name")).toBeUndefined();
  });

  it.for([
    ["posix", `export PATH="/d:$PATH"`],
    ["fish", `fish_add_path /d`],
    ["csh", `setenv PATH "/d:$PATH"`],
    ["powershell", `$env:PATH = "/d;$env:PATH"`],
    ["cmd", `set PATH=/d;%PATH%`],
  ] as const)("spells the PATH line for %s", ([shell, expected]) => {
    expect(pathExportLine("/d", shell)).toBe(expected);
  });
});

describe("disable (§10.6)", () => {
  it("125: removes the shims and leaves everything else alone", async () => {
    write(join(binDir, "jup"), "#!/bin/sh\n", 0o755);
    write(join(binDir, "unrelated"), "#!/bin/sh\n", 0o755);
    await cmdEnable([`--install-directory=${binDir}`], dist);

    expect(await cmdDisable([`--install-directory=${binDir}`])).toBe(0);

    for (const binName of ["npm", "npx", "pnpm", "pnpx", "yarn", "yarnpkg"]) {
      expect(lstatSync(join(binDir, binName), { throwIfNoEntry: false })).toBeUndefined();
    }
    expect(existsSync(join(binDir, "jup"))).toBe(true);
    expect(existsSync(join(binDir, "unrelated"))).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it("126: `disable yarn` removes yarn and yarnpkg only", async () => {
    await cmdEnable([`--install-directory=${binDir}`], dist);

    expect(await cmdDisable([`--install-directory=${binDir}`, "yarn"])).toBe(0);

    expect(existsSync(join(binDir, "yarn"))).toBe(false);
    expect(existsSync(join(binDir, "yarnpkg"))).toBe(false);
    expect(existsSync(join(binDir, "pnpm"))).toBe(true);
  });

  it("129: succeeds on a directory with no shims, repeatedly", async () => {
    expect(await cmdDisable([`--install-directory=${binDir}`])).toBe(0);
    expect(await cmdDisable([`--install-directory=${binDir}`])).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  // POSIX-only for row 124's reason: `cmdDisable` dispatches to
  // `removeWin32Link` on Windows, which §10.3 gives no Switch check. The row
  // below drives `removePosixLink` directly and covers the claim there.
  it.skipIf(process.platform === "win32")(
    "127: skips a Yarn Switch install with the same warning, exit 0",
    async () => {
      const switchBin = join(root, "switch", "bin");
      mkdirSync(switchBin, { recursive: true });
      write(join(switchBin, "yarn"), "#!/bin/sh\n", 0o755);

      const file = join(binDir, "yarn");
      symlinkSync(join(switchBin, "yarn"), file);

      expect(await cmdDisable([`--install-directory=${binDir}`, "yarn"])).toBe(0);

      expect(warn).toHaveBeenCalledWith(messages.yarnSwitchSkip("yarn", file));
      expect(lstatSync(file).isSymbolicLink()).toBe(true);
    },
  );

  // §10.6 redirected this row: `disable` used to unlink the three Windows files
  // unconditionally. It now removes only what it created — on every platform —
  // so the fixture installs real shims rather than planting empty stand-ins. The
  // claim under test is unchanged: the Yarn Switch guard is POSIX-only (§10.3),
  // so the *same* install is skipped there and removed here.
  it("128: Windows removal takes the same entry without the Switch check", async () => {
    const switchDist = join(root, "switch", "bin");
    mkdirSync(switchDist, { recursive: true });
    writeFileSync(join(switchDist, "index.mjs"), ENTRY_SOURCE);

    await generateWin32Link(binDir, switchDist, "yarn");
    const file = join(binDir, "yarn");
    expect(existsSync(`${file}.cmd`)).toBe(true);

    await removeWin32Link(binDir, "yarn");

    expect(existsSync(file)).toBe(false);
    expect(existsSync(`${file}.cmd`)).toBe(false);
    expect(existsSync(`${file}.ps1`)).toBe(false);
    expect(warn).not.toHaveBeenCalled();

    // The POSIX half of the same fixture is skipped, loudly (§10.3, row 127).
    symlinkSync(join(switchDist, "yarn.mjs"), file);
    await removePosixLink(binDir, "yarn");
    expect(warn).toHaveBeenCalledWith(messages.yarnSwitchSkip("yarn", file));
    expect(existsSync(file)).toBe(true);
  });

  it("173: removes a dangling shim rather than skipping it (§10.3, #751)", async () => {
    const file = join(binDir, "pnpm");
    symlinkSync(join(root, "gone", "pnpm.mjs"), file);

    await removePosixLink(binDir, "pnpm");

    expect(lstatSync(file, { throwIfNoEntry: false })).toBeUndefined();
  });

  it("leaves a real package manager it never installed alone (§10.6)", async () => {
    const file = join(binDir, "pnpm");
    const foreign = "#!/bin/sh\n# a real pnpm\n";
    write(file, foreign, 0o755);

    expect(await cmdDisable([`--install-directory=${binDir}`, "pnpm"])).toBe(0);

    expect(readFileSync(file, "utf8")).toBe(foreign);
    // …unless explicitly told to, which is corepack's old behaviour.
    expect(await cmdDisable([`--install-directory=${binDir}`, "--force", "pnpm"])).toBe(0);
    expect(existsSync(file)).toBe(false);
  });
});

describe("restoring what enable displaced (§10.6)", () => {
  it("174: enable --force over a real binary, then disable, restores it", async () => {
    const file = join(binDir, "pnpm");
    const foreign = "#!/bin/sh\n# a real pnpm\nexit 3\n";
    write(file, foreign, 0o755);

    expect(await cmdEnable([`--install-directory=${binDir}`, "--force", "pnpm"], dist)).toBe(0);
    expectShim(binDir, "pnpm");

    const record = readDisplacedRecord();
    expect(record).toHaveLength(1);
    expect(record[0]).toMatchObject({ path: file, type: "file" });

    expect(await cmdDisable([`--install-directory=${binDir}`, "pnpm"])).toBe(0);

    expect(lstatSync(file).isSymbolicLink()).toBe(false);
    expect(readFileSync(file, "utf8")).toBe(foreign);
    expectMode(file, 0o755);
    // The record is cleared, so a second disable is a no-op.
    expect(readDisplacedRecord()).toEqual([]);
    expect(await cmdDisable([`--install-directory=${binDir}`, "pnpm"])).toBe(0);
  });

  // A foreign *symlink* is only replaced-without-`--force` on POSIX: §10.3 makes
  // symlinks ours to manage, and §10.4 has no such rule, so on Windows the same
  // entry is §10.6's foreign file and is left alone with a warning. There is
  // nothing displaced there to restore.
  it.skipIf(process.platform === "win32")(
    "restores a displaced symlink, target and all",
    async () => {
      const real = join(root, "real-yarn");
      write(real, "#!/bin/sh\n", 0o755);
      const file = join(binDir, "yarn");
      symlinkSync(real, file);

      // A foreign *symlink* is replaced without --force (§10.3), so it too has to
      // be recorded or #112 stands for the commonest case of all.
      expect(await cmdEnable([`--install-directory=${binDir}`, "yarn"], dist)).toBe(0);
      const record: DisplacedEntry[] = readDisplacedRecord();
      expect(record).toHaveLength(1);
      expect(record[0]).toMatchObject({ path: file, type: "symlink", target: real });

      expect(await cmdDisable([`--install-directory=${binDir}`, "yarn"])).toBe(0);

      expect(readlinkSync(file)).toBe(real);
    },
  );

  it("says so and continues when a recorded entry cannot be restored", async () => {
    const file = join(binDir, "pnpm");
    write(file, "#!/bin/sh\n", 0o755);
    await cmdEnable([`--install-directory=${binDir}`, "--force", "pnpm"], dist);

    // The parked copy is gone — a `cache clean --all`, a tmpreaper, a user.
    const backup = readDisplacedRecord()[0]?.backup;
    expect(backup).toBeDefined();
    rmSync(backup!, { force: true });

    expect(await cmdDisable([`--install-directory=${binDir}`, "pnpm"])).toBe(0);

    expect(warn).toHaveBeenCalledWith(
      restoreFailed(file, "the saved copy is no longer in the store"),
    );
    // Continues: the shim is still gone and the record is cleared.
    expect(existsSync(file)).toBe(false);
    expect(readDisplacedRecord()).toEqual([]);
  });

  it("restores the recorded mode, not whatever the parked copy happens to have", async () => {
    // `rename` carries the permission bits along, so the recorded mode only
    // shows through when the copy path runs (EXDEV) or when the parked file was
    // touched in between. Drive it directly rather than pretending otherwise.
    const file = join(binDir, "pnpm");
    // Inside `<home>/displaced/`: that is the only place `displace` parks
    // content, and §10.6's reader rejects a `backup` from anywhere else.
    const backup = join(corepackHome, "displaced", "parked-pnpm");
    mkdirSync(dirname(backup), { recursive: true });
    write(backup, "#!/bin/sh\n", 0o600);
    writeFileSync(
      join(corepackHome, "shims.json"),
      JSON.stringify({
        version: 1,
        displaced: [{ path: file, type: "file", backup, mode: 0o755 }],
      }),
    );

    expect(restoreDisplaced(binDir, [file])).toBe(1);

    expectMode(file, 0o755);
    expect(readDisplacedRecord()).toEqual([]);
  });

  it("leaves records for other directories alone", async () => {
    const other = join(root, "other");
    mkdirSync(other);
    write(join(other, "pnpm"), "#!/bin/sh\n", 0o755);
    write(join(binDir, "pnpm"), "#!/bin/sh\n", 0o755);

    await cmdEnable([`--install-directory=${other}`, "--force", "pnpm"], dist);
    await cmdEnable([`--install-directory=${binDir}`, "--force", "pnpm"], dist);
    expect(readDisplacedRecord()).toHaveLength(2);

    expect(await cmdDisable([`--install-directory=${binDir}`, "pnpm"])).toBe(0);

    const left = readDisplacedRecord();
    expect(left).toHaveLength(1);
    expect(left[0]?.path).toBe(join(other, "pnpm"));
  });
});

/* ------------------------------------------------------------------ *
 * §10.2 — `enable` never bakes in an interpreter from the store
 *
 * §10.2 bakes `realpath(process.execPath)` into the shebang whenever
 * the shim directory claims the name `node`, and §02.3 makes `node` a
 * name it *can* claim. Once it has, §10.2's advice puts the shim ahead
 * of the real runtime on `PATH`, so the tool's own `#!/usr/bin/env node`
 * resolves through the shim, downloads the project's runtime and runs
 * under it — and the path §10.2 then bakes in is one `cache clean`
 * deletes. Every row below starts from that state.
 *
 * `process.execPath` is a writable, configurable property, so pointing
 * it at a file inside the fixture's `COREPACK_HOME` reproduces the
 * position exactly, with no 126 MB copy of the runtime involved.
 * ------------------------------------------------------------------ */

describe.skipIf(process.platform === "win32")("§10.2/§07.9 — the baked-in interpreter", () => {
  /**
   * A `node` under `COREPACK_HOME` that `process.execPath` then names — the
   * runtime a chain through our own `node` shim would be running under.
   */
  function runFromStore(): string {
    const store = join(corepackHome, "v1", "node", "22.14.0", "bin", "node");
    mkdirSync(dirname(store), { recursive: true });
    write(store, "#!/bin/sh\nexit 0\n", 0o755);
    process.execPath = store;
    return store;
  }

  /** An executable `node` in a directory of its own, outside the store. */
  function hostNode(name: string): string {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "node");
    write(file, "#!/bin/sh\nexit 0\n", 0o755);
    return file;
  }

  /** A file that answers `isOurShim` — what an earlier `enable node` leaves. */
  function ourNodeShim(name: string): string {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "node");
    write(file, `#!/usr/bin/env node\n// ${SHIM_MARKER}\n`, 0o755);
    return file;
  }

  const realExecPath = process.execPath;
  afterEach(() => {
    process.execPath = realExecPath;
  });

  /**
   * An ordinary machine has a `node` on `PATH`, and §10.2's second pinning
   * condition — "`env` finds none at all" — makes that a precondition of every
   * row below that expects the shipped `#!/usr/bin/env node` to survive. The
   * fixture's `PATH` holds shim directories and nothing else, so a row that did
   * not say this would be asserting the relocatable shebang on a machine where
   * it resolves to nothing. Appended rather than prepended: `verifyOnPath` has
   * to keep finding the shim directory these rows install into first, or every
   * one of them collects §10.5's "another version manager may be shadowing it".
   */
  beforeEach(() => {
    vi.stubEnv("PATH", [process.env.PATH, dirname(hostNode("on-path"))].join(delimiter));
  });

  it("tier 0: names the runtime running `enable`, when that is outside the store", () => {
    expect(interpreterPath()).toBe(realpathSync(process.execPath));
  });

  it("tier 1: prefers the forwarded host runtime to an execPath inside the store", () => {
    const store = runFromStore();
    const host = hostNode("host");
    vi.stubEnv("JUP_HOST_RUNTIME", host);

    expect(interpreterPath()).toBe(host);
    expect(interpreterPath()).not.toBe(store);
  });

  it("tier 1: refuses a forwarded value that is itself in the store, or one of our shims", () => {
    runFromStore();
    const host = hostNode("host");
    // The only `node` on `PATH` is the acceptable one, so a forwarded value that
    // is refused is visible as a fall through to it rather than as a failure.
    vi.stubEnv("PATH", dirname(host));

    // Inside the store: this is the value a chain would have carried if a level
    // of it had overwritten rather than passed through.
    vi.stubEnv("JUP_HOST_RUNTIME", join(corepackHome, "v1", "node", "22.14.0", "bin", "node"));
    expect(interpreterPath()).toBe(host);

    // One of our own shims: baking it in is §10.2's exec loop written by hand.
    vi.stubEnv("JUP_HOST_RUNTIME", ourNodeShim("stale"));
    expect(interpreterPath()).toBe(host);

    // A path that is not there at all.
    vi.stubEnv("JUP_HOST_RUNTIME", join(root, "gone", "node"));
    expect(interpreterPath()).toBe(host);
  });

  it("tier 2: walks PATH, skipping our own shims and anything in the store", () => {
    const store = runFromStore();
    const shim = ourNodeShim("shims");
    const host = hostNode("host");
    // Exactly the order §10.2 asks the user to create: the shim directory
    // first, the store's own `bin` next, the real runtime last.
    vi.stubEnv("PATH", [dirname(shim), dirname(store), dirname(host)].join(delimiter));

    expect(interpreterPath()).toBe(host);
  });

  it("tier 3: answers `undefined` when every runtime in sight is ours", () => {
    const store = runFromStore();
    vi.stubEnv("PATH", [dirname(ourNodeShim("shims")), dirname(store)].join(delimiter));

    expect(interpreterPath()).toBeUndefined();
  });

  it("bakes the forwarded runtime into the shebang, not the store path", async () => {
    const store = runFromStore();
    const host = hostNode("host");
    vi.stubEnv("JUP_HOST_RUNTIME", host);

    expect(await cmdEnable([`--install-directory=${binDir}`, "node"], dist)).toBe(0);

    const stub = readFileSync(stubPath("node"), "utf8");
    expect(stub.split("\n")[0]).toBe(`#!${host}`);
    // The property, stated the way the bug is: nothing `cache clean` removes.
    expect(stub).not.toContain(store);
    expect(stub).not.toContain(corepackHome);
  });

  it("reads back the interpreter an install already has (§07.9)", async () => {
    // No stub yet: there is nothing installed to read an answer out of.
    expect(await bakedInterpreter({ distFolder: dist })).toBeUndefined();

    // The relocatable spelling the shipped stubs keep is not a path in the
    // store, and `cache clean` will find nothing to spare in it.
    expect(await cmdEnable([`--install-directory=${binDir}`, "pnpm"], dist)).toBe(0);
    expect(await bakedInterpreter({ distFolder: dist })).toBe("/usr/bin/env node");

    // What an `enable node` writes, which is what the backstop acts on.
    const host = hostNode("host");
    vi.stubEnv("JUP_HOST_RUNTIME", host);
    runFromStore();
    expect(await cmdEnable([`--install-directory=${binDir}`, "node"], dist)).toBe(0);
    expect(await bakedInterpreter({ distFolder: dist })).toBe(host);
  });

  it("reads the shims that are installed, not this copy's own stub (§07.9)", async () => {
    // The install `cache clean` has to protect is frequently not the copy of the
    // tool that is running: an `npx jup enable`, or a global that has since been
    // reinstalled, leaves shims linked to *its* stub. Reading only our own
    // `dist/` would find the relocatable shebang, spare nothing, and delete the
    // runtime the installed shims are pointing at.
    const store = join(corepackHome, "v1", "node", "22.14.0", "bin", "node");
    mkdirSync(dirname(store), { recursive: true });
    write(store, "#!/bin/sh\nexit 0\n", 0o755);

    // Our own copy: the shipped, relocatable spelling, and nothing installed yet.
    expect(await cmdEnable([`--install-directory=${binDir}`, "pnpm"], dist)).toBe(0);
    const otherBin = join(root, "other-copy-bin");
    mkdirSync(otherBin);
    expect(await bakedInterpreter({ distFolder: dist, installDirectory: otherBin })).toBe(
      "/usr/bin/env node",
    );

    // The other copy's stub, and a shim of the shape §10.3 leaves pointing at it.
    const otherDist = join(root, "other-dist");
    mkdirSync(otherDist);
    const otherStub = join(otherDist, stubNameFor("yarn"));
    write(otherStub, `#!${store}\n// ${SHIM_MARKER}\n`, 0o755);
    symlinkSync(relative(otherBin, otherStub), join(otherBin, "yarn"));

    expect(await bakedInterpreter({ distFolder: dist, installDirectory: otherBin })).toBe(store);

    // A foreign binary wearing one of our names contributes nothing: the shim
    // directory is full of other programs (§10.2) and only a stub carrying the
    // marker is a record of what an `enable` wrote.
    rmSync(join(otherBin, "yarn"), { force: true });
    write(join(otherBin, "yarn"), `#!${store}\nexit 0\n`, 0o755);
    expect(await bakedInterpreter({ distFolder: dist, installDirectory: otherBin })).toBe(
      "/usr/bin/env node",
    );
  });

  /**
   * §10.2 tier 2 filters the `PATH` walk with `isOurShim`, and the filter has to
   * see every shape §10.4 writes. It used to match the marker or — on Windows
   * alone — a `#!/bin/sh` head, which is the one wrapper `whichAll` can never
   * hand it there: the Windows walk iterates `PATHEXT` (`.COM;.EXE;.BAT;.CMD`)
   * and yields `node.cmd`, never the extensionless sh script. So a nested
   * `enable` under a store runtime, with a shim directory outside `<home>`, took
   * its own `node.cmd` for a host runtime and baked it into every wrapper it
   * wrote — §10.2's exec loop, by hand.
   *
   * §10.4's writers are platform-independent on purpose, so this runs the real
   * bodies through the real recogniser on any platform.
   */
  it("recognises all three Windows wrapper shapes as ours (§10.6)", async () => {
    const host = hostNode("host");
    await generateWin32Link(binDir, dist, "node", {}, host);

    for (const extension of ["", ".cmd", ".ps1"]) {
      expect(isOurShim(join(binDir, `node${extension}`), "node")).toBe(true);
    }

    // And nothing else: a wrapper is ours by its head *and* the per-name stub it
    // invokes, so somebody else's `node.cmd` is still somebody else's.
    const foreign = join(binDir, "foreign.cmd");
    write(foreign, `@SETLOCAL\r\n"C:\\other\\node.exe" "%~dp0\\thing.mjs" %*\r\n`);
    expect(isOurShim(foreign, "node")).toBe(false);
  });

  it("reads the Windows wrappers, which name the interpreter each (§07.9)", async () => {
    // §10.4's writers are platform-independent on purpose, so the *reader* is
    // exercised the same way: generate the wrappers here and parse them back.
    // The `win32` branch of `bakedInterpreter` cannot be reached on POSIX, so
    // this asserts the shape it looks for rather than dispatching to it.
    const host = hostNode("host");
    await generateWin32Link(binDir, dist, "yarn", {}, host);

    const cmd = readFileSync(join(binDir, "yarn.cmd"), "utf8");
    expect(/^\s*"((?!%~dp0)[^"\n]+)"\s\s"%~dp0[\\/]/m.exec(cmd)?.[1]).toBe(host);
  });

  it("refuses rather than baking a store path, and writes nothing", async () => {
    const store = runFromStore();
    vi.stubEnv("PATH", [dirname(ourNodeShim("shims")), dirname(store)].join(delimiter));

    await expect(cmdEnable([`--install-directory=${binDir}`, "node"], dist)).rejects.toThrow(
      interpreterOnlyInStore(store, corepackHome),
    );
    await expect(cmdEnable([`--install-directory=${binDir}`, "node"], dist)).rejects.toThrow(
      UsageError,
    );

    // Not a partial install: the name is untaken and the shipped stub — which a
    // `#!/usr/bin/env node` fallback would have left in place — was never written.
    expect(existsSync(join(binDir, "node"))).toBe(false);
    expect(existsSync(stubPath("node"))).toBe(false);
  });

  /**
   * §10.2 — the refusal is scoped to the `node` shim. Every other name goes
   * through the shipped `#!/usr/bin/env node` stub, which is what keeps a
   * machine with no runtime outside the store still able to install `pnpm`.
   */
  it("does not refuse an `enable` that never claims the interpreter's name", async () => {
    const store = runFromStore();
    vi.stubEnv("PATH", [dirname(ourNodeShim("shims")), dirname(store)].join(delimiter));

    expect(await cmdEnable([`--install-directory=${binDir}`, "pnpm"], dist)).toBe(0);
    expect(readFileSync(stubPath("pnpm"), "utf8").split("\n")[0]).toBe("#!/usr/bin/env node");
  });

  /**
   * §10.2's adjacent message. `guardWrites` covers the shim directory and jup's
   * own package directory alike, and the shim directory's message — the one
   * naming `--install-directory` and `JUP_SHIM_DIRECTORY` — is wrong for the
   * second: neither option moves the stub, which lives with the tool.
   */
  it.skipIf(process.getuid?.() === 0)(
    "names the stub, not the shim directory, when the package directory is read-only",
    async () => {
      // The stub has to exist first, or the failure would be "no stub yet"
      // rather than "the stub needs rewriting".
      expect(await cmdEnable([`--install-directory=${binDir}`, "pnpm"], dist)).toBe(0);
      // The file *and* the directory: a read-only directory alone still permits
      // a write to a file already in it, and what a system package install
      // actually leaves behind is root-owned files the user cannot open for
      // writing. Both are what §10.8 means by "read-only".
      chmodSync(stubPath("pnpm"), 0o555);
      chmodSync(dist, 0o555);

      try {
        await expect(cmdEnable([`--install-directory=${binDir}`, "node"], dist)).rejects.toThrow(
          stubNotWritable(stubPath("pnpm")),
        );
        // §10.8 — and the case that must keep working: a warm `enable` of
        // anything else compares before it writes, so it never touches `dist`.
        expect(await cmdEnable([`--install-directory=${binDir}`, "pnpm"], dist)).toBe(0);
        expect(warn).not.toHaveBeenCalled();
      } finally {
        chmodSync(dist, 0o755);
        chmodSync(stubPath("pnpm"), 0o755);
      }
    },
  );

  /**
   * §10.8's message, which is the third read-only shape and shares neither
   * remedy with the two above.
   *
   * Only the text is asserted: a `chmod` fails on ownership, not on directory
   * permissions, so a fixture the test user owns cannot be put into the state
   * that provokes the refusal — it takes a read-only mount or a root-owned
   * install. What the row pins is that the message the refusal carries is the
   * one that would help there.
   */
  it("254: the not-executable message names the stub and a remedy that reaches it", () => {
    const message = stubNotExecutable(stubPath("pnpm"));

    expect(message).toContain(stubPath("pnpm"));
    expect(message).toContain("chmod +x");
    // Not §10.2's: neither of those moves this file, and "without node" is
    // wrong advice here — the bit is needed whichever names are enabled.
    expect(message).not.toContain("--install-directory");
    expect(message).not.toContain("JUP_SHIM_DIRECTORY");
    expect(message).not.toContain("without node");
  });
});

/* ------------------------------------------------------------------ *
 * §10.2 — jup's own CLI entry does not run through jup's own shim
 *
 * `bin/jup.mjs` — what `package.json`'s `bin` points at — opens
 * `#!/usr/bin/env node` like any published Node program, and that is
 * §10.2 consequence 2 aimed at us: with our `node` shim first on the
 * `PATH` §10.2 asks for, `env node` finds the shim, the shim resolves
 * the project's runtime, and `jup --version` downloads 171 MB to print
 * a version string. §10.2 made the path that gets baked in safe; this
 * is the recursion itself.
 *
 * We ship the file, but what these rows pin is *how little* of it is
 * touched: the first line, only when it is wrong, and never the body —
 * the installation being enabled is frequently not the one that wrote
 * it, and a version skew is not ours to turn into a refusal.
 * ------------------------------------------------------------------ */

describe.skipIf(process.platform === "win32")("§10.2 — pinning jup's own CLI entry", () => {
  /** What the tests expect `enable` to choose: §10.2 tier 0, here and now. */
  const HOST = realpathSync(process.execPath);

  /**
   * A stand-in for the bundled entry. The non-ASCII line is deliberate: the
   * rewrite works in bytes, and a body measured in UTF-16 code units would
   * splice this file in the wrong place.
   */
  const BODY = [
    'import { runMain } from "../dist/index.mjs";',
    "// 200 → 400, ≥ 1 KiB of bundle stands in for the rest",
    "await runMain(process.argv.slice(2));",
    "",
  ].join("\n");

  /** Write `<bin>/jup.mjs` the shape a published install has it: 0o755. */
  function writeEntry(shebang = "#!/usr/bin/env node"): string {
    write(cliEntry, `${shebang}\n${BODY}`, 0o755);
    return cliEntry;
  }

  function firstLine(file: string): string {
    return readFileSync(file, "utf8").split("\n")[0]!;
  }

  /**
   * The same ordinary-machine precondition the §10.2 rows state: with no `node`
   * on `PATH` at all, §10.2 pins unconditionally, and the rows below that expect
   * an untouched `#!/usr/bin/env node` would be asserting a shebang that
   * resolves to nothing.
   */
  beforeEach(() => {
    const dir = join(root, "cli-entry-on-path");
    mkdirSync(dir, { recursive: true });
    write(join(dir, "node"), "#!/bin/sh\nexit 0\n", 0o755);
    vi.stubEnv("PATH", [process.env.PATH, dir].join(delimiter));
  });

  /** Everything from the first line ending on — the part that must not move. */
  function body(file: string): string {
    const content = readFileSync(file, "utf8");
    return content.slice(content.indexOf("\n"));
  }

  it("pins the interpreter when the directory claims the interpreter's name", async () => {
    const entry = writeEntry();

    expect(await cmdEnable([`--install-directory=${binDir}`, "node"], dist)).toBe(0);

    expect(firstLine(entry)).toBe(`#!${HOST}`);
    // The body is copied through byte for byte, and the mode with it — a `bin`
    // target that came back without its execute bit is §07.4 one file over.
    expect(body(entry)).toBe(`\n${BODY}`);
    expectMode(entry, 0o755);
  });

  // §10.2's last bullet: "an entry that comes back without its execute bit is
  // §07.4's silent failure one file over". `open`'s mode argument is masked by
  // the umask, so the `mode:` on the temp write is a floor rather than the mode —
  // a `sudo npm i -g jup` followed by `jup enable node` from a `umask 077` shell
  // used to leave `bin.mjs` at `0o700`, and every other user's `jup` on `PATH`
  // became a file the lookup passes over in silence.
  it("carries the mode across even under a restrictive umask", async () => {
    const entry = writeEntry();
    const previous = process.umask(0o077);

    try {
      expect(await cmdEnable([`--install-directory=${binDir}`, "node"], dist)).toBe(0);
    } finally {
      process.umask(previous);
    }

    expect(firstLine(entry)).toBe(`#!${HOST}`);
    expectMode(entry, 0o755);
    // The stub the shims link to is the same property one file over, and it
    // goes through a `chmod` of its own.
    expectMode(stubPath("node"), 0o755);
  });

  it("leaves it byte-identical when no `node` shim is claimed (§10.2)", async () => {
    const entry = writeEntry();
    const before = readFileSync(entry);

    expect(await cmdEnable([`--install-directory=${binDir}`, "pnpm"], dist)).toBe(0);

    expect(readFileSync(entry).equals(before)).toBe(true);
    expect(firstLine(entry)).toBe("#!/usr/bin/env node");
  });

  it("pins it for a directory an *earlier* run claimed the name in", async () => {
    const entry = writeEntry();
    // The stub is shared by every name (§10.1), so a `pnpm` shim installed into
    // a directory that already holds our `node` still goes through `env node`.
    // `claimsInterpreter` is what sees that, and the entry follows the stub.
    expect(await cmdEnable([`--install-directory=${binDir}`, "node"], dist)).toBe(0);
    writeEntry();

    expect(await cmdEnable([`--install-directory=${binDir}`, "pnpm"], dist)).toBe(0);
    expect(firstLine(entry)).toBe(`#!${HOST}`);
  });

  it("writes nothing at all on a second run (§10.3 property 4)", async () => {
    const entry = writeEntry();
    expect(await cmdEnable([`--install-directory=${binDir}`, "node"], dist)).toBe(0);
    // `ctime` moves for a rename even when the content it lands is identical, so
    // this is what a rewrite-every-time would show.
    const before = statSync(entry).ctimeMs;

    expect(await cmdEnable([`--install-directory=${binDir}`, "node"], dist)).toBe(0);

    expect(statSync(entry).ctimeMs).toBe(before);
    expect(warn).not.toHaveBeenCalled();
  });

  it("does nothing when there is no built entry, or none with a shebang", async () => {
    // An installation with no CLI entry beside the stubs: there is nothing to
    // pin, and `enable` must not fail for want of one.
    expect(await cmdEnable([`--install-directory=${binDir}`, "node"], dist)).toBe(0);
    expect(existsSync(cliEntry)).toBe(false);

    // An entry whose first line is not an interpreter is not ours to edit.
    const entry = writeEntry("// no shebang here");
    const before = readFileSync(entry);
    expect(await cmdEnable([`--install-directory=${binDir}`, "yarn"], dist)).toBe(0);
    expect(readFileSync(entry).equals(before)).toBe(true);
  });

  it.skipIf(process.getuid?.() === 0)(
    "fails naming the entry, not the stub, when it cannot be rewritten",
    async () => {
      const entry = writeEntry();
      // Seed the stub first, so the failure below is about the entry rather than
      // about a stub that was never written.
      expect(await cmdEnable([`--install-directory=${binDir}`, "pnpm"], dist)).toBe(0);
      // The file *and* its directory: the temp-then-rename needs the directory,
      // and a system package install leaves both beyond the user's reach.
      chmodSync(entry, 0o555);
      chmodSync(dirname(entry), 0o555);

      try {
        await expect(cmdEnable([`--install-directory=${binDir}`, "node"], dist)).rejects.toThrow(
          cliEntryNotWritable(entry),
        );
        await expect(cmdEnable([`--install-directory=${binDir}`, "node"], dist)).rejects.toThrow(
          UsageError,
        );

        // Not a partial enable: the check runs before any shim is written, so
        // the name is still free and the entry is untouched.
        expect(existsSync(join(binDir, "node"))).toBe(false);
        expect(firstLine(entry)).toBe("#!/usr/bin/env node");
        // And no temp file left behind by the refused write.
        expect(readdirSync(dirname(entry)).some((name) => name.endsWith(".tmp"))).toBe(false);
      } finally {
        chmodSync(dirname(entry), 0o755);
        chmodSync(entry, 0o755);
      }
    },
  );

  /**
   * The third read-only shape, and the third diagnosis. It shares no remedy with
   * §10.2's stub message (whose two options move the *shims*) and none with
   * §10.8's (whose `chmod` is about a different property).
   */
  it("255: the message names the entry, the recursion, and the remedies that reach it", () => {
    const message = cliEntryNotWritable(cliEntry);

    expect(message).toContain(cliEntry);
    expect(message).toContain("downloads a runtime");
    expect(message).toContain("jup disable node");
    expect(message).not.toContain("chmod +x");
    expect(message).not.toContain("--install-directory");
    expect(message).not.toContain("JUP_SHIM_DIRECTORY");
  });

  /**
   * §10.2's counterpart to its own bargain for the stub: `disable` removes the
   * shims and leaves the pin, because §10.2 guarantees it names a runtime the
   * cache cannot take away, and unpinning would be a write into a directory
   * §10.8 says is routinely read-only — halfway through a removal.
   */
  it("disable removes the shims and leaves the pin in place", async () => {
    const entry = writeEntry();
    expect(await cmdEnable([`--install-directory=${binDir}`, "node"], dist)).toBe(0);

    expect(await cmdDisable([`--install-directory=${binDir}`, "node"])).toBe(0);

    expect(existsSync(join(binDir, "node"))).toBe(false);
    expect(firstLine(entry)).toBe(`#!${HOST}`);
  });
});

describe("Windows shims (§10.4)", () => {
  /**
   * §10.4's `<node>` — the absolute `realpath` of the runtime running `enable`,
   * which is what the fallback branches name instead of a bare `node` (§10.2).
   * Computed here the way the spec words it, not read back from the module.
   */
  const node = realpathSync(process.execPath);
  const posixNode = node.replaceAll("\\", "/");

  /** The three bodies, transcribed from §10.4 rather than from the implementation. */
  const expectedCmd = (rel: string) =>
    `@SETLOCAL
@IF EXIST "%~dp0\\node.exe" (
  "%~dp0\\node.exe"  "%~dp0\\${rel}" %*
) ELSE (
  @SET PATHEXT=%PATHEXT:;.JS;=;%
  "${node}"  "%~dp0\\${rel}" %*
)
`;

  const expectedSh = (rel: string) =>
    `#!/bin/sh
basedir=$(dirname "$(echo "$0" | sed -e 's,\\\\,/,g')")

case \`uname\` in
    *CYGWIN*) basedir=\`cygpath -w "$basedir"\`;;
esac

if [ -x "$basedir/node" ]; then
  exec "$basedir/node"  "$basedir/${rel}" "$@"
else
  exec "${posixNode}"  "$basedir/${rel}" "$@"
fi
`;

  const expectedPs1 = (rel: string) =>
    `#!/usr/bin/env pwsh
$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent

$exe=""
if ($PSVersionTable.PSVersion -lt "6.0" -or $IsWindows) {
  # Fix case when both the Windows and Linux builds of Node
  # are installed in the same directory
  $exe=".exe"
}
$ret=0
if (Test-Path "$basedir/node$exe") {
  # Support pipeline input
  if ($MyInvocation.ExpectingInput) {
    $input | & "$basedir/node$exe"  "$basedir/${rel}" $args
  } else {
    & "$basedir/node$exe"  "$basedir/${rel}" $args
  }
  $ret=$LASTEXITCODE
} else {
  if ($MyInvocation.ExpectingInput) {
    $input | & "${node}"  "$basedir/${rel}" $args
  } else {
    & "${node}"  "$basedir/${rel}" $args
  }
  $ret=$LASTEXITCODE
}
exit $ret
`;

  it("131: writes <B>, <B>.cmd and <B>.ps1, byte for byte", async () => {
    await generateWin32Link(binDir, dist, "yarn");

    const rel = expectedTarget("yarn");
    const file = join(binDir, "yarn");

    expect(readFileSync(file, "utf8")).toBe(expectedSh(rel.replaceAll("\\", "/")));
    expect(readFileSync(`${file}.cmd`, "utf8")).toBe(expectedCmd(rel.replaceAll("/", "\\")));
    expect(readFileSync(`${file}.ps1`, "utf8")).toBe(expectedPs1(rel.replaceAll("\\", "/")));

    for (const path of [file, `${file}.cmd`, `${file}.ps1`]) {
      expectMode(path, 0o755);
    }
  });

  it("overwrites its own files unconditionally — no idempotency short-circuit", async () => {
    await generateWin32Link(binDir, dist, "yarn");
    const file = join(binDir, "yarn");
    const past = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
    lutimesSync(file, past, past);

    await generateWin32Link(binDir, dist, "yarn");

    expect(lstatSync(file).mtime.getTime()).toBeGreaterThan(past.getTime());
  });

  it("121: refuses a foreign wrapper unless --force, and restores it (§10.6)", async () => {
    const cmd = join(binDir, "yarn.cmd");
    const foreign = "@echo somebody else's yarn\n";
    write(cmd, foreign);

    expect(await generateWin32Link(binDir, dist, "yarn", {})).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(messages.shimNotOurs("yarn", cmd));
    // Refused as a unit: no half-installed set beside the foreign wrapper.
    expect(existsSync(join(binDir, "yarn"))).toBe(false);
    expect(readFileSync(cmd, "utf8")).toBe(foreign);

    expect(await generateWin32Link(binDir, dist, "yarn", { force: true })).toBe(
      join(binDir, "yarn"),
    );
    expect(readFileSync(cmd, "utf8")).not.toBe(foreign);

    await removeWin32Link(binDir, "yarn");
    const restored = restoreDisplaced(binDir, [
      join(binDir, "yarn"),
      cmd,
      join(binDir, "yarn.ps1"),
    ]);
    expect(restored).toBe(1);
    expect(readFileSync(cmd, "utf8")).toBe(foreign);
  });
});

/* ------------------------------------------------------------------ *
 * The files that ship in `bin/`
 *
 * `bin/jup.mjs` and the stubs beside it are build output, written by
 * `build.config.ts`'s `end` hook — one directory over from `dist/`,
 * because `obuild` empties that folder on every run and §10.8 wants
 * files an installation nobody can write to still has. They are also
 * the files every `yarn`, `npm` and `pnpm` on the machine runs through,
 * and the reason `enable` can find the shipped stubs already correct
 * and write nothing (§10.3 property 4).
 *
 * `bin/` is not in the repository, so what is asserted here is the
 * generator: it runs into the fixture, and what it leaves must be the
 * table's names and nothing else, each reaching the bundle from the
 * sibling directory the published layout puts it in.
 * ------------------------------------------------------------------ */

describe("the shipped static files", () => {
  let shipped: string;

  /** Every binary name the table shims, which is the per-name stub list (§10.1). */
  const SHIPPED_NAMES = Object.keys(DEFINITIONS).flatMap((name) => getBinariesFor(name));

  const read = (name: string): string => readFileSync(join(shipped, name), "utf8");

  beforeEach(() => {
    shipped = join(root, STUB_FOLDER_NAME);
    writeStubFolder(shipped);
  });

  it("the CLI entry is what `cliEntrySource()` writes", () => {
    expect(read(CLI_ENTRY_NAME)).toBe(cliEntrySource());
  });

  it.for(SHIPPED_NAMES.map((name) => [name]))(
    "the stub for %s is what `shimSource()` writes for it",
    ([binName]) => {
      expect(read(stubNameFor(binName!))).toBe(shimSource(BUILT_ENTRY_SPECIFIER, binName!));
    },
  );

  it("holds those and nothing else — a name left the table without its stub going too", () => {
    expect(readdirSync(shipped).sort()).toEqual(
      [CLI_ENTRY_NAME, ...SHIPPED_NAMES.map((name) => stubNameFor(name))].sort(),
    );
  });

  /**
   * The specifier is the one thing a build cannot correct. A file that shipped
   * naming `index.mjs` beside itself would resolve to `bin/index.mjs`, which
   * nothing writes, and every shimmed binary on the machine would fail
   * `ERR_MODULE_NOT_FOUND` — after `enable` had already reported success.
   */
  it("reaches the bundle from a sibling directory, not from its own", () => {
    expect(BUILT_ENTRY_SPECIFIER).toBe("../dist/index.mjs");
    for (const file of readdirSync(shipped)) {
      expect(read(file)).toContain(`new URL("../dist/index.mjs"`);
    }
  });

  /** §10.1 — a dev checkout runs these straight out of the tree. */
  it.skipIf(process.platform === "win32")("writes them executable", () => {
    for (const file of readdirSync(shipped)) {
      expect(statSync(join(shipped, file)).mode & 0o111).not.toBe(0);
    }
  });

  /**
   * `bin/` is not emptied the way `dist/` is, so a stub whose name has left the
   * table would otherwise stay behind for `enable` to shim and `npm pack` to
   * ship. Removal goes by the generated banner, so a file a maintainer put
   * there by hand survives the build that finds it.
   */
  it("clears a stale stub and leaves a foreign file alone", () => {
    const stale = join(shipped, "gone.mjs");
    const foreign = join(shipped, "notes.mjs");
    writeFileSync(stale, shimSource(BUILT_ENTRY_SPECIFIER, "gone"));
    writeFileSync(foreign, "// mine\n");

    writeStubFolder(shipped);

    expect(existsSync(stale)).toBe(false);
    expect(readFileSync(foreign, "utf8")).toBe("// mine\n");
  });

  /**
   * §10.2's guard, from the other side. `enable` from a checkout resolves its
   * stub folder to `src/`, and the CLI entry is in `bin/` — so the lookup
   * cannot reach it, and no maintainer's `enable node` can leave an absolute
   * shebang naming their own machine in a file `npm publish` would ship.
   */
  it("is not reachable as a CLI entry from a source checkout", () => {
    expect(findCliEntry(new URL("../../src", import.meta.url).pathname)).toBeUndefined();
  });
});
