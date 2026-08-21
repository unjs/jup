/**
 * Handing over control — §08.
 *
 * Run the package manager so convincingly that neither the user nor the package
 * manager itself can tell a trampoline was involved.
 */

import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getPackageManagerFor } from "./config/table.ts";
import { messages } from "./errors.ts";
import type { InstallSpec } from "./types.ts";
import { getOwnRoot as resolveOwnRoot } from "./self.ts";

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
 */
export function resolveBinPath(binName: string, spec: InstallSpec, specUrl: string): string {
  const location = resolve(spec.location);

  let declared: string | undefined;
  if (Array.isArray(spec.bin)) {
    if (spec.bin.includes(binName)) {
      const pathname = urlPathname(specUrl);
      // Dispatch on the URL path's extension, exactly as the download did (§07.4).
      if (extname(pathname) === ".js") declared = basename(pathname);
    }
  } else if (Object.hasOwn(spec.bin, binName)) {
    declared = spec.bin[binName];
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
 * §08.2 — in-process handover.
 *
 * Rewrites the process state to look like a direct invocation, then loads the
 * entry module on `nextTick` so our frames leave any stack trace the package
 * manager prints. `process.argv[1]` is how Yarn locates itself; an undefined
 * `require.main` is how pnpm detects its own version; `execArgv` is cleared so
 * the package manager does not inherit our runtime flags.
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
 */
export function execPackageManager(
  binName: string,
  spec: InstallSpec,
  args: string[],
  specUrl: string,
): void {
  const binPath = resolveBinPath(binName, spec, specUrl);

  // §08.7 — the only variable we add. Package managers use it purely as an "am I
  // running under a version manager?" flag. `PATH` is deliberately left alone in
  // phase 1; §15.32 will prepend `dirname(binPath)` to it here.
  process.env.COREPACK_ROOT = getOwnRoot();

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
}
