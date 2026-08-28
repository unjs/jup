/**
 * Handing over control — §08.
 *
 * Run the package manager so convincingly that neither the user nor the package
 * manager itself can tell a trampoline was involved.
 */

import { closeSync, openSync, readlinkSync, readSync } from "node:fs";
import { runMain } from "node:module";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { ENV, readEnv, SYSTEM_ENV, writeEnv } from "../config/env-vars.ts";
import { getPackageManagerFor } from "../config/table.ts";
import { messages } from "../errors.ts";
import type { BinSpec, InstallSpec } from "../types.ts";
import { getOwnRoot as resolveOwnRoot } from "../utils/self.ts";

/**
 * §08.7 — the directory containing our own installation root.
 *
 * Corepack resolves its own `package.json` and takes its directory. Two fixed
 * `dirname`s would be cheaper, but they give the wrong answer once bundled: the
 * chunk lands in `dist/_chunks/`, so the root would come out as `dist/`. The walk
 * is cached, so handover still costs no repeat I/O (§16.3).
 */
let ownRoot: string | undefined;
function getOwnRoot(): string {
  ownRoot ??= resolveOwnRoot(import.meta.url);
  return ownRoot;
}

/* -------------------------------------------------------------------------- */
/* §15.32 — the resolved package manager on `PATH`                             */
/* -------------------------------------------------------------------------- */

/**
 * §15.13 point 1 — the per-user shim directory, the one place a shim can always
 * be written without elevation. `LOCALAPPDATA` only on Windows (point 5, #673).
 * On Windows that is `%LOCALAPPDATA%\jup\bin` (§14.24) — nothing is stranded by
 * the spelling, since the directory is §15.13's own invention and corepack puts
 * its shims beside its own binary instead.
 *
 * It lives here rather than in `shims.ts`, which imports it: §15.32 needs it on
 * every proxy invocation, and the directory this prepends and the one `enable`
 * writes into must never drift apart. `undefined` means there is no home
 * directory to derive one from — §14.17's error for `enable`, and simply nothing
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
  // `resolve`d for the same reason `COREPACK_SHIM_DIRECTORY` is below: this
  // directory is prepended to `PATH` for every child process (§15.32), and a
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
 * §15.13 point 6 — the **closed list** of directories `enable` may choose from:
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
  return list;
}

/**
 * §14.16 — how we recognise a stub we wrote.
 *
 * It lives here rather than in `shims.ts` because `shims.ts` imports *this*
 * module and the reverse would be a cycle — and because §15.32's `PATH`
 * promotion below is the one reader of it that runs on every invocation, not
 * just under `enable`. `shims.ts` re-exports it, so there is still one spelling.
 */
export const SHIM_MARKER = "@jup-shim";

/**
 * §10.2 — the shared stub every POSIX shim links to. It carries no binary name,
 * so it cannot collide with one: every table name is a bare command, and this is
 * the only file in `dist/` with a hyphen.
 */
export const PROXY_STUB_NAME = "shim-proxy.mjs";

/**
 * §10.3 — the per-name stub a Windows wrapper invokes. `.mjs` so the runtime
 * knows the format from the name and never walks up for a `package.json`
 * `"type"` (§14.27). Here for the reason `SHIM_MARKER` is: §14.16's ownership
 * test reads it on every invocation.
 */
export function stubNameFor(binName: string): string {
  return `${binName}.mjs`;
}

/**
 * The first line of each §10.3 Windows wrapper.
 *
 * The wrappers cannot carry {@link SHIM_MARKER} — §10.3 fixes their bodies byte
 * for byte — so they are recognised by their head plus the {@link stubNameFor}
 * stub they invoke. Here for the reason {@link SHIM_MARKER} is: {@link isOurShim}
 * reads it on every invocation and decides which `node` on `PATH` §15.43 may
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
 * A POSIX shim is a symlink to the shared stub (§10.2), so the open follows it
 * and reads the stub's banner: a link is ours exactly when what it points at is.
 * §10.3's Windows wrappers cannot carry the marker (their bodies are byte-exact)
 * and are recognised by shebang plus the {@link stubNameFor} stub they invoke.
 */
