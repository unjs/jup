/**
 * Shims and PATH integration — §10, §15.13, §15.14, §15.15, §15.16, §15.29.
 *
 * `enable` puts our names on PATH; `disable` takes them off.
 *
 * §14.15's `argv[0]` dispatch was written as a native-binary divergence, on the
 * reading that Node `realpath`s the module it executes and so loses the
 * invocation name. It does — but it does **not** `realpath` `process.argv[1]`,
 * which still holds the path as invoked. So a POSIX shim is a relative symlink
 * to **one** name-agnostic stub that reads its own name from there, and no file
 * in `dist/` is named after a binary any more.
 *
 * Windows keeps §10.3's three script variants per name, because a `.cmd` or
 * `.ps1` wrapper invokes `node <stub>` and the invocation name is genuinely gone
 * by then. That is the whole of the platform split, and the per-name stub
 * machinery below exists for it alone.
 *
 * Four §15 items reshape the command around that core:
 *
 * * **§15.13** — shims go to a per-user directory by default, never somewhere
 *   that needs elevation, and `enable` says so when the directory it picked is
 *   not on `PATH`.
 * * **§15.15** — anything `enable` displaces is recorded in `<home>/shims.json`
 *   and put back by `disable`, which now removes only entries it created.
 * * **§15.16** — npm is shimmed by default; `--exclude npm` opts out.
 * * **§15.29** — after writing, `enable` checks that the shims actually won on
 *   `PATH` and names whatever beat them.
 */

