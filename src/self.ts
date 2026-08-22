/**
 * Locating our own installation — §08.7, §10.4.
 *
 * Two questions, both answered by walking **up** from whichever file is asking:
 * where is our package root (for `COREPACK_ROOT`), and where is the entry module
 * a shim stub should import (for `enable`).
 *
 * Walking is not over-engineering here. A bundler is free to emit chunks into a
 * subdirectory — obuild puts them in `dist/_chunks/` — so a fixed number of
 * `dirname` calls from `import.meta.url` gives a different answer when built
 * than when run from source. That mismatch is invisible in tests that run from
 * source and wrong in the shipped package, which is the worst combination.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Candidate names for the module a shim stub should import, best first.
 *
 * `shim.*` comes first because it is the proxy-only entry (§16.3): it exports
 * `runMain` and nothing else, so a shim never loads the library surface. Older
 * installations have no such file, and `index.*` still works there.
 */
export const ENTRY_CANDIDATES = [
  "shim.mjs",
  "shim.js",
  "shim.ts",
  "index.mjs",
  "index.js",
  "index.ts",
];

/** Stop rather than walking to `/` if something is badly wrong. */
const MAX_DEPTH = 16;

function walkUp(from: string, matches: (dir: string) => boolean): string | undefined {
  let dir = from;
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    if (matches(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * The directory containing our own `package.json`.
 *
 * §08.7 — exported to the package manager as `COREPACK_ROOT` so it can detect
 * that it is running under a version manager. Yarn's `yarn init` reads it.
 */
export function getOwnRoot(moduleUrl: string): string {
  const from = dirname(fileURLToPath(moduleUrl));
  return walkUp(from, (dir) => existsSync(join(dir, "package.json"))) ?? from;
}

/**
 * The tool's own version (§09.9, §15.30f), read from our own manifest.
 *
 * The walk above is what makes this correct in a built package: two fixed levels
 * is right from `<root>/src/cli.ts` and wrong from `<root>/dist/_chunks/cli.mjs`,
 * where a bundler puts the caller — and the shipped package would then answer
 * `--version` with the `0.0.0` fallback forever.
 *
 * It lives here rather than in `cli.ts` because `info` reports it too, and
 * §15.35f asks the tool to report its own version: two copies of a path
 * computation that is only wrong when built is exactly the drift to avoid.
 */
export function getOwnVersion(): string {
  try {
    const raw = readFileSync(join(getOwnRoot(import.meta.url), "package.json"), "utf8");
    const data = JSON.parse(raw) as { version?: unknown };
    if (typeof data.version === "string") return data.version;
  } catch {
    // A package without a readable manifest still answers `--version`.
  }
  return "0.0.0";
}

/**
 * The directory holding the library entry module: `src/` from source, `dist/`
 * from a build — never the bundler's chunk directory.
 *
 * Returns the directory and the entry's file name, since `enable` needs both to
 * write a stub that imports it by a relative specifier.
 */
export function findEntryModule(
  moduleUrl: string,
): { directory: string; entry: string } | undefined {
  const from = dirname(fileURLToPath(moduleUrl));

  let found: string | undefined;
  const directory = walkUp(from, (dir) => {
    found = ENTRY_CANDIDATES.find((candidate) => existsSync(join(dir, candidate)));
    return found !== undefined;
  });

  return directory === undefined || found === undefined ? undefined : { directory, entry: found };
}