export function isOurShim(file: string, binName: string): boolean {
  const head = readHeadSync(file, 1024);
  if (head === undefined) {
    // The open follows the link, so this also covers #751's stale shim, whose
    // stub has moved away: §15.14 has `disable` remove it, which needs this
    // lookup to find the directory. Dangling is ours iff it still names our
    // stub — `isOurEntry`'s rule. Only reached once the read failed.
    let link: string;
    try {
      link = readlinkSync(file);
    } catch {
      return false;
    }
    const target = basename(link);
    return target === PROXY_STUB_NAME || target === stubNameFor(binName);
  }
  if (head.includes(SHIM_MARKER)) return true;
  // All three shapes, and not gated on the platform — `isOurEntry` reads them
  // the same way. The gate was the bug: `whichAll` walks `PATHEXT` on Windows,
  // so the only candidates it can hand this are `.cmd` and `.ps1`, and a §15.43
  // tier-2 walk blind to those baked our own `node.cmd` into every wrapper it
  // wrote — §14.26's exec loop, by hand.
  return (
    WIN32_WRAPPER_HEADS.some((start) => head.startsWith(start)) &&
    head.includes(stubNameFor(binName))
  );
}

/**
 * §15.32 — the directory to put in front of `PATH` for a JavaScript package
 * manager, or `undefined` when there is none.
 *
 * §14.15's shims are self-dispatching, so the shim directory *is* a directory
 * containing the resolved package manager's binaries: a nested `pnpm` re-enters
 * this tool, walks the same project and resolves the same version, with nothing
 * copied or generated to make it so.
 *
 * The check keeps that claim honest. Shims may never have been installed, and
 * the per-user default (`~/.local/bin`) is full of *other* programs; prepending
 * it when it holds no shim of ours would put the package manager nowhere and
 * only re-rank the user's own binaries for the child — which is what §15.32's
 * "the prepended entry MUST be the only modification" forbids.
 *
 * A plain existence test was not enough for that. `~/.local/bin/pnpm` installed
 * by anything else — a distro package, a `pip install --user`, a file someone
 * dropped there — was enough to move that directory to the **front** of `PATH`
 * for every child of every `jup pnpm` run, re-ranking the whole of the user's
 * `PATH` on the strength of a name. Reading the banner costs one open+read on a
 * path we were about to `stat` anyway (§16.3) and makes the promotion mean what
 * it says.
 *
 * §15.13 point 7 makes that same read the *selector*, since `enable` may have
 * chosen an alternate and this MUST NOT read `PATH` to find out which. §16.3
 * carries the measured cost and the `argv[1]` branch that pays for it: §14.15's
 * shim is a symlink named `<binName>` and Node does not `realpath` `argv[1]`, so
 * a run *through* a shim already holds the answer and opens nothing. Both halves
 * of that test are load-bearing — a promotion decided on a name alone is what the
 * banner check exists to prevent.
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
 * Per §14.13, when `bin` came from a downloaded `package.json` rather than the
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
export function resolveBinPath(binName: string, spec: InstallSpec, fallbackBin?: BinSpec): string {
  const location = resolve(spec.location);
  const bin = spec.bin ?? fallbackBin;

  const declared = bin !== undefined && Object.hasOwn(bin, binName) ? bin[binName] : undefined;
  if (declared === undefined) throw new Error(messages.assertUnableToLocateBinPath(binName));
  // Empty resolves to the install directory, which passes containment below and
  // is not an entry point.
  if (declared === "") throw new Error(messages.assertUnableToLocateBinPath(binName));

  const binPath = resolve(location, declared);
  if (binPath !== location && !binPath.startsWith(location + sep)) {
    // §14.13 — `<installFolder>/<name>/<version>` is the store layout (§07.2), so
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
 * §08.2 — in-process handover, or §15.28's native handover.
 *
 * The JavaScript path rewrites the process state to look like a direct
 * invocation, then loads the entry module on `nextTick` so our frames leave any
 * stack trace the package manager prints. `process.argv[1]` is how Yarn locates
 * itself; `require.main` is first cleared and then repopulated by `runMain` with
 * the package manager's *own* entry module, which is what both generations of
 * pnpm's self-detection read; `execArgv` is cleared so the package manager does
 * not inherit our runtime flags.
 *
 * **Do not wrap the load in a catch that rewrites the exit code.** §08.4's
 * contract is exact: a synchronous `exitCode = 42` exits 42; setting 42 and then
 * throwing exits **1**; setting 42 only in a `beforeExit` hook exits 42. The
 * first and third fall out of doing nothing; the second is the runtime's own
 * rule — an uncaught exception resets the pending exit code to 1 — and it only
 * applies if the rejection reaches the runtime unhandled. A `.catch()` here, even
 * one that only logs, is the corepack 0.18.1 regression.
 *
 * stdio is untouched and stdin is never speculatively consumed (§08.6): there is
 * only one process, so the package manager inherits the real handles, TTY-ness
 * and all.
 *
 * `execMode` is §15.28's per-band flag. `"native"` means the `bin` target is a
 * real executable, so it is run **directly**: §08.3.1's JavaScript-runtime
 * lookup is skipped entirely, which makes this the *cheaper* of the two paths
 * rather than the more expensive one. The returned promise then settles with the
 * child's exit code; see `native.ts` for how §08.4's and §08.5's observables are
 * preserved across the process boundary, and for §15.43's one further entry in
 * the child's environment — the child may itself be a runtime out of the store.
 *
 * The return value is `0` on the JavaScript path because the package manager
 * sets the real exit code from its own module body, which runs strictly after
 * this returns (§08.4). Awaiting it is safe and changes nothing: `nextTick`
 * drains ahead of the microtask queue either way.
 */
