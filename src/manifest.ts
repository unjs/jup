/**
 * Project spec discovery and parsing — §03.
 *
 * Answers "which package manager, at which version range, does this directory
 * want?" It touches the filesystem only, never the network.
 */

import { readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { isSupportedPackageManager } from "./config/table.ts";
import { applyEnvFile, envDisabled, envFlag, loadEnvFileFrom } from "./env.ts";
import { messages, UsageError, VALIDATION_WARNING_PREFIX } from "./errors.ts";
import {
  detectFormat,
  parseManifest,
  scanTopLevelFields,
  scanTopLevelKey,
  setNestedString,
  setTopLevelString,
} from "./json.ts";
import { isValidRange, isValidVersion, parse, satisfies } from "./semver.ts";
import type {
  Descriptor,
  DevEnginesDeclaration,
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
 * §15.27 — the extra field a *mutating* walk needs, and only a mutating walk.
 *
 * `workspaces` on a real manifest is an array (sometimes a large one), and
 * {@link scanTopLevelFields} allocates a value for every field it is asked for.
 * The warm proxy path answers a two-field question (§16.3) and must keep
 * answering exactly that, so the third field is requested only where the answer
 * is used.
 */
const MUTATING_MANIFEST_FIELDS = [...MANIFEST_FIELDS, "workspaces"] as const;

/** §15.27 — a directory containing this is a workspace root even with no `workspaces` field. */
const PNPM_WORKSPACE_FILE = "pnpm-workspace.yaml";

/**
 * §03.1 as amended by §15.25 — the walk's stop condition.
 *
 * Corepack's loop condition is `!selection || !selection.data.packageManager`:
 * a *truthiness* test on one field. Two consequences, both defects (#779):
 *
 * * a manifest declaring only `devEngines.packageManager` does not stop the
 *   climb, so a parent's spec — or the global default — silently wins over the
 *   nested project's own declaration;
 * * `packageManager: null` reads as "absent" rather than as "declared and
 *   invalid", so the walk sails past a manifest whose author plainly meant to
 *   say something.
 *
 * Both fields are stop conditions here, and the test is **key presence**, not
 * truthiness: a declared-but-invalid value stops the walk and is then reported
 * by `parseSpec`, which is where an invalid value belongs.
 */
function stopsWalk(data: Manifest | undefined): boolean {
  if (data === undefined) return false;
  if (Object.hasOwn(data, "packageManager")) return true;

  const devEngines = data.devEngines;
  return (
    typeof devEngines === "object" &&
    devEngines !== null &&
    Object.hasOwn(devEngines, "packageManager") &&
    devEngines.packageManager !== undefined &&
    devEngines.packageManager !== null
  );
}

/**
 * §15.27 — a workspace root, where a mutating walk must stop.
 *
 * #607: `corepack use` in a nested directory of a monorepo updates the *root*
 * `package.json`, which corepack's author confirmed is intentional and agreed is
 * surprising. Climbing to the workspace root is right — a monorepo pins its
 * package manager once — but climbing *past* it is never right, and that is what
 * happens today when some ancestor of the repository (a `$HOME/package.json`,
 * §15.35k's other victim) happens to carry a pin.
 *
 * Both conventions count: `workspaces` in the manifest (npm, yarn, bun) and a
 * `pnpm-workspace.yaml` beside it (pnpm).
 */
function isWorkspaceRoot(dir: string, data: Manifest): boolean {
  if (Object.hasOwn(data, "workspaces") && data.workspaces !== undefined) return true;
  return statSync(join(dir, PNPM_WORKSPACE_FILE), { throwIfNoEntry: false }) !== undefined;
}

/**
 * §03.1 — walk from `cwd` toward the root.
 *
 * At each directory: skip if it is a package dir inside `node_modules`; load the
 * env file if none has been loaded yet; read `package.json`. The walk stops on a
 * manifest declaring either package-manager field ({@link stopsWalk}, §15.25),
 * and the **last** manifest seen is what gets recorded — which is why a monorepo
 * with no declaration anywhere yields `NoSpec` targeting the *root*.
 *
 * `mutating` adds §15.27's workspace-boundary stop condition and `here` confines
 * the selection to `cwd`'s own manifest; both are for commands that are about to
 * *write*, and neither affects what the proxy path reads.
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
  options?: { envOnly?: boolean; projectSpecFlag?: boolean; mutating?: boolean; here?: boolean },
): SpecResult {
  const initialCwd = resolve(cwd);
  let envOnly = options?.envOnly === true;
  const projectSpecFlag = options?.projectSpecFlag === true;
  const mutating = options?.mutating === true;
  const here = options?.here === true;
  const fields = mutating ? MUTATING_MANIFEST_FIELDS : MANIFEST_FIELDS;

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

    // §15.27 — `--here` mutates the manifest the user is standing in, full stop.
    // The climb continues for the env file alone (which may carry the registry
    // settings the resolution needs), so from the second directory on this is
    // exactly `envOnly`.
    if (here && currentDir !== initialCwd) {
      envOnly = true;
    }

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
    let data: unknown = scanTopLevelFields(content, fields);
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

    // §15.27 — a mutating walk stops at the workspace root even when that
    // manifest declares no package manager at all. Non-mutating discovery keeps
    // climbing, because *reading* a pin from further up is the documented
    // monorepo behaviour (§03.1); it is only *writing* one past the repository
    // that surprises people.
    if (mutating && isWorkspaceRoot(currentDir, selection.data)) {
      break;
    }
  }

  // A manifest read *before* the env file that disables the project spec was
  // found is still discarded here: §11.1 says "entirely", and that includes the
  // eager devEngines validation below.
  if (selection === undefined || (projectSpecFlag && envDisabled("COREPACK_ENABLE_PROJECT_SPEC"))) {
    return { type: "NoProject", target: join(initialCwd, MANIFEST_NAME), envFilePath };
  }

  // devEngines validation is eager (a bad `onFail: "error"` must fail the run);
  // only `parseSpec` is deferred.
  const { raw, range, hasPin, devEngines } = readSpecFromManifest(selection.data, selection.target);
  if (raw === undefined) {
    return { type: "NoSpec", target: selection.target, envFilePath };
  }

  // Messages name the manifest relative to where the user was standing.
  const source = relative(initialCwd, selection.target);
  return {
    type: "Found",
    target: selection.target,
    range,
    devEngines,
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
): {
  raw: unknown;
  range?: DevEnginesRange;
  /** §15.26 — the declaration itself, present even when it names no version. */
  devEngines?: DevEnginesDeclaration;
  hasPin: boolean;
} {
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
  // §15.12 — the sidecar spelling of the pin. Read here so the same `onFail`
  // routing governs it as governs every other field of the block.
  const integrity = (de as Record<string, unknown>).integrity;

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

  const failure = typeof onFail === "string" ? onFail : undefined;
  const range: DevEnginesRange | undefined =
    typeof version === "string" ? { name, range: version, onFail: failure } : undefined;

  // §15.26 — reported whether or not a version was declared. A block naming only
  // a package manager still says which one the project is for, and `writePin`
  // has to honour that or it writes a pin §03.3 refuses to read.
  const devEngines: DevEnginesDeclaration = { name, onFail: failure };
  if (typeof version === "string") devEngines.version = version;

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
    return { raw: withSidecarIntegrity(pm, integrity, onFail), range, devEngines, hasPin };
  }

  return {
    raw: withSidecarIntegrity(`${name}@${version ?? "*"}`, integrity, onFail),
    range,
    devEngines,
    hasPin,
  };
}