import {
  accessSync,
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  constants as fsConstants,
} from "node:fs";
import type { Stats } from "node:fs";
import {
  chmod,
  lstat,
  open,
  readlink,
  realpath,
  rename,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, delimiter, dirname, join, relative, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { ENV, jupSpelling, readEnv, SYSTEM_ENV } from "../config/env-vars.ts";
import { DEFINITIONS, getBinariesFor, shimsByDefault } from "../config/table.ts";
import { advisory, messages, UsageError } from "../errors-cold.ts";
import { perUserShimDirectory as perUserDefault } from "../run/exec.ts";
import { ENTRY_CANDIDATES, findEntryModule } from "../utils/self.ts";
import { getHomeFolder } from "../cache/store.ts";

/** Our own binary name — what §15.29's `PATH` verification and §10.4's lookup search for. */
const TOOL_NAME = "jup";

/**
 * §14.16 — how we recognise a stub we wrote. A regular file that does not carry
 * this marker is somebody else's binary and is never replaced without `--force`.
 */
export const SHIM_MARKER = "@jup-shim";

/** §10.2 — a Yarn Switch install lives under `…/switch/bin/…`. */
const YARN_SWITCH_RE = /[/\\]switch[/\\]bin[/\\]/;

/** Windows writes three files per binary name (§10.3); `disable` removes all three. */
const WIN32_EXTENSIONS = ["", ".ps1", ".cmd"];

/**
 * The first line of each §10.3 wrapper.
 *
 * The wrappers cannot carry {@link SHIM_MARKER}: §10.3 fixes their bodies byte
 * for byte and the conformance suite compares them literally. They are
 * recognised instead by their shebang plus the `<binName>.js` stub they invoke,
 * which no unrelated binary of the same name would contain.
 */
const WIN32_WRAPPER_HEADS = ["@SETLOCAL", "#!/bin/sh", "#!/usr/bin/env pwsh"];

/** §15.15 — where the record of displaced entries lives, under `<home>`. */
const DISPLACED_RECORD_NAME = "shims.json";

/** §15.15 — where the *content* of a displaced regular file is parked. */
const DISPLACED_BACKUP_DIR = "displaced";

export interface ShimOptions {
  installDirectory?: string;
  /** §14.16 — required to replace an entry we did not create. */
  force?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Messages                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * These live here rather than in `errors.ts` for the same reason `info.ts` keeps
 * its own: they are this command's vocabulary and nothing else refers to them.
 *
 * The two `!` lines quoted verbatim by §15.13 and §15.29 are byte-exact
 * contract; the rest are ours to word.
 */

/**
 * §14.18 — `EROFS`/`EACCES` on the shim directory is the container and
 * OS-package case, and a raw errno tells the user nothing. Name the ways out.
 */
export const shimDirectoryNotWritable = (directory: string) =>
  `Unable to write shims to ${directory}: the directory is not writable. Either re-run with --install-directory <a writable directory on your PATH>, set JUP_SHIM_DIRECTORY, or define shell aliases instead (e.g. alias yarn="${TOOL_NAME} yarn")`;

/** §15.13 point 2 — verbatim. */
export const shimDirectoryFallback = (directory: string, fallback: string) =>
  `! ${directory} is not writable; installing shims to ${fallback} instead`;

/** §15.29 point 2 — verbatim. */
export const shimShadowed = (name: string, path: string, shim: string) =>
  `! ${name} on PATH resolves to ${path}, not the shim just installed at ${shim}. Another version manager may be shadowing it.`;

const REHASH_ADVICE =
  "A shell that is already open may need `hash -r` before the change is visible.";

/** §15.13 point 3 / §15.29 point 3 — the exact line to add, for the detected shell. */
export const shimDirectoryNotOnPath = (directory: string) =>
  [
    `! ${directory} is not on your PATH, so the shims installed there will not be found.`,
    `! Add it by running:`,
    `!     ${pathExportLine(directory)}`,
    `! ${REHASH_ADVICE}`,
  ].join(`\n`);

/** §15.29 point 4. */
export const rehashNotice = () => `! ${REHASH_ADVICE}`;

/** §15.15 — "if a recorded entry can no longer be restored, say so and continue". */
export const restoreFailed = (path: string, reason: string) =>
  `! Unable to restore ${path}: ${reason}`;

/* -------------------------------------------------------------------------- */
/* Argument parsing and the target set                                        */
/* -------------------------------------------------------------------------- */

interface ParsedArgs {
  options: ShimOptions;
  names: string[];
  exclude: string[];
}

/**
 * §09.8 — `[--install-directory <path>] [...name]`, plus §14.16's `--force` and
 * §15.16's `--exclude <name>`.
 *
 * `--exclude` is repeatable and accepts a comma-separated list, because that is
 * what a user who has just read "`--exclude npm`" will try next.
 */
function parseShimArgs(args: string[]): ParsedArgs {
  const options: ShimOptions = {};
  const names: string[] = [];
  const exclude: string[] = [];

  const valueOf = (arg: string, index: number): [string, number] => {
    const inline = arg.indexOf("=");
    if (inline !== -1) return [arg.slice(inline + 1), index];
    const value = args[index + 1];
    if (value === undefined) {
      throw new UsageError(`Option ${arg} requires an argument`);
    }
    return [value, index + 1];
  };

  for (let index = 0; index < args.length; index++) {
    const arg = args[index] as string;

    if (arg === "--install-directory" || arg.startsWith("--install-directory=")) {
      const [value, next] = valueOf(arg, index);
      options.installDirectory = value;
      index = next;
    } else if (arg === "--exclude" || arg.startsWith("--exclude=")) {
      const [value, next] = valueOf(arg, index);
      for (const name of value.split(",")) {
        if (name !== "") exclude.push(name);
      }
      index = next;
    } else if (arg === "--force") {
      options.force = true;
    } else {
      // Anything else is a package manager name and is validated as one, which
      // is also how a typo'd flag reports itself (§12.9).
      names.push(arg);
    }
  }

  return { options, names, exclude };
}

function assertKnownName(name: string): void {
  if (!Object.hasOwn(DEFINITIONS, name)) {
    throw new UsageError(messages.invalidPackageManagerName(name));
  }
}

/**
 * §10.5 as amended by §15.16 — with no names, every supported package manager
 * that opts into the default set, npm included; each name then expands to its
 * full binary set, so `disable yarn` takes `yarnpkg` with it.
 *
 * npm used to be excluded on the grounds that it ships with Node. §15.16 rejects
 * that: the exclusion is inter-team policy corepack is party to and we are not,
 * and its consequence is that a yarn-pinned project correctly blocks `pnpm`
 * while `npm install` silently works anyway. `--exclude npm` restores it.
 *
 * §15.28's native entries are the opposite case and opt *out*
 * (`shimByDefault: false`). `bun` and `deno` name runtimes that users install
 * deliberately and reach for outside any project; a bare `jup enable` claiming
 * those names on `PATH` would be a takeover nobody asked for, and — unlike the
 * npm question — it would land on people who upgraded rather than on people who
 * chose. Naming the entry is the opt-in: `jup enable bun` installs its shims,
 * and `jup disable` with no names still removes whatever is installed, because
 * removal has no such hazard.
 */
export function targetBinaries(
  names: string[],
  exclude: string[] = [],
  options?: { includeOptOut?: boolean },
): string[] {
  for (const name of exclude) assertKnownName(name);
  const excluded = new Set(exclude);

  const defaults = Object.keys(DEFINITIONS).filter(
    (name) => options?.includeOptOut === true || shimsByDefault(name),
  );

  const selected = (names.length > 0 ? names : defaults).filter((name) => {
    assertKnownName(name);
    return !excluded.has(name);
  });

  const binaries = new Set<string>();
  for (const name of selected) {
    for (const binName of getBinariesFor(name)) binaries.add(binName);
  }

  return [...binaries];
}

/* -------------------------------------------------------------------------- */
/* Where the shims go — §10.4, §14.17, §15.13                                 */
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

/** `which(name)` — the full path of the first executable of that name on `PATH`. */
export function whichFile(name: string): string | undefined {
  const pathValue = process.env[SYSTEM_ENV.PATH] ?? "";
  const extensions =
    process.platform === "win32"
      ? (process.env[SYSTEM_ENV.PATHEXT] ?? ".COM;.EXE;.BAT;.CMD").split(";")
      : [""];

  for (const entry of pathValue.split(delimiter)) {
    if (entry === "") continue;
    for (const extension of extensions) {
      const candidate = join(entry, `${name}${extension}`);
      if (isExecutableFile(candidate)) return candidate;
    }
  }

  return undefined;
}

/** Two paths naming the same directory or file, symlinks resolved where possible. */
function samePath(left: string, right: string): boolean {
  if (left === right) return true;
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
}

/**
 * §15.13 point 1 — the per-user default, the one place a shim can always be
 * written without elevation.
 *
 * The chain itself lives in `exec.ts`, because §15.32 prepends this directory to
 * `PATH` on every proxy invocation and the two must name the same place. All
 * this adds is §14.17's error: without a home directory there is no per-user
 * default to fall back to, and the user has to name a directory.
 */
export function perUserShimDirectory(): string {
  const directory = perUserDefault();
  if (directory === undefined) throw new UsageError(messages.noShimDirectory());
  return directory;
}

/**
 * §15.13 point 1 — `--install-directory`, else `COREPACK_SHIM_DIRECTORY`, else
 * the per-user default.
 *
 * The `PATH` lookup for our own binary is gone from this chain on purpose: it is
 * exactly what #71 is about. `--install-directory=<the directory containing the
 * tool>` (point 4) remains available for anyone who wants the old behaviour.
 *
 * `enable` realpaths the result so relative link targets are correct; `disable`
 * deliberately does not (§10.4).
 */
export function resolveInstallDirectory(options: ShimOptions, forEnable: boolean): string {
  const configured = options.installDirectory ?? readEnv(ENV.SHIM_DIRECTORY);
  const directory =
    configured !== undefined && configured !== ""
      ? resolvePath(configured)
      : perUserShimDirectory();

  if (!forEnable) return directory;

  // §10.2 property 2: a relative link target computed from a symlinked directory
  // would be wrong, so `enable` — and only `enable` — resolves it first.
  try {
    return realpathSync(directory);
  } catch {
    return directory;
  }
}

/** `undefined` when the directory can be created and written to, else the errno. */
function probeWritable(directory: string): NodeJS.ErrnoException | undefined {
  const probe = join(directory, `.${TOOL_NAME}-probe-${process.pid.toString(36)}`);
  try {
    mkdirSync(directory, { recursive: true });
    writeFileSync(probe, "");
    return undefined;
  } catch (error) {
    return error as NodeJS.ErrnoException;
  } finally {
    rmSync(probe, { force: true });
  }
}

const NOT_WRITABLE = new Set(["EROFS", "EACCES", "EPERM"]);

/**
 * §15.13 point 2 — probe *before* writing anything, and fall back to the
 * per-user default rather than failing, saying so on the way.
 *
 * Returns the realpath of the directory that will actually be used.
 */
export function prepareInstallDirectory(directory: string): string {
  const failure = probeWritable(directory);
  if (failure === undefined) return realpathOr(directory);

  const fallback = perUserShimDirectory();
  if (!NOT_WRITABLE.has(failure.code ?? "") || samePath(directory, fallback)) {
    if (NOT_WRITABLE.has(failure.code ?? "")) {
      throw new UsageError(shimDirectoryNotWritable(directory));
    }
    throw failure;
  }

  advisory(shimDirectoryFallback(directory, fallback));

  const second = probeWritable(fallback);
  if (second !== undefined) throw new UsageError(shimDirectoryNotWritable(fallback));

  return realpathOr(fallback);
}

function realpathOr(directory: string): string {
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
 *
 * **The entry is resolved against the stub's own realpath, not by a relative
 * specifier.** `./shim.mjs` would be the obvious spelling and it is wrong: the
 * shim on `PATH` is a *symlink* to this file (§10.2), so a relative specifier is
 * resolved against whichever path the runtime considers the main module's. That
 * happens to be the realpath under stock Node, which is why the relative form
 * worked — but it is a default, not a guarantee. `node
 * --preserve-symlinks-main`, a documented and supported flag, turns it off, and
 * the stub then looks for its entry *next to the symlink* and dies with
 * `ERR_MODULE_NOT_FOUND`; bun and deno resolve from the link too. Doing the
 * `realpath` ourselves makes the pair relocatable under every one of them, and
 * costs a single `stat` on a path the loader is about to stat anyway — measured
 * at no change against §16.3's budget, because `node:fs` and `node:url` are
 * already loaded by the warm chunk this stub is about to import.
 *
 * The two builtin imports are static, since neither reads our environment; the
 * `import()` of the entry stays *after* the download-prompt assignment, which
 * the entry does read.
 *
 * The exit code is assigned only when it is non-zero, exactly as `bin.ts` does
 * it and for the same reason (§08.4): the in-process handover answers `0` before
 * the package manager's module body has run, and writing that would replace
 * `undefined` with `0` — after which a package manager whose `beforeExit` hook
 * guards on `process.exitCode === undefined` declines to set its own code. Node
 * exits 0 when nothing is assigned, so a plain success is unaffected. This is
 * the stub every `yarn`, `npm` and `pnpm` on the machine runs through, so the
 * reasoning lives here rather than in the handful of lines it emits.
 *
 * §14.15 — **`binName` is omitted on POSIX**, and the stub reads the name it was
 * invoked under from `basename(process.argv[1])` instead. Node does not
 * `realpath` `argv[1]` (it does `realpath` the *module*, which is what
 * {@link ENTRY_CANDIDATES} and the `realpathSync` below are for), so a symlink
 * named `yarn` still says `yarn` there — under a direct `PATH` execution, under
 * `node <shim>`, and under `--preserve-symlinks-main`. One stub therefore serves
 * every binary name, which is #751 closed at the root: there is no per-name file
 * left to go stale.
 *
 * Windows still passes a name, because §10.3's `.cmd` / `.ps1` wrappers invoke
 * `node <stub>` and the invocation name is gone by then. That is the *only*
 * reason the parameter still exists.
 *
 * @param entryName The entry module's *bare file name* — one of
 * {@link ENTRY_CANDIDATES}. Not a specifier: the stub builds its own.
 * @param binName Windows only. Omitted, the stub dispatches on its own
 * invocation name.
 */
export function shimSource(entryName: string, binName?: string): string {
  const name = binName === undefined ? "basename(process.argv[1])" : JSON.stringify(binName);
  return [
    "#!/usr/bin/env node",
    `// ${SHIM_MARKER} — generated by \`${TOOL_NAME} enable\`; edits are overwritten.`,
    `import { realpathSync } from "node:fs";`,
    ...(binName === undefined ? [`import { basename } from "node:path";`] : []),
    `import { pathToFileURL } from "node:url";`,
    `if (process.env.${jupSpelling(ENV.ENABLE_DOWNLOAD_PROMPT)} === undefined)`,
    `  process.env.${ENV.ENABLE_DOWNLOAD_PROMPT} ??= "1";`,
    `const entry = new URL(${JSON.stringify(entryName)}, pathToFileURL(realpathSync(import.meta.filename)));`,
    `const { runMain } = await import(entry.href);`,
    `const code = await runMain([${name}, ...process.argv.slice(2)]);`,
    `if (code !== 0) process.exitCode = code;`,
    "",
  ].join("\n");
}

/**
 * §10.2 — the one stub every POSIX shim points at.
 *
 * It carries no binary name, so it cannot collide with one: every name in the
 * table is a bare command (`yarn`, `npm`, `aubx`), and this is the only file in
 * `dist/` with a hyphen in it.
 */
export const PROXY_STUB_NAME = "shim-proxy.js";

/** §14.18 — map the read-only install to something the user can act on. */
async function guardWrites<T>(directory: string, action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (NOT_WRITABLE.has(code ?? "")) {
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
 * Make sure the stub exists and is current, and hand back its path. It is
 * rewritten only when the content differs, so a warm `enable` writes nothing at
 * all — which is what lets §10.2's idempotency hold even when the dist folder is
 * read-only.
 *
 * `binName` is Windows's: §10.3 needs one stub per name because its wrappers
 * cannot carry the invocation name. POSIX omits it and gets
 * {@link PROXY_STUB_NAME}, written once however many names are enabled.
 */
async function ensureStub(distFolder: string, binName?: string): Promise<string> {
  // The stub resolves its entry module against its own realpath, so the pair
  // stays relocatable (§10.2 property 2) whichever path the runtime hands the
  // stub — see `shimSource`. Which name exists depends on
  // whether we are running from source or from a build; `ENTRY_CANDIDATES` is the
  // single definition of that order, and `scripts/generate-shims.mjs` shares it so
  // that the shipped stubs and the ones `enable` writes are byte-identical.
  const entry = ENTRY_CANDIDATES.find((candidate) => existsSync(join(distFolder, candidate)));
  if (entry === undefined) throw new UsageError(messages.assertStubFolderMissing());

  const file = join(distFolder, binName === undefined ? PROXY_STUB_NAME : `${binName}.js`);
  const source = shimSource(entry, binName);

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
/* Ownership — §14.16, §15.14, §15.15                                         */
/* -------------------------------------------------------------------------- */

/** §10.2 — a `yarn`-ish name whose realpath lands inside a Yarn Switch install. */
async function isYarnSwitch(binName: string, file: string): Promise<boolean> {
  if (!binName.includes("yarn")) return false;
  // A dangling link has no realpath, and that is not a Switch install.
  const target = await realpath(file).catch(() => undefined);
  return target !== undefined && YARN_SWITCH_RE.test(target);
}

/**
 * Is the entry at `file` one *we* created?
 *
 * §14.16 answers this for `enable`; §15.15 makes `disable` ask the same question
 * before removing anything, which is the whole of #112. The three shapes:
 *
 * * a POSIX symlink whose target carries {@link SHIM_MARKER};
 * * a **dangling** symlink that still names a stub of ours — the shared
 *   {@link PROXY_STUB_NAME}, or a per-name `<binName>.js` from a Windows install
 *   or an older build. This is #751's stale shim, which `enable` must replace and
 *   `disable` must remove rather than skip (§15.14);
 * * a regular file carrying the marker, or one of §10.3's three Windows
 *   wrappers, which cannot carry it (see {@link WIN32_WRAPPER_HEADS}).
 */
async function isOurEntry(file: string, binName: string, stats?: Stats): Promise<boolean> {
  const entry = stats ?? (await lstat(file).catch(() => undefined));
  if (entry === undefined) return false;

  if (entry.isSymbolicLink()) {
    const link = await readlink(file).catch(() => undefined);
    if (link === undefined) return false;
    const head = await readHead(resolvePath(dirname(file), link), 1024);
    // A live link is ours iff what it points at is ours; a dangling one is ours
    // iff it still names our stub (§15.14 / #751).
    if (head !== undefined) return head.includes(SHIM_MARKER);
    const target = basename(link);
    return target === PROXY_STUB_NAME || target === `${binName}.js`;
  }

  if (!entry.isFile()) return false;

  const head = await readHead(file, 1024);
  if (head === undefined) return false;
  if (head.includes(SHIM_MARKER)) return true;
  return (
    WIN32_WRAPPER_HEADS.some((start) => head.startsWith(start)) && head.includes(`${binName}.js`)
  );
}

/* -------------------------------------------------------------------------- */
/* §15.15 — the record of what `enable` displaced                             */
/* -------------------------------------------------------------------------- */

/**
 * One entry `enable` moved out of the way.
 *
 * §15.15 asks for "path, type, and for a symlink its target". A *regular file*
 * needs one thing more to be restorable: its content. Recording a type alone
 * would let `disable` recreate an empty stand-in, which is worse than not
 * restoring at all — so the file itself is parked under `<home>/displaced/` and
 * the record names it. Its mode rides along, or the restored binary would come
 * back non-executable.
 */
export interface DisplacedEntry {
  path: string;
  type: "symlink" | "file";
  /** Symlinks: the link target, verbatim (it may be relative). */
  target?: string;
  /** Regular files: where the content is parked. */
  backup?: string;
  /** Regular files: the permission bits to restore. */
  mode?: number;
}

interface DisplacedRecord {
  version: number;
  displaced: DisplacedEntry[];
}

function displacedRecordPath(): string {
  return join(getHomeFolder(), DISPLACED_RECORD_NAME);
}

export function readDisplacedRecord(): DisplacedEntry[] {
  let raw: string;
  try {
    raw = readFileSync(displacedRecordPath(), "utf8");
  } catch {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as DisplacedRecord;
    return Array.isArray(parsed.displaced) ? parsed.displaced : [];
  } catch {
    // A corrupt record is not a reason to refuse to disable; it only means there
    // is nothing we can put back.
    return [];
  }
}

function writeDisplacedRecord(entries: DisplacedEntry[]): void {
  const file = displacedRecordPath();
  if (entries.length === 0) {
    rmSync(file, { force: true });
    return;
  }
  mkdirSync(dirname(file), { recursive: true });
  const record: DisplacedRecord = { version: 1, displaced: entries };
  writeFileSync(file, `${JSON.stringify(record, undefined, 2)}\n`);
}

/**
 * Append to the record.
 *
 * Deliberately synchronous: `enable` processes every binary name concurrently
 * (§10.5), and a sync read-modify-write cannot be interleaved by another
 * microtask, so no lock is needed for the in-process race that actually exists.
 */
function appendDisplaced(entry: DisplacedEntry): void {
  const entries = readDisplacedRecord().filter((existing) => existing.path !== entry.path);
  entries.push(entry);
  writeDisplacedRecord(entries);
}

let backupCounter = 0;

function backupPathFor(file: string): string {
  const dir = join(getHomeFolder(), DISPLACED_BACKUP_DIR);
  mkdirSync(dir, { recursive: true });
  const suffix = `${Date.now().toString(36)}-${process.pid.toString(36)}-${backupCounter++}`;
  return join(dir, `${basename(file)}-${suffix}`);
}

/**
 * §15.15 — move an entry that is not ours out of the way, recording enough to
 * put it back.
 *
 * The record is written whenever we displace something foreign, not only under
 * `--force`: §10.2 lets `enable` replace a *symlink* it did not create without
 * asking, and losing a symlink is exactly the complaint in #112. Returns `true`
 * when the entry has already been removed from `file`.
 */
async function displace(file: string, stats: Stats, installDirectory: string): Promise<boolean> {
  if (stats.isSymbolicLink()) {
    const target = await readlink(file).catch(() => undefined);
    if (target !== undefined) appendDisplaced({ path: file, type: "symlink", target });
    return false;
  }

  if (!stats.isFile()) return false;

  const backup = backupPathFor(file);
  await guardWrites(installDirectory, async () => {
    try {
      await rename(file, backup);
    } catch (error) {
      // A rename across devices cannot work; a copy can.
      if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
      copyFileSync(file, backup);
      await unlink(file);
    }
  });

  appendDisplaced({ path: file, type: "file", backup, mode: stats.mode & 0o777 });
  return true;
}

/**
 * §15.15 — put back whatever `enable` displaced at these paths, then forget it.
 *
 * "If a recorded entry can no longer be restored, say so and continue": every
 * failure warns and the entry is dropped, so a second `disable` does not repeat
 * a complaint the user can do nothing about.
 */
export function restoreDisplaced(installDirectory: string, files: string[]): number {
  const wanted = new Set(files.map((file) => basename(file)));
  const entries = readDisplacedRecord();

  const kept: DisplacedEntry[] = [];
  let restored = 0;

  for (const entry of entries) {
    if (!wanted.has(basename(entry.path)) || !samePath(dirname(entry.path), installDirectory)) {
      kept.push(entry);
      continue;
    }

    const failure = restoreOne(entry);
    if (failure !== undefined) advisory(restoreFailed(entry.path, failure));
    else restored++;
  }

  if (kept.length !== entries.length) writeDisplacedRecord(kept);
  return restored;
}

function restoreOne(entry: DisplacedEntry): string | undefined {
  if (lstatSync(entry.path, { throwIfNoEntry: false }) !== undefined) {
    return `something else now occupies that path`;
  }

  try {
    if (entry.type === "symlink") {
      if (entry.target === undefined) return `the recorded link target is missing`;
      symlinkSync(entry.target, entry.path);
      return undefined;
    }

    if (entry.backup === undefined || !existsSync(entry.backup)) {
      return `the saved copy is no longer in the store`;
    }
    try {
      renameSync(entry.backup, entry.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
      copyFileSync(entry.backup, entry.path);
      rmSync(entry.backup, { force: true });
    }
    if (entry.mode !== undefined) chmodSync(entry.path, entry.mode);
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
}

/* -------------------------------------------------------------------------- */
/* POSIX — §10.2, §10.6                                                       */
/* -------------------------------------------------------------------------- */

/**
 * §10.2 — POSIX shims are relative symlinks, created with `lstat` (not `stat`,
 * so a dangling symlink is seen as a symlink) and **idempotent**: an
 * already-correct link is not rewritten and its mtime is unchanged.
 *
 * §14.16: refuse to replace a regular file that is not one of our own shims
 * unless `--force`. Yarn Switch then falls out of the general rule rather than
 * being a hard-coded exception — both are "this entry is not ours to touch",
 * both warn on stderr, both leave the entry alone, and both exit 0.
 *
 * Returns the installed shim's path, or `undefined` when the name was skipped —
 * §15.29 only verifies the names it actually wrote.
 */
export async function generatePosixLink(
  installDirectory: string,
  distFolder: string,
  binName: string,
  options: ShimOptions = {},
): Promise<string | undefined> {
  const stub = await ensureStub(distFolder);
  const file = join(installDirectory, binName);
  const target = relative(installDirectory, stub);

  // lstat, NOT stat: a dangling symlink must read as a symlink rather than as an
  // absent file, or the symlink() below fails with EEXIST (corepack's 0.34.4 bug).
  const existing = await lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });

  if (existing !== undefined) {
    const ours = await isOurEntry(file, binName, existing);

    if (ours) {
      if (existing.isSymbolicLink() && (await readlink(file).catch(() => undefined)) === target) {
        // Already correct: no write, so the mtime does not move (test 122).
        return file;
      }
    } else {
      if (!options.force) {
        if (await isYarnSwitch(binName, file)) {
          // Corepack prints this one too (`Enable.ts`, `Disable.ts`), so it is
          // not `advisory()`: §11.5 scopes the mute to the lines *we* add.
          console.warn(messages.yarnSwitchSkip(binName, file));
          return undefined;
        }
        // Symlinks are ours to manage — §10.2 corrects one that points elsewhere.
        // Anything else without our marker is a real binary and stays put.
        if (!existing.isSymbolicLink()) {
          advisory(messages.shimNotOurs(binName, file));
          return undefined;
        }
      }

      // §15.15 — whatever we are about to overwrite is somebody else's; record
      // it so `disable` can put it back.
      if (await displace(file, existing, installDirectory)) {
        await guardWrites(installDirectory, () => symlink(target, file));
        return file;
      }
    }

    await guardWrites(installDirectory, () => unlink(file));
  }

  await guardWrites(installDirectory, () => symlink(target, file));
  return file;
}

/**
 * §10.6 + §15.15 — POSIX removal: the Yarn Switch guard, then removal of the
 * entry **only if we created it**, then `unlink` with `ENOENT` ignored.
 *
 * `--force` restores corepack's unconditional behaviour for anyone who wants it.
 */
export async function removePosixLink(
  installDirectory: string,
  binName: string,
  options: ShimOptions = {},
): Promise<void> {
  const file = join(installDirectory, binName);

  const existing = await lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existing === undefined) return;

  if (!options.force) {
    if (await isYarnSwitch(binName, file)) {
      // Corepack prints this one too — see `installPosixLink`.
      console.warn(messages.yarnSwitchSkip(binName, file));
      return;
    }
    // §15.15 — "removes only entries it created". A real package manager that
    // predates us, or one restored by an earlier `disable`, is left alone.
    if (!(await isOurEntry(file, binName, existing))) return;
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
 * §14.16 and §15.15 do still apply here — "unconditionally" in §10.3 is about
 * not short-circuiting on our *own* files, not a licence to delete somebody
 * else's `yarn.cmd`.
 *
 * Platform-independent on purpose, so Windows shims can be produced — and
 * tested — from a POSIX machine.
 */
export async function generateWin32Link(
  installDirectory: string,
  distFolder: string,
  binName: string,
  options: ShimOptions = {},
): Promise<string | undefined> {
  const stub = await ensureStub(distFolder, binName);
  const file = join(installDirectory, binName);
  const rel = relative(installDirectory, stub);

  const files = [
    [file, win32ShSource(rel)],
    [`${file}.cmd`, win32CmdSource(rel)],
    [`${file}.ps1`, win32Ps1Source(rel)],
  ] as const;

  // §14.16 — decide for the whole binary name before writing any of the three,
  // so a refusal never leaves two of our wrappers beside somebody else's third.
  for (const [path] of files) {
    const existing = await lstat(path).catch(() => undefined);
    if (existing === undefined) continue;
    if (await isOurEntry(path, binName, existing)) continue;
    if (!options.force) {
      advisory(messages.shimNotOurs(binName, path));
      return undefined;
    }
  }

  for (const [path] of files) {
    const existing = await lstat(path).catch(() => undefined);
    if (existing === undefined) continue;
    if (await isOurEntry(path, binName, existing)) continue;
    await displace(path, existing, installDirectory);
  }

  await guardWrites(installDirectory, async () => {
    for (const [path, source] of files) {
      await writeFile(path, source);
      await chmod(path, 0o755);
    }
  });

  return file;
}

/** §10.6 + §15.15 — Windows removal: all three files, ours only, `ENOENT` ignored. */
export async function removeWin32Link(
  installDirectory: string,
  binName: string,
  options: ShimOptions = {},
): Promise<void> {
  await guardWrites(installDirectory, async () => {
    for (const extension of WIN32_EXTENSIONS) {
      const file = join(installDirectory, `${binName}${extension}`);
      const existing = await lstat(file).catch(() => undefined);
      if (existing === undefined) continue;
      // No Yarn Switch check here — §10.2 makes it POSIX-only — but §15.15's
      // "only what we created" holds on every platform.
      if (!options.force && !(await isOurEntry(file, binName, existing))) continue;
      await unlink(file).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  });
}

/* -------------------------------------------------------------------------- */
/* §15.13 / §15.29 — did it take effect?                                      */
/* -------------------------------------------------------------------------- */

type Shell = "posix" | "fish" | "csh" | "powershell" | "cmd";

/** Which shell is the user most likely typing into right now? */
export function detectShell(): Shell {
  const shell = process.env[SYSTEM_ENV.SHELL];
  if (shell !== undefined && shell !== "") {
    const name = basename(shell).replace(/\.exe$/i, "");
    if (name === "fish") return "fish";
    if (name === "csh" || name === "tcsh") return "csh";
    if (name === "pwsh" || name === "powershell") return "powershell";
    return "posix";
  }

  if (process.platform === "win32") {
    // PowerShell exports this; `cmd.exe` does not.
    return process.env[SYSTEM_ENV.PSMODULEPATH] !== undefined ? "powershell" : "cmd";
  }

  return "posix";
}

/** §15.13 point 3 — the exact line to add, for the detected shell. */
export function pathExportLine(directory: string, shell: Shell = detectShell()): string {
  switch (shell) {
    case "fish":
      return `fish_add_path ${directory}`;
    case "csh":
      return `setenv PATH "${directory}:$PATH"`;
    case "powershell":
      return `$env:PATH = "${directory};$env:PATH"`;
    case "cmd":
      return `set PATH=${directory};%PATH%`;
    default:
      return `export PATH="${directory}:$PATH"`;
  }
}

function directoryOnPath(directory: string): boolean {
  for (const entry of (process.env[SYSTEM_ENV.PATH] ?? "").split(delimiter)) {
    if (entry !== "" && samePath(entry, directory)) return true;
  }
  return false;
}

/**
 * §15.29 — `enable` verifies its own post-condition.
 *
 * #507 is "corepack enable exits 0 and `yarn` is still the old one". Two causes,
 * two messages: the directory is not on `PATH` at all, or it is but something
 * earlier wins. The first subsumes the second — if the directory is missing from
 * `PATH` then *every* name is shadowed, and repeating that per binary would bury
 * the one line the user has to act on — so only one of the two is printed.
 *
 * Exit code stays 0: these are warnings, not failures.
 */
export function verifyOnPath(installDirectory: string, installed: [string, string][]): void {
  if (!directoryOnPath(installDirectory)) {
    advisory(shimDirectoryNotOnPath(installDirectory));
    return;
  }

  let shadowed = false;
  for (const [binName, shim] of installed) {
    const resolved = whichFile(binName);
    // Nothing on `PATH` at all is not a shadowing report; the directory *is* on
    // `PATH`, so this only happens for an entry we did not install.
    if (resolved === undefined) continue;
    if (samePath(dirname(resolved), installDirectory)) continue;
    advisory(shimShadowed(binName, resolved, shim));
    shadowed = true;
  }

  if (shadowed) advisory(rehashNotice());
}

/* -------------------------------------------------------------------------- */
/* Commands — §09.8                                                           */
/* -------------------------------------------------------------------------- */

/**
 * §10 — install the shims. Idempotent, and exits 0 with empty stdout and stderr
 * on success. A skipped entry — Yarn Switch, or §14.16's foreign binary — warns
 * on stderr and still exits 0: it is a warning, not a failure. So do §15.13's
 * fallback and §15.29's verification.
 *
 * `distFolder` is a seam for the tests; production always uses our own folder.
 */
export async function cmdEnable(
  args: string[],
  distFolder: string = resolveDistFolder(),
): Promise<number> {
  const { options, names, exclude } = parseShimArgs(args);
  // Validate before touching the filesystem, so a bad name reports itself even
  // when the install directory cannot be resolved (§12.9).
  const binaries = targetBinaries(names, exclude);
  // §15.13 — resolve, then probe, then fall back; nothing is written before the
  // directory is known to be writable.
  const installDirectory = prepareInstallDirectory(resolveInstallDirectory(options, false));

  const generate = process.platform === "win32" ? generateWin32Link : generatePosixLink;

  // §10.5 — all binaries are processed concurrently.
  const installed = await Promise.all(
    binaries.map(async (binName): Promise<[string, string] | undefined> => {
      const shim = await generate(installDirectory, distFolder, binName, options);
      return shim === undefined ? undefined : [binName, shim];
    }),
  );

  verifyOnPath(
    installDirectory,
    installed.filter((entry) => entry !== undefined),
  );

  return 0;
}

/**
 * §10.6 — removes only the names it was asked about, and within those only the
 * entries it created (§15.15); `disable yarn` also removes `yarnpkg`. Anything
 * `enable` displaced is then put back.
 */
export async function cmdDisable(args: string[]): Promise<number> {
  const { options, names, exclude } = parseShimArgs(args);
  // `includeOptOut` — removal covers every name the tool can install, including
  // the §15.28 entries a bare `enable` leaves alone. Otherwise `jup disable`
  // would silently decline to undo a `jup enable bun`, which is the one thing a
  // no-argument disable is for.
  const binaries = targetBinaries(names, exclude, { includeOptOut: true });
  // §10.4 — no realpath here: removal needs no relative-path computation.
  const installDirectory = resolveInstallDirectory(options, false);

  await Promise.all(
    binaries.map((binName) =>
      process.platform === "win32"
        ? removeWin32Link(installDirectory, binName, options)
        : removePosixLink(installDirectory, binName, options),
    ),
  );

  // §15.15 — restore *after* removal, so the recorded path is free again. On
  // Windows a name occupies three files, and each was recorded separately.
  const files =
    process.platform === "win32"
      ? binaries.flatMap((binName) =>
          WIN32_EXTENSIONS.map((extension) => join(installDirectory, `${binName}${extension}`)),
        )
      : binaries.map((binName) => join(installDirectory, binName));
  restoreDisplaced(installDirectory, files);

  return 0;
}
