/**
 * Management-mode commands — §09.
 *
 * This is the complete surface. Anything not here is out of scope (§01.7).
 *
 * §09.14 stream routing is preserved: informational output uses stdout,
 * warnings use stderr, and `UsageError`s propagate to `main.ts`.
 */

const { createReadStream, realpathSync } = process.getBuiltinModule("node:fs");
const { readdir, rm } = process.getBuiltinModule("node:fs/promises");
const {
  basename,
  dirname,
  join,
  relative,
  resolve: resolvePath,
  sep,
} = process.getBuiltinModule("node:path");
const { Readable } = process.getBuiltinModule("node:stream");
import { ENV, envSpellings, writeEnv } from "../config/env-vars.ts";
import {
  getTableSpec,
  isPerHost,
  isSupportedPackageManager,
  resolveSpecBin,
} from "../config/table.ts";
import { isFrozenLockfile } from "../project/env.ts";
import { advisory, explainFetchFailure, messages, UsageError } from "../errors-cold.ts";
import { execPackageManager } from "../run/exec.ts";
import { ensureInstalled } from "../cache/install.ts";
import {
  hasLockfile,
  LOCKFILE_NAME,
  readKnownResolution,
  readLockfile,
  removeCachedResolution,
  removeResolution,
  resolutionKey,
  usesLockfile,
  writeCachedResolution,
  writeResolution,
} from "../project/lockfile.ts";
import { CLI_SOURCE, findProjectSpec, parseSpec } from "../project/manifest.ts";
import { type PinOptions, writePin } from "../project/pin.ts";
import { resolveSpec, type ResolveOptions } from "../version/resolve.ts";
import { isValidRange, isValidVersion, major, parse } from "../version/semver.ts";
import {
  cacheClean,
  createTempDir,
  getHomeFolder,
  getInstallFolder,
  isInsideInstallFolder,
  listInstalled,
  MARKER_NAME,
  PINNED_STAMP,
  promote,
  readLastKnownGood,
  readMarker,
  recordLastKnownGood,
  referenceWithHash,
  UNATTRIBUTABLE_HASH,
  writeMarker,
} from "../cache/store.ts";
import { create, extract, listEntries } from "../cache/tar.ts";
import type { Spec, Installation, ResolvedSpec, ProjectSpec, RunOptions } from "../types.ts";

/** §09.6 — the default `pack` output, relative to the cwd. */
const DEFAULT_ARCHIVE_NAME = "jup.tgz";

import { formatHelp } from "./usage.ts";
import { getOwnVersion } from "../utils/self.ts";
import { out, outColors } from "../utils/log.ts";

