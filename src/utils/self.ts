/**
 * Locate package entries by walking upward because bundled chunks may be nested below the package root.
 */

const { existsSync, readFileSync } = process.getBuiltinModule("node:fs");
const { dirname, join } = process.getBuiltinModule("node:path");
const { fileURLToPath } = process.getBuiltinModule("node:url");

/**
 * Candidate names for the module a shim stub should import, best first.
 *
 * One name, in three spellings. `shim.*` used to come first because it exposed
 * only the proxy entry, but `codeSplitting: false` had already made that a
 * distinction without a difference: the warm set statically reachable from
 * `index.ts` is *identical* to the one reachable from the old `shim.ts`, and the
 * two bundles differed by 338 of 168,000 bytes (§16.3). The second entry was one
 * more copy of the same file, and its cost was paid by everyone who installs us.
 */
export const ENTRY_CANDIDATES = ["index.mjs", "index.js", "index.ts"];

/**
 * The bundler's own folder in a published install. It is emptied on every build,
 * which is why {@link STUB_FOLDER_NAME} is not inside it — and why §09.12 has to
 * name both to copy an installation into the store.
 */
export const DIST_FOLDER_NAME = "dist";

/**
 * Directories the entry module can sit in, relative to the folder holding the
 * stubs, best first. Forward slashes: these become `new URL` specifiers.
 *
 * Beside the stub is the source checkout, where `enable` writes into `src/` next
 * to `index.ts`. One directory over is the published install, where the shipped
 * files are {@link STUB_FOLDER_NAME} and the bundle lands in `dist/` — separate
 * because the bundler owns `dist/` and empties it on every build, and these
 * files are meant to survive that untouched (§10.7).
 *
 * Beside first, so a source checkout that also happens to hold a build keeps
 * importing its own sources rather than a bundle that may be stale.
 */
const ENTRY_FOLDERS = ["", `../${DIST_FOLDER_NAME}/`];

/**
 * The one directory this package ships that is not the bundler's: `bin/`, a
 * sibling of `dist/`. It holds the CLI entry `package.json`'s `bin` points at
 * and, beside it, every stub §10 installs shims against — one directory rather
 * than two, since both are the same kind of thing (a small static file that
 * imports the bundle) and both are addressed relative to `dist/` the same way.
 */
export const STUB_FOLDER_NAME = "bin";

/**
 * The specifier every *shipped* file uses to reach the bundle. Composed rather
 * than spelled out, so the published layout cannot drift from the one
 * {@link findEntrySpecifier} probes for.
 */
export const BUILT_ENTRY_SPECIFIER = ENTRY_FOLDERS[1]! + ENTRY_CANDIDATES[0]!;

/**
 * The specifier a stub in `stubFolder` must import to reach the entry module, or
 * `undefined` when there is no entry to reach.
 *
 * A specifier and not a path: the stub resolves it with `new URL` against its
 * own realpath, so the pair stays relocatable (§10.2 property 2).
 */
export function findEntrySpecifier(stubFolder: string): string | undefined {
  for (const folder of ENTRY_FOLDERS) {
    for (const candidate of ENTRY_CANDIDATES) {
      const specifier = folder + candidate;
      if (existsSync(join(stubFolder, ...specifier.split("/")))) return specifier;
    }
  }
  return undefined;
}

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
 * The folder holding the stubs for the installation `moduleUrl` belongs to.
 *
 * Two layouts, and the entry's extension is what separates them. A published
 * install has a bundled `dist/index.mjs` with the shipped files beside it in
 * {@link STUB_FOLDER_NAME}; `enable` finds them already correct and writes
 * nothing, which is what lets §10.7's read-only installation work. A source
 * checkout has `src/index.ts` and no shipped stubs, so `enable` writes its own
 * next to the entry, exactly as it always has.
 *
 * The extension test is not decoration: a checkout that has also been built has
 * both a `dist/` and a `bin/`, and pointing at the latter would have `enable`
 * rewrite tracked files — the stubs with specifiers naming `src/`, and §15.46's
 * pin into `bin/jup.mjs` with an absolute shebang.
 */
export function findStubFolder(module: { directory: string; entry: string }): string {
  if (module.entry.endsWith(".ts")) return module.directory;
  const shipped = join(dirname(module.directory), STUB_FOLDER_NAME);
  return existsSync(shipped) ? shipped : module.directory;
}

/**
 * **Our own CLI entry** — the file `package.json`'s `bin` points both `jup` and
 * `corepack` at, and therefore the file a user's `jup` on `PATH` executes. It
 * ships in {@link STUB_FOLDER_NAME}, beside the stubs, so the name alone locates
 * it from the folder its one caller already has.
 */
export const CLI_ENTRY_NAME = "jup.mjs";

/**
 * **The names we answer to ourselves** — `package.json`'s two `bin` keys, and
 * therefore the two names §09.12's `self-install` puts on `PATH`.
 *
 * They are the exception §10.1 carves out of the shared POSIX stub: every other
 * name that reaches it is a package manager to be run, and these two are the
 * management CLI. The stub reads the list to decide which of the two it was
 * invoked as — see `shimSource` — so it lives here, beside {@link CLI_ENTRY_NAME},
 * as the one statement of what "our own name" means.
 *
 * `corepack` is on it for the reason it is a `bin` key at all: a drop-in
 * replacement has to answer to the name the machine already types.
 */
export const OWN_BIN_NAMES = ["jup", "corepack"] as const;

/** Is `binName` one of {@link OWN_BIN_NAMES} rather than a package manager? */
export function isOwnBinName(binName: string): boolean {
  return (OWN_BIN_NAMES as readonly string[]).includes(binName);
}

/**
 * Our own CLI entry for the installation whose stubs are in `stubFolder`, or
 * `undefined` when this installation has none — §15.46.
 *
 * Takes the stub folder rather than finding it, because its one caller has
 * already resolved the same folder for the stub it writes, and the two must not
 * be able to disagree.
 *
 * A source checkout answers `undefined`, and by construction rather than by a
 * special case: `enable` writes its stubs beside `src/index.ts` there, and
 * `src/` has no `jup.mjs` in it — the generated one is in `bin/`, which is a
 * folder this lookup never reaches from a checkout. That matters, because
 * `bin/jup.mjs` survives a rebuild rather than being emptied with `dist/`: a
 * maintainer's `enable node` that found it would leave an absolute shebang
 * naming their own machine in the file `npm publish` ships as our `bin` target. {@link findStubFolder} is the other half of the same guard.
 */
export function findCliEntry(stubFolder: string): string | undefined {
  const file = join(stubFolder, CLI_ENTRY_NAME);
  return existsSync(file) ? file : undefined;
}
