/**
 * Locate package entries by walking upward because bundled chunks may be nested below the package root.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Candidate names for the module a shim stub should import, best first.
 *
 * `shim.*` comes first because it exposes only the proxy entry (§16.3).
 * `index.*` remains a compatibility fallback.
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
 * Baked in by the bundler (`build.config.ts`'s rolldown `define`), and absent
 * when running from source. `typeof` rather than a direct read, because an
 * undeclared identifier is only safe to touch through it.
 */
declare const __JUP_VERSION__: string | undefined;

/** What `--version` answers when neither the build nor a manifest could say. */
export const UNKNOWN_VERSION = "0.0.0-unknown";

/**
 * The bundled version literal avoids runtime I/O; source runs fall back to package metadata, and `UNKNOWN_VERSION` avoids inventing a plausible version.
 */
export function getOwnVersion(): string {
  if (typeof __JUP_VERSION__ === "string") return __JUP_VERSION__;
  try {
    const raw = readFileSync(join(getOwnRoot(import.meta.url), "package.json"), "utf8");
    const data = JSON.parse(raw) as { version?: unknown };
    if (typeof data.version === "string") return data.version;
  } catch {
    // A package without a readable manifest still answers `--version`.
  }
  return UNKNOWN_VERSION;
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

/**
 * Candidate names for **our own CLI entry** — the file `package.json`'s `bin`
 * points both `jup` and `corepack` at, and therefore the file a user's `jup` on
 * `PATH` actually executes. Best first, matching {@link ENTRY_CANDIDATES}' shape.
 *
 * Deliberately only the *built* spellings. From a source checkout the entry is
 * `bin.ts`, which no shim and no `PATH` name ever reaches through `execve` — it
 * is run as `node src/bin.ts` by the test harness and by `pnpm dev` — so §15.46
 * has nothing to pin there and {@link findCliEntry} answering `undefined` is the
 * correct answer rather than a gap.
 */
export const CLI_ENTRY_CANDIDATES = ["bin.mjs", "bin.js"];

/**
 * Our own CLI entry inside `directory`, or `undefined` when this installation
 * has none — §15.46.
 *
 * Takes the directory rather than finding it, because its one caller has already
 * resolved the same folder for the stub it writes beside this file, and the two
 * must not be able to disagree.
 */
export function findCliEntry(directory: string): string | undefined {
  for (const candidate of CLI_ENTRY_CANDIDATES) {
    const file = join(directory, candidate);
    if (existsSync(file)) return file;
  }
  return undefined;
}
