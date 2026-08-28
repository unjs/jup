import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  lutimesSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
import {
  chooseInstallDirectory,
  cmdDisable,
  cmdEnable,
  type DisplacedEntry,
  generatePosixLink,
  generateWin32Link,
  pathExportLine,
  perUserShimDirectory,
  PROXY_STUB_NAME,
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
  targetBinaries,
  verifyOnPath,
  whichFile,
} from "../../src/commands/shims.ts";

const execFileAsync = promisify(execFile);

/**
 * `dist` stands in for the folder holding this module — `src/` from source,
 * `dist/` from a build. Pointing the tests at a temporary one keeps the
 * generated stubs (`<dist>/yarn.js`, …) out of the repository, and lets the
 * end-to-end test substitute a fake library entry for `main.ts`, which is
 * another task's file.
 */
let root: string;
let dist: string;
let binDir: string;
/** §15.13's per-user default, redirected into the fixture. */
let perUserBin: string;
/** §15.13 point 1's Windows spelling, redirected into the fixture. */
let localAppData: string;
let corepackHome: string;
let warn: ReturnType<typeof vi.spyOn>;

const ENTRY_SOURCE = `export async function runMain(argv) {
  process.stdout.write(JSON.stringify({ argv, prompt: process.env.COREPACK_ENABLE_DOWNLOAD_PROMPT }));
  return 0;
}
`;

/** The relative symlink target `enable` must install for a binary name. */
/**
 * §14.15 — every POSIX shim points at the same stub, whatever name it wears, so
 * this takes no binary name any more. The Windows wrappers still name their own
 * (`expectedWin32Stub`).
 */
function expectedTarget(from = binDir): string {
  return relative(from, join(dist, PROXY_STUB_NAME));
}

/** §10.3 — Windows keeps one stub per name; this is the path its wrappers cite. */
function expectedWin32Stub(binName: string, from = binDir): string {
  return relative(from, join(dist, `${binName}.js`));
}

function write(file: string, content: string, mode = 0o644): void {
  writeFileSync(file, content);
  chmodSync(file, mode);
}

/**
 * `enable` leaves a different shape behind on each platform: §10.2's one
 * relative symlink to the shared stub, or §10.3's three regular files citing a
 * per-name one. Rows that only care *that* the name was taken assert through
 * this rather than reaching for `readlink`, which is `EINVAL` on a Windows
 * wrapper.
 */
