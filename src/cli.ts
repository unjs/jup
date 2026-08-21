/**
 * Management-mode commands — §09.
 *
 * This is the complete surface. Anything not here is out of scope (§01.7).
 *
 * Two disciplines run through every command in this file:
 *
 * * **Streams (§09.11).** Informational lines and `--json` go to stdout; the
 *   `Usage Error:` block goes to stdout too (§12.1), and it is `main.ts` that
 *   prints it — a `UsageError` therefore propagates out of here rather than
 *   being caught. Warnings and notices go to stderr. The package manager's own
 *   output is never wrapped, prefixed, colourised, or buffered.
 * * **Last-known-good.** Three commands, three different rules; see
 *   {@link setLastKnownGood}.
 */

import { createReadStream, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { basename, dirname, join, relative, resolve as resolvePath } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { getSpecFor, isSupportedPackageManager, SUPPORTED_NAMES } from "./config/table.ts";
import { messages, UsageError } from "./errors.ts";
import { execPackageManager } from "./exec.ts";
import { ensureInstalled } from "./install.ts";
import { discoverProjectSpec, parseSpec, writePin } from "./manifest.ts";
import { resolveDescriptor, type ResolveOptions } from "./resolve.ts";
import { isValidRange, isValidVersion, major, parse } from "./semver.ts";
import {
  cacheClean,
  createTempDir,
  getInstallFolder,
  MARKER_NAME,
  promote,
  readLastKnownGood,
  writeLastKnownGood,
} from "./store.ts";
import { create, extract, listEntries } from "./tar.ts";
import type { Descriptor, InstallSpec, Locator } from "./types.ts";

/** §03.4 — the `source` reported for anything the user typed on the command line. */
const CLI_SOURCE = "CLI arguments";

/** §09.6 — the default `pack` output, relative to the cwd. */
const DEFAULT_ARCHIVE_NAME = "corepack.tgz";

export { USAGE_LINES } from "./usage.ts";
import { HELP_TEXT } from "./usage.ts";

/* -------------------------------------------------------------------------- */
/* Small shared helpers                                                        */
/* -------------------------------------------------------------------------- */

/** §09.11 — informational output is stdout, unbuffered, unprefixed. */
function out(text: string): void {
  process.stdout.write(text);
}

async function resolveOrThrow(descriptor: Descriptor, options: ResolveOptions): Promise<Locator> {
  const locator = await resolveDescriptor(descriptor, options);
  if (locator === null) {
    // The range the *user* wrote, not whatever a tag expanded to (§12.4).
    throw new UsageError(messages.failedToResolve(descriptor.range, descriptor.name));
  }
  return locator;
}

/**
 * The three last-known-good rules, in one place because they are asserted
 * separately and are easy to blur together:
 *
 * | Command | Effect on `lastKnownGood.json` |
 * |---|---|
 * | `install` (§09.2) | **none** — it only warms the cache |
 * | `install -g` (§09.3) | set **unconditionally**, even downgrading across majors |
 * | `install -g --cache-only` | none |
 * | `pack` (§09.6) | set, deliberately: you pack what you intend to run |
 * | `hydrate` | only with `--activate` (opt-*in*, §09.10) |
 *
 * This is not §04.7's guarded bump — no "same major", no "strictly upward", no
 * "only if an entry already exists". `install -g yarn@1.0.0` makes 1.0.0 the
 * default even when the current default is 4.x.
 */
function setLastKnownGood(name: string, reference: string): void {
  const lkg = readLastKnownGood();
  lkg[name] = reference;
  // Swallows `EROFS` itself (§07.8): recording a default must never fail a run.
  writeLastKnownGood(lkg);
}

/**
 * §07.6 step 3 — the reference that goes into `package.json` and the store's
 * bookkeeping, carrying the hash of the bytes we actually have.
 *
 * `ensureInstalled` rewrites `locator.reference` on the download path, but the
 * warm path returns from the `.corepack` marker without touching it, so the hash
 * has to be re-attached here. Composing it from `parse().version` (rather than
 * appending) also makes it idempotent: a reference that already carries a suffix
 * never grows a second one.
 */
function referenceWithHash(locator: Locator, spec: InstallSpec): string {
  const parsed = parse(locator.reference);
  // A URL reference keeps its own `#algo.digest` notation and is never rewritten.
  return parsed === null ? locator.reference : `${parsed.version}+${spec.hash}`;
}

/**
 * §08.1 — the package manager spec's **download URL**, with `{}` substituted.
 *
 * `exec.ts` needs the whole URL, not just its extension: a `bin` *list* resolves
 * to `<location>/<basename of the URL path>`.
 */
function getSpecUrl(name: string, version: string): string {
  return getSpecFor(name, version).url.replace("{}", version);
}

function fileStream(path: string): ReadableStream<Uint8Array> {
  return Readable.toWeb(createReadStream(path)) as unknown as ReadableStream<Uint8Array>;
}

/** The tool's own version (§09.9), read from the manifest next to our sources. */
function getOwnVersion(): string {
  // Both layouts are one level below the package root — `<root>/src/cli.ts` from
  // source, `<root>/dist/index.mjs` once bundled.
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  try {
    const raw = readFileSync(join(root, "package.json"), "utf8");
    const data = JSON.parse(raw) as { version?: unknown };
    if (typeof data.version === "string") return data.version;
  } catch {
    // A package without a readable manifest still answers `--version`.
  }
  return "0.0.0";
}

/* -------------------------------------------------------------------------- */
/* Argument parsing                                                            */
/* -------------------------------------------------------------------------- */

interface ArgSpec {
  booleans?: string[];
  strings?: string[];
  /** §09.10 — flags whose value may be omitted (`prepare --output`). */
  optional?: string[];
}

interface ParsedArgs {
  flags: Set<string>;
  values: Map<string, string>;
  positionals: string[];
}

/**
 * A deliberately tiny parser: `--flag`, `--flag value`, `--flag=value`, `-o
 * value`, `-o=value`, and `--` to end option parsing. Anything unrecognised is a
 * usage error rather than a silently-ignored typo.
 */
function parseArgs(args: string[], spec: ArgSpec): ParsedArgs {
  const booleans = new Set(spec.booleans ?? []);
  const optional = new Set(spec.optional ?? []);
  const strings = new Set([...(spec.strings ?? []), ...optional]);

  const flags = new Set<string>();
  const values = new Map<string, string>();
  const positionals: string[] = [];
  let literal = false;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;

    if (literal || arg === "-" || !arg.startsWith("-")) {
      positionals.push(arg);
      continue;
    }
    if (arg === "--") {
      literal = true;
      continue;
    }

    const equals = arg.indexOf("=");
    const name = equals === -1 ? arg : arg.slice(0, equals);

    if (equals === -1 && booleans.has(name)) {
      flags.add(name);
      continue;
    }

    if (strings.has(name)) {
      if (equals !== -1) {
        values.set(name, arg.slice(equals + 1));
        continue;
      }
      // An optional-value flag only ever takes its value through `=`: with the
      // space form there is no way to tell `prepare --output yarn@1` (a bare
      // flag plus a spec) from an output path.
      if (optional.has(name)) {
        flags.add(name);
        continue;
      }
      const next = args[index + 1];
      if (next !== undefined && (next === "-" || !next.startsWith("-"))) {
        values.set(name, next);
        index++;
        continue;
      }
      throw new UsageError(`Option "${name}" requires a value`);
    }

    throw new UsageError(`Unsupported option name ("${arg}")`);
  }

  return { flags, values, positionals };
}

