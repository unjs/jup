/**
 * Shims and PATH integration — §10.
 *
 * `enable` puts our names on PATH; `disable` takes them off.
 *
 * The shape follows §10.1's *generated stub* model rather than §14.15's
 * `argv[0]` dispatch: §14.15 is explicitly a native-binary divergence, and Node
 * `realpath`s the module it executes, so the invocation name is gone by the time
 * we run. A POSIX shim is therefore a relative symlink to a small stub whose
 * *filename* carries the binary name; Windows gets the three script variants of
 * §10.3.
 */

import { accessSync, constants as fsConstants, existsSync, realpathSync, statSync } from "node:fs";
import {
  chmod,
  lstat,
  open,
  readlink,
  realpath,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { delimiter, dirname, join, relative, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFINITIONS, getBinariesFor } from "./config/table.ts";
import { messages, UsageError } from "./errors.ts";
import { ENTRY_CANDIDATES, findEntryModule } from "./self.ts";

/** Our own binary name — what the §10.4 `PATH` lookup searches for. */
const TOOL_NAME = "pipack";

/**
 * Names our own binary answers to, for the §10.4 self-directory gate.
 *
 * We ship a `corepack` alias so scripts that already call `corepack use` keep
 * working, which means a directory holding only that alias is still a legitimate
 * place for shims to live.
 */
const TOOL_ALIASES = [TOOL_NAME, "corepack"] as const;

/**
 * §14.16 — how we recognise a stub we wrote. A regular file that does not carry
 * this marker is somebody else's binary and is never replaced without `--force`.
 */
const SHIM_MARKER = "@pipack-shim";

/** §10.2 — a Yarn Switch install lives under `…/switch/bin/…`. */
const YARN_SWITCH_RE = /[/\\]switch[/\\]bin[/\\]/;

/** Windows writes three files per binary name (§10.3); `disable` removes all three. */
const WIN32_EXTENSIONS = ["", ".ps1", ".cmd"];

export interface ShimOptions {
  installDirectory?: string;
  /** §14.16 — required to replace an entry we did not create. */
  force?: boolean;
}

/**
 * §14.18 — `EROFS`/`EACCES` on the shim directory is the container and
 * OS-package case, and a raw errno tells the user nothing. Name the two real
 * ways out instead.
 *
 * §12.12 words the other messages this spec adds; this one is ours.
 */
export const shimDirectoryNotWritable = (directory: string) =>
  `Unable to write shims to ${directory}: the directory is not writable. Either re-run with --install-directory <a writable directory on your PATH>, or define shell aliases instead (e.g. alias yarn="${TOOL_NAME} yarn")`;

/* -------------------------------------------------------------------------- */
/* Argument parsing and the target set                                        */
/* -------------------------------------------------------------------------- */

interface ParsedArgs {
  options: ShimOptions;
  names: string[];
}

/** §09.8 — `[--install-directory <path>] [...name]`, plus §14.16's `--force`. */
function parseShimArgs(args: string[]): ParsedArgs {
  const options: ShimOptions = {};
  const names: string[] = [];

  for (let index = 0; index < args.length; index++) {
    const arg = args[index] as string;

    if (arg === "--install-directory") {
      const value = args[++index];
      if (value === undefined)
        throw new UsageError("Option --install-directory requires an argument");
      options.installDirectory = value;
    } else if (arg.startsWith("--install-directory=")) {
      options.installDirectory = arg.slice("--install-directory=".length);
    } else if (arg === "--force") {
      options.force = true;
    } else {
      // Anything else is a package manager name and is validated as one, which
      // is also how a typo'd flag reports itself (§12.9).
      names.push(arg);
    }
  }

  return { options, names };
}

/**
 * §10.5 — with no names, every supported package manager **except npm**; each
 * name then expands to its full binary set, so `disable yarn` takes `yarnpkg`
 * with it.
 */
export function targetBinaries(names: string[]): string[] {
  // §15.16 flips this default in phase 2 (npm shimmed too, with `--exclude npm`
  // to opt out); this filter is the only thing that has to change.
  const selected =
    names.length > 0 ? names : Object.keys(DEFINITIONS).filter((name) => name !== "npm");

  const binaries = new Set<string>();
  for (const name of selected) {
    if (!Object.hasOwn(DEFINITIONS, name)) {
      throw new UsageError(messages.invalidPackageManagerName(name));
    }
    for (const binName of getBinariesFor(name)) binaries.add(binName);
  }

  return [...binaries];
}

/* -------------------------------------------------------------------------- */
/* Locating ourselves — §10.4, §14.17                                         */
/* -------------------------------------------------------------------------- */

/**
 * The folder holding the library entry: `src/` from source, `dist/` from a build.
 *
 * Found by walking up rather than by taking this module's own directory — a
 * bundler may emit chunks into a subdirectory (obuild uses `dist/_chunks/`), in
 * which case this file's neighbour is not the entry.
 */
function resolveDistFolder(): string {
  return findEntryModule(import.meta.url)?.directory ?? dirname(fileURLToPath(import.meta.url));
}

function isExecutableFile(file: string): boolean {
  const stats = statSync(file, { throwIfNoEntry: false });
  if (stats === undefined || !stats.isFile()) return false;
  if (process.platform === "win32") return true;
  try {
    accessSync(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Does this directory hold our own binary — i.e. is it a place shims belong? */
function holdsToolBinary(directory: string): boolean {
  if (TOOL_ALIASES.some((name) => isExecutableFile(join(directory, name)))) return true;
  if (process.platform !== "win32") return false;
  return TOOL_ALIASES.some(
    (name) =>
      existsSync(join(directory, `${name}.cmd`)) || existsSync(join(directory, `${name}.exe`)),
  );
}

/**
 * §14.17 — our own path first.
 *
 * The gate matters. For a JS distribution this module sits in `dist/`, which is
 * *not* on `PATH`, so "where am I" is only the right answer when we really are
 * installed as the tool binary in that directory (a single-file install, or a
 * copied bin). Where it is the right answer it beats the `PATH` lookup, which
 * picks the wrong copy when we were invoked by absolute path while a different
 * copy sits earlier on `PATH`.
 */
function selfDirectory(): string | undefined {
  for (const candidate of [process.argv[1], fileURLToPath(import.meta.url)]) {
    if (candidate === undefined || candidate === "") continue;
    const directory = dirname(candidate);
    if (holdsToolBinary(directory)) return directory;
  }
  return undefined;
}

/** §10.4 — `dirname(which("<tool>"))`, the lookup corepack uses exclusively. */
function lookupOnPath(name: string): string | undefined {
  const pathValue = process.env.PATH ?? "";
  const extensions =
    process.platform === "win32" ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";") : [""];

  for (const entry of pathValue.split(delimiter)) {
    if (entry === "") continue;
    for (const extension of extensions) {
      const candidate = join(entry, `${name}${extension}`);
      if (isExecutableFile(candidate)) return dirname(candidate);
    }
  }

  return undefined;
}

/**
 * §10.4 + §14.17 — locate where shims go.
 *
 * Prefer our own path over a `PATH` lookup for a binary named `pipack`, which
 * picks the wrong directory when the tool was run by absolute path while another
 * copy sits earlier on PATH. `enable` realpaths the result so relative link
 * targets are correct; `disable` deliberately does not.
 */
export function resolveInstallDirectory(options: ShimOptions, forEnable: boolean): string {
  const directory =
    options.installDirectory === undefined
      ? (selfDirectory() ?? lookupOnPath(TOOL_NAME))
      : resolvePath(options.installDirectory);

  if (directory === undefined) throw new UsageError(messages.noShimDirectory());
  if (!forEnable) return directory;

  // §10.2 property 2: a relative link target computed from a symlinked directory
  // would be wrong, so `enable` — and only `enable` — resolves it first.
  try {
    return realpathSync(directory);
  } catch {
    return directory;
  }
}

/* -------------------------------------------------------------------------- */
/* Stub generation — §10.1                                                    */
/* -------------------------------------------------------------------------- */

/**
 * §10.1 — the stub bakes in the binary name, because Node loses it: it
 * `realpath`s the executed module, so a shim cannot ask how it was called.
 *
 * `COREPACK_ENABLE_DOWNLOAD_PROMPT` defaults to `1` here and to `0` in `bin.ts`
 * (§05.5): the user asked for `yarn`, not for a download. `??=` in both, so a
 * real environment variable still wins.
 */
export function shimSource(entrySpecifier: string, binName: string): string {
  return [
    "#!/usr/bin/env node",
    `// ${SHIM_MARKER} — generated by \`${TOOL_NAME} enable\`; edits are overwritten.`,
    `process.env.COREPACK_ENABLE_DOWNLOAD_PROMPT ??= "1";`,
    `const { runMain } = await import(${JSON.stringify(entrySpecifier)});`,
    `process.exitCode = await runMain([${JSON.stringify(binName)}, ...process.argv.slice(2)]);`,
    "",
  ].join("\n");
}

/** §14.18 — map the read-only install to something the user can act on. */
async function guardWrites<T>(directory: string, action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EROFS" || code === "EACCES" || code === "EPERM") {
      throw new UsageError(shimDirectoryNotWritable(directory));
    }
    throw error;
  }
}

/** First `length` bytes of a file as UTF-8, or `undefined` if it cannot be read. */
async function readHead(file: string, length: number): Promise<string | undefined> {
  const handle = await open(file, "r").catch(() => undefined);
  if (handle === undefined) return undefined;

  try {
    const buffer = Buffer.allocUnsafe(length);
    let filled = 0;
    while (filled < length) {
      const { bytesRead } = await handle.read(buffer, filled, length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return buffer.toString("utf8", 0, filled);
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}

/**
 * Make sure `<distFolder>/<binName>.js` exists and is current, and hand back its
 * path. It is rewritten only when the content differs, so a warm `enable` writes
 * nothing at all — which is what lets §10.2's idempotency hold even when the
 * dist folder is read-only.
 */
async function ensureStub(distFolder: string, binName: string): Promise<string> {
  // The stub imports its entry module by a path *relative to the dist folder*, so
  // the pair stays relocatable (§10.2 property 2). Which name exists depends on
  // whether we are running from source or from a build; `ENTRY_CANDIDATES` is the
  // single definition of that order, and `scripts/generate-shims.mjs` shares it so
  // that the shipped stubs and the ones `enable` writes are byte-identical.
  const entry = ENTRY_CANDIDATES.find((candidate) => existsSync(join(distFolder, candidate)));
  if (entry === undefined) throw new UsageError(messages.assertStubFolderMissing());

  const file = join(distFolder, `${binName}.js`);
  const source = shimSource(`./${entry}`, binName);

  // One byte more than the stub is long, so a longer file cannot compare equal.
  // `byteLength`, not `length`: the banner is not ASCII.
  if ((await readHead(file, Buffer.byteLength(source) + 1)) === source) return file;

  await guardWrites(distFolder, async () => {
    await writeFile(file, source);
    await chmod(file, 0o755);
  });

  return file;
}

/* -------------------------------------------------------------------------- */
/* POSIX — §10.2, §10.6                                                       */
/* -------------------------------------------------------------------------- */

/** §10.2 — a `yarn`-ish name whose realpath lands inside a Yarn Switch install. */
async function isYarnSwitch(binName: string, file: string): Promise<boolean> {
  if (!binName.includes("yarn")) return false;
  // A dangling link has no realpath, and that is not a Switch install.
  const target = await realpath(file).catch(() => undefined);
  return target !== undefined && YARN_SWITCH_RE.test(target);
}

/** §14.16 — one of ours, or somebody else's binary? */
async function isOurShim(file: string): Promise<boolean> {
  const head = await readHead(file, 1024);
  return head !== undefined && head.includes(SHIM_MARKER);
}

/**
 * §10.2 — POSIX shims are relative symlinks, created with `lstat` (not `stat`,
 * so a dangling symlink is seen as a symlink) and **idempotent**: an
 * already-correct link is not rewritten and its mtime is unchanged.
 *
 * §14.16: refuse to replace a regular file that is not one of our own shims
 * unless `--force`. Yarn Switch then falls out of the general rule rather than
 * being a hard-coded exception — both are "this entry is not ours to touch",
 * both warn on stderr, both leave the entry alone, and both exit 0.
 */
export async function generatePosixLink(
  installDirectory: string,
  distFolder: string,
  binName: string,
  options: ShimOptions = {},
): Promise<void> {
  const stub = await ensureStub(distFolder, binName);
  const file = join(installDirectory, binName);
  const target = relative(installDirectory, stub);

  // lstat, NOT stat: a dangling symlink must read as a symlink rather than as an
  // absent file, or the symlink() below fails with EEXIST (corepack's 0.34.4 bug).
  const existing = await lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });

  if (existing !== undefined) {
    if (!options.force) {
      if (await isYarnSwitch(binName, file)) {
        console.warn(messages.yarnSwitchSkip(binName, file));
        return;
      }
      // Symlinks are ours to manage — §10.2 corrects one that points elsewhere.
      // Anything else without our marker is a real binary and stays put.
      if (!existing.isSymbolicLink() && !(await isOurShim(file))) {
        console.warn(messages.shimNotOurs(binName, file));
        return;
      }
    }

    if (existing.isSymbolicLink() && (await readlink(file).catch(() => undefined)) === target) {
      // Already correct: no write, so the mtime does not move (test 122).
      return;
    }

    await guardWrites(installDirectory, () => unlink(file));
  }

  await guardWrites(installDirectory, () => symlink(target, file));
}

/** §10.6 — POSIX removal: the Yarn Switch guard, then `unlink` with `ENOENT` ignored. */
export async function removePosixLink(
  installDirectory: string,
  binName: string,
  options: ShimOptions = {},
): Promise<void> {
  const file = join(installDirectory, binName);

  if (!options.force && (await isYarnSwitch(binName, file))) {
    console.warn(messages.yarnSwitchSkip(binName, file));
    return;
  }

  await guardWrites(installDirectory, () =>
    unlink(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    }),
  );
}

/* -------------------------------------------------------------------------- */
/* Windows — §10.3, §10.6                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The `.cmd` body of §10.3, byte for byte.
 *
 * The double spaces are real — an empty interpolated argument slot — and the
 * `PATHEXT` line drops `.JS` from the executable-extension list so that `node`
 * resolves to `node.exe` instead of recursing into a `node.js` file.
 */
function win32CmdSource(rel: string): string {
  const windowsRel = rel.replaceAll("/", "\\");
  return [
    `@SETLOCAL`,
    `@IF EXIST "%~dp0\\node.exe" (`,
    `  "%~dp0\\node.exe"  "%~dp0\\${windowsRel}" %*`,
    `) ELSE (`,
    `  @SET PATHEXT=%PATHEXT:;.JS;=;%`,
    `  node  "%~dp0\\${windowsRel}" %*`,
    `)`,
    ``,
  ].join("\n");
}

/** The extensionless sh body of §10.3, for Git Bash / MSYS / Cygwin. */
function win32ShSource(rel: string): string {
  const posixRel = rel.replaceAll("\\", "/");
  return [
    `#!/bin/sh`,
    `basedir=$(dirname "$(echo "$0" | sed -e 's,\\\\,/,g')")`,
    ``,
    `case \`uname\` in`,
    `    *CYGWIN*) basedir=\`cygpath -w "$basedir"\`;;`,
    `esac`,
    ``,
    `if [ -x "$basedir/node" ]; then`,
    `  exec "$basedir/node"  "$basedir/${posixRel}" "$@"`,
    `else`,
    `  exec node  "$basedir/${posixRel}" "$@"`,
    `fi`,
    ``,
  ].join("\n");
}

/** The `.ps1` body of §10.3. */
function win32Ps1Source(rel: string): string {
  const posixRel = rel.replaceAll("\\", "/");
  return [
    `#!/usr/bin/env pwsh`,
    `$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent`,
    ``,
    `$exe=""`,
    `if ($PSVersionTable.PSVersion -lt "6.0" -or $IsWindows) {`,
    `  # Fix case when both the Windows and Linux builds of Node`,
    `  # are installed in the same directory`,
    `  $exe=".exe"`,
    `}`,
    `$ret=0`,
    `if (Test-Path "$basedir/node$exe") {`,
    `  # Support pipeline input`,
    `  if ($MyInvocation.ExpectingInput) {`,
    `    $input | & "$basedir/node$exe"  "$basedir/${posixRel}" $args`,
    `  } else {`,
    `    & "$basedir/node$exe"  "$basedir/${posixRel}" $args`,
    `  }`,
    `  $ret=$LASTEXITCODE`,
    `} else {`,
    `  if ($MyInvocation.ExpectingInput) {`,
    `    $input | & "node$exe"  "$basedir/${posixRel}" $args`,
    `  } else {`,
    `    & "node$exe"  "$basedir/${posixRel}" $args`,
    `  }`,
    `  $ret=$LASTEXITCODE`,
    `}`,
    `exit $ret`,
    ``,
  ].join("\n");
}

/**
 * §10.3 — three files per binary name, all `0o755`, all written
 * **unconditionally**: there is no idempotency short-circuit on Windows, and no
 * Yarn Switch check either (§10.2 makes that check POSIX-only).
 *
 * Platform-independent on purpose, so Windows shims can be produced — and
 * tested — from a POSIX machine.
 */
export async function generateWin32Link(
  installDirectory: string,
  distFolder: string,
  binName: string,
  _options: ShimOptions = {},
): Promise<void> {
  const stub = await ensureStub(distFolder, binName);
  const file = join(installDirectory, binName);
  const rel = relative(installDirectory, stub);

  const files = [
    [file, win32ShSource(rel)],
    [`${file}.cmd`, win32CmdSource(rel)],
    [`${file}.ps1`, win32Ps1Source(rel)],
  ] as const;

  await guardWrites(installDirectory, async () => {
    for (const [path, source] of files) {
      await writeFile(path, source);
      await chmod(path, 0o755);
    }
  });
}

/** §10.6 — Windows removal: all three files, `ENOENT` ignored, no Switch check. */
export async function removeWin32Link(installDirectory: string, binName: string): Promise<void> {
  await guardWrites(installDirectory, async () => {
    for (const extension of WIN32_EXTENSIONS) {
      await unlink(join(installDirectory, `${binName}${extension}`)).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        },
      );
    }
  });
}

