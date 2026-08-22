/**
 * Project spec discovery and parsing — §03.
 *
 * Answers "which package manager, at which version range, does this directory
 * want?" It touches the filesystem only, never the network.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { isSupportedPackageManager } from "./config/table.ts";
import { applyEnvFile, envDisabled, envFlag, loadEnvFileFrom } from "./env.ts";
import { messages, UsageError, VALIDATION_WARNING_PREFIX } from "./errors.ts";
import { parseManifest, scanTopLevelFields, setTopLevelString } from "./json.ts";
import { isValidRange, isValidVersion, satisfies } from "./semver.ts";
import type {
  Descriptor,
  DevEnginesPackageManager,
  DevEnginesRange,
  LazyLocator,
  Manifest,
  ParseSpecOptions,
  SpecResult,
} from "./types.ts";

/** Directories inside a `node_modules` are skipped, so a dependency cannot hijack its host. */
export const NODE_MODULES_RE = /[\\/]node_modules[\\/](@[^\\/]*[\\/])?([^@\\/][^\\/]*)$/;

/** The manifest file name the walk looks for in every directory. */
const MANIFEST_NAME = "package.json";

/** §03.4 — the `source` reported for anything the user typed on the command line. */
export const CLI_SOURCE = "CLI arguments";

/** §03.3 — every field of the manifest the discovery walk actually looks at. */
const MANIFEST_FIELDS = ["packageManager", "devEngines"] as const;

/**
 * §03.1 — the walk's stop condition, isolated because §15.25 changes it.
 *
 * Today **only** a truthy `packageManager` halts the climb; a manifest carrying
 * just `devEngines.packageManager` (or `packageManager: null`) does not, and a
 * parent's spec silently wins. Phase 2 makes both fields symmetric stop
 * conditions — this predicate is the single place that has to change.
 */
function stopsWalk(data: Manifest | undefined): boolean {
  // Matches the normative loop condition `!selection || !selection.data.packageManager`
  // exactly: it is a truthiness test, not a key-presence test.
  return data !== undefined && Boolean(data.packageManager);
}

/**
 * §03.7 — which file a project-mutating command rewrites, isolated because
 * §15.27 changes it (a `--here` flag, and preferring the workspace root).
 */
function pinTarget(result: SpecResult): string {
  return result.target;
}

/**
 * §03.1 — walk from `cwd` toward the root.
 *
 * At each directory: skip if it is a package dir inside `node_modules`; load the
 * env file if none has been loaded yet; read `package.json`. The walk stops only
 * on a manifest carrying a `packageManager` key, and the **last** manifest seen
 * is what gets recorded — which is why a monorepo with no pin anywhere yields
 * `NoSpec` targeting the *root*.
 *
 * `envOnly` loads the env file and stops at the first one found, never reading
 * manifests: for commands given an explicit package-manager pattern on the CLI.
 *
 * `projectSpecFlag` lets the caller honour `COREPACK_ENABLE_PROJECT_SPEC=0`
 * (§03.5, §11.1: "never look at the project at all"). It degrades the walk to
 * `envOnly` the moment the flag is seen, so a broken manifest cannot defeat the
 * escape hatch users reach for *because* their manifest is broken. It is opt-in
 * because corepack consults that variable only on the proxy path — `use`, `up`,
 * `install` and `pack` load the spec regardless of it.
 */