/**
 * §15.12 — fold `devEngines.packageManager.integrity` into the spec string.
 *
 * The sidecar exists because `<version>+<algo>.<hex>` is valid semver build
 * metadata but stops `packageManager` round-tripping through tools that treat
 * it as a version (#316, #726, #620). Both spellings MUST be accepted on read,
 * and the cheapest way to *mean the same thing* is to make them literally the
 * same thing: an SRI beside a clean `yarn@4.14.1` becomes `yarn@4.14.1+sha512.…`
 * here, and from that point §06.1 row 1 treats it exactly as it treats a
 * hand-written suffix — including §15.11's "a pinned hash is a verification
 * tier".
 *
 * Three shapes are deliberately left alone:
 *
 * * a spec that already carries a build suffix — the explicit spelling wins,
 *   and a *disagreeing* sidecar is reported through `onFail` rather than
 *   silently discarded, because two digests for one artifact means at most one
 *   of them describes what will run;
 * * a range or a dist-tag, which no single digest can describe. §15.23's
 *   `.corepack.lock` is where a range's resolved digest lives, and it records
 *   one on the first resolve;
 * * a URL reference, which carries its hash in the fragment (§02.1).
 */
function withSidecarIntegrity(raw: unknown, integrity: unknown, onFail: unknown): unknown {
  if (integrity === undefined || integrity === null) return raw;
  if (typeof raw !== "string") return raw;

  if (typeof integrity !== "string") {
    warnOrThrow(messages.devEnginesBadIntegrity(integrity), onFail);
    return raw;
  }

  const hash = hashFromIntegrity(integrity);
  if (hash === undefined) {
    warnOrThrow(messages.devEnginesBadIntegrity(integrity), onFail);
    return raw;
  }

  const at = raw.indexOf("@");
  if (at <= 0) return raw;

  const reference = raw.slice(at + 1);
  const parsed = parse(reference);
  // Not an exact version: a range, a dist-tag, or a URL. Nothing a single
  // digest can describe, so the field is left where it is.
  if (parsed === null) return raw;
  const suffix = parsed.build.length === 0 ? "" : `+${parsed.build.join(".")}`;
  // `parse` normalises (`v1.22.4` -> `1.22.4`); rewriting a reference into a
  // different string than the manifest holds is not this function's business.
  if (`${parsed.version}${suffix}` !== reference) return raw;

  if (suffix !== "") {
    if (parsed.build.join(".").toLowerCase() !== hash) {
      warnOrThrow(messages.devEnginesIntegrityMismatch(raw, integrity), onFail);
    }
    return raw;
  }

  return `${raw.slice(0, at)}@${parsed.version}+${hash}`;
}