export function execPackageManager(
  binName: string,
  spec: InstallSpec,
  args: string[],
  fallbackBin?: BinSpec,
  execMode?: "js" | "native",
): number | Promise<number> {
  const binPath = resolveBinPath(binName, spec, fallbackBin);

  // §08.7 — the only variable we add, and it is added the same way for both
  // models: a native child inherits `process.env` wholesale. Package managers
  // use it purely as an "am I running under a version manager?" flag.
  writeEnv(ENV.ROOT, getOwnRoot());

  if (execMode === "native") {
    // §15.32 — what goes in front of `PATH` for a native artifact is the
    // directory holding it. This branch spawns, so it has a real child
    // environment: the entry is written into *that* and `process.env.PATH` is
    // never touched, which is "MUST NOT leak into the tool's own process" in its
    // literal form.
    const env = { ...process.env };
    const path = pathWith(dirname(binPath), process.env[SYSTEM_ENV.PATH]);
    if (path !== undefined) setPath(env, path);

    // Imported here and nowhere else: `node:child_process` must not enter the
    // module graph of a JavaScript cache hit (§01.3, §16.3).
    // `binName`, not `binPath`: §15.28's artifacts dispatch on `argv[0]`, and
    // `bunx` and `bun` are the same file.
    return import("./native.ts").then((native) => native.execNative(binPath, args, env, binName));
  }

  // §15.32 — the JavaScript path hands over **in process**, so there is no child
  // environment to write into: `process.env` *is* what the package manager will
  // read. "Must not leak into the tool's own process" is therefore honoured by
  // scope rather than by copying — this is the last statement before handover,
  // after every write the tool performs (§08.3.2) and after all of its own work,
  // none of which resolves a binary from `PATH`. Nothing of ours ever observes
  // the modified value.
  const shimDirectory = shimDirectoryFor(binName);
  if (shimDirectory !== undefined) {
    const path = pathWith(shimDirectory, process.env[SYSTEM_ENV.PATH]);
    if (path !== undefined) process.env[SYSTEM_ENV.PATH] = path;
  }

  process.argv = [process.execPath, binPath, ...args];
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
  // silently reports `0.0.0` when that throws. Unlike `node:child_process` above
  // this import is static: `node:module` is the CJS loader, already instantiated
  // during bootstrap, so a cache hit pays nothing for it (§16.3). Failures reach
  // the runtime uncaught, per §08.4 above.
  process.nextTick(runMain, binPath);

  return 0;
}
