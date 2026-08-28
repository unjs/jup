/**
 * Fixtures: throwaway projects, throwaway `COREPACK_HOME`s, and fake package
 * managers — both as store entries (a hand-written `.jup` marker plus a
 * trivial entry script) and as npm-shaped tarballs the mock registry can serve.
 *
 * The `bin` layout comes from the embedded table, so the entry point a fake
 * writes is exactly the one §08.1 will look for.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { getSpecFor, isSupportedPackageManager } from "../../../src/config/table.ts";
import { parse } from "../../../src/version/semver.ts";
import { hashOf, npmTarball } from "./tarball.ts";

const roots: string[] = [];

export interface Fixture {
  /** The throwaway root holding both of the below. */
  root: string;
  /** The project directory a `run()` starts in. */
  cwd: string;
  /** A fresh `COREPACK_HOME` (§13.1). */
  home: string;
  write(relative: string, content: string): string;
  read(relative: string): string;
  json(relative: string): unknown;
  exists(relative: string): boolean;
  path(relative: string): string;
  remove(relative: string): void;
}

/**
 * §15.13's per-user shim directory for a fixture whose home is `root`, and the
 * environment that redirects it there.
 *
 * Both halves are platform-specific, and a row that hardcodes either one tests
 * nothing on the other two platforms. Linux and the BSDs honour
 * `XDG_BIN_HOME`; **macOS has no XDG convention** and always lands on
 * `~/.local/bin`; Windows uses `%LOCALAPPDATA%\jup\bin` (§15.13 point 1, and
 * point 5 for why `LOCALAPPDATA` is cleared everywhere else).
 *
 * A row that set only `XDG_BIN_HOME` therefore redirected nothing on macOS and
 * `enable` wrote into the developer's own `~/.local/bin` — which is what the
 * macOS CI leg found, in every shim row at once.
 */
export function perUserShims(root: string): {
  dir: string;
  env: Record<string, string | undefined>;
} {
  if (process.platform === "win32") {
    const localAppData = join(root, "AppData", "Local");
    return {
      dir: join(localAppData, "jup", "bin"),
      env: { LOCALAPPDATA: localAppData, XDG_BIN_HOME: undefined },
    };
  }
  if (process.platform === "darwin") {
    return {
      dir: join(root, ".local", "bin"),
      env: { LOCALAPPDATA: undefined, XDG_BIN_HOME: undefined },
    };
  }
  const dir = join(root, "user-bin");
  return { dir, env: { LOCALAPPDATA: undefined, XDG_BIN_HOME: dir } };
}

/**
 * §15.13 point 6's `<home>/bin` alternate, for a fixture whose home is `root`.
 *
 * There is no Windows counterpart — the candidate list has one entry there, so a
 * row that exercises the preference skips that platform rather than spelling the
 * directory differently.
 */
export function alternateShims(root: string): string {
  return join(root, "bin");
}

/**
 * A temporary directory, by its **real** path.
 *
 * `realpath`, because macOS puts `$TMPDIR` behind a symlink (`/var` ->
 * `/private/var`) and the tool resolves the paths it reports and compares:
 * §10.4 realpaths the install directory, §03.1 realpaths the manifest it
 * names. Without this every assertion that quotes a path back compares
 * `/var/folders/...` against `/private/var/folders/...` and fails on macOS
 * alone. `test/unit/shims.test.ts` has done this since it was written; the
 * shared harness had not.
 */
function tempRoot(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(root);
  return root;
}

/**
 * A project directory and a private store.
 *
 * `manifest` is written as `package.json` unless it is `undefined` (no manifest
 * at all) — pass a string to write it verbatim, which is how the invalid-JSON
 * and BOM rows get their fixtures.
 */
export function createFixture(manifest?: unknown): Fixture {
  const root = tempRoot("jup-conf-");

  const cwd = join(root, "project");
  const home = join(root, "home");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(home, { recursive: true });

  const fixture: Fixture = {
    root,
    cwd,
    home,
    path: (relative) => join(cwd, relative),
    write(relative, content) {
      const file = join(cwd, relative);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
      return file;
    },
    read: (relative) => readFileSync(join(cwd, relative), "utf8"),
    json: (relative) => JSON.parse(readFileSync(join(cwd, relative), "utf8")) as unknown,
    exists: (relative) => existsSync(join(cwd, relative)),
    remove: (relative) => rmSync(join(cwd, relative), { force: true, recursive: true }),
  };

  if (manifest !== undefined) {
    fixture.write(
      "package.json",
      typeof manifest === "string" ? manifest : `${JSON.stringify(manifest, undefined, 2)}\n`,
    );
  }

  return fixture;
}

/** Every fixture root created so far. Call from an `afterAll`. */
export function cleanupFixtures(): void {
  while (roots.length > 0) {
    rmSync(roots.pop()!, { recursive: true, force: true });
  }
}

/**
 * A throwaway copy of `src/`, and the path to its `bin.ts`.
 *
 * `enable` writes its stub files next to the library entry module (§10.1), so a
 * conformance run of `enable` against the checkout would drop generated files
 * into `src/`. Running a copy keeps the repository untouched and is otherwise
 * indistinguishable — the copy is the same source, type-stripped the same way.
 */
export function copyTool(): string {
  const root = tempRoot("jup-tool-");
  cpSync(new URL("../../../src", import.meta.url), join(root, "src"), { recursive: true });
  // The published package has one, and two things depend on it: `.js` files —
  // which is what `enable` writes (§10.1) — are only ESM when it says so, and
  // `COREPACK_ROOT` (§08.7) is the directory that holds it. Without it a shim
  // written into the copy could not run, and `COREPACK_ROOT` would point
  // somewhere outside the copy entirely.
  writeFileSync(join(root, "package.json"), `{"name":"jup","version":"0.0.0","type":"module"}\n`);
  return join(root, "src", "bin.ts");
}

