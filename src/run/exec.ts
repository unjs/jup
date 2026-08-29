/**
 * Handing over control — §08.
 *
 * Run the package manager so convincingly that neither the user nor the package
 * manager itself can tell a trampoline was involved.
 */

const { closeSync, openSync, readlinkSync, readSync } = process.getBuiltinModule("node:fs");
const { runMain } = process.getBuiltinModule("node:module");
const { homedir } = process.getBuiltinModule("node:os");
const { basename, delimiter, dirname, isAbsolute, join, resolve, sep } =
  process.getBuiltinModule("node:path");
import { ENV, readEnv, SYSTEM_ENV, writeEnv } from "../config/env-vars.ts";
import { getPackageManagerFor } from "../config/table.ts";
import { messages } from "../errors.ts";
import type { BinSpec, Installation } from "../types.ts";
import { CLI_ENTRY_NAME, getOwnRoot as resolveOwnRoot } from "../utils/self.ts";

/**
 * §08.7 — walk to the installation root because bundled chunks may be nested.
 * The result is cached.
 */
let ownRoot: string | undefined;
function getOwnRoot(): string {
  ownRoot ??= resolveOwnRoot(import.meta.url);
  return ownRoot;
}

/**
 * §10.5 — the per-user shim directory. Windows uses
 * `%LOCALAPPDATA%\jup\bin`.
 *
 * It lives here rather than in `shims.ts`, which imports it: §08.7 needs it on
 * every proxy invocation, and the directory this prepends and the one `enable`
 * writes into must never drift apart. `undefined` means there is no home
 * directory to derive one from — §12.10's error for `enable`, and simply nothing
 * to prepend for a proxy run.
 */
export function perUserShimDirectory(): string | undefined {
  if (process.platform === "win32") {
    const localAppData = process.env[SYSTEM_ENV.LOCALAPPDATA];
    if (localAppData !== undefined && localAppData !== "") {
      return join(localAppData, "jup", "bin");
    }
    const home = homedir();
    return home === "" ? undefined : join(home, "AppData", "Local", "jup", "bin");
  }

  // macOS has no XDG convention; Linux and the BSDs do.
  //
  // `resolve`d for the same reason `JUP_SHIM_DIRECTORY` is below: this
  // directory is prepended to `PATH` for every child process (§08.7), and a
  // relative value there is a *cwd-relative* `PATH` entry — one that follows the
  // package manager into every directory it happens to chdir into. The XDG base
  // directory specification requires an absolute path anyway.
  if (process.platform !== "darwin") {
    const xdg = process.env[SYSTEM_ENV.XDG_BIN_HOME];
    if (xdg !== undefined && xdg !== "") return resolve(xdg);
  }

  const home = homedir();
  return home === "" ? undefined : join(home, ".local", "bin");
}

/**
 * §10.5 — the machine-wide directory: `--system`'s target, and the one
 * alternate a `root` process may reach.
 *
 * POSIX uses `/usr/local/bin`; Windows uses `%ProgramData%\jup\bin` and returns
 * `undefined` when that variable is unset.
 */
export function systemShimDirectory(): string | undefined {
  if (process.platform !== "win32") return "/usr/local/bin";
  const programData = process.env[SYSTEM_ENV.PROGRAMDATA];
  return programData === undefined || programData === ""
    ? undefined
    : join(programData, "jup", "bin");
}

/**
 * §10.5 — the **closed list** of directories `enable` may choose from:
 * the default first, then the alternates. Nothing here comes from `PATH`, which
 * only decides *among* these, and only under `enable`. Deduped, since the default
 * is one of the alternates on every platform but macOS-without-XDG.
 */
export function shimDirectoryCandidates(): string[] {
  const list: string[] = [];
  const add = (directory: string | undefined): void => {
    if (directory !== undefined && directory !== "" && !list.includes(directory)) {
      list.push(directory);
    }
  };

  add(perUserShimDirectory());
  if (process.platform === "win32") return list;

  // `XDG_BIN_HOME` is an alternate on macOS though never its default: no XDG
  // convention to default to, but a user who set it has still named a directory.
  const xdg = process.env[SYSTEM_ENV.XDG_BIN_HOME];
  if (xdg !== undefined && xdg !== "") add(resolve(xdg));
  const home = homedir();
  if (home !== "") {
    add(join(home, ".local", "bin"));
    add(join(home, "bin"));
  }

  // §10.5 — last, and only for uid 0: a per-user directory already on
  // `PATH` remains the better answer even for `root`, and for anyone else the
  // ownership gate would reject this one anyway. A *candidate* rather than a
  // branch inside `enable`, because §10.5's scan is how `disable`, `info` and
  // the promotion below find those shims again.
  if (process.getuid?.() === 0) add(systemShimDirectory());

  return list;
}

