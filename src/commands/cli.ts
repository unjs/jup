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

import { createReadStream } from "node:fs";
import { rm } from "node:fs/promises";
import { basename, dirname, join, relative, resolve as resolvePath } from "node:path";
import { Readable } from "node:stream";
import { ENV, writeEnv } from "../config/env-vars.ts";
import {
  getTableSpec,
  isPerHost,
  isSupportedPackageManager,
  resolveSpecBin,
  SUPPORTED_NAMES,
} from "../config/table.ts";
import { isFrozenLockfile } from "../project/env.ts";
import { explainFetchFailure, messages, UsageError } from "../errors-cold.ts";
import { execPackageManager } from "../run/exec.ts";
import { ensureInstalled } from "../cache/install.ts";
import {
  LOCKFILE_NAME,
  readResolution,
  removeResolution,
  resolutionKey,
  usesLockfile,
  writeResolution,
} from "../project/lockfile.ts";
import { CLI_SOURCE, discoverProjectSpec, parseSpec } from "../project/manifest.ts";
import { type PinStyle, writePin } from "../project/pin.ts";
import { resolveDescriptor, type ResolveOptions } from "../version/resolve.ts";
import { isValidRange, isValidVersion, major, parse } from "../version/semver.ts";
import {
  cacheClean,
  createTempDir,
  getHomeFolder,
  getInstallFolder,
  listInstalled,
  MARKER_NAME,
  promote,
  readLastKnownGood,
  referenceWithHash,
  writeLastKnownGood,
} from "../cache/store.ts";
import { create, extract, listEntries } from "../cache/tar.ts";
import type { Descriptor, InstallSpec, Locator, SpecResult } from "../types.ts";

/** §09.6 — the default `pack` output, relative to the cwd. */
const DEFAULT_ARCHIVE_NAME = "jup.tgz";

import { HELP_TEXT } from "./usage.ts";
import { getOwnVersion } from "../utils/self.ts";

/* -------------------------------------------------------------------------- */
/* Small shared helpers                                                        */
/* -------------------------------------------------------------------------- */

/** §09.11 — informational output is stdout, unbuffered, unprefixed. */
function out(text: string): void {
  process.stdout.write(text);
}

async function resolveOrThrow(descriptor: Descriptor, options: ResolveOptions): Promise<Locator> {
  let locator: Locator | null;
  try {
    locator = await resolveDescriptor(descriptor, options);
  } catch (error) {
    // §15.19 — with the network off, "can't reach <url>" is the least useful
    // thing to say; name the package manager and the command that seeds it.
    throw explainFetchFailure(error, descriptor) ?? error;
  }
  if (locator === null) {
    // The range the *user* wrote, not whatever a tag expanded to (§12.4).
    throw new UsageError(messages.failedToResolve(descriptor.range, descriptor.name));
  }
  return locator;
}

/**
 * `ensureInstalled`, with §15.19's and §15.35j's diagnostics attached.
 *
 * `range` is what the *user* wrote, so an airgapped failure names something they
 * can paste back into `corepack install -g --cache-only`; the version comes from
 * the locator, because that is the thing the registry says does not exist.
 */
async function installOrExplain(
  locator: Locator,
  range: string,
  options?: { cacheOnly?: boolean },
): Promise<InstallSpec> {
  try {
    return await ensureInstalled(locator, options);
  } catch (error) {
    const version = parse(locator.reference)?.version;
    const what = { name: locator.name, range, ...(version === undefined ? {} : { version }) };
    throw explainFetchFailure(error, what) ?? error;
  }
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

function fileStream(path: string): ReadableStream<Uint8Array> {
  return Readable.toWeb(createReadStream(path)) as unknown as ReadableStream<Uint8Array>;
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
    return patterns.map((pattern) => parseSpec(pattern, CLI_SOURCE, { requireVersion: false }));
  }

  return [resolveProjectSpec(legacy).descriptor];
}

/**
 * The project's own spec, plus the lookup that produced it.
 *
 * `up` needs both halves: the descriptor to resolve, and the lookup to tell a
 * declared `packageManager` range (which §15.23 refreshes in `.jup.lock`)
 * from a spec synthesised out of `devEngines` (which row 114 turns into a pin).
 */