/* -------------------------------------------------------------------------- */
/* Commands — §09.8                                                           */
/* -------------------------------------------------------------------------- */

/**
 * §10 — install the shims. Idempotent, and exits 0 with empty stdout and stderr
 * on success. A skipped entry — Yarn Switch, or §14.16's foreign binary — warns
 * on stderr and still exits 0: it is a warning, not a failure.
 *
 * `distFolder` is a seam for the tests; production always uses our own folder.
 */
export async function cmdEnable(
  args: string[],
  distFolder: string = resolveDistFolder(),
): Promise<number> {
  const { options, names } = parseShimArgs(args);
  // Validate before touching the filesystem, so a bad name reports itself even
  // when the install directory cannot be resolved (§12.9).
  const binaries = targetBinaries(names);
  const installDirectory = resolveInstallDirectory(options, true);

  const generate = process.platform === "win32" ? generateWin32Link : generatePosixLink;

  // §10.5 — all binaries are processed concurrently.
  await Promise.all(
    binaries.map((binName) => generate(installDirectory, distFolder, binName, options)),
  );

  return 0;
}

/** §10.6 — removes only the names it was asked about; `disable yarn` also removes `yarnpkg`. */
export async function cmdDisable(args: string[]): Promise<number> {
  const { options, names } = parseShimArgs(args);
  const binaries = targetBinaries(names);
  // §10.4 — no realpath here: removal needs no relative-path computation.
  const installDirectory = resolveInstallDirectory(options, false);

  await Promise.all(
    binaries.map((binName) =>
      process.platform === "win32"
        ? removeWin32Link(installDirectory, binName)
        : removePosixLink(installDirectory, binName, options),
    ),
  );

  return 0;
}