/**
 * §10.6 — how we recognise a stub we wrote.
 *
 * It lives here rather than in `shims.ts` because `shims.ts` imports *this*
 * module and the reverse would be a cycle — and because §08.7's `PATH`
 * promotion below is the one reader of it that runs on every invocation, not
 * just under `enable`. `shims.ts` re-exports it, so there is still one spelling.
 */
export const SHIM_MARKER = "@jup-shim";

/**
 * §10.3 — the stub a shim points at, one per binary name. `.mjs` so the runtime
 * knows the format from the name and never walks up for a `package.json`
 * `"type"`. Here for the reason `SHIM_MARKER` is: §10.6's ownership
 * test reads it on every invocation.
 */
export function stubNameFor(binName: string): string {
  return `${binName}.mjs`;
}

/**
 * The first line of each §10.4 Windows wrapper.
 *
 * The wrappers cannot carry {@link SHIM_MARKER} — §10.4 fixes their bodies byte
 * for byte — so they are recognised by their head plus the {@link stubNameFor}
 * stub they invoke. Here for the reason {@link SHIM_MARKER} is: {@link isOurShim}
 * reads it on every invocation and decides which `node` on `PATH` §10.2 may
 * bake in. `shims.ts` re-exports it, so there is one list.
 */
export const WIN32_WRAPPER_HEADS = ["@SETLOCAL", "#!/bin/sh", "#!/usr/bin/env pwsh"];