function resolveProjectSpec(
  legacy: boolean,
  options?: { mutating?: boolean; here?: boolean },
): {
  descriptor: Descriptor;
  lookup: Extract<SpecResult, { type: "Found" }>;
} {
  // §15.27 — a command that is about to *write* must read the spec from the file
  // it will write, or `up` refreshes one manifest and pins another.
  const lookup = discoverProjectSpec(process.cwd(), options);
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
      // `requireVersion: false` because these commands legitimately accept
      // a range-valued pin — §09.4's own error message says "a semver version or
      // semver range", and that check is only reachable if parsing got this far.
      return { descriptor: lookup.range ?? lookup.getSpec({ requireVersion: false }), lookup };
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
      `The 'jup install' command takes no arguments; use 'jup install -g <name>@<version>' to install one globally`,
    );
  }

  const { descriptor, lookup } = resolveProjectSpec(false);

  // §15.23 — warm the cache with the version the project will actually run.
  // `install` exists to fill a Docker layer, and resolving a range afresh here
  // can legitimately answer something newer than `.jup.lock` records — which
  // would cache one version and then run another, offline, in the layer that has
  // no network to fix it with. The recorded resolution is consulted under the
  // same key the proxy path uses: the pin itself, not the `devEngines` range that
  // §09.1 lets outrank it for `up`.
  const pinned = lookup.getSpec({ requireVersion: false });
  const recorded = usesLockfile(pinned) ? readResolution(dirname(lookup.target), pinned) : null;

  const locator = recorded ?? (await resolveOrThrow(descriptor, { allowTags: true }));

  out(`${messages.addingToCache(locator.name, locator.reference)}\n`);
  // `cacheOnly` suppresses §04.7's guarded last-known-good bump.
  //
  // The spec contradicts itself here: §04.7 bumps after *any* successful install
  // of a supported version (and corepack does bump on this path), while §09.2
  // says `install` "does not touch `lastKnownGood.json` — the global default is
  // unchanged". §09.2 is the specific, command-scoped statement, so it wins over
  // the general rule: warming a Docker layer must not silently repoint the
  // machine's default.
  await installOrExplain(locator, descriptor.range, { cacheOnly: true });

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
      `The 'jup install -g' command requires at least one package manager or archive`,
    );
  }

  for (const target of parsed.positionals) {
    // §09.3 — an archive argument is anything ending in `.tgz`; everything else
    // is a spec.
    if (target.endsWith(".tgz")) {
      await installFromArchive(target, { activate: !cacheOnly, format: "pack" });
      continue;
    }

    const descriptor = parseSpec(target, CLI_SOURCE, { requireVersion: false });
    const locator = await resolveOrThrow(descriptor, { allowTags: true });

    out(
      `${
        cacheOnly
          ? messages.addingToCache(locator.name, locator.reference)
          : messages.installing(locator.name, locator.reference)
      }\n`,
    );

    const spec = await installOrExplain(locator, descriptor.range, { cacheOnly });
    if (!cacheOnly)
      setLastKnownGood(locator.name, referenceWithHash(locator.name, locator.reference, spec.hash));
  }

  return 0;
}

/* -------------------------------------------------------------------------- */
/* §07.10 — portable archives                                                  */
/* -------------------------------------------------------------------------- */

/**
 * §07.10 — validate that the archive came from `pack` before touching anything.
 *
 * Only entries whose **last** path segment is the `.jup` marker are
 * considered; anything shorter than `<name>/<version>/.jup` poisons the
 * whole archive. This guards against passing the wrong tarball by accident — it
 * is **not** a security boundary, which is why the extraction below still runs
 * through §07.4's rules with nothing relaxed.
 */