/* -------------------------------------------------------------------------- */
/* Fake package managers                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The stand-in entry point. It answers `--version` with the bare version — which
 * is what rows 1 and 137 assert, decoration and all — echoes its argv otherwise,
 * and dumps this tool's environment — both prefixes, §11.6 — for `run env`
 * (row 51).
 */
export function pmScript(name: string, version: string): string {
  return [
    `const args = process.argv.slice(2);`,
    `const NAME = ${JSON.stringify(name)};`,
    `const VERSION = ${JSON.stringify(version)};`,
    `if (args[0] === "--version" || args[0] === "-v") {`,
    `  process.stdout.write(VERSION + "\\n");`,
    `} else if (args[0] === "run" && args[1] === "env") {`,
    `  for (const key of Object.keys(process.env).sort()) {`,
    `    if (key.startsWith("COREPACK_") || key.startsWith("JUP_"))`,
    `      process.stdout.write(key + "=" + process.env[key] + "\\n");`,
    `  }`,
    `} else {`,
    `  process.stdout.write(NAME + "@" + VERSION + (args.length ? " " + args.join(" ") : "") + "\\n");`,
    `}`,
    ``,
  ].join("\n");
}

/** `1.22.4+sha1.abc` -> `1.22.4`; the store never keeps the build suffix (§07.2). */
export function versionOf(reference: string): string {
  const parsed = parse(reference);
  if (parsed === null) throw new Error(`Not a version reference: ${reference}`);
  return parsed.version;
}

/** The entry-point paths the table declares for this version, tarball-relative. */
export function binPathsFor(name: string, version: string): string[] {
  // §15.41 — every band is a tarball with a `BinSpec` of paths; the single-file
  // branch that used to stand here was Yarn Berry's alone.
  const spec = getSpecFor(name, version);
  return [...new Set(Object.values(spec.bin))].map((path) => path.replace(/^\.\//, ""));
}

/**
 * Seed `<home>/v1/<name>/<version>` with a marker and an entry script, which is
 * the whole of what §07.2 calls a complete install.
 */
export function seedPackageManager(
  home: string,
  name: string,
  reference: string,
  options?: { script?: string; esm?: boolean },
): string {
  const version = versionOf(reference);
  const spec = getSpecFor(name, version);
  const location = join(home, "v1", name, version);
  mkdirSync(location, { recursive: true });

  const script = options?.script ?? pmScript(name, version);
  for (const relative of binPathsFor(name, version)) {
    const file = join(location, relative);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, script);
    if (options?.esm) {
      writeFileSync(join(dirname(file), "package.json"), `{"type":"module"}\n`);
    }
  }

  // §15.11 — the marker's hash is what a cache hit is now checked against, so a
  // seeded entry has to record the digest the reference it stands for pins.
  // Writing a constant here would make every seeded fixture that pins a hash
  // look like the collision §15.11 refuses to adopt.
  const pinned = parse(reference)?.build ?? [];
  const hash = pinned.length > 0 ? pinned.join(".") : "sha512.seeded";

  writeFileSync(
    join(location, ".jup"),
    JSON.stringify({ locator: { name, reference }, bin: spec.bin, hash }),
  );

  return location;
}

/** An npm-shaped tarball for a package manager, with the table's `bin` layout. */
export function packageManagerTarball(
  name: string,
  version: string,
  options?: { script?: string; binPaths?: string[]; packageName?: string },
): Uint8Array {
  const script = options?.script ?? pmScript(name, version);
  const binPaths = options?.binPaths ?? binPathsFor(name, version);

  // §07.7 reads `bin` from *here* now, not from the table, so the manifest has
  // to declare what a real package declares: the band's own map when the caller
  // did not override the layout, and one entry per path when it did.
  const tableBin =
    options?.binPaths === undefined && isSupportedPackageManager(name)
      ? getSpecFor(name, version).bin
      : undefined;
  const bin: Record<string, string> = {};
  if (tableBin !== undefined) {
    Object.assign(bin, tableBin);
  } else {
    for (const path of binPaths) bin[basename(path).replace(/\.[cm]?js$/, "")] = `./${path}`;
  }

  const files: Record<string, string> = {
    "package.json": `${JSON.stringify(
      { name: options?.packageName ?? name, version, bin },
      undefined,
      2,
    )}\n`,
  };
  for (const path of binPaths) files[path] = script;

  return npmTarball(files);
}

/**
 * §15.41 — Yarn Berry, published the way the table now fetches it.
 *
 * Berry used to be a lone `yarn.js` on `repo.yarnpkg.com`, seeded with
 * `publishFile` at a path built out of the band's URL template. It is an
 * ordinary npm package now, so the rows that need it publish
 * `@yarnpkg/cli-dist` like any other tarball — and get npm's signature with it,
 * which is what lets them stop opting out of §15.11.
 *
 * Returns the hash-pinned reference for the published bytes, since that is what
 * most callers then write into a `packageManager` field.
 */
export function publishBerry(
  registry: { publish: (name: string, version: string, tarball: Uint8Array) => void },
  version: string,
): { reference: string; tarball: Uint8Array } {
  const tarball = packageManagerTarball("yarn", version, { packageName: "@yarnpkg/cli-dist" });
  registry.publish("@yarnpkg/cli-dist", version, tarball);
  return { reference: `${version}+sha512.${hashOf(tarball)}`, tarball };
}