function firstValue(parsed: ParsedArgs, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = parsed.values.get(name);
    if (value !== undefined) return value;
  }
  return undefined;
}

function hasFlag(parsed: ParsedArgs, ...names: string[]): boolean {
  return names.some((name) => parsed.flags.has(name));
}

/* -------------------------------------------------------------------------- */
/* §09.1 — pattern resolution                                                  */
/* -------------------------------------------------------------------------- */

/**
 * §09.1 — shared by `install`, `pack`, `up`, and `use`.
 *
 * With patterns, only the env file is loaded (§03.2 `envOnly`). Without them the
 * project is consulted, and `lookup.range ?? lookup.getSpec()` prefers a
 * declared devEngines range over the exact pin — which is what lets `up` follow
 * a range across majors.
 *
 * The messages say "to pack" in all four commands. That is a copy-paste artefact
 * in the reference implementation and §14.14 recommends fixing it, but the
 * strings are matched by real-world scripts and CI, so this project keeps them
 * byte-compatible and does **not** apply that divergence.
 */
export function resolvePatternsToDescriptors(patterns: string[]): Descriptor[] {
  return resolveDescriptorsFrom(patterns, false);
}

/**
 * The one behavioural difference the deprecated `prepare` has here: its "no
 * spec" error predates `devEngines` and never mentions it (§09.10).
 */