async function readArchiveEntries(
  filePath: string,
  format: "pack" | "prepare",
): Promise<Map<string, Set<string>>> {
  const found = new Map<string, Set<string>>();
  let hasInvalidEntries = false;

  for (const entry of await listEntries(fileStream(filePath))) {
    const segments = entry.path.split("/");
    if (segments[segments.length - 1] !== MARKER_NAME) continue;

    if (segments.length < 3) {
      hasInvalidEntries = true;
      continue;
    }

    const name = segments[0]!;
    const reference = segments[1]!;

    // §07.10's algorithm records `segments[0]` and `segments[1]` verbatim, and
    // neither it nor corepack validates them — but they are then used as path
    // components *and* written to `lastKnownGood.json`. `<name>/./.jup`
    // survives the extractor (`join` folds the `.` away), so `promote` operates
    // on `<name>` and the recorded default becomes the literal `"."`, which
    // every later spec-less run classifies as a dist-tag and takes to the
    // network. `cache clean` spares that file by design, so only a hand edit
    // undoes it. Treat an implausible segment exactly like a short entry: this
    // archive did not come from `pack`.
    if (!isPlausibleSegment(name) || !isPlausibleSegment(reference)) {
      hasInvalidEntries = true;
      continue;
    }
    let references = found.get(name);
    if (references === undefined) {
      references = new Set();
      found.set(name, references);
    }
    references.add(reference);
  }

  if (hasInvalidEntries || found.size === 0) {
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
 * A single path component that can stand for a package manager name or a store
 * reference: non-empty, not a relative-path marker, and carrying nothing a path
 * join could reinterpret. (`..` is already caught by the extractor; `.` is not,
 * because it simply disappears.)
 */
function isPlausibleSegment(segment: string): boolean {
  return (
    segment.length > 0 &&
    segment !== "." &&
    segment !== ".." &&
    !segment.includes("\\") &&
    !segment.includes("\0")
  );
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
  const parsed = parseArgs(args, { booleans: ["--here"], strings: ["--pin-style"] });
  if (parsed.positionals.length > 0) {
    throw new UsageError(`The 'jup up' command takes no arguments`);
  }

  // §15.27 — `--here` reads and writes `cwd`'s own manifest, ignoring the walk.
  const here = hasFlag(parsed, "--here");
  const pinStyle = readPinStyle(parsed);
  const { descriptor, lookup } = resolveProjectSpec(false, { mutating: true, here });
  const { name, range } = descriptor;

  if (!isValidVersion(range) && !isValidRange(range)) {
    throw new UsageError(messages.upNotSemver());
  }

  // §15.23 — when the `packageManager` field itself holds a range, that range is
  // the user's statement of intent and `up` must not overwrite it with a version:
  // what it refreshes is the recorded resolution. A pin synthesised from
  // `devEngines` is a different case and still becomes a real pin (row 114).
  const pin = lookup.hasPin === true ? lookup.getSpec({ requireVersion: false }) : undefined;
  if (pin !== undefined && usesLockfile(pin)) {
    if (!isValidRange(pin.range)) {
      // A dist-tag pin. §09.4 has always refused these, and recording a tag's
      // current expansion is `use`'s job, not `up`'s.
      throw new UsageError(messages.upNotSemver());
    }
    if (isFrozenLockfile({ refresh: true })) {
      throw new UsageError(messages.lockfileUnresolved(pin.name, pin.range));
    }

    // No second, major-confining resolve here: for an exact pin that step is what
    // keeps `up` inside the current major, but a declared range already says how
    // far the user is willing to move — and `^2.0.0` derived from a `~2.1.0` pin
    // would pick a version the range itself rejects, which the next run would
    // then discard as unsatisfying.
    const refreshed = await resolveOrThrow(pin, { useCache: false });
    const dir = dirname(lookup.target);
    return applyToProject(refreshed, (reference, spec) => {
      writeResolution(dir, pin, { name: pin.name, reference }, spec.hash, isPerHost(refreshed));
      // §15.35l — the resolution file is what changed, so that is what is named.
      out(`${messages.updatedManifest(join(dir, LOCKFILE_NAME), pin.name, reference)}\n`);
      // The field is unchanged, so that is what the package manager migrates from.
      return `${pin.name}@${pin.range}`;
    });
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
  const target = { name, range: `^${line}.0.0` };
  let highest: Locator | null;
  try {
    highest = await resolveDescriptor(target, { useCache: false });
  } catch (error) {
    // §15.19 — this second resolve is the one that reaches the registry for an
    // exactly-pinned project, so leaving it unwrapped left `corepack up` on an
    // airgapped machine reporting a URL instead of the seeding command. Found
    // against the built binary; the source-level rows all resolve at step one.
    throw explainFetchFailure(error, target) ?? error;
  }
  if (highest === null) throw new UsageError(messages.upNoHighest(name, line));

  return pinToProject(highest, { here, pinStyle });
}

/* -------------------------------------------------------------------------- */
/* §09.5 — use                                                                 */
/* -------------------------------------------------------------------------- */

/** §09.5 — writes the pin, then runs the package manager's `use` command. */
export async function cmdUse(args: string[]): Promise<number> {
  const parsed = parseArgs(args, { booleans: ["--here"], strings: ["--pin-style"] });
  const [pattern, ...extra] = parsed.positionals;
  if (pattern === undefined) {
    throw new UsageError(`The 'jup use' command requires a package manager pattern`);
  }
  if (extra.length > 0) {
    throw new UsageError(`The 'jup use' command accepts a single package manager pattern`);
  }

  // Read before anything is resolved or downloaded: see {@link readPinStyle}.
  const pinStyle = readPinStyle(parsed);

  const descriptor = parseSpec(pattern, CLI_SOURCE, { requireVersion: false });
  // `useCache: false`: `corepack use yarn@stable` must ask what stable means
  // today, not what is lying around in the store.
  const resolved = await resolveOrThrow(descriptor, { allowTags: true, useCache: false });

  // §15.27 — `--here` mutates `cwd`'s own manifest, creating it if absent.
  return pinToProject(resolved, { here: hasFlag(parsed, "--here"), pinStyle });
}

/**
 * The shared tail of `use` (§09.5) and `up` (§09.4).
 *
 * Order is observable and test-asserted: the banner reaches stdout **before**
 * the install and before `writePin`'s devEngines check, so a mismatch surfaces
 * underneath a banner that has already been printed (test 110).
 *
 * `record` is what the command does with the installed version — write the pin,
 * or (§15.23) refresh the recorded resolution — and returns the value
 * `COREPACK_MIGRATE_FROM` carries into the package manager's own `use` command.
 */
async function applyToProject(
  locator: Locator,
  record: (reference: string, spec: InstallSpec) => string,
): Promise<number> {
  out(`${messages.installingInProject(locator.name, locator.reference)}\n`);

  const spec = await installOrExplain(locator, locator.reference);
  // §15.28 — `referenceWithHash` declines to attach a per-host digest, so what
  // goes into `packageManager` is a bare version for bun and deno.
  const reference = referenceWithHash(locator.name, locator.reference, spec.hash);

  // §03.7 — may throw a `UsageError` through `warnOrThrow`; the banner above is
  // already on stdout, which is exactly what §09.5 describes.
  const previousPackageManager = record(reference, spec);

  // A URL reference has no table band, so it has no `commands.use` either.
  const pinned: Locator = { name: locator.name, reference };
  const tableSpec = getTableSpec(pinned);
  const useCommand = tableSpec?.commands?.use;

  if (useCommand === undefined || useCommand.length === 0) return 0;

  // §09.5 — what the package manager's own `use` command is told to migrate
  // from; the literal `unknown` when the project had no previous value.
  writeEnv(ENV.MIGRATE_FROM, previousPackageManager);
  out(`\n`);

  // From here the package manager owns the process and its output is passed
  // through untouched (§09.11). §15.28's native path is the one that has an exit
  // code to hand back here; the JavaScript path answers 0 and sets the real one
  // itself, later (§08.4).
  return await execPackageManager(
    useCommand[0]!,
    spec,
    useCommand.slice(1),
    // §08.1 — `installSpec.bin ?? spec.bin`; the marker may carry no `bin`.
    // §15.28 — `{exe}`-substituted, per `resolveSpecBin`.
    tableSpec === undefined ? undefined : resolveSpecBin(tableSpec),
    tableSpec?.exec,
  );
}

/** §09.5 / §03.7 — write the exact pin, and retire the range it replaced. */
function pinToProject(
  locator: Locator,
  options?: { here?: boolean; pinStyle?: PinStyle },
): Promise<number> {
  // §15.28 — a native package manager's artifact differs per host, so its digest
  // is not a portable fact and must not be written into a file people commit: a
  // Linux-pinned `bun@1.4.0+sha512.…` fails on a colleague's Mac with a hash
  // mismatch, which is the one outcome a pin exists to prevent. The version is
  // still pinned exactly; what stands in for the digest is npm's signature over
  // the host's own artifact (§06.3, checked on every install), plus §15.23's
  // per-host record in `.jup.lock` for the hosts that have actually run.
  const perHost = isPerHost(locator);

  return applyToProject(locator, (reference, spec) => {
    const { previousPackageManager, target, written } = writePin(
      process.cwd(),
      { name: locator.name, reference, hash: perHost ? undefined : spec.hash },
      options,
    );

    // §15.27, §15.35l — name the file. The whole "corepack edited a manifest I
    // did not expect" class (#607) is a walk the user could not see, and this is
    // the line that makes it visible; it prints *after* the write, so it can
    // never claim a change that did not happen.
    // §15.12 — `written`, not `reference`: under `--pin-style=sidecar` the field
    // holds a clean version and the digest lives beside it, and a line claiming
    // otherwise would name a string that is nowhere in the file.
    out(`${messages.updatedManifest(target, locator.name, written)}\n`);

    // §15.23 — the field now names one exact version, so any resolution recorded
    // for the range it replaced answers a question nobody asks any more. Left
    // behind, it would come back to life the moment someone edited the pin back
    // to that same range, pinning a version chosen for a project state that no
    // longer exists.
    const stale = staleResolutionKey(previousPackageManager);
    if (stale !== undefined) removeResolution(dirname(target), stale);

    return previousPackageManager;
  });
}

/**
 * §15.12 — `--pin-style=suffix` (the default) or `--pin-style=sidecar`.
 *
 * Validated here rather than in `writePin` so a typo fails before the install
 * runs and the banner is printed: a mutating command that has already
 * downloaded and announced a version, then rejects its own flag, is the worst
 * possible order to discover a typo in.
 */
function readPinStyle(parsed: ParsedArgs): PinStyle | undefined {
  const value = firstValue(parsed, "--pin-style");
  if (value === undefined) return undefined;
  if (value !== "suffix" && value !== "sidecar") {
    throw new UsageError(`Option "--pin-style" accepts only "suffix" or "sidecar"`);
  }
  return value;
}

/**
 * The `.jup.lock` key a replaced `packageManager` value used to own, or
 * `undefined` when it owned none (the literal `unknown`, or an exact pin).
 */
function staleResolutionKey(previous: string): string | undefined {
  const at = previous.indexOf("@");
  if (at <= 0 || at === previous.length - 1) return undefined;

  const descriptor = { name: previous.slice(0, at), range: previous.slice(at + 1) };
  return usesLockfile(descriptor) ? resolutionKey(descriptor) : undefined;
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

    const spec = await installOrExplain(locator, descriptor.range);
    locations.push(spec.location);

    // §09.6 — `pack` updates last-known-good as a side effect, intentionally:
    // you pack what you intend to run.
    setLastKnownGood(locator.name, referenceWithHash(locator.name, locator.reference, spec.hash));
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

/**
 * §09.7 — `clean` and `clear` are the same command, plus §15.18's `--all` and
 * §15.19's `list`.
 */
export async function cmdCache(args: string[]): Promise<number> {
  const parsed = parseArgs(args, { booleans: ["--all", "--json"] });
  const [subcommand, ...extra] = parsed.positionals;

  if (subcommand === "list" && extra.length === 0) {
    // §15.30 — `cache list` is the store half of `info`, and says so: one
    // report builder, one shape, no second listing to keep in step.
    return import("./info.ts").then(({ cmdCacheList }) =>
      cmdCacheList(hasFlag(parsed, "--json") ? ["--json"] : []),
    );
  }

  if ((subcommand !== "clean" && subcommand !== "clear") || extra.length > 0) {
    throw new UsageError(`The 'jup cache' command only accepts 'clean', 'clear' or 'list'`);
  }
  // `--json` belongs to `list`; silently ignoring it here would let a script
  // believe it was parsing output that never came.
  if (hasFlag(parsed, "--json")) {
    throw new UsageError(`The 'jup cache ${subcommand}' command does not accept --json`);
  }

  // `rm -rf <home>/v1`, forced; `lastKnownGood.json` lives outside `v1` and
  // therefore survives, so the recorded default is simply re-downloaded.
  //
  // §15.18 — the survival is deliberate, but corepack's documentation claimed
  // otherwise and #675 is the resulting confusion. `--all` is the explicit
  // "yes, the recorded defaults too", and unlike the silent default it reports
  // what it removed, because a command that deletes things silently gives the
  // user no way to tell a successful clean from a no-op.
  //
  // §15.35l — and *both* forms report. "`cache clean` currently prints nothing;
  // it MUST print `Removed <n> cached version(s) from <path>` (or `Nothing to
  // remove`)": a command whose entire job is deletion gives the user no way to
  // tell a successful clean from a no-op when it is silent, and `DEBUG=corepack`
  // is a debugging aid rather than command output.
  //
  // The count is taken *before* the removal, because afterwards there is nothing
  // left to count.
  const all = hasFlag(parsed, "--all");
  const removed = listInstalled().length;

  if (!all) {
    cacheClean();
    out(
      `${removed === 0 ? messages.nothingToRemove() : messages.removedFromCache(removed, getInstallFolder())}\n`,
    );
    return 0;
  }

  const defaults = Object.keys(readLastKnownGood()).length;
  cacheClean({ all: true });

  out(
    `${
      removed === 0 && defaults === 0
        ? messages.nothingToRemove()
        : messages.removedFromCacheAll(removed, defaults, getHomeFolder())
    }\n`,
  );
  return 0;
}

/* -------------------------------------------------------------------------- */
/* §09.10 — deprecated commands                                                */
/* -------------------------------------------------------------------------- */

/**
 * §15.35c — a deprecated command names its replacement, on **stderr**, and then
 * does its job.
 *
 * stderr rather than stdout for two reasons that agree: §09.11 puts warnings
 * there, and `prepare --json` writes a document to stdout that a caller pipes
 * into `jq`. "Never silently hide a command" cuts both ways — the command still
 * works, and the notice never breaks what it prints.
 */
function deprecated(command: string, replacement: string): void {
  process.stderr.write(`${messages.deprecatedCommand(command, replacement)}\n`);
}

/** §09.10 — deprecated, retained for compatibility. */
export async function cmdHydrate(args: string[]): Promise<number> {
  // The predecessor of `install -g <file>.tgz` (§09.10), which is what it names.
  deprecated("hydrate", "install -g");
  const parsed = parseArgs(args, { booleans: ["--activate"] });
  const [file, ...extra] = parsed.positionals;

  if (file === undefined || extra.length > 0) {
    throw new UsageError(`The 'jup hydrate' command requires exactly one archive`);
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
  // §15.35c's sentence, verbatim. `pack` is `prepare`'s replacement for the
  // archive half; `--activate` is `install -g`, but the spec names one command
  // and this is the one it names.
  deprecated("prepare", "pack");
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

    const spec = await installOrExplain(locator, descriptor.range, { cacheOnly: !activate });
    locations.push(spec.location);
    if (activate)
      setLastKnownGood(locator.name, referenceWithHash(locator.name, locator.reference, spec.hash));
  }

  // §09.10 — `--output` tolerates a bare flag, defaulting to `jup.tgz`.
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
    case "info": {
      // Lazily, like `enable`/`disable`: §15.30's report reaches for the shim
      // resolver and the store listing, and no other command pays for either.
      return import("./info.ts").then(({ cmdInfo }) => cmdInfo(rest));
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
