/**
 * Handing over control — §08.
 *
 * Run the package manager so convincingly that neither the user nor the package
 * manager itself can tell a trampoline was involved.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, extname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { ENV, readEnv, SYSTEM_ENV, writeEnv } from "../config/env-vars.ts";
import { getPackageManagerFor } from "../config/table.ts";
import { messages } from "../errors.ts";
import type { BinList, BinSpec, InstallSpec } from "../types.ts";
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
      return join(localAppData, "node", "corepack", "bin");
    }
    const home = homedir();
    return home === "" ? undefined : join(home, "AppData", "Local", "node", "corepack", "bin");
  }

  // macOS has no XDG convention; Linux and the BSDs do.
  if (process.platform !== "darwin") {
    const xdg = process.env[SYSTEM_ENV.XDG_BIN_HOME];
    if (xdg !== undefined && xdg !== "") return xdg;
  }

  const home = homedir();
  return home === "" ? undefined : join(home, ".local", "bin");
}

/** §15.13 point 1 — `COREPACK_SHIM_DIRECTORY`, else the per-user default. */
function defaultShimDirectory(): string | undefined {
  const configured = readEnv(ENV.SHIM_DIRECTORY);
  if (configured !== undefined && configured !== "") return resolve(configured);
  return perUserShimDirectory();
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
 * The one `stat` keeps that claim honest. Shims may never have been installed,
 * and the per-user default (`~/.local/bin`) is full of *other* programs;
 * prepending it when it holds no shim of ours would put the package manager
 * nowhere and only re-rank the user's own binaries for the child — which is what
 * §15.32's "the prepended entry MUST be the only modification" forbids.
 */
function shimDirectoryFor(binName: string): string | undefined {
  const directory = defaultShimDirectory();
  if (directory === undefined) return undefined;
  return existsSync(join(directory, binName)) ? directory : undefined;
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
 * The URL's path component, without query or fragment.
 *
 * `specUrl` comes from the embedded table (`PackageManagerSpec.url`, with `{}`
 * already substituted), so it parses as an absolute URL; the fallback keeps a
 * hand-built spec from throwing here rather than at the assertion below.
 */
function urlPathname(specUrl: string): string {
  try {
    return new URL(specUrl).pathname;
  } catch {
    return specUrl;
  }
}

/**
 * §08.1 — locate the entry point.
 *
 * `specUrl` is the package manager spec's **download URL**, not just its
 * extension: a `bin` list resolves to `<location>/<basename of the URL path>`,
 * which needs the whole path. The `.js` extension check is what makes the list
 * form meaningful — a list only ever describes a single-file download (§07.4),
 * and any other extension leaves the path unset, i.e. an assertion failure.
 *
 * Per §14.13, when `bin` came from a downloaded `package.json` rather than the
 * embedded table its values are attacker-controlled: resolve the joined path and
 * verify it stays inside `<location>`. The marker file (§07.2) does not record
 * which of the two sources its `bin` came from, so the check is unconditional —
 * the embedded table's own values never escape, so nothing legitimate is lost.
 *
 * `fallbackBin` is §08.1's `installSpec.bin ?? spec.bin`: the embedded table's
 * `bin` for this locator. Markers written by older corepack releases carry no
 * `bin` at all, and §07.1 requires the store to stay compatible with them, so
 * without the fallback a run the spec says must succeed dies on a `TypeError`
 * instead.
 */
export function resolveBinPath(
  binName: string,
  spec: InstallSpec,
  specUrl: string,
  fallbackBin?: BinSpec | BinList,
): string {
  const location = resolve(spec.location);
  const bin = spec.bin ?? fallbackBin;

  let declared: string | undefined;
  if (Array.isArray(bin)) {
    if (bin.includes(binName)) {
      const pathname = urlPathname(specUrl);
      // Dispatch on the URL path's extension, exactly as the download did (§07.4).
      if (extname(pathname) === ".js") declared = basename(pathname);
    }
  } else if (bin !== undefined && Object.hasOwn(bin, binName)) {
    declared = bin[binName];
  }

  if (declared === undefined) throw new Error(messages.assertUnableToLocateBinPath(binName));

  const binPath = resolve(location, declared);
  if (binPath !== location && !binPath.startsWith(location + sep)) {
    // §14.13 — `<installFolder>/<name>/<version>` is the store layout (§07.2), so
    // the two trailing segments name the locator this install belongs to.
    const name = getPackageManagerFor(binName) ?? basename(dirname(location));
    throw new Error(messages.binEscapes(declared, name, basename(location)));
  }

  // Not `binPath`: §08.1 joins naively, and a `bin` value of `./bin/yarn.js` must
  // stay `<location>/bin/yarn.js` in `process.argv[1]` rather than being rewritten
  // by `resolve`'s normalisation of the location itself.
  return join(spec.location, declared);
}

/**
 * §08.2 — in-process handover, or §15.28's native handover.
 *
 * The JavaScript path rewrites the process state to look like a direct
 * invocation, then loads the entry module on `nextTick` so our frames leave any
 * stack trace the package manager prints. `process.argv[1]` is how Yarn locates
 * itself; an undefined `require.main` is how pnpm detects its own version;
 * `execArgv` is cleared so the package manager does not inherit our runtime
 * flags.
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
 * preserved across the process boundary.
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
  specUrl: string,
  fallbackBin?: BinSpec | BinList,
  execMode?: "js" | "native",
): number | Promise<number> {
  const binPath = resolveBinPath(binName, spec, specUrl, fallbackBin);

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
    return import("./native.ts").then((native) => native.execNative(binPath, args, env));
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
  // Let the runtime set it (§08.2); pnpm reads `require.main == null` to detect
  // that it is running from a version manager rather than from its own bin stub.
  (process as { mainModule?: unknown }).mainModule = undefined;

  process.nextTick(() => {
    // `import()` handles both CJS and ESM entry points and leaves `require.main`
    // undefined for the CJS ones. The promise is deliberately left unhandled.
    void import(pathToFileURL(binPath).href);
  });

  return 0;
}