async function resolveOrThrow(descriptor: Spec, options: ResolveOptions): Promise<ResolvedSpec> {
  let locator: ResolvedSpec | null;
  try {
    locator = await resolveSpec(descriptor, options);
  } catch (error) {
    // §12.6 — with the network off, "can't reach <url>" is the least useful
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
 * `ensureInstalled`, with §12.6's and §04.1's diagnostics attached.
 *
 * `range` is what the user wrote, so an airgapped failure can name the cache
 * seeding command; the locator supplies the version for missing-artifact errors.
 */
async function installOrExplain(
  locator: ResolvedSpec,
  range: string,
  options?: { cacheOnly?: boolean },
): Promise<Installation> {
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
 *
 * This is not §04.8's guarded bump — no "same major", no "strictly upward", no
 * "only if an entry already exists". `install -g yarn@1.0.0` makes 1.0.0 the
 * default even when the current default is 4.x.
 */
function setLastKnownGood(name: string, reference: string): void {
  // §04.5 — *pinned*, not merely current: the user named this version, so
  // §04.6's TTL leaves it alone until they name another. Every entry these two
  // commands did not write ages out and is re-checked.
  //
  // Swallows `EROFS` itself (§07.8): recording a default must never fail a run.
  recordLastKnownGood(name, reference, PINNED_STAMP);
}

function fileStream(path: string): ReadableStream<Uint8Array> {
  return Readable.toWeb(createReadStream(path)) as unknown as ReadableStream<Uint8Array>;
}
interface ArgSpec {
  booleans?: string[];
  strings?: string[];
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
  const strings = new Set(spec.strings ?? []);

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
/**
 * §09.1 — shared by `install`, `pack`, `up`, and `use`.
 *
 * With patterns, only the env file is loaded (§03.2 `envOnly`). Without them the
 * project is consulted, and `lookup.range ?? lookup.getSpec()` prefers a
 * declared devEngines range over the exact pin — which is what lets `up` follow
 * a range across majors.
 *
 * The byte-compatible messages say "to pack" in all four commands.
 */
export function resolvePatternsToDescriptors(patterns: string[]): Spec[] {
  const cwd = process.cwd();

  if (patterns.length > 0) {
    // Explicit patterns mean the project is irrelevant — but the env file is
    // not, because it can carry the registry and network settings the
    // resolution below needs.
    findProjectSpec(cwd, { envOnly: true });
    return patterns.map((pattern) =>
      parseSpec(pattern, { source: CLI_SOURCE, requireVersion: false }),
    );
  }

  return [resolveProjectSpec().descriptor];
}

/**
 * The project's own spec, plus the lookup that produced it.
 *
 * `up` needs both halves: the descriptor to resolve, and the lookup to tell a
 * declared `packageManager` range (which §04.4 refreshes in `jup.lock`)
 * from a spec synthesised out of `devEngines` (which row 114 turns into a pin).
 */
function resolveProjectSpec(options?: { mutating?: boolean; here?: boolean }): {
  descriptor: Spec;
  lookup: Extract<ProjectSpec, { type: "Found" }>;
} {
  // §03.1 — a command that is about to *write* must read the spec from the file
  // it will write, or `up` refreshes one manifest and pins another.
  const lookup = findProjectSpec(process.cwd(), options);
  switch (lookup.type) {
    case "NoProject": {
      throw new UsageError(messages.couldntFindProject());
    }
    case "NoSpec": {
      throw new UsageError(messages.noSpecInProject());
    }
    case "Found": {
      // A declared `devEngines.packageManager.version` outranks the exact pin.
      //
      // `requireVersion: false` because these commands legitimately accept
      // a range-valued pin — §09.4's own error message says "a semver version or
      // semver range", and that check is only reachable if parsing got this far.
      return { descriptor: lookup.range ?? lookup.getSpec({ requireVersion: false }), lookup };
    }
  }
}
/** §09.2 — cache the project's package manager. Does **not** touch last-known-good. */
export async function cmdInstall(args: string[]): Promise<number> {
  const parsed = parseArgs(args, {});
  if (parsed.positionals.length > 0) {
    throw new UsageError(
      `The 'jup install' command takes no arguments; use 'jup install -g <name>@<version>' to install one globally`,
    );
  }

  const { descriptor, lookup } = resolveProjectSpec();

  // §04.4 — warm the cache with the version the project will actually run.
  // `install` exists to fill a Docker layer, and resolving a range afresh here
  // can legitimately answer something newer than the project's files record —
  // which would cache one version and then run another, offline, in the layer
  // that has no network to fix it with.
  //
  // Consult committed and cached resolutions in §04.4 order, keyed by the pin
  // rather than the `devEngines` range used by `up`.
  const pinned = lookup.getSpec({ requireVersion: false });
  const known = usesLockfile(pinned)
    ? readKnownResolution(dirname(lookup.target), pinned).locator
    : null;

  const locator = known ?? (await resolveOrThrow(descriptor, { allowTags: true }));

  out(`${messages.addingToCache(locator.name, locator.reference)}\n`);
  // Project `install` warms the cache without changing the global default.
  await installOrExplain(locator, descriptor.range, { cacheOnly: true });

  return 0;
}
/** §09.3 — sets last-known-good **unconditionally**, unlike §04.8's guarded bump. */
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
      await installFromArchive(target, { activate: !cacheOnly });
      continue;
    }

    const descriptor = parseSpec(target, { source: CLI_SOURCE, requireVersion: false });
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
/**
 * §07.10 — validate that the archive came from `pack` before touching anything.
 *
 * Only entries whose **last** path segment is the `.jup` marker are
 * considered; anything shorter than `<name>/<version>/.jup` poisons the
 * whole archive. This guards against passing the wrong tarball by accident — it
 * is **not** a security boundary, which is why the extraction below still runs
 * through §07.4's rules with nothing relaxed.
 */
async function readArchiveEntries(filePath: string): Promise<Map<string, Set<string>>> {
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

    // These segments become path components and recorded defaults; reject
    // values that path joining could reinterpret.
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
    throw new UsageError(messages.invalidArchiveFormat());
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
 * §07.10 — strip the unattributable `hash` from a marker the archive supplied.
 *
 * A marker's `hash` is a *claim*: nothing in this path hashed the bytes it
 * describes. `pack` ships extracted `<name>/<version>/` subtrees rather than
 * the artifact tarball the digest was taken over, so there is nothing left here
 * to re-derive it from — which is §07.10's second clause, not its first. Left
 * intact, the claim is exactly what `markerProvesPin` compares a pin against,
 * so an archive could seed arbitrary bytes under a name and version some
 * project pins and have them execute with nothing ever hashed.
 *
 * A marker §07.2 cannot read is left as it is: it carries no claim anyone will
 * honour, because every consumer already treats it as no marker at all.
 */
function stripUnattributableHash(dir: string): void {
  const marker = readMarker(dir);
  if (marker === null) return;
  writeMarker(dir, { ...marker, hash: UNATTRIBUTABLE_HASH });
}

/**
 * Extract into a temp folder **inside** the install tree, then promote each
 * validated `<name>/<version>` subtree with the same atomic rename the download
 * path uses (§07.5). Only validated subtrees are promoted, so an archive
 * carrying extra entries never contributes anything to the store.
 */
async function installFromArchive(file: string, options: { activate: boolean }): Promise<void> {
  const filePath = resolvePath(process.cwd(), file);
  const found = await readArchiveEntries(filePath);

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
        // §07.10 — before promotion, never after: the store must not hold a
        // digest claim this never checked, not even briefly.
        const staged = join(tmp, name, reference);
        stripUnattributableHash(staged);
        promote(staged, join(installFolder, name, reference));
        if (options.activate) setLastKnownGood(name, reference);
      }
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
/** §09.4 — the two-step resolve is what confines the update to the current major line. */
export async function cmdUp(args: string[], run?: RunOptions): Promise<number> {
  const parsed = parseArgs(args, {
    booleans: ["--here", "--no-integrity", "--no-lockfile"],
  });
  if (parsed.positionals.length > 0) {
    throw new UsageError(`The 'jup up' command takes no arguments`);
  }

  // §03.1 — `--here` reads and writes `cwd`'s own manifest, ignoring the walk.
  const here = hasFlag(parsed, "--here");
  const integrity = !hasFlag(parsed, "--no-integrity");
  // §04.4 — `--no-lockfile` records nothing and retires what is recorded. It
  // reaches only the range branch below: an exact pin never wrote a resolution
  // in the first place, and the one it *removes* is the removal this flag wants
  // anyway, so `pinToProject`'s behaviour is already the flag's behaviour.
  const lockfile = !hasFlag(parsed, "--no-lockfile");
  const { descriptor, lookup } = resolveProjectSpec({ mutating: true, here });
  const { name, range } = descriptor;

  if (!isValidVersion(range) && !isValidRange(range)) {
    throw new UsageError(messages.upNotSemver());
  }

  // §04.4 — when the pin the project declares *is* a range, that range is the
  // user's statement of intent and `up` must not overwrite it with a version:
  // what it refreshes is the recorded resolution.
  //
  // The question is what the spec says, never which field happens to carry it
  // (§03.7 — one logical pin). `use <name>@<range>` writes the range into
  // `devEngines.packageManager.version` alone whenever no top-level
  // `packageManager` exists, which is also the shape pnpm 11.21 generates; a
  // gate asking for a top-level string skipped both, collapsed the range to an
  // exact version, and deleted the very `jup.lock` entry `use` had just
  // recorded. `getSpec` answers for all three shapes: the top-level field when
  // it is there, the `devEngines` declaration when it is not — and `descriptor`
  // is already that answer whenever no `devEngines` range outranked it (§09.1).
  const pin = lookup.range === undefined ? descriptor : declaredPin(lookup);
  if (pin !== undefined && usesLockfile(pin)) {
    if (!isValidRange(pin.range)) {
      // A dist-tag pin is not refreshable by `up`; `use` records its expansion.
      throw new UsageError(messages.upNotSemver());
    }
    const dir = dirname(lookup.target);
    // §04.4 — `up` refreshes a committed resolution; it does not start the file.
    // A project that has never committed one has chosen the memo, and a command
    // asked to move the range forward is not the moment to add a file to the
    // user's tree — `use` is what creates one. The memo below carries the
    // decision instead.
    const commit = lockfile && hasLockfile(dir);

    // §04.4's flag governs the *file*. It is refused only where this run would
    // still change it: the refresh above, and — under `--no-lockfile`, which
    // writes nothing — the removal below, on the projects that hold the entry.
    if (isFrozenLockfile() && (commit || (!lockfile && holdsResolution(dir, pin)))) {
      throw new UsageError(messages.lockfileUnresolved(pin.name, pin.range));
    }

    // No second, major-confining resolve here: for an exact pin that step is what
    // keeps `up` inside the current major, but a declared range already says how
    // far the user is willing to move — and `^2.0.0` derived from a `~2.1.0` pin
    // would pick a version the range itself rejects, which the next run would
    // then discard as unsatisfying.
    //
    // The resolve and the install happen under `--no-lockfile` too: the flag is
    // about what gets *committed*, not about what `up` means. The newest release
    // the range allows is still selected, installed and handed over; the only
    // difference is that nothing records which one it was.
    const refreshed = await resolveOrThrow(pin, { useCache: false });
    return applyToProject(
      refreshed,
      (reference, spec) => {
        const locator = { name: pin.name, reference };
        if (commit) {
          writeResolution(dir, pin, locator, spec.hash, isPerHost(refreshed));
          // The memo under `node_modules` answers the same key and now holds the
          // version this command just superseded — and it answers *alone* wherever
          // the recorded file is not visible: an `up` not yet committed, a `git
          // stash`, a CI cache that restores `node_modules` without the lockfile.
          // Retiring it is what stops the project silently running the old version
          // (§04.4).
          removeCachedResolution(dir, resolutionKey(pin));
          // §12.11 — the resolution file is what changed, so that is what is named.
          out(`${messages.updatedManifest(join(dir, LOCKFILE_NAME), pin.name, reference)}\n`);
        } else if (lockfile) {
          // Nothing committed to refresh: the answer came from the registry, so
          // it goes where an ordinary proxy run would have put it (§04.4). The
          // stale entry it replaces is the same key, so this overwrites it rather
          // than leaving the superseded version to answer. No path is named —
          // §12.11 names what changed in the project, and the memo is host-local
          // derived state no command announces.
          writeCachedResolution(dir, pin, locator, spec.hash, isPerHost(refreshed));
        } else {
          dropRecordedResolution(dir, pin);
        }
        // The field is unchanged, so that is what the package manager migrates from.
        return `${pin.name}@${pin.range}`;
      },
      run,
    );
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
  let highest: ResolvedSpec | null;
  try {
    highest = await resolveSpec(target, { useCache: false });
  } catch (error) {
    // Attach the same offline seeding diagnostic to the second resolution.
    throw explainFetchFailure(error, target) ?? error;
  }
  if (highest === null) throw new UsageError(messages.upNoHighest(name, line));

  return pinToProject(highest, { here, integrity }, run);
}

/**
 * The pin as the manifest declares it, or `undefined` when it cannot be read.
 *
 * Only reached when a `devEngines` range outranked the pin (§09.1), which is the
 * one case where a `packageManager` field too malformed to parse — a number, a
 * bare `@` — is not already fatal: the project has a usable range either way, so
 * `up` refreshes on that and overwrites the broken field, as §09.5 has `use` do.
 */
function declaredPin(lookup: Extract<ProjectSpec, { type: "Found" }>): Spec | undefined {
  try {
    return lookup.getSpec({ requireVersion: false });
  } catch {
    return undefined;
  }
}
/** §09.5 — writes the pin, then runs the package manager's `use` command. */
export async function cmdUse(args: string[], run?: RunOptions): Promise<number> {
  const parsed = parseArgs(args, {
    booleans: ["--here", "--no-integrity", "--no-lockfile"],
  });
  const [pattern, ...extra] = parsed.positionals;
  if (pattern === undefined) {
    throw new UsageError(`The 'jup use' command requires a package manager pattern`);
  }
  if (extra.length > 0) {
    throw new UsageError(`The 'jup use' command accepts a single package manager pattern`);
  }

  // §03.7 / §04.4 — both are recorded by default, and both flags are opt-outs
  // that also retire what a previous run recorded.
  const integrity = !hasFlag(parsed, "--no-integrity");
  const lockfile = !hasFlag(parsed, "--no-lockfile");

  const descriptor = parseSpec(pattern, { source: CLI_SOURCE, requireVersion: false });

  // §04.4 — preserve an explicitly typed semver range and record its resolution
  // in `jup.lock`. Exact versions, dist-tags, and bare names pin exactly.
  const range =
    pattern.slice(1).includes("@") && isValidRange(descriptor.range) && usesLockfile(descriptor);

  // §03.1 — `--here` mutates `cwd`'s own manifest, creating it if absent.
  const here = hasFlag(parsed, "--here");

  // Checked before the resolve so a frozen job fails on the flag it set rather
  // than after a download it cannot use.
  //
  // §04.4's flag governs the *file*, not one syntax of pin: an exact `use` over
  // a project that currently declares a range retires that range's recorded
  // resolution below — dropping the key, and `rm`ing `jup.lock` outright when it
  // was the only one — and a deletion is a write. So the exact form is refused
  // too, and for the same reason, whenever the committed file actually holds the
  // entry it would remove.
  //
  // `--no-lockfile` puts the range form on that same footing: it writes nothing,
  // so it is refused only where it would remove something. Two keys can go —
  // the range this run pins and the pin it replaces — so both are offered to
  // {@link recordedPinToRetire}, which answers with whichever the file holds.
  if (isFrozenLockfile()) {
    const frozen =
      range && lockfile
        ? descriptor
        : recordedPinToRetire(here, descriptor.name, lockfile ? undefined : descriptor);
    if (frozen !== undefined) {
      throw new UsageError(messages.lockfileUnresolved(frozen.name, frozen.range));
    }
  }

  // Resolve tags afresh rather than reusing a cached version.
  const resolved = await resolveOrThrow(descriptor, { allowTags: true, useCache: false });

  const options = { here, integrity };
  return range
    ? pinRangeToProject(descriptor, resolved, options, lockfile, run)
    : pinToProject(resolved, options, run);
}

/**
 * §04.4 / §09.5 — `use <name>@<range>`: the range goes in the field, the
 * version it resolved to goes in `jup.lock`.
 *
 * This path creates the recorded resolution and retires the replaced field's
 * resolution; `up` only refreshes an existing record.
 *
 * Under `--no-lockfile` the range still goes into the manifest — that is the pin
 * the user asked for — and the resolution simply is not recorded. What *was*
 * recorded for that range comes out with it, for the reason §09 gives the
 * integrity opt-out: a flag that asked for no lockfile and left the old entry
 * standing would have changed nothing about what the next run resolves.
 */
function pinRangeToProject(
  descriptor: Spec,
  locator: ResolvedSpec,
  options?: PinOptions,
  lockfile = true,
  run?: RunOptions,
): Promise<number> {
  return applyToProject(
    locator,
    (_reference, spec) => {
      const { previousPackageManager, target, written } = writePin(
        process.cwd(),
        // §02.4 — the digest is per-host for a native tool, so it never reaches
        // the manifest; for a range it never does anyway, since the field holds no
        // version for a digest to describe. `jup.lock` below is where it lands.
        { name: descriptor.name, reference: descriptor.range, resolved: locator.reference },
        options,
      );

      const dir = dirname(target);
      if (lockfile) {
        writeResolution(dir, descriptor, locator, spec.hash, isPerHost(locator));
        // The committed resolution supersedes any host-local memo for this key.
        removeCachedResolution(dir, resolutionKey(descriptor));
      }

      // §03.7, §12.11 — both files changed, so both are named, in the order they
      // are read back: the field that declares the range, then the file that says
      // what it currently means.
      out(`${messages.updatedManifest(target, descriptor.name, written)}\n`);
      if (lockfile) {
        out(
          `${messages.updatedManifest(join(dir, LOCKFILE_NAME), descriptor.name, locator.reference)}\n`,
        );
      } else {
        dropRecordedResolution(dir, descriptor);
      }

      const stale = staleResolutionKey(previousPackageManager);
      if (stale !== undefined && stale !== resolutionKey(descriptor)) removeResolution(dir, stale);

      return previousPackageManager;
    },
    run,
  );
}

/**
 * The shared tail of `use` (§09.5) and `up` (§09.4).
 *
 * Order is observable and test-asserted: the banner reaches stdout **before**
 * the install and before `writePin`'s devEngines check, so a mismatch surfaces
 * underneath a banner that has already been printed (test 110).
 *
 * `record` is what the command does with the installed version — write the pin,
 * or (§04.4) refresh the recorded resolution — and returns the value
 * `COREPACK_MIGRATE_FROM` carries into the package manager's own `use` command.
 */
async function applyToProject(
  locator: ResolvedSpec,
  record: (reference: string, spec: Installation) => string,
  run?: RunOptions,
): Promise<number> {
  out(`${messages.installingInProject(locator.name, locator.reference)}\n`);

  const spec = await installOrExplain(locator, locator.reference);
  // §02.4 — `referenceWithHash` declines to attach a per-host digest, so what
  // goes into `packageManager` is a bare version for bun and deno.
  const reference = referenceWithHash(locator.name, locator.reference, spec.hash);

  // §03.7 — may throw a `UsageError` through `warnOrThrow`; the banner above is
  // already on stdout, which is exactly what §09.5 describes.
  const previousPackageManager = record(reference, spec);

  // A URL reference has no table band, so it has no `commands.use` either.
  const pinned: ResolvedSpec = { name: locator.name, reference };
  const tableSpec = getTableSpec(pinned);
  const useCommand = tableSpec?.commands?.use;

  if (useCommand === undefined || useCommand.length === 0) return 0;

  // §09.5 — what the package manager's own `use` command is told to migrate
  // from; the literal `unknown` when the project had no previous value.
  //
  // §08.7 puts this in the *child's* environment, and `process.env` is only that
  // when this process is the tool's. Without handover there is a caller above
  // whose environment outlives the run, so the variable is put back afterwards:
  // the child's block is a copy taken at spawn time, so it still carries the
  // value, and nothing of ours reads it after the handover returns.
  const restore = restoreEnvAfter(run, ENV.MIGRATE_FROM);
  writeEnv(ENV.MIGRATE_FROM, previousPackageManager);
  out(`\n`);

  try {
    // From here the package manager owns the process and its output is passed
    // through untouched (§09.14). §08.3's native path is the one that has an exit
    // code to hand back here; the JavaScript path answers 0 and sets the real one
    // itself, later (§08.4) — unless `run.handover` is off, in which case it is
    // spawned too and this is the tool's own code either way.
    return await execPackageManager(
      useCommand[0]!,
      spec,
      useCommand.slice(1),
      // §08.1 — `installSpec.bin ?? spec.bin`; the marker may carry no `bin`.
      // §02.4 — `{exe}`-substituted, per `resolveSpecBin`.
      tableSpec === undefined ? undefined : resolveSpecBin(tableSpec),
      tableSpec?.exec,
      // §02.4 — no band names its own `commands.use` under an aliased bin, so
      // this is `undefined` for every entry in the table today; it is passed for
      // the same reason the two above are, so that one handover cannot drift from
      // the other.
      tableSpec?.binArgs?.[useCommand[0]!],
      run,
    );
  } finally {
    restore();
  }
}

/**
 * A no-op under handover, and otherwise a function that puts every spelling of
 * `name` back the way it was.
 *
 * Both spellings, because {@link writeEnv} sets both (§11.6) and restoring one
 * would leave the compatibility name standing — which for
 * `COREPACK_MIGRATE_FROM` is the one a package manager actually reads.
 */
function restoreEnvAfter(run: RunOptions | undefined, name: string): () => void {
  if (run?.handover === true) return () => {};

  const before = envSpellings(name).map((spelling) => [spelling, process.env[spelling]] as const);
  return () => {
    for (const [spelling, value] of before) {
      if (value === undefined) delete process.env[spelling];
      else process.env[spelling] = value;
    }
  };
}

/** §09.5 / §03.7 — write the exact pin, and retire the range it replaced. */
function pinToProject(
  locator: ResolvedSpec,
  options?: PinOptions,
  run?: RunOptions,
): Promise<number> {
  // §02.4 — a native package manager's artifact differs per host, so its digest
  // is not a portable fact and must not be written into a file people commit: a
  // Linux-pinned `bun@1.4.0+sha512.…` fails on a colleague's Mac with a hash
  // mismatch, which is the one outcome a pin exists to prevent. The version is
  // still pinned exactly; what stands in for the digest is npm's signature over
  // the host's own artifact (§06.3, checked on every install), plus §04.4's
  // per-host record in `jup.lock` for the hosts that have actually run.
  const perHost = isPerHost(locator);

  return applyToProject(
    locator,
    (reference, spec) => {
      const { previousPackageManager, target, written } = writePin(
        process.cwd(),
        { name: locator.name, reference, hash: perHost ? undefined : spec.hash },
        options,
      );

      // Name the selected manifest after the write succeeds.
      // §03.7 — `written`, not `reference`: the member holds a clean version with
      // the digest beside it in `integrity` (or, under `--no-integrity`, nowhere),
      // and a line claiming otherwise would name a string that is nowhere in the
      // file.
      out(`${messages.updatedManifest(target, locator.name, written)}\n`);

      // An exact pin retires the replaced range's resolution so restoring the
      // range cannot resurrect stale state.
      const stale = staleResolutionKey(previousPackageManager);
      if (stale !== undefined) removeResolution(dirname(target), stale);

      return previousPackageManager;
    },
    run,
  );
}

/**
 * §04.4 — the pin whose recorded resolution a mutation is about to retire, but
 * only when the committed file actually holds it.
 *
 * `isFrozenLockfile` governs "whether the project's `jup.lock` may be written",
 * and a deletion is a write — the entry goes, and the file with it when it was
 * the only one. So the exact form of `use` is refused under the flag on exactly
 * the projects where it would change that file, and nowhere else: a project with
 * no recorded entry has nothing to freeze, and refusing there would break every
 * `use` in CI for a file that does not exist.
 *
 * `also` is the second key a `--no-lockfile` run can remove: the range it is
 * pinning, whose entry a previous run may have recorded under exactly this key.
 * It is checked first because it is the one the caller knows about; the declared
 * pin is the one being replaced. Either answers the question the caller asks,
 * which is "would this run change the file", so the first hit wins.
 *
 * The walk is the mutating one, with the same `--here` and the same tool, so the
 * manifest read here is the manifest the caller is about to write.
 */
function recordedPinToRetire(here: boolean, tool: string, also?: Spec): Spec | undefined {
  const lookup = findProjectSpec(process.cwd(), { mutating: true, here, tool });
  if (lookup.type !== "Found") return undefined;

  const dir = dirname(lookup.target);
  if (also !== undefined && holdsResolution(dir, also)) return also;

  let pin: Spec;
  try {
    pin = lookup.getSpec({ requireVersion: false });
  } catch {
    // §09.5 — a malformed field is one `use` overwrites rather than reads, and
    // a field nobody can parse owns no resolution key either.
    return undefined;
  }
  return holdsResolution(dir, pin) ? pin : undefined;
}

/** §04.4 — does the committed `jup.lock` in `dir` hold this descriptor's entry? */
function holdsResolution(dir: string, descriptor: Spec): boolean {
  if (!usesLockfile(descriptor)) return false;
  const data = readLockfile(dir);
  return data !== null && Object.hasOwn(data.resolutions, resolutionKey(descriptor));
}

/**
 * §04.4 / §09 — `--no-lockfile`'s half of the write: retire the recorded
 * resolution, and name the file when the removal actually changed it.
 *
 * The memo under `node_modules` goes with it — {@link removeResolution} drops
 * both — because a memo left behind answers the same key alone wherever the
 * recorded file is not visible, which is precisely the stale resolution the flag
 * was asked to stop committing.
 *
 * §12.11 requires the path to be printed *because it changed*, so the check
 * comes first: a removal that removed nothing changed no path, and naming one
 * would be a false statement about the user's tree.
 */
function dropRecordedResolution(dir: string, descriptor: Spec): void {
  const held = holdsResolution(dir, descriptor);
  removeResolution(dir, resolutionKey(descriptor));
  if (held) {
    out(
      `${messages.removedResolution(join(dir, LOCKFILE_NAME), descriptor.name, descriptor.range)}\n`,
    );
  }
}

/**
 * Return the replaced `packageManager` value's `jup.lock` key, if it had one.
 */
function staleResolutionKey(previous: string): string | undefined {
  const at = previous.indexOf("@");
  if (at <= 0 || at === previous.length - 1) return undefined;

  const descriptor = { name: previous.slice(0, at), range: previous.slice(at + 1) };
  return usesLockfile(descriptor) ? resolutionKey(descriptor) : undefined;
}
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
/**
 * §09.7 — `clean` and `clear` are the same command; §07.9 covers `--all`, and
 * `cache list` is handled just below.
 */
export async function cmdCache(args: string[]): Promise<number> {
  const parsed = parseArgs(args, { booleans: ["--all", "--json"] });
  const [subcommand, ...extra] = parsed.positionals;

  if (subcommand === "list" && extra.length === 0) {
    // §09.9 — `cache list` is the store half of `info`, and says so: one
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
  // Recorded defaults survive unless `--all` explicitly includes them. Both
  // forms report whether removal occurred.
  //
  // The count is taken *before* the removal, because afterwards there is nothing
  // left to count.
  const all = hasFlag(parsed, "--all");
  const installed = listInstalled();

  // §07.9 — the backstop for §10.2. A shim may have an interpreter path baked
  // into it that points *into* this cache; removing it leaves every
  // shim dying with `bad interpreter` and `enable`, the repair, unreachable
  // behind the broken `node` shim. So the version holding it is spared.
  //
  // The lookup is unconditional. It is tempting to skip it when `listInstalled`
  // comes back empty — nothing can be spared out of an empty store — but that
  // list is not the store: §07.2 makes it skip any version directory without a
  // `.jup` marker, and a marker is exactly what an interrupted install, a disk
  // cleaner, or a hand-edited store loses. Such a store lists as empty while
  // still holding the runtime the shims' shebang names, and the skip would
  // `rm -rf <home>/v1` out from under them, print `Nothing to remove`, and leave
  // every shim dying with `bad interpreter` behind an `enable` that can no
  // longer start. §07.9 exists for precisely the installs a marker cannot vouch
  // for, so its guard must not be gated on one. The cost on the ordinary install
  // — where §10.2 has already put the interpreter outside `<home>` — is one
  // open of a file whose first line answers, on a command about to delete the
  // whole store.
  const pinned = await interpreterInStore();

  if (!all) {
    // Without a pinned interpreter, remove the store in one operation (§07.9).
    if (pinned === undefined) {
      cacheClean();
      out(
        `${installed.length === 0 ? messages.nothingToRemove() : messages.removedFromCache(installed.length, getInstallFolder())}\n`,
      );
      return 0;
    }

    const { name, version } = pinned.installed;
    const failed = await cleanSparing(pinned.installed);
    // §07.9's line, and then whatever could not be removed — in that order,
    // because the spared version is the reason the count is low by design and a
    // failure is the reason it is low by accident.
    advisory(messages.interpreterKept(name, version, pinned.interpreter, getHomeFolder()));
    for (const failure of failed) advisory(messages.cacheEntryNotRemoved(failure.path));

    // Counted by exclusion rather than as `length - 1`: the spared directory is
    // not necessarily one of the versions `listInstalled` counts (§07.2 wants a
    // marker), and the number printed has to be the number actually removed —
    // which excludes anything a failed `rm` left standing.
    const installFolder = getInstallFolder();
    const survived = new Set(failed.map((failure) => failure.path));
    const removed = installed.filter(
      (entry) =>
        (entry.name !== name || entry.version !== version) &&
        !survived.has(join(installFolder, entry.name)) &&
        !survived.has(join(installFolder, entry.name, entry.version)),
    ).length;
    out(
      `${removed === 0 ? messages.nothingToRemove() : messages.removedFromCache(removed, getInstallFolder())}\n`,
    );
    return 0;
  }

  // §07.9 — `--all` is the explicit "yes, everything", so it does remove the
  // interpreter. It says so first: the shims are about to stop working, and a
  // user who reads it after the fact has already lost the `jup` that would tell
  // them why.
  if (pinned !== undefined) {
    advisory(
      messages.interpreterRemoved(
        pinned.installed.name,
        pinned.installed.version,
        pinned.interpreter,
        getHomeFolder(),
      ),
    );
  }

  const removed = installed.length;
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

/**
 * §07.9 — the interpreter the installed shims run under, when it lives in this
 * cache, together with the version directory holding it.
 *
 * `undefined` covers every ordinary install: no shims, a relocatable
 * `#!/usr/bin/env node`, or — since §10.2 — an interpreter deliberately pinned
 * outside `<home>`. The shim module is imported lazily because that is the only
 * thing `cache` needs from it, and §09.7 is not worth ~40 kB of shim machinery
 * on the runs that have nothing to protect.
 */
async function interpreterInStore(): Promise<
  { interpreter: string; installed: { name: string; version: string } } | undefined
> {
  const { bakedInterpreter } = await import("./shims.ts");
  const interpreter = await bakedInterpreter();
  // §10.2's boundary test answers the question first, and it is the same one
  // `enable` refuses on, so the two halves cannot disagree about what this
  // command is about to delete: `<home>/v1` does not contain `<home>/self`, and
  // an interpreter parked outside it is not one `cache clean` can strand.
  if (interpreter === undefined || !isInsideInstallFolder(interpreter)) return undefined;

  const installed = storeVersionOf(interpreter);
  return installed === undefined ? undefined : { interpreter, installed };
}

/**
 * §07.9 — the `<name>/<version>` pair whose install directory holds `file`.
 *
 * The pair rather than the path, because {@link cleanSparing} walks its own
 * spelling of the install folder and two spellings of one directory — a
 * symlinked `<home>`, a trailing separator — would never compare equal. Joining
 * the segments there cannot disagree with what the walk is looking at.
 *
 * Depth is the whole test: `<install>/node/22.14.0/bin/node` is three segments
 * or more below the install folder, while `<install>/node/22.14.0` itself is a
 * version directory rather than a file *in* one, and something directly under
 * `<install>` belongs to no version at all.
 *
 * It lives here rather than in `cache/store.ts` for the reason §16 (Build
 * shape) gives: the only caller is a management command, and the store module
 * is in the warm chunk a `yarn --version` parses in full.
 */
function storeVersionOf(file: string): { name: string; version: string } | undefined {
  let installFolder = getInstallFolder();
  try {
    installFolder = realpathSync(installFolder);
  } catch {
    // Not created yet: the literal spelling is the best there is, and nothing
    // is inside a directory that does not exist.
  }

  const segments = relative(installFolder, file).split(sep);
  const [name, version] = segments;
  if (segments.length < 3 || name === undefined || version === undefined) return undefined;
  // `..` is the escape `relative` reports, and a `.` prefix is a marker or one
  // of §07.5's temp folders — neither is a cached version (§07.2).
  if (name.startsWith(".") || version.startsWith(".")) return undefined;
  return { name, version };
}

/**
 * §07.9 — `cacheClean()`, minus one version directory.
 *
 * Per-entry rather than one `rm -rf`, because `<install>` and
 * `<install>/<name>` both have to survive for the spared version to. Everything
 * else goes, other versions of the same tool and §07.5's temp folders included:
 * sparing one directory is not a licence to keep anything else.
 *
 * Attempt every removal and return failures rather than aborting the batch, so a
 * partial clean can report what remained.
 */
async function cleanSparing(spare: {
  name: string;
  version: string;
}): Promise<Array<{ path: string }>> {
  const installFolder = getInstallFolder();
  const keep = join(installFolder, spare.name, spare.version);

  const targets: string[] = [];
  for (const name of await readdir(installFolder).catch(() => [])) {
    const toolFolder = join(installFolder, name);
    if (name !== spare.name) {
      targets.push(toolFolder);
      continue;
    }
    for (const version of await readdir(toolFolder).catch(() => [])) {
      const versionFolder = join(toolFolder, version);
      if (versionFolder !== keep) targets.push(versionFolder);
    }
  }

  const results = await Promise.allSettled(
    targets.map((path) => rm(path, { recursive: true, force: true })),
  );
  return targets
    .filter((_path, index) => results[index]?.status === "rejected")
    .map((path) => ({ path }));
}
function cmdVersion(): Promise<number> {
  out(`${getOwnVersion()}\n`);
  return Promise.resolve(0);
}

function cmdHelp(): Promise<number> {
  out(formatHelp(outColors));
  return Promise.resolve(0);
}
/**
 * §09 — dispatch a management-mode invocation and return its exit code.
 *
 * A `UsageError` deliberately propagates: `main.ts` owns §12.1's presentation
 * (stdout, `Usage Error: `, a blank line, then {@link USAGE_LINES}'s entry for
 * the command word).
 */
export async function runManagementCommand(args: string[], run?: RunOptions): Promise<number> {
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
      // Lazily, like `enable`/`disable`: §09.9's report reaches for the shim
      // resolver and the store listing, and no other command pays for either.
      return import("./info.ts").then(({ cmdInfo }) => cmdInfo(rest));
    }
    case "install": {
      // `-g`/`--global` selects a different command, not a different flag.
      return rest.includes("-g") || rest.includes("--global")
        ? cmdInstallGlobal(rest)
        : cmdInstall(rest);
    }
    case "self-install": {
      // Lazily, like `enable`/`disable`, and for the same reason: §09.12 pulls
      // in the whole of §10's shim machinery plus a tree copy, and no other
      // command in this switch pays for either.
      return import("./self-install.ts").then(({ cmdSelfInstall }) => cmdSelfInstall(rest));
    }
    // §09.13 — `upgrade` is the same command under a shorter name. It is
    // deliberately *not* `up`, which updates the project's `packageManager`
    // field (§09.4) and is corepack's own spelling for it; the two are adjacent
    // enough that the help text distinguishes them outright.
    case "self-upgrade":
    case "upgrade": {
      return import("./self-upgrade.ts").then(({ cmdSelfUpgrade }) =>
        cmdSelfUpgrade(rest, command),
      );
    }
    case "pack": {
      return cmdPack(rest);
    }
    case "up": {
      return cmdUp(rest, run);
    }
    case "use": {
      return cmdUse(rest, run);
    }
    default: {
      throw new UsageError(`Unknown command "${command}"`);
    }
  }
}
