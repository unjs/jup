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
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { messages, UsageError } from "../../src/errors.ts";
import {
  cmdDisable,
  cmdEnable,
  generatePosixLink,
  generateWin32Link,
  removePosixLink,
  removeWin32Link,
  resolveInstallDirectory,
  shimDirectoryNotWritable,
  shimSource,
  targetBinaries,
} from "../../src/shims.ts";

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
let warn: ReturnType<typeof vi.spyOn>;

const ENTRY_SOURCE = `export async function runMain(argv) {
  process.stdout.write(JSON.stringify({ argv, prompt: process.env.COREPACK_ENABLE_DOWNLOAD_PROMPT }));
  return 0;
}
`;

/** The relative symlink target `enable` must install for a binary name. */
function expectedTarget(binName: string): string {
  return relative(binDir, join(dist, `${binName}.js`));
}

function write(file: string, content: string, mode = 0o644): void {
  writeFileSync(file, content);
  chmodSync(file, mode);
}

beforeEach(() => {
  // realpath: macOS puts the temp directory behind a symlink, and `enable`
  // resolves the install directory (§10.4) before computing relative targets.
  root = realpathSync(mkdtempSync(join(tmpdir(), "pipack-shims-")));
  dist = join(root, "dist");
  binDir = join(root, "bin");
  mkdirSync(dist);
  mkdirSync(binDir);
  writeFileSync(join(dist, "package.json"), `{"type":"module"}\n`);
  writeFileSync(join(dist, "index.mjs"), ENTRY_SOURCE);

  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe("target set (§10.5)", () => {
  it("defaults to every package manager except npm", () => {
    expect(targetBinaries([])).toEqual(["pnpm", "pnpx", "yarn", "yarnpkg"]);
  });

  it("expands a single name to its full binary set", () => {
    expect(targetBinaries(["yarn"])).toEqual(["yarn", "yarnpkg"]);
    expect(targetBinaries(["npm"])).toEqual(["npm", "npx"]);
  });

  it("130: rejects a name that is not a package manager", () => {
    expect(() => targetBinaries(["cargo"])).toThrow(UsageError);
    expect(() => targetBinaries(["cargo"])).toThrow(messages.invalidPackageManagerName("cargo"));
    // Not fooled by inherited properties.
    expect(() => targetBinaries(["constructor"])).toThrow(
      messages.invalidPackageManagerName("constructor"),
    );
  });
});

describe("install directory resolution (§10.4, §14.17)", () => {
  it("uses --install-directory as given, realpathed for enable only", () => {
    const linkedBin = join(root, "linked-bin");
    symlinkSync(binDir, linkedBin);

    expect(resolveInstallDirectory({ installDirectory: linkedBin }, true)).toBe(binDir);
    expect(resolveInstallDirectory({ installDirectory: linkedBin }, false)).toBe(linkedBin);
  });

  it("falls back to a PATH lookup for our own binary", () => {
    write(join(binDir, "pipack"), "#!/bin/sh\n", 0o755);
    vi.stubEnv("PATH", binDir);

    expect(resolveInstallDirectory({}, true)).toBe(binDir);
  });

  it("errors clearly when neither our own path nor PATH answers (§14.17)", () => {
    vi.stubEnv("PATH", join(root, "nowhere"));

    expect(() => resolveInstallDirectory({}, true)).toThrow(messages.noShimDirectory());
  });
});

describe("enable (§10.2)", () => {
  it("117: creates shims for every non-npm package manager beside the tool on PATH", async () => {
    write(join(binDir, "pipack"), "#!/bin/sh\n", 0o755);
    vi.stubEnv("PATH", binDir);

    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const exitCode = await cmdEnable([], dist);
    stdout.mockRestore();

    expect(exitCode).toBe(0);
    expect(warn).not.toHaveBeenCalled();
    for (const binName of ["pnpm", "pnpx", "yarn", "yarnpkg"]) {
      expect(lstatSync(join(binDir, binName)).isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(binDir, binName))).toBe(expectedTarget(binName));
    }
    // npm is excluded by default (§10.5); §15.16 flips this in phase 2.
    expect(existsSync(join(binDir, "npm"))).toBe(false);
    expect(existsSync(join(binDir, "npx"))).toBe(false);
  });

  it("118: honours --install-directory", async () => {
    expect(await cmdEnable(["--install-directory", binDir], dist)).toBe(0);
    expect(readlinkSync(join(binDir, "yarn"))).toBe(expectedTarget("yarn"));
  });

  it("119: a single named package manager expands to its binaries only", async () => {
    expect(await cmdEnable([`--install-directory=${binDir}`, "yarn"], dist)).toBe(0);

    expect(existsSync(join(binDir, "yarn"))).toBe(true);
    expect(existsSync(join(binDir, "yarnpkg"))).toBe(true);
    expect(existsSync(join(binDir, "pnpm"))).toBe(false);
  });

  it("122: is idempotent — an already-correct symlink is not rewritten", async () => {
    await cmdEnable([`--install-directory=${binDir}`, "yarn"], dist);

    const file = join(binDir, "yarn");
    const stub = join(dist, "yarn.js");
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
  });

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

    await expect(generatePosixLink(binDir, dist, "yarn")).resolves.toBeUndefined();

    expect(readlinkSync(file)).toBe(expectedTarget("yarn"));
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
    expect(readlinkSync(join(binDir, "pnpx"))).toBe(expectedTarget("pnpx"));
  });

  it("120: replaces that file when --force is given (§14.16)", async () => {
    const file = join(binDir, "pnpm");
    write(file, "#!/bin/sh\nexit 3\n", 0o755);

    expect(await cmdEnable([`--install-directory=${binDir}`, "--force", "pnpm"], dist)).toBe(0);

    expect(warn).not.toHaveBeenCalled();
    expect(readlinkSync(file)).toBe(expectedTarget("pnpm"));
  });

  it("replaces one of our own stubs left as a regular file, without --force", async () => {
    const file = join(binDir, "yarn");
    write(file, shimSource("./index.mjs", "yarn"), 0o755);

    await generatePosixLink(binDir, dist, "yarn");

    expect(warn).not.toHaveBeenCalled();
    expect(readlinkSync(file)).toBe(expectedTarget("yarn"));
  });

  it("124: leaves a Yarn Switch install alone, warns, and exits 0", async () => {
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
  });

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

  it.skipIf(process.getuid?.() === 0)(
    "maps a read-only install directory to an actionable message (§14.18)",
    async () => {
      const readOnly = join(root, "read-only");
      mkdirSync(readOnly);
      chmodSync(readOnly, 0o555);

      try {
        await expect(cmdEnable([`--install-directory=${readOnly}`, "yarn"], dist)).rejects.toThrow(
          shimDirectoryNotWritable(readOnly),
        );
        await expect(cmdEnable([`--install-directory=${readOnly}`, "yarn"], dist)).rejects.toThrow(
          UsageError,
        );
      } finally {
        chmodSync(readOnly, 0o755);
      }
    },
  );

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
    expect(lstatSync(join(dist, "yarn.js")).mode & 0o777).toBe(0o755);
  });
});

