/**
 * Project spec discovery and parsing — §03.
 *
 * Answers "which package manager, at which version range, does this directory
 * want?" It touches the filesystem only, never the network.
 */

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { ENV, readEnv } from "../config/env-vars.ts";
import { getRoles, isSupportedPackageManager, ROLE_ORDER } from "../config/table.ts";
import { applyEnvFile, envDisabled, envFlag, loadEnvFileFrom } from "./env.ts";
import { messages, UsageError, validationWarningPrefix } from "../errors.ts";
import { parseManifest, scanTopLevelFields } from "../utils/json.ts";
import { isValidRange, isValidVersion, parse, satisfies } from "../version/semver.ts";
import type {
  Descriptor,
  DevEnginesBlock,
  DevEnginesDeclaration,
  DevEnginesRange,
  LazyLocator,
  Manifest,
  ParseSpecOptions,
  ProjectPin,
  Role,
  SpecResult,
} from "../types.ts";

/** Directories inside a `node_modules` are skipped, so a dependency cannot hijack its host. */
export const NODE_MODULES_RE = /[\\/]node_modules[\\/](@[^\\/]*[\\/])?([^@\\/][^\\/]*)$/;

/** The manifest file name the walk looks for in every directory. */
const MANIFEST_NAME = "package.json";

/** §03.4 — the `source` reported for anything the user typed on the command line. */
export const CLI_SOURCE = "CLI arguments";

/** §17.3 R4 row 1 — the manifest fields that encode one role's pin. */
export interface PinFields {
  /**
   * The top-level field, for the one role that has one. §17.5 R14: "There is no
   * top-level `runtime` field and this specification MUST NOT invent one;
   * `packageManager` is a historical shape, not a pattern to repeat."
   */
  readonly top?: "packageManager";
  /** The `devEngines` sub-key, which every role has (§02.7). */
  readonly block: "packageManager" | "runtime";
}

/**
 * §17.3 R4 row 1, §17.5 R14 — where each role's pin lives, as **data**.
 *
 * This map and `table.ts`'s `ROLE_ORDER` are the whole of "which field does this
 * role read": every reader below is parameterised by a role and looks its fields
 * up here, so R3's "adding a runtime MUST be a data-only change" holds for §03
 * too. Nothing in this file compares a role against a literal.
 *
 * `devEngines.runtime` is therefore "parsed, validated, and reconciled by the
 * same rules §03.3 applies to `devEngines.packageManager`, `onFail` included"
 * (R14) by construction rather than by a second copy of §03.3.
 */
export const PIN_FIELDS: Readonly<Record<Role, PinFields>> = {
  "package-manager": { top: "packageManager", block: "packageManager" },
  runtime: { block: "runtime" },
};

/**
 * How a message names the field that holds this role's pin.
 *
 * `packageManager` for a package manager — which is what every §12 string
 * carrying the name says today, byte for byte — and `devEngines.runtime` for a
 * role whose pin has no top-level home (§17.5 R14).
 */
export function pinFieldLabel(role: Role): string {
  return pinFieldLabels(role)[0]!;
}

/**
 * **Every** field that holds this role's pin, primary first — §17.6 C10a.
 *
 * The one §12.9 sentence that names the noun *and* the fields names both of the
 * package manager's ("a 'packageManager' field nor a 'devEngines.packageManager'
 * field"), so C10a's "the field names move with the noun" needs the list, not
 * just the label. {@link pinFieldLabel} is its head, which is what makes the two
 * one mapping rather than two.
 */
