/**
 * Our own identity — §08.7, §10.4, §17.6 C1′.
 *
 * Two questions are answered by walking **up** from whichever file is asking:
 * where is our package root (for `COREPACK_ROOT`), and where is the entry module
 * a shim stub should import (for `enable`). A third — *which of our two names
 * were we invoked under* — is answered from `process.argv[1]` at the bottom of
 * this file.
 *
 * Walking is not over-engineering here. A bundler is free to emit chunks into a
 * subdirectory — obuild puts them in `dist/_chunks/` — so a fixed number of
 * `dirname` calls from `import.meta.url` gives a different answer when built
 * than when run from source. That mismatch is invisible in tests that run from
 * source and wrong in the shipped package, which is the worst combination.
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
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

/* -------------------------------------------------------------------------- */
/* The invoked entry point — §17.6 C1′                                        */
/* -------------------------------------------------------------------------- */

/**
 * §17.6 C1′ — the tool's own entry-point names.
 *
 * One executable, two names: `jup` is its name and `corepack` a second name for
 * the same file. Both are members of "the tool's own entry-point names" in
 * §17.4 R7 step 0, so neither is ever mistaken for a shim.
 */
export const ENTRY_NAMES = ["jup", "corepack"] as const;

export type EntryName = (typeof ENTRY_NAMES)[number];

/**
 * Extensions a launcher may carry that are not part of the name the user typed.
 *
 * `.ts` is how the tool runs from source under Node's type stripping, `.mjs`
 * how it runs from `dist/`, and `.exe` how a Windows launcher would be named.
 */
const SCRIPT_EXTENSION =
  process.platform === "win32" ? /\.(?:c?js|mjs|ts|exe)$/i : /\.(?:c?js|mjs|ts)$/;

/**
 * Which of {@link ENTRY_NAMES} this argv[1] names — **`jup` when it names
 * neither** (§17.6 C1′).
 *
 * Node does not realpath `process.argv[1]`, so the name survives the two
 * indirections that matter: npm's bin symlink (`node_modules/.bin/corepack` →
 * `dist/bin.mjs`) arrives spelled `corepack`, and a generated package-manager
 * shim (`~/.local/bin/pnpm`, §10.1) arrives spelled `pnpm` — neither of our
 * names, and correctly `jup`, because a shim reaches `runMain` with the binary
 * name already prepended to argv and never wants corepack's spellings.
 *
 * Pure, and exported separately from {@link getEntryName}, so the classification
 * is testable without a process.
 */
export function entryNameFrom(argv1: string | undefined): EntryName {
  if (argv1 === undefined || argv1 === "") return "jup";
  const name = basename(argv1).replace(SCRIPT_EXTENSION, "");
  return (ENTRY_NAMES as readonly string[]).includes(name) ? (name as EntryName) : "jup";
}

/**
 * The name this process was invoked under (§17.4 R12, §17.6 C10).
 *
 * Deliberately not cached: it is two string operations, it is only ever reached
 * while building a message or a usage line, and a cache would make the one
 * process-global input here untestable without a hook in shipped code.
 */
export function getEntryName(): EntryName {
  return entryNameFrom(process.argv[1]);
}