/** First `length` bytes of a file as UTF-8, or `undefined` if it cannot be read. */
function readHeadSync(file: string, length: number): string | undefined {
  let handle: number | undefined;
  try {
    handle = openSync(file, "r");
    const buffer = Buffer.allocUnsafe(length);
    const read = readSync(handle, buffer, 0, length, 0);
    return buffer.toString("utf8", 0, read);
  } catch {
    return undefined;
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
}

/**
 * Is the entry at `file` a shim **we** wrote, rather than any file that happens
 * to wear the name?
 *
 * A POSIX shim is a symlink to a stub of ours (§10.3), so the open follows it
 * and reads the stub's banner: a link is ours exactly when what it points at is.
 * §10.4's Windows wrappers cannot carry the marker (their bodies are byte-exact)
 * and are recognised by shebang plus the {@link stubNameFor} stub they invoke.
 *
 * Two names satisfy the dangling case, one per shape a link of ours can have:
 * the per-name stub §10.3 writes, and {@link CLI_ENTRY_NAME} for the two names
 * §10.9 points at the CLI entry itself.
 */
export function isOurShim(file: string, binName: string): boolean {
  const head = readHeadSync(file, 1024);
  if (head === undefined) {
    // A dangling link is ours only if it still names our stub.
    let link: string;
    try {
      link = readlinkSync(file);
    } catch {
      return false;
    }
    const target = basename(link);
    return target === stubNameFor(binName) || target === CLI_ENTRY_NAME;
  }
  if (head.includes(SHIM_MARKER)) return true;
  // All three shapes, and not gated on the platform — `isOurEntry` reads them
  // the same way. The gate was the bug: `whichAll` walks `PATHEXT` on Windows,
  // so the only candidates it can hand this are `.cmd` and `.ps1`, and a §10.2
  // tier-2 walk blind to those baked our own `node.cmd` into every wrapper it
  // wrote — §10.2's exec loop, by hand.
  return (
    WIN32_WRAPPER_HEADS.some((start) => head.startsWith(start)) &&
    head.includes(stubNameFor(binName))
  );
}

/**
 * §08.7 — the directory to put in front of `PATH` for a JavaScript package
 * manager, or `undefined` when there is none.
 *
 * §10.1's shims are self-dispatching, so the shim directory *is* a directory
 * containing the resolved package manager's binaries: a nested `pnpm` re-enters
 * this tool, walks the same project and resolves the same version, with nothing
 * copied or generated to make it so.
 *
 * The check keeps that claim honest. Shims may never have been installed, and
 * the per-user default (`~/.local/bin`) is full of *other* programs; prepending
 * it when it holds no shim of ours would put the package manager nowhere and
 * only re-rank the user's own binaries for the child — which is what §08.7's
 * "the prepended entry MUST be the only modification" forbids.
 *
 * A plain existence test was not enough for that. `~/.local/bin/pnpm` installed
 * by anything else — a distro package, a `pip install --user`, a file someone
 * dropped there — was enough to move that directory to the **front** of `PATH`
 * for every child of every `jup pnpm` run, re-ranking the whole of the user's
 * `PATH` on the strength of a name. Reading the banner costs one open+read on a
 * path we were about to `stat` anyway (§16, Build shape) and makes the promotion mean what
 * it says.
 *
 * §10.5 makes that same read the *selector*, since `enable` may have
 * chosen an alternate and this MUST NOT read `PATH` to find out which. §16,
 * Build shape carries the measured cost and the `argv[1]` branch that pays for
 * it: §10.1's shim is a symlink named `<binName>` and Node does not `realpath`
 * `argv[1]`, so
 * a run *through* a shim already holds the answer and opens nothing. Both halves
 * of that test are load-bearing — a promotion decided on a name alone is what the
 * banner check exists to prevent.
 *
 * The branch is an optimisation and never an answer of its own: a runtime that
 * *does* `realpath` `argv[1]` — bun does — simply fails the name comparison and
 * pays for the loop below, which reads the same directories and returns the same
 * directory. Nothing about correctness rests on which runtime is reading this.
 */
function shimDirectoryFor(binName: string): string | undefined {
  const configured = readEnv(ENV.SHIM_DIRECTORY);
  const candidates =
    configured !== undefined && configured !== ""
      ? [resolve(configured)]
      : shimDirectoryCandidates();

  const self = process.argv[1];
  if (self !== undefined && basename(self) === binName) {
    const directory = dirname(self);
    if (candidates.includes(directory)) return directory;
  }

  for (const directory of candidates) {
    if (isOurShim(join(directory, binName), binName)) return directory;
  }
  return undefined;
}

/**
 * `PATH` with `directory` prepended, or `undefined` when it is already first.
 *
 * Idempotent on purpose: a nested run re-enters through the very shim this entry
 * made reachable, so without the check each level of nesting would add another
 * copy and a deep `pnpm run` chain would grow `PATH` without bound.
 */
export function pathWith(directory: string, current: string | undefined): string | undefined {
  if (current === undefined || current === "") return directory;
  if (current === directory || current.startsWith(directory + delimiter)) return undefined;
  return directory + delimiter + current;
}

/**
 * Set `PATH` on a child environment, whatever case the ambient one spells it:
 * Windows variables are case-insensitive but an object's keys are not, so a
 * spread of `process.env` yields `Path` and adding `PATH` would hand it two.
 */
function setPath(env: Record<string, string | undefined>, value: string): void {
  for (const key of Object.keys(env)) {
    if (key !== SYSTEM_ENV.PATH && key.toLowerCase() === "path") delete env[key];
  }
  env[SYSTEM_ENV.PATH] = value;
}

/**
 * §08.1 — locate the entry point.
 *
 * Per §08.1, when `bin` came from a downloaded `package.json` rather than the
 * embedded table its values are attacker-controlled: resolve the joined path and
 * verify it stays inside `<location>`. The marker file (§07.2) does not record
 * which of the two sources its `bin` came from, so the check is unconditional —
 * the embedded table's own values never escape, so nothing legitimate is lost.
 *
 * `fallbackBin` is §08.1's `installSpec.bin ?? spec.bin`: the embedded table's
 * `bin` for this locator. §07.7 always records a `bin`, so this stands in only
 * for a marker jup did not write — §07.10 promotes those out of an archive —
 * where without it a run dies on a `TypeError` rather than the §08.1 assertion.
 */
export function resolveBinPath(binName: string, spec: Installation, fallbackBin?: BinSpec): string {
  const location = resolve(spec.location);
  const bin = spec.bin ?? fallbackBin;

  const declared = bin !== undefined && Object.hasOwn(bin, binName) ? bin[binName] : undefined;
  if (declared === undefined) throw new Error(messages.assertUnableToLocateBinPath(binName));
  // Empty resolves to the install directory, which passes containment below and
  // is not an entry point.
  if (declared === "") throw new Error(messages.assertUnableToLocateBinPath(binName));

  const binPath = resolve(location, declared);
  if (binPath !== location && !binPath.startsWith(location + sep)) {
    // §08.1 — `<installFolder>/<name>/<version>` is the store layout (§07.2), so
    // the two trailing segments name the locator this install belongs to.
    const name = getPackageManagerFor(binName) ?? basename(dirname(location));
    throw new Error(messages.binEscapes(declared, name, basename(location)));
  }

  // Not `binPath` for a relative value: §08.1 joins naively, and `./bin/yarn.js`
  // must stay `<location>/bin/yarn.js` in `process.argv[1]`. An absolute value
  // has nothing to prepend, and joining one yielded `<location>` concatenated
  // onto itself — neither what was declared nor what was checked.
  return isAbsolute(declared) ? binPath : join(spec.location, declared);
}

/**
 * JavaScript handover rewrites process state, schedules `runMain`, and returns 0;
 * the module sets the process's eventual exit status. Deliberately do not catch
 * that load: doing so changes the runtime's uncaught-exception exit behavior.
 * Native handover instead returns the eventual child exit code. Both preserve
 * inherited stdio.
 */
export function execPackageManager(
  binName: string,
  spec: Installation,
  args: string[],
  fallbackBin?: BinSpec,
  execMode?: "js" | "native",
  binArgs?: readonly string[],
): number | Promise<number> {
  const binPath = resolveBinPath(binName, spec, fallbackBin);

  // §08.3 — the band's argv for *this* name, in front of the user's own. It is
  // how `pnpx` reaches pnpm 12: one binary, and one of the two names it answers
  // to is spelled as a subcommand rather than as an `argv[0]` it can read. The
  // words are prepended and nothing else — this is not a place to rewrite what
  // the user typed.
  const argv = binArgs === undefined || binArgs.length === 0 ? args : [...binArgs, ...args];

  // §08.7 — the only variable we add, and it is added the same way for both
  // models: a native child inherits `process.env` wholesale. Package managers
  // use it purely as an "am I running under a version manager?" flag.
  writeEnv(ENV.ROOT, getOwnRoot());

  if (execMode === "native") {
    // §08.7 — what goes in front of `PATH` for a native artifact is the
    // directory holding it. This branch spawns, so it has a real child
    // environment: the entry is written into *that* and `process.env.PATH` is
    // never touched, which is "MUST NOT leak into the tool's own process" in its
    // literal form.
    const env = { ...process.env };
    const path = pathWith(dirname(binPath), process.env[SYSTEM_ENV.PATH]);
    if (path !== undefined) setPath(env, path);

    // Imported here and nowhere else: `node:child_process` must not enter the
    // module graph of a JavaScript cache hit (§01.3, §16, Build shape).
    // `binName`, not `binPath`: §08.3's artifacts dispatch on `argv[0]`, and
    // `bunx` and `bun` are the same file.
    return import("./native.ts").then((native) => native.execNative(binPath, argv, env, binName));
  }

  // §08.7 — the JavaScript path hands over **in process**, so there is no child
  // environment to write into: `process.env` *is* what the package manager will
  // read. "Must not leak into the tool's own process" is therefore honoured by
  // scope rather than by copying — this is the last statement before handover,
  // after every write the tool performs (§08.3) and after all of its own work,
  // none of which resolves a binary from `PATH`. Nothing of ours ever observes
  // the modified value.
  const shimDirectory = shimDirectoryFor(binName);

  if (shimDirectory !== undefined) {
    const path = pathWith(shimDirectory, process.env[SYSTEM_ENV.PATH]);
    if (path !== undefined) process.env[SYSTEM_ENV.PATH] = path;
  }

  process.argv = [process.execPath, binPath, ...argv];
  process.execArgv = [];
  // `require.main` is a live view of `process.mainModule`, and the two lines below
  // are one statement about it. Cleared first, so that whatever started *us* — a
  // CJS shim, when we were invoked through one — is never mistaken for the package
  // manager's own entry: that is the `require.main == null` pnpm checks to tell it
  // is running under a version manager rather than from its bin stub (§08.2).
  (process as { mainModule?: unknown }).mainModule = undefined;

  // Repopulated second, by §08.2's handover itself: `runMain` is Node's
  // `executeUserEntryPoint`, so it covers CJS and ESM entry points alike *and*
  // installs the loaded one as `require.main`, which a bare `import()` never does.
  // npm 6 dereferences `require.main.filename` unconditionally; pnpm 4 reads its
  // own version out of `dirname(require.main.filename)/../package.json` and
  // silently reports `0.0.0` when that throws. Unlike `node:child_process`, which
  // this file never names, `node:module` is looked up at the top of it: the CJS
  // loader is already instantiated during bootstrap, so a cache hit pays nothing
  // for it (§16, Build shape). Failures reach the runtime uncaught, per §08.4 above.
  process.nextTick(runMain, binPath);

  return 0;
}