export function pinFieldLabels(role: Role): readonly string[] {
  const fields = PIN_FIELDS[role];
  const block = `devEngines.${fields.block}`;
  return fields.top === undefined ? [block] : [fields.top, block];
}

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
 *
 * `devEngines.runtime` (§17.5 R14) is deliberately **not** a stop condition, and
 * neither is any other role's field. §03.8 is explicit: "Until a runtime enters
 * the table (§02.5), the walk's stop conditions, precedence, and error messages
 * are exactly as specified above" — so the walk still selects one manifest by the
 * package-manager fields, and every role's pin is then read out of that manifest
 * (§17.4 R10 row 2's "every role the project pins"). Making a runtime-only
 * manifest stop the climb would silently strip the package-manager pin a parent
 * declares, which is a precedence question §17.7 has not answered.
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
  // §15.35d — an external spec file replaces the manifest, so the walk climbs
  // for the env file alone. Read before the walk begins, which is sound because
  // §15.37 makes the variable env-file ineligible: nothing loaded on the way up
  // can introduce it half-way. Degrading to `envOnly` is the point rather than
  // an optimisation — #682 and #402 are vendored trees whose `package.json`
  // cannot be edited, sometimes because it says the *wrong* thing, and a walk
  // that still parsed it would fail on exactly the file being bypassed.
  const specFile = externalSpecFile(initialCwd);
  let envOnly = options?.envOnly === true || specFile !== undefined;
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
    // includes its `.jup.env`, so this runs before the env file is loaded.
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
    // *after* the env-file step, because `.jup.env` is allowed to be what
    // sets the variable (§03.2); corepack returns before any walk and so cannot
    // honour an env file at all. From this point the walk is exactly `envOnly`:
    // it keeps climbing for an env file and records no manifest, so the result is
    // `NoProject` and §03.5 falls back.
    if (projectSpecFlag && envDisabled(ENV.ENABLE_PROJECT_SPEC)) {
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

  const specDisabled = projectSpecFlag && envDisabled(ENV.ENABLE_PROJECT_SPEC);

  // §15.35d — the external file is the project's declaration and outranks the
  // manifest. `COREPACK_ENABLE_PROJECT_SPEC=0` still wins over both: §11.1's
  // "never look at the project at all" covers a redirected spec too.
  if (specFile !== undefined && !specDisabled) {
    return describe(readExternalSpec(specFile), specFile, initialCwd, envFilePath);
  }

  // A manifest read *before* the env file that disables the project spec was
  // found is still discarded here: §11.1 says "entirely", and that includes the
  // eager devEngines validation below.
  if (selection === undefined || specDisabled) {
    return { type: "NoProject", target: join(initialCwd, MANIFEST_NAME), envFilePath };
  }

  return describe(selection.data, selection.target, initialCwd, envFilePath);
}

/**
 * The `SpecResult` for one already-read manifest — the walk's selection, or
 * §15.35d's external file, which get identical treatment. devEngines validation
 * is eager (a bad `onFail: "error"` must fail the run); `parseSpec` is deferred.
 *
 * §17.4 R10 row 2 — one pin per role the manifest declares, in {@link ROLE_ORDER}
 * (package manager first). The result is `Found` when at least one role is
 * pinned and `NoSpec` when none is, which for a table containing only
 * package-manager tools is the same test this made before, run once.
 *
 * The extra role costs no I/O: `devEngines` is already one of the two fields
 * {@link scanTopLevelFields} extracts, so its `runtime` sub-key arrives with the
 * `packageManager` one and the warm path still answers a two-field question
 * (§16.3).
 */
function describe(
  data: Manifest,
  target: string,
  initialCwd: string,
  envFilePath: string | undefined,
): SpecResult {
  // Messages name the manifest relative to where the user was standing.
  const source = relative(initialCwd, target);
  const pins: Partial<Record<Role, ProjectPin>> = {};

  for (const role of ROLE_ORDER) {
    const { raw, range, hasPin, devEngines } = readSpecFromManifest(data, target, role);
    if (raw === undefined) continue;

    const pin: ProjectPin = {
      hasPin,
      getSpec: (opts: ParseSpecOptions) => parseSpec(raw, source, opts),
    };
    if (range !== undefined) pin.range = range;
    if (devEngines !== undefined) pin.devEngines = devEngines;
    pins[role] = pin;
  }

  if (ROLE_ORDER.every((role) => pins[role] === undefined)) {
    return { type: "NoSpec", target, envFilePath };
  }

  return { type: "Found", target, pins, envFilePath };
}

/** §15.35d — `COREPACK_SPEC_FILE` resolved against the initial cwd, or `undefined`. */
function externalSpecFile(initialCwd: string): string | undefined {
  const configured = readEnv(ENV.SPEC_FILE);
  return configured === undefined || configured === ""
    ? undefined
    : resolve(initialCwd, configured);
}

/**
 * §15.35d — the spec file's contents, in `package.json` shape.
 *
 * A missing file is an error, not a fallback: quietly reverting to the manifest
 * on a typo would run the package manager the variable was set to override.
 * Everything else about it is a manifest — the same two fields, the same
 * `devEngines` validation, the same errors naming the file at fault.
 */
function readExternalSpec(path: string): Manifest {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new UsageError(messages.specFileMissing(path));
    }
    throw error;
  }

  let data: unknown;
  try {
    data = parseManifest(content);
  } catch {
    data = undefined;
  }
  if (typeof data !== "object" || data === null) {
    throw new UsageError(messages.invalidPackageJson(path));
  }
  return data as Manifest;
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
    if (isSupportedPackageManager(name) && !envFlag(ENV.ENABLE_UNSAFE_CUSTOM_URLS)) {
      throw new UsageError(messages.illegalUrl(raw));
    }
  } else {
    // §15.23 — an exact version, a semver range, and a dist-tag are all valid
    // here; §04.1 classifies which is which, and a range or a tag additionally
    // has its resolution recorded in `.jup.lock`. Corepack's
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
 * §03.3 — resolve a role's top-level pin against its `devEngines` block.
 *
 * Validation happens in a specific order because each failure has a different
 * outcome, and the top-level field always wins when present.
 *
 * §17.5 R14 — the *role* selects the fields, out of {@link PIN_FIELDS}, and
 * nothing else here changes: `devEngines.runtime` is validated by these rules,
 * `onFail` included, because it is these rules. A role with no top-level field
 * (every role but the package manager) simply has no `pm` to cross-check
 * against, so the two mismatch branches below are unreachable for it — which is
 * why those two messages stay spelled as §12.3 froze them.
 */
export function readSpecFromManifest(
  manifest: unknown,
  manifestPath: string,
  role: Role = "package-manager",
): {
  raw: unknown;
  range?: DevEnginesRange;
  /** §15.26 — the declaration itself, present even when it names no version. */
  devEngines?: DevEnginesDeclaration;
  hasPin: boolean;
} {
  void manifestPath; // Reserved: §15.25/§15.26 need it to report *which* file is at fault.

  const fields = PIN_FIELDS[role];
  const data = (manifest ?? {}) as Manifest;
  const pm = fields.top === undefined ? undefined : data[fields.top];
  const de = data.devEngines?.[fields.block];

  // Only a *string* counts as a declared pin: `packageManager: 42` is a spec
  // error waiting to be reported, not a range `up` could refresh.
  const hasPin = typeof pm === "string";

  if (de === undefined || de === null) {
    return { raw: pm, hasPin };
  }

  // These first two never throw, whatever `onFail` says: the field is too
  // malformed for its own `onFail` to be trustworthy.
  if (typeof de !== "object") {
    console.warn(messages.devEnginesNotObject(de, fields.block));
    return { raw: pm, hasPin };
  }
  if (Array.isArray(de)) {
    console.warn(messages.devEnginesArray(fields.block));
    return { raw: pm, hasPin };
  }

  const { name, version, onFail } = de as DevEnginesBlock;
  // §15.12 — the sidecar spelling of the pin. Read here so the same `onFail`
  // routing governs it as governs every other field of the block.
  const integrity = (de as Record<string, unknown>).integrity;

  if (typeof name !== "string" || name.includes("@")) {
    warnOrThrow(messages.devEnginesBadName(name, fields.block), onFail);
    return { raw: pm, hasPin };
  }
  if (version !== undefined && version !== null) {
    if (typeof version !== "string" || !isValidRange(version)) {
      warnOrThrow(messages.devEnginesBadVersion(version, fields.block), onFail);
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
    return { raw: withSidecarIntegrity(pm, integrity, onFail, role), range, devEngines, hasPin };
  }

  return {
    raw: withSidecarIntegrity(`${name}@${version ?? "*"}`, integrity, onFail, role),
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
 *   `.jup.lock` is where a range's resolved digest lives, and it records
 *   one on the first resolve;
 * * a URL reference, which carries its hash in the fragment (§02.1).
 */
function withSidecarIntegrity(
  raw: unknown,
  integrity: unknown,
  onFail: unknown,
  role: Role,
): unknown {
  if (integrity === undefined || integrity === null) return raw;
  if (typeof raw !== "string") return raw;

  if (typeof integrity !== "string") {
    warnOrThrow(messages.devEnginesBadIntegrity(integrity, PIN_FIELDS[role].block), onFail);
    return raw;
  }

  const hash = hashFromIntegrity(integrity);
  if (hash === undefined) {
    warnOrThrow(messages.devEnginesBadIntegrity(integrity, PIN_FIELDS[role].block), onFail);
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
      warnOrThrow(
        messages.devEnginesIntegrityMismatch(
          raw,
          integrity,
          pinFieldLabel(role),
          PIN_FIELDS[role].block,
        ),
        onFail,
      );
    }
    return raw;
  }

  return `${raw.slice(0, at)}@${parsed.version}+${hash}`;
}

/**
 * `sha512-<base64>` -> `sha512.<hex>`, the build-suffix spelling of §02.1.
 *
 * Duplicated from `lockfile.ts`'s function of the same name. The reason was that
 * importing it would have put that module in every invocation's graph to serve
 * one field almost no manifest carries — but §15.23 put `lockfile.ts` on the
 * warm path itself, so the copy no longer buys anything and could go.
 *
 * `integrity` is a different matter, and is still not reached for: it pulls
 * `node:crypto` (§16.3). An algorithm this implementation does not support is
 * rejected by `install` with §12's own message, and rejecting it twice would
 * give one input two errors.
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
      console.warn(`${validationWarningPrefix()}${message}`);
    }
  }
}

/**
 * §15.35k — is the governing manifest at the home directory or above?
 *
 * #424: a `packageManager` field in `$HOME/package.json` silently governs every
 * directory on the machine that has no manifest of its own. Anything at or
 * above the home directory is by definition not one project's declaration.
 *
 * Path comparison, not `realpath`: this only decorates an error already being
 * thrown, so a `stat` per mismatch is not worth a symlinked home directory.
 */
export function isOutsideProject(manifestPath: string): boolean {
  const home = homedir();
  if (home === "") return false;

  const dir = dirname(resolve(manifestPath));
  const target = resolve(home);
  return target === dir || target.startsWith(dir + sep);
}

/**
 * §17.3 R4 row 2 — the roles an invoked binary is enforced under.
 *
 * A name the table does not carry has none, and falls back to the
 * package-manager role: that is the pin corepack compares against today, so
 * `jup foo@1.2.3` in a pinned project keeps reaching §12.5's message rather than
 * silently running something the project forbids. It is the same tie-break R11's
 * last paragraph makes for an ambiguous invocation, for the same reason — the
 * package-manager pin is the one every existing project has.
 */
const UNKNOWN_BINARY_ROLES: readonly Role[] = ["package-manager"];

/**
 * §03.5, §17.3 R4 row 2 — reconcile the discovered spec with the requested
 * binary, **against the pin for that binary's role**.
 *
 * This is the row R4 calls "the one an implementation is most likely to miss",
 * and its symptom is severe: comparing every invocation against *the* project
 * spec makes `node foo.js` in a pnpm project fail with `This project is
 * configured to use pnpm` — for running the runtime. So the invoked tool's roles
 * select which of {@link SpecResult}'s per-role pins apply, and a role the
 * project does not pin contributes nothing:
 *
 * * a pin for a role this binary does not fill is **not** consulted, in either
 *   direction (rows 225 and 226);
 * * a binary whose roles are all unpinned takes "the ordinary fallback path
 *   (§03.5, §04.5)", exactly as `NoSpec` does;
 * * a dual-role binary matches if *any* of its roles is pinned to it — one
 *   artifact, one locator (R5), so there is nothing to choose between.
 *
 * With §02.5's table — every tool `package-manager`, every pin
 * `packageManager` — the loop runs once over the one role and the answer is
 * identical to the single-pin test it replaces.
 */
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
  if (envDisabled(ENV.ENABLE_PROJECT_SPEC)) {
    return withBinaryVersion(fallback);
  }

  // "Treats it like transparent": a mismatch falls back instead of erroring.
  const transparent = options.transparent || envDisabled(ENV.ENABLE_STRICT);

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
      // The roles the invoked binary fills, intersected with the roles the
      // project pins — in `ROLE_ORDER`, so a mismatch reports the same pin
      // whichever way the manifest was written.
      const roles = getRoles(requestedName) ?? UNKNOWN_BINARY_ROLES;
      const pinned = ROLE_ORDER.filter((role) => roles.includes(role) && result.pins[role]);

      // R4 — "a binary whose role has no pin takes the ordinary fallback path".
      // This is what stops a runtime-only project from rejecting `pnpm install`,
      // and a package-manager-only project from rejecting the runtime.
      if (pinned.length === 0) {
        return withBinaryVersion(fallback);
      }

      // Every pin is parsed before any of them is rejected, and the *first*
      // pinned role in `ROLE_ORDER` is what a mismatch reports — so the message
      // names one field, deterministically, rather than whichever loop iteration
      // happened to run last.
      let mismatched: string | undefined;
      for (const role of pinned) {
        const spec = result.pins[role]!.getSpec({ requireVersion: binaryVersion === undefined });
        if (spec.name === requestedName) return withBinaryVersion(spec);
        mismatched ??= spec.name;
      }

      if (transparent) {
        return withBinaryVersion(fallback);
      }
      throw new UsageError(
        messages.projectConfigured(
          mismatched!,
          result.target,
          isOutsideProject(result.target),
          pinFieldLabel(pinned[0]!),
        ),
      );
    }
  }
}