function resolveDescriptorsFrom(patterns: string[], legacy: boolean): Descriptor[] {
  const cwd = process.cwd();

  if (patterns.length > 0) {
    // Explicit patterns mean the project is irrelevant — but the env file is
    // not, because it can carry the registry and network settings the
    // resolution below needs.
    discoverProjectSpec(cwd, { envOnly: true });
    return patterns.map((pattern) =>
      parseSpec(pattern, CLI_SOURCE, { enforceExactVersion: false }),
    );
  }

  const lookup = discoverProjectSpec(cwd);
  switch (lookup.type) {
    case "NoProject": {
      throw new UsageError(messages.couldntFindProject());
    }
    case "NoSpec": {
      throw new UsageError(legacy ? messages.noSpecInProjectLegacy() : messages.noSpecInProject());
    }
    case "Found": {
      // `lookup.range` first: a declared `devEngines.packageManager.version`
      // outranks the exact `packageManager` pin, which is what makes `corepack
      // up` follow a declared range across a major boundary (§09.4).
      //
      // `enforceExactVersion: false` because these commands legitimately accept
      // a range-valued pin — §09.4's own error message says "a semver version or
      // semver range", and that check is only reachable if parsing got this far.
      return [lookup.range ?? lookup.getSpec({ enforceExactVersion: false })];
    }
  }
}

/* -------------------------------------------------------------------------- */
/* §09.2 — install                                                             */
/* -------------------------------------------------------------------------- */

/** §09.2 — cache the project's package manager. Does **not** touch last-known-good. */
export async function cmdInstall(args: string[]): Promise<number> {
  const parsed = parseArgs(args, {});
  if (parsed.positionals.length > 0) {
    throw new UsageError(
      `The 'corepack install' command takes no arguments; use 'corepack install -g <name>@<version>' to install one globally`,
    );
  }

  const [descriptor] = resolvePatternsToDescriptors([]);
  const locator = await resolveOrThrow(descriptor!, { allowTags: true });

  out(`${messages.addingToCache(locator.name, locator.reference)}\n`);
  await ensureInstalled(locator);

  // Deliberately nothing else: the global default is unchanged, so warming a
  // Docker layer cannot silently repoint the machine's default (§09.2).
  return 0;
}

/* -------------------------------------------------------------------------- */
/* §09.3 — install -g                                                          */
/* -------------------------------------------------------------------------- */

/** §09.3 — sets last-known-good **unconditionally**, unlike §04.7's guarded bump. */
export async function cmdInstallGlobal(args: string[]): Promise<number> {
  const parsed = parseArgs(args, { booleans: ["-g", "--global", "--cache-only"] });
  const cacheOnly = hasFlag(parsed, "--cache-only");

  if (parsed.positionals.length === 0) {
    throw new UsageError(
      `The 'corepack install -g' command requires at least one package manager or archive`,
    );
  }

  for (const target of parsed.positionals) {
    // §09.3 — an archive argument is anything ending in `.tgz`; everything else
    // is a spec.
    if (target.endsWith(".tgz")) {
      await installFromArchive(target, { activate: !cacheOnly, format: "pack" });
      continue;
    }

    const descriptor = parseSpec(target, CLI_SOURCE, { enforceExactVersion: false });
    const locator = await resolveOrThrow(descriptor, { allowTags: true });

    out(
      `${
        cacheOnly
          ? messages.addingToCache(locator.name, locator.reference)
          : messages.installing(locator.name, locator.reference)
      }\n`,
    );

    const spec = await ensureInstalled(locator, { cacheOnly });
    if (!cacheOnly) setLastKnownGood(locator.name, referenceWithHash(locator, spec));
  }

  return 0;
}

/* -------------------------------------------------------------------------- */
/* §07.10 — portable archives                                                  */
/* -------------------------------------------------------------------------- */

/**
 * §07.10 — validate that the archive came from `pack` before touching anything.
 *
 * Only entries whose **last** path segment is the `.corepack` marker are
 * considered; anything shorter than `<name>/<version>/.corepack` poisons the
 * whole archive. This guards against passing the wrong tarball by accident — it
 * is **not** a security boundary, which is why the extraction below still runs
 * through §07.4's rules with nothing relaxed.
 */