function expectShim(dir: string, binName: string): void {
  if (process.platform === "win32") {
    for (const extension of ["", ".cmd", ".ps1"]) {
      expect(existsSync(join(dir, `${binName}${extension}`))).toBe(true);
    }
    expect(readFileSync(join(dir, `${binName}.cmd`), "utf8")).toContain(
      expectedWin32Stub(binName, dir).replaceAll("/", "\\"),
    );
    return;
  }
  expect(lstatSync(join(dir, binName)).isSymbolicLink()).toBe(true);
  expect(readlinkSync(join(dir, binName))).toBe(expectedTarget(dir));
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
  // resolves the install directory (§10.4) before computing relative targets.
  root = realpathSync(mkdtempSync(join(tmpdir(), "jup-shims-")));
  dist = join(root, "dist");
  // Not `<root>/bin`: `HOME` is stubbed to `root` below, so that name is
  // §15.13 point 6's `~/bin` alternate and this directory is meant to be an
  // unrelated one the `--install-directory` rows point at.
  binDir = join(root, "other-bin");
  // §15.13's per-user default is platform-specific, and so is the variable that
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

  // §15.13 — the per-user default is a *real* directory under the user's home,
  // so every test that exercises it must be redirected first. `os.homedir()`
  // reads `HOME` on POSIX and `USERPROFILE` on Windows.
  vi.stubEnv("HOME", root);
  vi.stubEnv("USERPROFILE", root);
  vi.stubEnv("XDG_BIN_HOME", perUserBin);
  vi.stubEnv("LOCALAPPDATA", localAppData);
  vi.stubEnv("COREPACK_SHIM_DIRECTORY", undefined);
  vi.stubEnv("COREPACK_HOME", corepackHome);
  // Both candidate directories are on `PATH`, so §15.29's verification is
  // satisfied and a successful `enable` stays silent.
  vi.stubEnv("PATH", `${binDir}${delimiter}${perUserBin}`);

  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe("target set (§10.5, §15.16)", () => {
  // §15.16 redirected this row: npm used to be excluded by default. §15.21's
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

describe("install directory resolution (§15.13)", () => {
  it("uses --install-directory as given, realpathed for enable only", () => {
    const linkedBin = join(root, "linked-bin");
    symlinkSync(binDir, linkedBin);

    expect(resolveInstallDirectory({ installDirectory: linkedBin }, true)).toBe(binDir);
    expect(resolveInstallDirectory({ installDirectory: linkedBin }, false)).toBe(linkedBin);
  });

  it("falls back to COREPACK_SHIM_DIRECTORY, then to the per-user default", () => {
    expect(resolveInstallDirectory({}, false)).toBe(perUserBin);

    const configured = join(root, "configured");
    vi.stubEnv("COREPACK_SHIM_DIRECTORY", configured);
    expect(resolveInstallDirectory({}, false)).toBe(configured);

    // --install-directory still outranks the variable.
    expect(resolveInstallDirectory({ installDirectory: binDir }, false)).toBe(binDir);
  });

  it.skipIf(process.platform === "win32")(
    "171: honours XDG_BIN_HOME on Linux, ignores it on macOS, and never reads LOCALAPPDATA",
    () => {
      vi.stubEnv("LOCALAPPDATA", "/mnt/c/Users/someone/AppData/Local");
      // §15.13 point 5 — `LOCALAPPDATA` is Windows-only, so #673's WSL-interop
      // value must not move this on either platform.
      expect(perUserShimDirectory()).toBe(perUserBin);

      vi.stubEnv("XDG_BIN_HOME", undefined);
      // Linux and the BSDs fall back to `~/.local/bin` from here; macOS was
      // never anywhere else, because it has no XDG convention to honour.
      expect(perUserShimDirectory()).toBe(join(root, ".local", "bin"));
    },
  );

  it("no longer looks itself up on PATH — that is what #71 is about", () => {
    // A `jup` sitting in a directory on `PATH` used to *be* the answer
    // (§10.4). §15.13 replaced that chain wholesale; the old behaviour is
    // reachable only by naming the directory.
    write(join(binDir, "jup"), "#!/bin/sh\n", 0o755);
    expect(resolveInstallDirectory({}, false)).toBe(perUserBin);
  });
});

/**
 * §15.13 point 6 — `PATH` chooses among a closed list; it never supplies a
 * candidate. Windows has one candidate and therefore no preference at all, which
 * is why every row here skips it.
 */
describe.skipIf(process.platform === "win32")("the PATH preference (§15.13 point 6)", () => {
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

  it("--install-directory and COREPACK_SHIM_DIRECTORY still outrank it", () => {
    mkdirSync(homeBin);
    vi.stubEnv("PATH", homeBin);

    // `named` is what lets `cmdEnable` skip the second selection: with nothing
    // named, the directory already chosen *is* point 2's fallback.
    expect(chooseInstallDirectory({ installDirectory: binDir })).toEqual({
      directory: binDir,
      named: true,
    });
    vi.stubEnv("COREPACK_SHIM_DIRECTORY", binDir);
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

describe("enable (§10.2)", () => {
  it("117: creates shims for every package manager in the per-user directory", async () => {
    const exitCode = await cmdEnable([], dist);

    expect(exitCode).toBe(0);
    expect(warn).not.toHaveBeenCalled();
    // §15.16 redirected this row: npm and npx are now in the default set.
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

  // §10.3 is explicit that Windows has no idempotency short-circuit: all three
  // wrappers are rewritten on every run, and there is no shared `shim-proxy.js`
  // for the row to age either. The claim is POSIX's alone.
  it.skipIf(process.platform === "win32")(
    "122: is idempotent — an already-correct symlink is not rewritten",
    async () => {
      await cmdEnable([`--install-directory=${binDir}`, "yarn"], dist);

      const file = join(binDir, "yarn");
      const stub = join(dist, PROXY_STUB_NAME);
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

  it("123: corrects a symlink pointing elsewhere", async () => {
    const file = join(binDir, "yarn");
    symlinkSync(join(root, "somewhere-else"), file);

    await generatePosixLink(binDir, dist, "yarn");

    expect(readlinkSync(file)).toBe(expectedTarget());
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

    expect(readlinkSync(file)).toBe(expectedTarget());
  });

  it("173: replaces a shim whose target no longer exists (§15.14, #751)", async () => {
    // #751's exact shape: Node 25 stopped bundling corepack, so the stub the
    // shim points at is gone while the shim itself survives.
    const staleDist = join(root, "old-dist");
    mkdirSync(staleDist);
    const file = join(binDir, "yarn");
    symlinkSync(join(staleDist, "yarn.js"), file);
    rmSync(staleDist, { recursive: true });

    expect(await cmdEnable([`--install-directory=${binDir}`, "yarn"], dist)).toBe(0);

    expect(warn).not.toHaveBeenCalled();
    expectShim(binDir, "yarn");
    // Nothing was recorded as displaced: a stale shim of ours is not a foreign
    // binary (§15.15).
    expect(readDisplacedRecord()).toEqual([]);
  });

  it("121: refuses to replace a foreign regular file (§14.16)", async () => {
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

  it("120: replaces that file when --force is given (§14.16)", async () => {
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
    expect(readlinkSync(file)).toBe(expectedTarget());
  });

  // §10.2 scopes the Yarn Switch guard to POSIX, and `generateWin32Link` says so
  // in as many words: on Windows the same install is a foreign entry like any
  // other and is refused by §14.16 with §14.16's message. Row 128 is the
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
      expect(readlinkSync(join(binDir, "yarnpkg"))).toBe(expectedTarget());
    },
  );

  it("130: rejects an invalid package manager name before touching the filesystem", async () => {
    await expect(cmdEnable([`--install-directory=${binDir}`, "cargo"], dist)).rejects.toThrow(
      messages.invalidPackageManagerName("cargo"),
    );
    expect(existsSync(join(binDir, "yarn"))).toBe(false);
  });

  it("errors when the dist folder holds no entry module", async () => {
    const empty = join(root, "empty-dist");
    mkdirSync(empty);

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

    const { stdout } = await execFileAsync(
      process.execPath,
      [join(binDir, "yarn"), "add", "lodash"],
      { env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: undefined } },
    );

    expect(JSON.parse(stdout)).toEqual({
      argv: ["yarn", "add", "lodash"],
      // §10.1 — a shim defaults the prompt to `1`; `bin.ts` defaults it to `0`.
      prompt: "1",
    });
    // The stub is executable in its own right, for the `#!/usr/bin/env node` path.
    expectMode(join(dist, PROXY_STUB_NAME), 0o755);
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
  return 0;
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

// §15.13's fallback and §14.18's refusal are real on Windows, but nothing here
// can put the fixture in the state that triggers them: `chmod` on that platform
// toggles the read-only *file* attribute and has no effect on a directory, so a
// `0o555` directory stays writable and `enable` correctly declines to fall back.
// Reproducing it would mean denying a WRITE_DATA ACE through `icacls`, which is
// a different test than this one. Same reason `getuid() === 0` is skipped:
// root ignores the mode too.
describe.skipIf(process.platform === "win32")(
  "read-only install directories (§15.13, §14.18)",
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
      "gives up with an actionable message when the fallback is unwritable too (§14.18)",
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

describe("verifying that enable took effect (§15.29, §15.13 point 3)", () => {
  it("172: prints the exact line to add when the directory is not on PATH", async () => {
    vi.stubEnv("PATH", binDir);

    expect(await cmdEnable(["yarn"], dist)).toBe(0);

    expect(warn).toHaveBeenCalledWith(shimDirectoryNotOnPath(perUserBin));
    // §15.13 point 3 spells the line for the shell the user is in, so the row
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

describe("disable (§10.6, §15.15)", () => {
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
  // `removeWin32Link` on Windows, which §10.2 gives no Switch check. The row
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

  // §15.15 redirected this row: `disable` used to unlink the three Windows files
  // unconditionally. It now removes only what it created — on every platform —
  // so the fixture installs real shims rather than planting empty stand-ins. The
  // claim under test is unchanged: the Yarn Switch guard is POSIX-only (§10.2),
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

    // The POSIX half of the same fixture is skipped, loudly (§10.2, row 127).
    symlinkSync(join(switchDist, "yarn.js"), file);
    await removePosixLink(binDir, "yarn");
    expect(warn).toHaveBeenCalledWith(messages.yarnSwitchSkip("yarn", file));
    expect(existsSync(file)).toBe(true);
  });

  it("173: removes a dangling shim rather than skipping it (§15.14, #751)", async () => {
    const file = join(binDir, "pnpm");
    symlinkSync(join(root, "gone", "pnpm.js"), file);

    await removePosixLink(binDir, "pnpm");

    expect(lstatSync(file, { throwIfNoEntry: false })).toBeUndefined();
  });

  it("leaves a real package manager it never installed alone (§15.15)", async () => {
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

describe("restoring what enable displaced (§15.15)", () => {
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

  // A foreign *symlink* is only replaced-without-`--force` on POSIX: §10.2 makes
  // symlinks ours to manage, and §10.3 has no such rule, so on Windows the same
  // entry is §14.16's foreign file and is left alone with a warning. There is
  // nothing displaced there to restore.
  it.skipIf(process.platform === "win32")(
    "restores a displaced symlink, target and all",
    async () => {
      const real = join(root, "real-yarn");
      write(real, "#!/bin/sh\n", 0o755);
      const file = join(binDir, "yarn");
      symlinkSync(real, file);

      // A foreign *symlink* is replaced without --force (§10.2), so it too has to
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
    // content, and §15.15's reader rejects a `backup` from anywhere else.
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

describe("Windows shims (§10.3)", () => {
  /**
   * §10.3's `<node>` — the absolute `realpath` of the runtime running `enable`,
   * which is what the fallback branches name instead of a bare `node` (§14.26).
   * Computed here the way the spec words it, not read back from the module.
   */
  const node = realpathSync(process.execPath);
  const posixNode = node.replaceAll("\\", "/");

  /** The three bodies, transcribed from §10.3 rather than from the implementation. */
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

    const rel = expectedWin32Stub("yarn");
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

  it("121: refuses a foreign wrapper unless --force, and restores it (§14.16, §15.15)", async () => {
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