describe("disable (§10.6)", () => {
  it("125: removes the shims and leaves everything else alone", async () => {
    write(join(binDir, "pipack"), "#!/bin/sh\n", 0o755);
    write(join(binDir, "unrelated"), "#!/bin/sh\n", 0o755);
    await cmdEnable([`--install-directory=${binDir}`], dist);

    expect(await cmdDisable([`--install-directory=${binDir}`])).toBe(0);

    for (const binName of ["pnpm", "pnpx", "yarn", "yarnpkg"]) {
      expect(lstatSync(join(binDir, binName), { throwIfNoEntry: false })).toBeUndefined();
    }
    expect(existsSync(join(binDir, "pipack"))).toBe(true);
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

  it("127: skips a Yarn Switch install with the same warning, exit 0", async () => {
    const switchBin = join(root, "switch", "bin");
    mkdirSync(switchBin, { recursive: true });
    write(join(switchBin, "yarn"), "#!/bin/sh\n", 0o755);

    const file = join(binDir, "yarn");
    symlinkSync(join(switchBin, "yarn"), file);

    expect(await cmdDisable([`--install-directory=${binDir}`, "yarn"])).toBe(0);

    expect(warn).toHaveBeenCalledWith(messages.yarnSwitchSkip("yarn", file));
    expect(lstatSync(file).isSymbolicLink()).toBe(true);
  });

  it("128: Windows removal takes the same entry without the Switch check", async () => {
    const switchBin = join(root, "switch", "bin");
    mkdirSync(switchBin, { recursive: true });
    write(join(switchBin, "yarn"), "#!/bin/sh\n", 0o755);

    const file = join(binDir, "yarn");
    symlinkSync(join(switchBin, "yarn"), file);
    write(`${file}.cmd`, "@SETLOCAL\n");
    write(`${file}.ps1`, "#!/usr/bin/env pwsh\n");

    await removeWin32Link(binDir, "yarn");

    expect(existsSync(file)).toBe(false);
    expect(existsSync(`${file}.cmd`)).toBe(false);
    expect(existsSync(`${file}.ps1`)).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it("removes a dangling shim", async () => {
    const file = join(binDir, "pnpm");
    symlinkSync(join(root, "gone"), file);

    await removePosixLink(binDir, "pnpm");

    expect(lstatSync(file, { throwIfNoEntry: false })).toBeUndefined();
  });
});

describe("Windows shims (§10.3)", () => {
  /** The three bodies, transcribed from §10.3 rather than from the implementation. */
  const expectedCmd = (rel: string) =>
    `@SETLOCAL
@IF EXIST "%~dp0\\node.exe" (
  "%~dp0\\node.exe"  "%~dp0\\${rel}" %*
) ELSE (
  @SET PATHEXT=%PATHEXT:;.JS;=;%
  node  "%~dp0\\${rel}" %*
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
  exec node  "$basedir/${rel}" "$@"
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
    $input | & "node$exe"  "$basedir/${rel}" $args
  } else {
    & "node$exe"  "$basedir/${rel}" $args
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
      expect(lstatSync(path).mode & 0o777).toBe(0o755);
    }
  });

  it("overwrites unconditionally — no idempotency short-circuit", async () => {
    await generateWin32Link(binDir, dist, "yarn");
    const file = join(binDir, "yarn");
    const past = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
    lutimesSync(file, past, past);

    await generateWin32Link(binDir, dist, "yarn");

    expect(lstatSync(file).mtime.getTime()).toBeGreaterThan(past.getTime());
  });
});