async function readArchiveEntries(
  filePath: string,
  format: "pack" | "prepare",
): Promise<Map<string, Set<string>>> {
  const found = new Map<string, Set<string>>();
  let hasShortEntries = false;

  for (const entry of await listEntries(fileStream(filePath))) {
    const segments = entry.path.split("/");
    if (segments[segments.length - 1] !== MARKER_NAME) continue;

    if (segments.length < 3) {
      hasShortEntries = true;
      continue;
    }

    const name = segments[0]!;
    const reference = segments[1]!;
    let references = found.get(name);
    if (references === undefined) {
      references = new Set();
      found.set(name, references);
    }
    references.add(reference);
  }

  if (hasShortEntries || found.size === 0) {
    throw new UsageError(messages.invalidArchiveFormat(format));
  }

  for (const name of found.keys()) {
    if (!isSupportedPackageManager(name)) {
      throw new UsageError(messages.unsupportedPackageManagerName(name));
    }
  }

  return found;
}

/**
 * Extract into a temp folder **inside** the install tree, then promote each
 * validated `<name>/<version>` subtree with the same atomic rename the download
 * path uses (§07.5). Only validated subtrees are promoted, so an archive
 * carrying extra entries never contributes anything to the store.
 */
async function installFromArchive(
  file: string,
  options: { activate: boolean; format: "pack" | "prepare" },
): Promise<void> {
  const filePath = resolvePath(process.cwd(), file);
  const found = await readArchiveEntries(filePath, options.format);

  const installFolder = getInstallFolder();
  const tmp = createTempDir();
  try {
    // `strip: 0` — the archive is rooted at `<installFolder>` already (§07.10).
    await extract(fileStream(filePath), tmp, { strip: 0 });

    for (const [name, references] of found) {
      for (const reference of references) {
        out(
          `${
            options.activate
              ? messages.installing(name, reference)
              : messages.addingToCache(name, reference)
          }\n`,
        );
        promote(join(tmp, name, reference), join(installFolder, name, reference));
        if (options.activate) setLastKnownGood(name, reference);
      }
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/* -------------------------------------------------------------------------- */
/* §09.4 — up                                                                  */
/* -------------------------------------------------------------------------- */

/** §09.4 — the two-step resolve is what confines the update to the current major line. */
export async function cmdUp(args: string[]): Promise<number> {
  const parsed = parseArgs(args, {});
  if (parsed.positionals.length > 0) {
    throw new UsageError(`The 'corepack up' command takes no arguments`);
  }

  const [descriptor] = resolvePatternsToDescriptors([]);
  const { name, range } = descriptor!;

  if (!isValidVersion(range) && !isValidRange(range)) {
    throw new UsageError(messages.upNotSemver());
  }

  // Both resolves pass `useCache: false`: with the cache consulted they would
  // return the already-installed version and `up` would never update anything.
  // Tags are **not** allowed here — `up` follows semver, not a channel.
  const resolved = await resolveOrThrow({ name, range }, { useCache: false });

  // The second step is what confines the update to one major line. Note the
  // interaction with §09.1: when the descriptor came from a `devEngines` range
  // spanning majors, step one has already crossed the boundary and this pins the
  // major it landed in.
  const line = major(resolved.reference);
  const highest = await resolveDescriptor({ name, range: `^${line}.0.0` }, { useCache: false });
  if (highest === null) throw new UsageError(messages.upNoHighest(name, line));

  return pinToProject(highest);
}

/* -------------------------------------------------------------------------- */
/* §09.5 — use                                                                 */
/* -------------------------------------------------------------------------- */

/** §09.5 — writes the pin, then runs the package manager's `use` command. */
export async function cmdUse(args: string[]): Promise<number> {
  const parsed = parseArgs(args, {});
  const [pattern, ...extra] = parsed.positionals;
  if (pattern === undefined) {
    throw new UsageError(`The 'corepack use' command requires a package manager pattern`);
  }
  if (extra.length > 0) {
    throw new UsageError(`The 'corepack use' command accepts a single package manager pattern`);
  }

  const descriptor = parseSpec(pattern, CLI_SOURCE, { enforceExactVersion: false });
  // `useCache: false`: `corepack use yarn@stable` must ask what stable means
  // today, not what is lying around in the store.
  const resolved = await resolveOrThrow(descriptor, { allowTags: true, useCache: false });

  return pinToProject(resolved);
}

/**
 * The shared tail of `use` (§09.5) and `up` (§09.4).
 *
 * Order is observable and test-asserted: the banner reaches stdout **before**
 * the install and before `writePin`'s devEngines check, so a mismatch surfaces
 * underneath a banner that has already been printed (test 110).
 */
async function pinToProject(locator: Locator): Promise<number> {
  out(`${messages.installingInProject(locator.name, locator.reference)}\n`);

  const spec = await ensureInstalled(locator);
  const reference = referenceWithHash(locator, spec);

  // §03.7 — may throw a `UsageError` through `warnOrThrow`; the banner above is
  // already on stdout, which is exactly what §09.5 describes.
  const { previousPackageManager } = writePin(process.cwd(), { name: locator.name, reference });

  const parsed = parse(reference);
  // A URL reference has no table band, so it has no `commands.use` either.
  const useCommand =
    parsed === null || !isSupportedPackageManager(locator.name)
      ? undefined
      : getSpecFor(locator.name, parsed.version).commands?.use;

  if (useCommand === undefined || useCommand.length === 0) return 0;

  // §09.5 — what the package manager's own `use` command is told to migrate
  // from; the literal `unknown` when the project had no previous value.
  process.env.COREPACK_MIGRATE_FROM = previousPackageManager;
  out(`\n`);

  // From here the package manager owns the process and its output is passed
  // through untouched (§09.11).
  execPackageManager(
    useCommand[0]!,
    spec,
    useCommand.slice(1),
    getSpecUrl(locator.name, parsed!.version),
  );

  return 0;
}

/* -------------------------------------------------------------------------- */
/* §09.6 — pack                                                                */
/* -------------------------------------------------------------------------- */

/** §09.6 — a copy of cache subtrees, not a repackaging. Does update last-known-good. */
export async function cmdPack(args: string[]): Promise<number> {
  const parsed = parseArgs(args, { booleans: ["--json"], strings: ["-o", "--output"] });
  const json = hasFlag(parsed, "--json");

  const descriptors = resolvePatternsToDescriptors(parsed.positionals);
  const locations: string[] = [];

  for (const descriptor of descriptors) {
    const locator = await resolveOrThrow(descriptor, { allowTags: true });
    // §09.6 puts every human-readable line behind the `--json` branch, so a
    // machine consumer gets the output path and nothing else.
    if (!json) out(`${messages.addingToCache(locator.name, locator.reference)}\n`);

    const spec = await ensureInstalled(locator);
    locations.push(spec.location);

    // §09.6 — `pack` updates last-known-good as a side effect, intentionally:
    // you pack what you intend to run.
    setLastKnownGood(locator.name, referenceWithHash(locator, spec));
  }

  const output = resolvePath(
    process.cwd(),
    firstValue(parsed, "-o", "--output") ?? DEFAULT_ARCHIVE_NAME,
  );
  await writeArchive(locations, output, json);
  return 0;
}

/** §07.10 — a gzip tar rooted at `<installFolder>`, markers included. */
async function writeArchive(locations: string[], output: string, json: boolean): Promise<void> {
  const installFolder = getInstallFolder();
  if (!json) out(`Packing the selected tools in ${basename(output)}...\n`);

  await create(
    installFolder,
    locations.map((location) => relative(installFolder, location)),
    output,
  );

  if (json) out(`${JSON.stringify(output)}\n`);
  else out(`${messages.allDone()}\n`);
}

/* -------------------------------------------------------------------------- */
/* §09.7 — cache                                                               */
/* -------------------------------------------------------------------------- */

/** §09.7 — `clean` and `clear` are the same command. */
export async function cmdCache(args: string[]): Promise<number> {
  const parsed = parseArgs(args, {});
  const [subcommand, ...extra] = parsed.positionals;

  if ((subcommand !== "clean" && subcommand !== "clear") || extra.length > 0) {
    throw new UsageError(`The 'corepack cache' command only accepts 'clean' or 'clear'`);
  }

  // `rm -rf <home>/v1`, forced; `lastKnownGood.json` lives outside `v1` and
  // therefore survives, so the recorded default is simply re-downloaded.
  cacheClean();
  return 0;
}

/* -------------------------------------------------------------------------- */
/* §09.10 — deprecated commands                                                */
/* -------------------------------------------------------------------------- */

/** §09.10 — deprecated, retained for compatibility. */
export async function cmdHydrate(args: string[]): Promise<number> {
  const parsed = parseArgs(args, { booleans: ["--activate"] });
  const [file, ...extra] = parsed.positionals;

  if (file === undefined || extra.length > 0) {
    throw new UsageError(`The 'corepack hydrate' command requires exactly one archive`);
  }

  // Three differences from `install -g <file>.tgz`: no `.tgz` extension check,
  // the format error names `'corepack prepare'`, and activation is opt-**in**.
  await installFromArchive(file, {
    activate: hasFlag(parsed, "--activate"),
    format: "prepare",
  });

  out(`${messages.allDone()}\n`);
  return 0;
}

export async function cmdPrepare(args: string[]): Promise<number> {
  const parsed = parseArgs(args, {
    booleans: ["--activate", "--all", "--json"],
    optional: ["-o", "--output"],
  });
  const activate = hasFlag(parsed, "--activate");
  const json = hasFlag(parsed, "--json");

  if (hasFlag(parsed, "--all") && parsed.positionals.length > 0) {
    throw new UsageError(
      `The --all option cannot be used along with an explicit package manager specification`,
    );
  }

  const descriptors = hasFlag(parsed, "--all")
    ? SUPPORTED_NAMES.map((name) => ({ name, range: "*" }))
    : // §09.10 — the legacy "no spec" error omits the `devEngines` mention.
      resolveDescriptorsFrom(parsed.positionals, true);

  const locations: string[] = [];
  for (const descriptor of descriptors) {
    const locator = await resolveOrThrow(descriptor, { allowTags: true });

    if (!json) {
      out(
        `${
          activate
            ? messages.installing(locator.name, locator.reference)
            : messages.addingToCache(locator.name, locator.reference)
        }\n`,
      );
    }

    const spec = await ensureInstalled(locator, { cacheOnly: !activate });
    locations.push(spec.location);
    if (activate) setLastKnownGood(locator.name, referenceWithHash(locator, spec));
  }

  // §09.10 — `--output` tolerates a bare flag, defaulting to `corepack.tgz`.
  const output = firstValue(parsed, "-o", "--output");
  const bare = hasFlag(parsed, "-o", "--output");
  if (output !== undefined || bare) {
    await writeArchive(locations, resolvePath(process.cwd(), output ?? DEFAULT_ARCHIVE_NAME), json);
  }

  return 0;
}

/* -------------------------------------------------------------------------- */
/* §09.9 — --version, --help                                                   */
/* -------------------------------------------------------------------------- */

function cmdVersion(): Promise<number> {
  out(`${getOwnVersion()}\n`);
  return Promise.resolve(0);
}

function cmdHelp(): Promise<number> {
  out(HELP_TEXT);
  return Promise.resolve(0);
}

/* -------------------------------------------------------------------------- */
/* Dispatch                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * §09 — dispatch a management-mode invocation and return its exit code.
 *
 * A `UsageError` deliberately propagates: `main.ts` owns §12.1's presentation
 * (stdout, `Usage Error: `, a blank line, then {@link USAGE_LINES}'s entry for
 * the command word).
 */
export async function runManagementCommand(args: string[]): Promise<number> {
  const [command, ...rest] = args;

  switch (command) {
    case undefined:
    case "help":
    case "-h":
    case "--help": {
      return cmdHelp();
    }
    case "--version": {
      return cmdVersion();
    }
    case "cache": {
      return cmdCache(rest);
    }
    case "enable": {
      // Imported lazily: §10's shim machinery is only ever reached by these two
      // commands, and nothing else in the surface should pay to load it.
      return import("./shims.ts").then(({ cmdEnable }) => cmdEnable(rest));
    }
    case "disable": {
      return import("./shims.ts").then(({ cmdDisable }) => cmdDisable(rest));
    }
    case "install": {
      // `-g`/`--global` selects a different command, not a different flag.
      return rest.includes("-g") || rest.includes("--global")
        ? cmdInstallGlobal(rest)
        : cmdInstall(rest);
    }
    case "pack": {
      return cmdPack(rest);
    }
    case "up": {
      return cmdUp(rest);
    }
    case "use": {
      return cmdUse(rest);
    }
    case "hydrate": {
      return cmdHydrate(rest);
    }
    case "prepare": {
      return cmdPrepare(rest);
    }
    default: {
      throw new UsageError(`Unknown command "${command}"`);
    }
  }
}