/**
 * `sha512-<base64>` -> `sha512.<hex>`, the build-suffix spelling of §02.1.
 *
 * Duplicated from `lockfile.ts` for the same reason {@link integrityFromHash}
 * is: `manifest.ts` is on the warm path and `lockfile.ts` is loaded only when a
 * spec is a range, so importing it here would put it in every invocation's
 * module graph to serve one field that almost no manifest carries. `integrity`
 * is likewise not reached for, because it pulls `node:crypto` (§16.3); an
 * algorithm this implementation does not support is rejected by `install` with
 * §12's own message, and rejecting it twice would give one input two errors.
 */
function hashFromIntegrity(integrity: string): string | undefined {
  const entry = integrity.trim().split(/\s+/)[0] ?? "";
  const dash = entry.indexOf("-");
  if (dash <= 0) return undefined;

  const algo = entry.slice(0, dash).toLowerCase();
  if (!/^[a-z][\da-z]*$/.test(algo)) return undefined;

  const base64 = entry.slice(dash + 1).split("?")[0] ?? "";
  if (!/^[\d+/A-Za-z]+={0,2}$/.test(base64)) return undefined;

  const hex = Buffer.from(base64, "base64").toString("hex");
  return hex === "" ? undefined : `${algo}.${hex}`;
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
 * §03.7, as amended by §15.26 and §15.27 — write the pin.
 *
 * Preserves indentation, line endings, key order, and (per §14.7) the BOM.
 * Returns the previous value for `COREPACK_MIGRATE_FROM`, and the path actually
 * modified so the caller can print it (§15.35l).
 *
 * **Which field gets written** is §15.26's whole subject, and the rule has three
 * branches rather than one:
 *
 * | Manifest declares | Written |
 * |---|---|
 * | `packageManager` only, or neither | `packageManager` |
 * | `devEngines.packageManager` for **this** package manager, no `packageManager` | `devEngines.packageManager.version` (+ `integrity`) |
 * | both, for this package manager | `packageManager`; `devEngines` left alone |
 *
 * Row two is #874: `corepack use pnpm@latest` on a devEngines-only project
 * writes a top-level `packageManager` that then conflicts with the declaration
 * beside it — a hash-presence difference is enough — so the very next run fails
 * §03.3. The fix is not to create the second field at all.
 *
 * Row three needs no `devEngines` update *because* nothing broke: the value
 * being written already satisfies the declared range, which is exactly what the
 * check above establishes, and rewriting `1.x || 2.x` into `2.4.3` would destroy
 * the statement of intent that §09.4 relies on to carry `up` across a major.
 * §15.26's post-write requirement — "validation MUST run against the state being
 * written" — is met by the check being the same predicate §03.3 applies on read,
 * with the same `onFail`.
 *
 * When the declared name is a *different* package manager, `devEngines` is not
 * describing this pin at all: the mismatch is reported through `onFail` and,
 * if that does not throw, the pin goes to `packageManager` where a reader can
 * still see both statements.
 */
export function writePin(
  cwd: string,
  info: { name: string; reference: string; hash?: string },
  options?: { here?: boolean; pinStyle?: PinStyle },
): { previousPackageManager: string; target: string; written: string } {
  // 1 — re-run discovery: the file to edit is not necessarily in `cwd`. §15.27's
  // extra stop conditions apply here and only here, because this is the write.
  const lookup = discoverProjectSpec(cwd, { mutating: true, here: options?.here === true });
  const target = lookup.target;
  const declared = lookup.type === "Found" ? lookup.devEngines : undefined;
  const range = lookup.type === "Found" ? lookup.range : undefined;

  // 3 — a missing file is an empty document, so `NoProject` creates one. It is
  // read *before* the validation below because §15.26 requires that validation
  // to run against the state being **written**, and what is about to be written
  // depends on which fields the file already has.
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

  const devEnginesTarget = devEnginesWriteTarget(data, declared, info);

  // 2 — the package manager being pinned must be the one `devEngines` declares,
  // *and* its version must satisfy the declared range. Checking only the version
  // lets `use pnpm@6.6.2` succeed in a project whose devEngines say `yarn@6.x`,
  // writing a pin that then fails §03.3's name check on every subsequent run —
  // permanently, since nothing but a hand edit can undo it.
  //
  // §15.26 — the name half runs even when no version is declared. Corepack (and
  // this implementation before now) only reached the check through the *range*,
  // so `devEngines: {packageManager: {name: "yarn"}}` imposed nothing at all on
  // `corepack use pnpm@6`, and the resulting manifest was one §03.3 rejects by
  // default on every later run.
  //
  // The version half is skipped for exactly one shape — see
  // {@link devEnginesWriteTarget} — because there is nothing left to violate
  // once the declared value is the value being replaced. That is §15.26's
  // "validation MUST run against the state being written, not the state on disk".
  if (declared !== undefined && info.name !== declared.name) {
    warnOrThrow(
      messages.devEnginesPinMismatch(
        info.name,
        info.reference,
        declared.name,
        declared.version ?? "*",
      ),
      declared.onFail,
    );
  } else if (
    range !== undefined &&
    !devEnginesTarget.replacesDeclaredVersion &&
    !satisfies(info.reference, range.range)
  ) {
    warnOrThrow(
      messages.devEnginesPinMismatch(info.name, info.reference, range.name, range.range),
      range.onFail,
    );
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
  //
  // §15.26 — "a command that writes a pin MUST update **every** field that
  // encodes it", so the two writes compose rather than choosing between each
  // other. A `devEngines` write that could not be made surgically falls back to
  // the top-level field: writing the pin somewhere is always better than writing
  // it nowhere and reporting success.
  // §15.12 — `--pin-style=sidecar` moves the digest out of the version string
  // and into `devEngines.packageManager.integrity`, creating the block when the
  // manifest has none. The suffixed form stays the default: it is the
  // interoperable spelling and §13 asserts it.
  const sidecar = options?.pinStyle === "sidecar";

  let updated = content;
  let wroteDevEngines = false;
  if (devEnginesTarget.write || sidecar) {
    const next = sidecar
      ? writeSidecarPin(updated, data, info)
      : writeIntoDevEngines(updated, info);
    if (next !== null) {
      updated = next;
      wroteDevEngines = true;
    }
  }
  // What the pin field now holds, which is what the caller reports (§15.35l). It
  // differs from `info.reference` only in §15.12's sidecar form, where the
  // digest moved out of the version string and a line quoting the suffix would
  // name a string that is nowhere in the file.
  let written = info.reference;
  if (!devEnginesTarget.exclusive || !wroteDevEngines) {
    // A sidecar write that landed is what makes the clean version *readable*
    // again (§15.12 reads them as one pin); one that did not must keep the
    // suffix, or the pin would be written nowhere at all.
    if (sidecar && wroteDevEngines) written = parse(info.reference)?.version ?? info.reference;
    updated = setTopLevelString(updated, "packageManager", `${info.name}@${written}`);
  }

  // 9 — in the `NoProject` case this creates `<cwd>/package.json`.
  writeFileSync(target, updated);

  // `target` goes back to the caller because §15.23's `.corepack.lock` lives
  // beside *this* file, not beside the cwd — in a monorepo those differ, and a
  // resolution recorded next to the wrong manifest would never be found again.
  // §15.27 also requires it to be *printed*, and printing is the caller's job.
  return { previousPackageManager, target, written };
}

/**
 * §15.26 — which field (or fields) this pin belongs in.
 *
 * `devEngines.packageManager.version` is validated as a semver **range** (§03.3),
 * and the distinction between a range and an exact version is the one that
 * decides everything here:
 *
 * * an **exact** version is a *pin* — it says "this release" — so a mutating
 *   command replaces it, and there is nothing left for the version check to
 *   object to (`replacesDeclaredVersion`). This is #874's shape, where a
 *   hash-presence difference between the two fields is enough to make the next
 *   read fail;
 * * a **range** is a *constraint* — it says "anything in here" — so it is
 *   honoured, never overwritten. Collapsing `1.x || 2.x` into `2.4.3` would
 *   destroy the declaration §09.4 relies on to carry `corepack up` across a
 *   major boundary, and would silently narrow what the project accepts.
 *
 * `exclusive` is §15.26's second bullet: with no top-level `packageManager` the
 * pin goes into `devEngines` and **no** `packageManager` is created. Creating
 * one is what breaks #874.
 */
function devEnginesWriteTarget(
  data: Manifest,
  declared: DevEnginesDeclaration | undefined,
  info: { name: string; reference: string },
): { write: boolean; exclusive: boolean; replacesDeclaredVersion: boolean } {
  const none = { write: false, exclusive: false, replacesDeclaredVersion: false };

  // A declaration for a *different* package manager does not describe this pin;
  // the mismatch is reported through `onFail` and the pin goes to the top level,
  // where a reader can still see both statements.
  if (declared === undefined || declared.name !== info.name) return none;
  // A URL reference has no semver to record in a semver field.
  if (parse(info.reference) === null) return none;

  // A `packageManager` key that is present but not a string is a spec error the
  // user is about to have overwritten — write it at the top level, as before.
  const hasPin = typeof data.packageManager === "string";
  const hasBrokenPin =
    Object.hasOwn(data, "packageManager") && !hasPin && data.packageManager != null;
  if (hasBrokenPin) return none;

  const declaredExactVersion = declared.version !== undefined && isValidVersion(declared.version);

  if (!hasPin) {
    // §15.26 bullet 2 — the pin lives where the declaration already is.
    return { write: true, exclusive: true, replacesDeclaredVersion: declaredExactVersion };
  }

  // Both fields. `packageManager` is the one §03.3 reads, so it is always
  // written; `devEngines` is only rewritten when it was itself a pin.
  return {
    write: declaredExactVersion,
    exclusive: false,
    replacesDeclaredVersion: declaredExactVersion,
  };
}

/** §15.12 — where `use`/`up` put the digest. The suffixed form is the default. */
export type PinStyle = "suffix" | "sidecar";

/**
 * §15.12 — write the pin as a clean version plus a sidecar `integrity`.
 *
 * Returns `null` when the sidecar cannot be written, in which case the caller
 * falls back to the suffixed form: a pin written nowhere is worse than a pin
 * written in the interoperable spelling the user did not ask for.
 */
function writeSidecarPin(
  content: string,
  data: Manifest,
  info: { name: string; reference: string; hash?: string },
): string | null {
  const version = parse(info.reference)?.version;
  if (version === undefined || info.hash === undefined) return null;

  const integrity = integrityFromHash(info.hash);
  if (integrity === undefined) return null;

  const block = (data.devEngines as { packageManager?: unknown } | undefined)?.packageManager;

  // No `devEngines` at all: create the block, name included — §03.3 reads
  // `name` first and a block without one describes nothing.
  if (!Object.hasOwn(data, "devEngines")) {
    return createDevEnginesBlock(content, info.name, version, integrity);
  }

  // A block that is not an object, or that speaks for a different package
  // manager, is not ours to rewrite.
  if (typeof block !== "object" || block === null || Array.isArray(block)) return null;
  const declaredName = (block as { name?: unknown }).name;
  if (declaredName !== undefined && declaredName !== info.name) return null;

  return writeIntoDevEngines(content, info);
}

/**
 * Insert a whole `devEngines.packageManager` block, preserving the document's
 * indentation, line endings and BOM.
 *
 * `json.ts` inserts *string* values only, which is all §15.26 ever needed. The
 * two-step here — insert a placeholder string under the key, then swap its value
 * span for the object literal — reuses that machinery rather than growing a
 * JSON builder for one caller, and re-parses the result before returning it so
 * a manifest is never left in a shape this could not read back.
 */
function createDevEnginesBlock(
  content: string,
  name: string,
  version: string,
  integrity: string,
): string | null {
  let seeded: string;
  try {
    seeded = setTopLevelString(content, "devEngines", "");
  } catch {
    return null;
  }

  const span = scanTopLevelKey(seeded, "devEngines");
  if (span === null) return null;

  // `json.ts` inserts a one-line entry into a one-line object and a
  // freshly-indented one into a multi-line object; the value has to match, or a
  // compact manifest gains a five-line block wedged into its single line.
  const head = seeded.slice(0, span.start);
  const inline = !head.slice(head.lastIndexOf("{")).includes("\n");

  const { indent, eol } = detectFormat(seeded);
  const at = (depth: number): string => indent.repeat(depth);
  const literal = inline
    ? JSON.stringify({ packageManager: { name, version, integrity } })
    : `{${eol}${at(2)}"packageManager": {${eol}` +
      `${at(3)}"name": ${JSON.stringify(name)},${eol}` +
      `${at(3)}"version": ${JSON.stringify(version)},${eol}` +
      `${at(3)}"integrity": ${JSON.stringify(integrity)}${eol}` +
      `${at(2)}}${eol}${at(1)}}`;

  const result = seeded.slice(0, span.start) + literal + seeded.slice(span.end);
  try {
    const parsed = parseManifest(result);
    if (typeof parsed !== "object" || parsed === null) return null;
  } catch {
    return null;
  }
  return result;
}

/**
 * §15.26 — write the pin into `devEngines.packageManager`, or `null` if the
 * surgical edit could not be made.
 *
 * The version written is the **plain** semver version and the digest goes to
 * `integrity` beside it (§15.12's shape), because `devEngines.packageManager.version`
 * is validated as a semver *range* by §03.3 and a `+sha512.…` suffix has no
 * business in one. `integrity` is only written when a usable digest is
 * available, and it is never left behind pointing at a version that has moved,
 * because it is rewritten in the same edit as the version it describes.
 */
function writeIntoDevEngines(
  content: string,
  info: { name: string; reference: string; hash?: string },
): string | null {
  const version = parse(info.reference)?.version;
  if (version === undefined) return null;

  const withVersion = setNestedString(
    content,
    ["devEngines", "packageManager", "version"],
    version,
  );
  if (withVersion === null) return null;

  if (info.hash === undefined) return withVersion;
  const integrity = integrityFromHash(info.hash);
  if (integrity === undefined) return withVersion;

  return (
    setNestedString(withVersion, ["devEngines", "packageManager", "integrity"], integrity) ??
    withVersion
  );
}

/**
 * `sha512.<hex>` -> `sha512-<base64>`, the SRI spelling `integrity` fields use.
 *
 * Duplicated rather than imported from `lockfile.ts` on purpose: `manifest.ts`
 * is on the warm path and `lockfile.ts` is loaded only when a spec is a range,
 * so importing it here would put it in every single invocation's module graph to
 * serve a branch that only `use`/`up` reach.
 */
function integrityFromHash(hash: string): string | undefined {
  const dot = hash.indexOf(".");
  if (dot <= 0) return undefined;

  const algo = hash.slice(0, dot).toLowerCase();
  const hex = hash.slice(dot + 1);
  if (!/^[a-z][\da-z]*$/.test(algo) || !/^(?:[\da-f]{2})+$/i.test(hex)) return undefined;

  return `${algo}-${Buffer.from(hex, "hex").toString("base64")}`;
}