export function discoverProjectSpec(
  cwd: string,
  options?: { envOnly?: boolean; projectSpecFlag?: boolean },
): SpecResult {
  const initialCwd = resolve(cwd);
  let envOnly = options?.envOnly === true;
  const projectSpecFlag = options?.projectSpecFlag === true;

  let currentDir = "";
  let nextDir = initialCwd;
  let selection: { data: Manifest; target: string } | undefined;
  let envFilePath: string | undefined;

  // `envOnly` swaps the stop condition for "an env file has been found"; both
  // forms still terminate at the filesystem root, where `dirname(d) === d`.
  while (
    nextDir !== currentDir &&
    (envOnly ? envFilePath === undefined : !stopsWalk(selection?.data))
  ) {
    currentDir = nextDir;
    nextDir = dirname(currentDir);

    // Step 1 — a vendored dependency must never speak for its host, and that
    // includes its `.corepack.env`, so this runs before the env file is loaded.
    if (NODE_MODULES_RE.test(currentDir)) {
      continue;
    }

    // Step 2 — only the *closest* env file is ever applied (§03.2).
    if (envFilePath === undefined) {
      const loaded = loadEnvFileFrom(currentDir);
      if (loaded !== null) {
        applyEnvFile(loaded.vars, loaded.path);
        envFilePath = loaded.path;
      }
    }

    // §03.5 / §11.1 — with the project spec disabled the manifest must not be
    // read at all, let alone parsed or devEngines-validated. The test lives here,
    // *after* the env-file step, because `.corepack.env` is allowed to be what
    // sets the variable (§03.2); corepack returns before any walk and so cannot
    // honour an env file at all. From this point the walk is exactly `envOnly`:
    // it keeps climbing for an env file and records no manifest, so the result is
    // `NoProject` and §03.5 falls back.
    if (projectSpecFlag && envDisabled("COREPACK_ENABLE_PROJECT_SPEC")) {
      envOnly = true;
    }

    if (envOnly) {
      continue;
    }

    // Step 3 — read the manifest.
    const target = join(currentDir, MANIFEST_NAME);
    let content: string;
    try {
      content = readFileSync(target, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw error;
    }

    // §16.3 — the walk reads two fields, so scan for them rather than resolving
    // the whole manifest into a DOM: a 400-dependency `package.json` costs
    // several hundred allocations to answer a two-field question. The scan is
    // conservative and answers `null` for anything it cannot prove well-formed,
    // in which case the real parser decides — which is what keeps §03.1's
    // `Invalid package.json` firing on exactly the inputs it fired on before.
    let data: unknown = scanTopLevelFields(content, MANIFEST_FIELDS);
    if (data === null) {
      try {
        data = parseManifest(content);
      } catch {
        // Unparseable and "parsed to a non-object" are the same user-facing error.
        data = undefined;
      }
    }
    if (typeof data !== "object" || data === null) {
      // §03.1 — "relative to `d`", the directory being examined, not to the
      // initial cwd: the path always renders as the bare `package.json`, however
      // far up the walk the broken manifest was found. (`source` below *is*
      // relative to the initial cwd — the two are deliberately different.)
      throw new UsageError(messages.invalidPackageJson(relative(currentDir, target)));
    }

    // Recorded unconditionally, which is what makes the *outermost* manifest the
    // selection when nothing on the way up declares a `packageManager`.
    selection = { data: data as Manifest, target };
  }

  // A manifest read *before* the env file that disables the project spec was
  // found is still discarded here: §11.1 says "entirely", and that includes the
  // eager devEngines validation below.
  if (selection === undefined || (projectSpecFlag && envDisabled("COREPACK_ENABLE_PROJECT_SPEC"))) {
    return { type: "NoProject", target: join(initialCwd, MANIFEST_NAME), envFilePath };
  }

  // devEngines validation is eager (a bad `onFail: "error"` must fail the run);
  // only `parseSpec` is deferred.
  const { raw, range, hasPin } = readSpecFromManifest(selection.data, selection.target);
  if (raw === undefined) {
    return { type: "NoSpec", target: selection.target, envFilePath };
  }

  // Messages name the manifest relative to where the user was standing.
  const source = relative(initialCwd, selection.target);
  return {
    type: "Found",
    target: selection.target,
    range,
    hasPin,
    envFilePath,
    getSpec: (opts: ParseSpecOptions) => parseSpec(raw, source, opts),
  };
}

/**
 * §03.4 — parse a spec string into a descriptor.
 *
 * `source` is `CLI arguments` or the manifest path relative to the initial cwd.
 * Note `name` is the substring before the **first** `@`, so `@scope/pkg@1.0.0`
 * yields an empty name and correctly fails the supported-name check.
 */
export function parseSpec(raw: unknown, source: string, options: ParseSpecOptions): Descriptor {
  // 1 — a non-string field (`packageManager: 42`, `null`, an object).
  if (typeof raw !== "string") {
    throw new UsageError(messages.invalidSpecNotString(source));
  }

  // 2 — `yarn` or `yarn@`: a name with no version at all. §15.23 widened what a
  // version may *be*, not whether a pin has to carry one, so this is untouched:
  // a manifest that names no version at all is still §12.2's error.
  const atIndex = raw.indexOf("@");
  if (atIndex === -1 || atIndex === raw.length - 1) {
    if (options.requireVersion) {
      throw new UsageError(messages.noVersionSpecified(raw, source));
    }
    const bareName = atIndex === -1 ? raw : raw.slice(0, -1);
    if (!isSupportedPackageManager(bareName)) {
      // Name-only form reports the *name*, not the raw string.
      throw new UsageError(messages.unsupportedSpec(bareName));
    }
    return { name: bareName, range: "*" };
  }

  // 3 — split on the *first* `@`.
  const name = raw.slice(0, atIndex);
  const range = raw.slice(atIndex + 1);

  // 4 — a URL reference is a different thing entirely from a version.
  if (URL.canParse(range)) {
    if (isSupportedPackageManager(name) && !envFlag("COREPACK_ENABLE_UNSAFE_CUSTOM_URLS")) {
      throw new UsageError(messages.illegalUrl(raw));
    }
  } else {
    // §15.23 — an exact version, a semver range, and a dist-tag are all valid
    // here; §04.1 classifies which is which, and a range or a tag additionally
    // has its resolution recorded in `.corepack.lock`. Corepack's
    // exact-version-only rule lived at exactly this line, and is the whole of
    // #95 (121👍), #402 and #729 — the rule that broke Dependabot, Renovate and
    // Netlify, and that pnpm 11.21's generated `devEngines` ranges trip over.
    //
    // Nothing is left to reject: what is neither a version nor a range is a tag,
    // and a tag that names nothing fails later with §12.4's `Tag not found`,
    // which says considerably more than "expected a semver version" did.
    //
    // Version-bearing form reports the whole raw string.
    if (!isSupportedPackageManager(name)) {
      throw new UsageError(messages.unsupportedSpec(raw));
    }
  }

  return { name, range };
}

/**
 * §03.3 — resolve `packageManager` against `devEngines.packageManager`.
 *
 * Validation happens in a specific order because each failure has a different
 * outcome, and `packageManager` always wins when present.
 */
export function readSpecFromManifest(
  manifest: unknown,
  manifestPath: string,
): { raw: unknown; range?: { name: string; range: string; onFail?: string }; hasPin: boolean } {
  void manifestPath; // Reserved: §15.25/§15.26 need it to report *which* file is at fault.

  const data = (manifest ?? {}) as Manifest;
  const pm = data.packageManager;
  const de = data.devEngines?.packageManager;

  // Only a *string* counts as a declared pin: `packageManager: 42` is a spec
  // error waiting to be reported, not a range `up` could refresh.
  const hasPin = typeof pm === "string";

  if (de === undefined || de === null) {
    return { raw: pm, hasPin };
  }

  // These first two never throw, whatever `onFail` says: the field is too
  // malformed for its own `onFail` to be trustworthy.
  if (typeof de !== "object") {
    console.warn(messages.devEnginesNotObject(de));
    return { raw: pm, hasPin };
  }
  if (Array.isArray(de)) {
    console.warn(messages.devEnginesArray());
    return { raw: pm, hasPin };
  }

  const { name, version, onFail } = de as DevEnginesPackageManager;

  if (typeof name !== "string" || name.includes("@")) {
    warnOrThrow(messages.devEnginesBadName(name), onFail);
    return { raw: pm, hasPin };
  }
  if (version !== undefined && version !== null) {
    if (typeof version !== "string" || !isValidRange(version)) {
      warnOrThrow(messages.devEnginesBadVersion(version), onFail);
      return { raw: pm, hasPin };
    }
  }

  const range: DevEnginesRange | undefined =
    typeof version === "string"
      ? { name, range: version, onFail: typeof onFail === "string" ? onFail : undefined }
      : undefined;

  if (pm !== undefined && pm !== null) {
    if (typeof pm !== "string" || !pm.startsWith(`${name}@`)) {
      warnOrThrow(messages.devEnginesNameMismatch(pm, name), onFail);
    } else if (
      typeof version === "string" &&
      // §15.23 — the cross-check compares a *version* against a range, so it
      // only applies when the pin carries one. Once the pin may itself be a
      // range or a tag (`pnpm@^11.0.0` beside a declared `>=11`), asking
      // `satisfies("^11.0.0", ">=11")` answers `false` for every input and would
      // turn the pnpm-generated shape §15.23 exists to support into a hard
      // error. Comparing two ranges properly means range containment, which
      // neither §03.3 nor §04.2 defines; the name check still applies, and the
      // resolved version still has to satisfy the pin's own range.
      isValidVersion(pm.slice(name.length + 1)) &&
      !satisfies(pm.slice(name.length + 1), version)
      // Strict satisfaction (§04.2): a prerelease pin does *not* silently pass a
      // plain range here, unlike the band lookup in §02.3.
    ) {
      warnOrThrow(messages.devEnginesVersionMismatch(pm, name, version), onFail);
    }
    // `packageManager` wins whenever it is present, even after a warning.
    return { raw: pm, range, hasPin };
  }

  return { raw: `${name}@${version ?? "*"}`, range, hasPin };
}

/**
 * §03.3 — `onFail` routing. Default is **error**; an unrecognised value degrades
 * to a warning rather than being rejected. Both must be preserved.
 */
export function warnOrThrow(message: string, onFail?: unknown): void {
  switch (onFail) {
    case "ignore": {
      return;
    }
    case "error":
    case undefined: {
      throw new UsageError(message);
    }
    default: {
      // Includes `"warn"` — and anything unrecognised, which degrades here
      // rather than becoming an error about the error handling.
      console.warn(`${VALIDATION_WARNING_PREFIX}${message}`);
    }
  }
}

/** §03.5 — reconcile the discovered spec with the requested binary. */
export function reconcile(
  result: SpecResult,
  fallback: LazyLocator,
  options: { requestedName: string; transparent: boolean; binaryVersion?: string },
): Descriptor | LazyLocator {
  const { requestedName, binaryVersion } = options;

  // An explicit CLI version replaces the *range*, never the name — which is why
  // `corepack yarn@1.22.4 --version` works in a Yarn 4 project while
  // `corepack pnpm@9 install` in that same project still errors.
  const withBinaryVersion = (descriptor: Descriptor | LazyLocator): Descriptor | LazyLocator =>
    binaryVersion === undefined ? descriptor : { name: descriptor.name, range: binaryVersion };

  // Never look at the project at all.
  if (envDisabled("COREPACK_ENABLE_PROJECT_SPEC")) {
    return withBinaryVersion(fallback);
  }

  // "Treats it like transparent": a mismatch falls back instead of erroring.
  const transparent = options.transparent || envDisabled("COREPACK_ENABLE_STRICT");

  switch (result.type) {
    case "NoProject": {
      return withBinaryVersion(fallback);
    }
    case "NoSpec": {
      // Auto-pin (§03.6) needs the network and a store write, so the proxy path
      // performs it before calling here; the reconciled answer is the same.
      return withBinaryVersion(fallback);
    }
    case "Found": {
      const spec = result.getSpec({ requireVersion: binaryVersion === undefined });
      if (spec.name !== requestedName) {
        if (transparent) {
          return withBinaryVersion(fallback);
        }
        throw new UsageError(messages.projectConfigured(spec.name, result.target));
      }
      return withBinaryVersion(spec);
    }
  }
}

/**
 * §03.7 — write the pin, preserving indentation, line endings, key order, and
 * (per §14.7) the BOM. Returns the previous value for `COREPACK_MIGRATE_FROM`.
 */
export function writePin(
  cwd: string,
  info: { name: string; reference: string },
): { previousPackageManager: string; target: string } {
  // 1 — re-run discovery: the file to edit is not necessarily in `cwd`.
  const lookup = discoverProjectSpec(cwd);
  const target = pinTarget(lookup);
  const range = lookup.type === "Found" ? lookup.range : undefined;

  // 2 — the package manager being pinned must be the one `devEngines` declares,
  // *and* its version must satisfy the declared range. Checking only the version
  // lets `use pnpm@6.6.2` succeed in a project whose devEngines say `yarn@6.x`,
  // writing a pin that then fails §03.3's name check on every subsequent run —
  // permanently, since nothing but a hand edit can undo it.
  if (
    range !== undefined &&
    (info.name !== range.name || !satisfies(info.reference, range.range))
  ) {
    warnOrThrow(
      messages.devEnginesPinMismatch(info.name, info.reference, range.name, range.range),
      range.onFail,
    );
  }

  // 3 — a missing file is an empty document, so `NoProject` creates one.
  let content = "";
  if (lookup.type !== "NoProject") {
    try {
      content = readFileSync(target, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  // 4 — tolerant read: BOM stripped for parsing, empty content is `{}`.
  let data: Manifest = {};
  try {
    const parsed = parseManifest(content);
    if (typeof parsed === "object" && parsed !== null) {
      data = parsed as Manifest;
    }
  } catch {
    // `use` must be able to overwrite a manifest it cannot fully parse only as
    // far as the surgical edit allows; `setTopLevelString` re-validates below.
  }

  // 6 — what the package manager's own `use` command is told to migrate from.
  const previousPackageManager =
    typeof data.packageManager === "string"
      ? data.packageManager
      : range === undefined
        ? "unknown"
        : `${range.name}@${range.range}`;

  // 5, 7, 8 — the rewrite preserves indentation, line endings, key order and the
  // BOM; the reference carries its freshly computed hash suffix.
  const updated = setTopLevelString(content, "packageManager", `${info.name}@${info.reference}`);

  // 9 — in the `NoProject` case this creates `<cwd>/package.json`.
  writeFileSync(target, updated);

  // `target` goes back to the caller because §15.23's `.corepack.lock` lives
  // beside *this* file, not beside the cwd — in a monorepo those differ, and a
  // resolution recorded next to the wrong manifest would never be found again.
  return { previousPackageManager, target };
}
