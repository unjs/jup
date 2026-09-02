/**
 * Project spec discovery and parsing — §03.
 *
 * Answers "which package manager, at which version range, does this directory
 * want?" It touches the filesystem only, never the network.
 */

const { readFileSync, statSync } = process.getBuiltinModule("node:fs");
const { homedir } = process.getBuiltinModule("node:os");
const { dirname, join, relative, resolve, sep } = process.getBuiltinModule("node:path");
import { ENV, readEnv } from "../config/env-vars.ts";
import {
  devEnginesFieldFor,
  isRuntime,
  isSupportedPackageManager,
  runsAsRuntime,
  versionFileFor,
} from "../config/table.ts";
import { applyEnvFile, envDisabled, envFlag, loadEnvFileFrom } from "./env.ts";
import { hashFromIntegrity } from "./lockfile.ts";
import { loadVersionFile, readVersionFile, type VersionFile } from "./version-file.ts";
import { advisory, messages, UsageError, VALIDATION_WARNING_PREFIX } from "../errors.ts";
import { warn } from "../utils/log.ts";
import { parseManifest, scanTopLevelFields } from "../utils/json.ts";
import { isValidRange, isValidVersion, parse, satisfies } from "../version/semver.ts";
import type {
  Spec,
  DevEnginesDeclaration,
  DevEnginesEntry,
  DevEnginesField,
  DevEnginesRange,
  LazyResolvedSpec,
  Manifest,
  ParseSpecOptions,
  ProjectSpec,
} from "../types.ts";

/** Directories inside a `node_modules` are skipped, so a dependency cannot hijack its host. */
export const NODE_MODULES_RE = /[\\/]node_modules[\\/](@[^\\/]*[\\/])?([^@\\/][^\\/]*)$/;

/**
 * §03.2 — anything *under* a `node_modules`, for the env-file step alone.
 *
 * {@link NODE_MODULES_RE} matches only the last segment pair as §03.1 requires.
 * That tail match is too narrow for the env file: a
 * dependency that cannot supply a `packageManager` from `node_modules/evil` can
 * still supply a whole *environment* from `node_modules/evil/src/.jup.env`, and
 * the env file is the more dangerous of the two — §03.2's prefix filter is the
 * only sandbox around it, and nothing inside a `node_modules` is ever the
 * project's own configuration. Containment, and the trailing `$` so the
 * `node_modules` directory itself — writable by any dependency's install — is
 * covered as well.
 */
const INSIDE_NODE_MODULES_RE = /[\\/]node_modules([\\/]|$)/;

/**
 * §03.1 — a `.git` entry marks a repository root. A file on a worktree or a
 * submodule, a directory otherwise, so presence is the whole test.
 */
const GIT_ENTRY_NAME = ".git";

/**
 * §03.4, §07.2 — the shape a tool name must have.
 *
 * The npm package-name shape, because a name reaches the store as a *directory
 * segment*: `resolveInstallTarget` builds `join(getInstallFolder(), name)`, and
 * where the reference beside it is percent-encoded by `versionDirFor`, the name
 * is not encoded by anything. `..`, `a/b` and a NUL therefore reach the
 * filesystem verbatim.
 *
 * The scoped alternative is unreachable from {@link parseSpec} as it splits
 * today — the name is everything before the *first* `@` — and is written out
 * anyway so the predicate answers for a scoped name what npm answers, rather
 * than being a rule that happens to be equivalent only under one caller.
 *
 * Excluded beyond the npm shape, all of them because this is a path segment:
 * `\` and `:` (a separator and a drive/ADS marker on Windows, where `a\..\..`
 * escapes exactly as `a/../..` does on POSIX) and every control character,
 * whose NUL truncates the path the segment is spliced into.
 */
const TOOL_NAME_RE = /^(?:@[^\s/@\\:]+\/)?[^\s/@\\:]+$/;

const CONTROL_CHAR_RE = /\p{Cc}/u;

/**
 * Is `name` usable both as a tool name and as the store directory named after it?
 *
 * The regex admits `.` and `..` — they are ordinary npm-name characters — so the
 * dot segments are refused separately: `join(store, "..")` is the store's parent,
 * which is the whole of the traversal this predicate exists to stop.
 */
export function isValidToolName(name: string): boolean {
  if (!TOOL_NAME_RE.test(name) || CONTROL_CHAR_RE.test(name)) return false;
  return !name.split("/").some((segment) => segment === "." || segment === "..");
}

const MANIFEST_NAME = "package.json";

export const CLI_SOURCE = "CLI arguments";

const MANIFEST_FIELDS = ["packageManager", "devEngines"] as const;

/**
 * §03.1 — the extra field a *mutating* walk needs, and only a mutating walk.
 *
 * `workspaces` on a real manifest is an array (sometimes a large one), and
 * {@link scanTopLevelFields} allocates a value for every field it is asked for.
 * The warm proxy path answers a two-field question (§16, Build shape) and must keep
 * answering exactly that, so the third field is requested only where the answer
 * is used.
 */
const MUTATING_MANIFEST_FIELDS = [...MANIFEST_FIELDS, "workspaces"] as const;

const PNPM_WORKSPACE_FILE = "pnpm-workspace.yaml";

/**
 * Either relevant field's key presence stops discovery, including invalid
 * values, so validation occurs at the declaring manifest.
 */
export function stopsWalk(data: Manifest | undefined, field: DevEnginesField): boolean {
  if (data === undefined) return false;
  // §02.3 — the top-level field speaks for package managers only, so a nested
  // manifest pinning `pnpm` says nothing about the runtime and must not stop a
  // runtime's walk. The `devEngines` member is the symmetric half.
  if (field === "packageManager" && Object.hasOwn(data, "packageManager")) return true;

  const devEngines = data.devEngines;
  return (
    typeof devEngines === "object" &&
    devEngines !== null &&
    Object.hasOwn(devEngines, field) &&
    devEngines[field] !== undefined &&
    devEngines[field] !== null
  );
}

/** Mutating discovery stops at either workspace convention and never climbs beyond it. */
function isWorkspaceRoot(dir: string, data: Manifest): boolean {
  if (Object.hasOwn(data, "workspaces") && data.workspaces !== undefined) return true;
  return statSync(join(dir, PNPM_WORKSPACE_FILE), { throwIfNoEntry: false }) !== undefined;
}

/**
 * §03.2 — where the env-file search stops: the outer edge of *this* project.
 *
 * A `package.json` or `.git` marks a project boundary; configuration above it
 * belongs to another project. This differs from the pin-based manifest stop.
 *
 * `package.json` first: it is the commoner marker, and on the directory the walk
 * is standing in it is the file about to be read anyway. `.git` may be a file
 * (worktrees, submodules) or a directory, so presence is the whole test.
 */
function isProjectBoundary(dir: string): boolean {
  return (
    statSync(join(dir, MANIFEST_NAME), { throwIfNoEntry: false }) !== undefined ||
    statSync(join(dir, GIT_ENTRY_NAME), { throwIfNoEntry: false }) !== undefined
  );
}

/**
 * §03.1 — walk from `cwd` toward the root.
 *
 * At each directory: skip if it is a package dir inside `node_modules`; load the
 * env file if none has been loaded yet and the project boundary is not behind us
 * ({@link isProjectBoundary}); read `package.json`. The walk stops on a manifest
 * declaring either package-manager field ({@link stopsWalk}, §03.1), and the
 * **last** manifest seen is what gets recorded — which is why a monorepo with no
 * declaration anywhere yields `NoSpec` targeting the *root*.
 *
 * The two searches therefore end in different places, and deliberately: reading
 * a *pin* from an ancestor is the documented monorepo behaviour (§03.1), while
 * an ancestor of the project supplying its whole environment is §03.2's hazard.
 *
 * `mutating` adds §03.1's workspace-boundary stop condition and `here` confines
 * the selection to `cwd`'s own manifest; both are for commands that are about to
 * *write*, and neither affects what the proxy path reads.
 *
 * `envOnly` loads the env file and stops at the first one found — or at the
 * project boundary, which is where there is no longer one to find — never
 * reading manifests: for commands given an explicit package-manager pattern on
 * the CLI.
 *
 * `tool` names the tool the answer is *for*, and §02.3 is the whole of what it
 * changes: a `kind: "runtime"` name reads `devEngines.runtime` and nothing else,
 * where every other name reads `packageManager` / `devEngines.packageManager`.
 * An absent tool selects the package-manager field pair.
 *
 * §03.1 — a tool whose table entry declares a {@link VersionFileSpec} also has
 * the nearest such file recorded on the way up, and it speaks only where the
 * manifest did not. It is not looked for on a `mutating` walk: §03.7 writes
 * `devEngines.runtime` and nothing else, so the file a command is about to edit
 * is always the manifest.
 *
 * `projectSpecFlag` lets the caller honour `COREPACK_ENABLE_PROJECT_SPEC=0`
 * (§03.5, §11.1: "never look at the project at all"). It degrades the walk to
 * `envOnly` the moment the flag is seen, so a broken manifest cannot defeat the
 * escape hatch users reach for *because* their manifest is broken. Compatibility
 * applies it only on the proxy path; management commands always load the spec.
 */
export function findProjectSpec(
  cwd: string,
  options?: {
    envOnly?: boolean;
    projectSpecFlag?: boolean;
    mutating?: boolean;
    here?: boolean;
    tool?: string;
  },
): ProjectSpec {
  const initialCwd = resolve(cwd);
  // An external spec bypasses manifest parsing while discovery continues for
  // the env file. The external-spec variable cannot be supplied by that file.
  const specFile = externalSpecFile(initialCwd);
  let envOnly = options?.envOnly === true || specFile !== undefined;
  const projectSpecFlag = options?.projectSpecFlag === true;
  const mutating = options?.mutating === true;
  const here = options?.here === true;
  const tool = options?.tool;
  const field = tool === undefined ? "packageManager" : devEnginesFieldFor(tool);
  const fields = mutating ? MUTATING_MANIFEST_FIELDS : MANIFEST_FIELDS;
  // §03.1 — `undefined` for every entry that declares no version file, which is
  // every package manager, and the walk then costs exactly what it always did.
  const versionFileSpec = tool === undefined || mutating ? undefined : versionFileFor(tool);

  let currentDir = "";
  let nextDir = initialCwd;
  let selection: { data: Manifest; target: string } | undefined;
  let envFilePath: string | undefined;
  let versionFile: VersionFile | undefined;
  // §03.2 — set once the env file has been found *or* the walk has left the
  // project; either way no further directory is asked for one.
  let envSearchOver = false;

  // `envOnly` swaps the stop condition for "the env-file search is over"; both
  // forms still terminate at the filesystem root, where `dirname(d) === d`.
  while (
    nextDir !== currentDir &&
    (envOnly ? !envSearchOver : !stopsWalk(selection?.data, field))
  ) {
    currentDir = nextDir;
    nextDir = dirname(currentDir);

    // §03.1 — `--here` mutates the manifest the user is standing in, full stop.
    // The climb continues for the env file alone (which may carry the registry
    // settings the resolution needs), so from the second directory on this is
    // exactly `envOnly`.
    if (here && currentDir !== initialCwd) {
      envOnly = true;
    }

    // Step 1 — a vendored dependency must never speak for its host, and that
    // includes its env file, so this runs before the env file is loaded.
    if (NODE_MODULES_RE.test(currentDir)) {
      continue;
    }

    // Step 2 — only the *closest* env file is ever applied (§03.2), and only
    // from inside the project.
    //
    // §11.6 already describes the search as reaching "only directories at or
    // below the project root", but the stop condition it names — a manifest
    // carrying `packageManager` — is the *manifest* walk's, and an unpinned
    // project has none: the common case climbed to `/`. That is how a
    // `/tmp/.jup.env` written by any user on a shared host governs every build
    // run under `/tmp` by every other user, and §03.2's prefix filter does not
    // help, because the variables it admits are exactly the ones worth
    // hijacking. The boundary is the project itself — the first directory
    // carrying its own `package.json` or `.git` — and the file *in* that
    // directory still applies, which is the case anyone writes deliberately.
    //
    // The boundary is tested only when the walk is about to climb past this
    // directory, so the exact-pin fast path (§16, Build shape; one directory, stop) pays
    // nothing for it and every other run pays one `stat` on a dentry the
    // manifest read is about to want anyway.
    // {@link INSIDE_NODE_MODULES_RE} rather than the tail match above: a
    // dependency's `src` directory is not the project either, and it is not the
    // project's boundary — the walk keeps looking above it for the *host's* env
    // file, which is the one that legitimately applies.
    if (!envSearchOver && !INSIDE_NODE_MODULES_RE.test(currentDir)) {
      const loaded = loadEnvFileFrom(currentDir);
      if (loaded !== null) {
        applyEnvFile(loaded.vars, loaded.path);
        envFilePath = loaded.path;
        envSearchOver = true;
      } else if (nextDir === currentDir || isProjectBoundary(currentDir)) {
        envSearchOver = true;
      }
    }

    // §03.5 / §11.1 — with the project spec disabled the manifest must not be
    // read at all, let alone parsed or devEngines-validated. The test lives here,
    // *after* the env-file step, because the env file is allowed to be what
    // sets the variable (§03.2). From this point the walk is exactly `envOnly`:
    // it keeps climbing for an env file and records no manifest, so the result is
    // `NoProject` and §03.5 falls back.
    if (projectSpecFlag && envDisabled(ENV.ENABLE_PROJECT_SPEC)) {
      envOnly = true;
    }

    if (envOnly) {
      continue;
    }

    // §03.1 — before the manifest read, because that read `continue`s on ENOENT
    // and a directory holding a version file and no `package.json` is an
    // ordinary shape. Only the nearest one is kept, as with the env file above.
    if (versionFileSpec !== undefined && versionFile === undefined) {
      versionFile = loadVersionFile(currentDir, versionFileSpec) ?? undefined;
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

    // §16, Build shape — the walk reads two fields, so scan for them rather than resolving
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

    // §03.1 — a mutating walk stops at the workspace root even when that
    // manifest declares no package manager at all. Non-mutating discovery keeps
    // climbing, because *reading* a pin from further up is the documented
    // monorepo behaviour (§03.1); it is only *writing* one past the repository
    // that surprises people.
    if (mutating && isWorkspaceRoot(currentDir, selection.data)) {
      break;
    }
  }

  const specDisabled = projectSpecFlag && envDisabled(ENV.ENABLE_PROJECT_SPEC);

  const result = ((): ProjectSpec => {
    // §03.1 — the external file is the project's declaration and outranks the
    // manifest. `COREPACK_ENABLE_PROJECT_SPEC=0` still wins over both: §11.1's
    // "never look at the project at all" covers a redirected spec too.
    if (specFile !== undefined && !specDisabled) {
      return describe(readExternalSpec(specFile), specFile, initialCwd, envFilePath, field);
    }

    // A manifest read *before* the env file that disables the project spec was
    // found is still discarded here: §11.1 says "entirely", and that includes the
    // eager devEngines validation below.
    if (selection === undefined || specDisabled) {
      return { type: "NoProject", target: join(initialCwd, MANIFEST_NAME), envFilePath };
    }

    return describe(selection.data, selection.target, initialCwd, envFilePath, field);
  })();

  // §03.1 — the version file ranks strictly below the manifest and strictly
  // above §03.5's fallback, so it is consulted on exactly the two outcomes that
  // mean "this project said nothing about the requested tool". A `Found` is
  // never displaced: the `devEngines` member is jup's own field and is the one a
  // user edits to override a version file they are not free to delete.
  //
  // `specDisabled` is re-tested because it may have been set by an env file
  // found further up than a version file recorded earlier in the same walk.
  if (versionFile !== undefined && tool !== undefined && !specDisabled && result.type !== "Found") {
    // `null` — an alias jup cannot resolve; warned about and out of the picture.
    const spoke = describeVersionFile(versionFile, tool, initialCwd, result.envFilePath);
    if (spoke !== null) return spoke;
  }

  return result;
}

/**
 * §03.1 — the `ProjectSpec` for a version file, in the `describe` shape.
 *
 * `hasPin` is false and no `devEngines` declaration is carried, which is the
 * truth about it: nothing here is a committed pin, so §04.4's `up` treats it as
 * it treats a synthesised spec and §03.6's auto-pin — which fires on `NoSpec`
 * and this is not one — leaves it alone.
 *
 * No `specField` either, and it cannot matter: §12.5's message is the only
 * reader, and it is reached only from §03.5's name mismatch, which a version
 * file cannot produce. The walk consults one only for the tool that was
 * *requested* (§03.1), so the name it yields is the requested name by
 * construction.
 *
 * `null` when the file names an alias jup has no answer for: §03.1 warns and
 * skips it rather than fail a run this source was never asked to decide. A
 * **malformed** file still fails only the request that needed it, for the
 * reason `describe` keeps its own parsing lazy. Routing the synthesised string
 * back through {@link parseSpec} rather than returning a descriptor directly is
 * what keeps one definition of what a spec string means.
 */
function describeVersionFile(
  file: VersionFile,
  tool: string,
  initialCwd: string,
  envFilePath: string | undefined,
): ProjectSpec | null {
  const source = relative(initialCwd, file.path);
  const reading = readVersionFile(file);
  if (reading.kind === "unsupported") {
    advisory(messages.versionFileUnsupported(reading.declared, source));
    return null;
  }

  return {
    type: "Found",
    target: file.path,
    hasPin: false,
    envFilePath,
    getSpec: (opts?: ParseSpecOptions) => {
      if (reading.kind === "invalid") throw new UsageError(messages.versionFileInvalid(source));
      return parseSpec(`${tool}@${reading.range}`, {
        ...opts,
        source,
        packageManagerField: false,
      });
    },
  };
}

/**
 * The `ProjectSpec` for one already-read manifest — the walk's selection, or
 * §03.1's external file, which get identical treatment. devEngines validation
 * is eager (a bad `onFail: "error"` must fail the run); `parseSpec` is deferred.
 */
function describe(
  data: Manifest,
  target: string,
  initialCwd: string,
  envFilePath: string | undefined,
  field: DevEnginesField = "packageManager",
): ProjectSpec {
  const { raw, range, hasPin, devEngines, fromPackageManagerField } = readSpecFromManifest(
    data,
    target,
    field,
  );
  if (raw === undefined) {
    return { type: "NoSpec", target, envFilePath };
  }

  // Messages name the manifest relative to where the user was standing.
  const source = relative(initialCwd, target);
  // §03.4 — the runtime refusal is about the `packageManager` *field*, so it
  // applies exactly when `raw` came from it. A spec synthesised out of a
  // `devEngines` member did not, and neither did anything the user typed.
  // Since §03.3 lets a versioned member outrank a present `packageManager`,
  // "the field holds a string" and "the field supplied this spec" have come
  // apart; `readSpecFromManifest` reports the second.
  const packageManagerField = field === "packageManager" && fromPackageManagerField;
  // §12.5 — the field a user has to edit to change this answer, which is the
  // one the spec came from and not simply the one that exists.
  const specField = packageManagerField ? "packageManager" : `devEngines.${field}`;
  return {
    type: "Found",
    target,
    range,
    devEngines,
    hasPin,
    specField,
    envFilePath,
    getSpec: (opts?: ParseSpecOptions) => parseSpec(raw, { ...opts, source, packageManagerField }),
  };
}

/** §03.1 — `JUP_SPEC_FILE` resolved against the initial cwd, or `undefined`. */
function externalSpecFile(initialCwd: string): string | undefined {
  const configured = readEnv(ENV.SPEC_FILE);
  return configured === undefined || configured === ""
    ? undefined
    : resolve(initialCwd, configured);
}

/**
 * §03.1 — the spec file's contents, in `package.json` shape.
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
 * §03.4 — parse a spec string into a {@link Spec}.
 *
 * `options.source` names the input in §12's messages: `CLI arguments` — the
 * default, and what every CLI caller passes — or the manifest path relative to
 * the initial cwd. Note `name` is the substring before the **first** `@`, so
 * `@scope/pkg@1.0.0` yields an empty name and correctly fails the
 * supported-name check.
 */
export function parseSpec(raw: unknown, options?: ParseSpecOptions): Spec {
  const source = options?.source ?? CLI_SOURCE;
  // 1 — a non-string field (`packageManager: 42`, `null`, an object).
  if (typeof raw !== "string") {
    throw new UsageError(messages.invalidSpecNotString(source));
  }

  // 2 — `yarn` or `yarn@`: a name with no version at all. §04.4 widened what a
  // version may *be*, not whether a pin has to carry one, so this is untouched:
  // a manifest that names no version at all is still §12.2's error.
  const atIndex = raw.indexOf("@");
  if (atIndex === -1 || atIndex === raw.length - 1) {
    if (options?.requireVersion === true) {
      throw new UsageError(messages.noVersionSpecified(raw, source));
    }
    const bareName = atIndex === -1 ? raw : raw.slice(0, -1);
    if (!isSupportedPackageManager(bareName)) {
      // Name-only form reports the *name*, not the raw string.
      throw new UsageError(messages.unsupportedSpec(bareName));
    }
    // §03.4 — the version-bearing form is checked below; a `packageManager`
    // reading exactly `node` reaches this branch and is the same mistake.
    if (options?.packageManagerField === true && isRuntime(bareName)) {
      throw new UsageError(messages.runtimeInPackageManager(bareName));
    }
    return { name: bareName, range: "*" };
  }

  // 3 — split on the *first* `@`.
  const name = raw.slice(0, atIndex);
  const range = raw.slice(atIndex + 1);

  // §07.2 — the name has to be a *name* before anything else asks what it means,
  // because it is what `resolveInstallTarget` joins onto the store root, and
  // nothing between here and there escapes it. The two branches below are not
  // symmetric and cannot be relied on for this: step 4's non-URL branch refuses
  // an unsupported name, but the URL branch refuses only a *supported* one, so
  // an unsupported name carrying a URL reference — `../../tmp/x@https://…` — used
  // to reach the store unexamined and install attacker-served bytes at an
  // attacker-chosen path (the `#sha512.…` fragment satisfies §06.1's tier, so
  // nothing later objected either). Checking here covers both branches and the
  // `devEngines` spellings that route through them; the name-only form in step 2
  // is already confined to the built-in table, which admits no such name.
  if (!isValidToolName(name)) {
    // §12 — the existing string, deliberately: what this rejects is a spec whose
    // name cannot name a tool, which is what "unsupported" already says.
    throw new UsageError(messages.unsupportedSpec(raw));
  }

  // §03.4 — a runtime is never a `packageManager` value. Checked here rather
  // than in `readSpecFromManifest` because §03.1's laziness is load-bearing:
  // `jup use pnpm@9` must be able to overwrite a manifest saying `node@22`,
  // and it can only do that if reading the field is what fails, not discovery.
  if (options?.packageManagerField === true && isRuntime(name)) {
    throw new UsageError(messages.runtimeInPackageManager(name));
  }

  // 4 — a URL reference is a different thing entirely from a version.
  if (URL.canParse(range)) {
    if (isSupportedPackageManager(name) && !envFlag(ENV.ENABLE_UNSAFE_CUSTOM_URLS)) {
      throw new UsageError(messages.illegalUrl(raw));
    }
  } else {
    // §04.4 — exact versions, semver ranges, and dist-tags are valid; §04.1
    // classifies them, and non-exact references use `jup.lock` resolution.
    // What is neither a version nor a range is a tag,
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
 * §03.3 — resolve `devEngines.packageManager` against `packageManager`.
 *
 * Validation happens in a specific order because each failure has a different
 * outcome, and a **valid `devEngines` member that names a version wins** over
 * the top-level field. It is the richer declaration — a name, a range, an
 * `onFail` policy and a sidecar digest, where `packageManager` has one string —
 * so it is the one jup treats as the pin, and §03.7 writes it there.
 *
 * Two shapes still fall back to `pm`, and for the same reason: the member is
 * not answering the question. A member that fails any validation below is not a
 * declaration at all — its own `onFail` is not even trustworthy — and a member
 * carrying no `version` says *which* tool the project is for without saying
 * which release, so a `packageManager` beside it is strictly more specific.
 * Reading `name@*` over an exact pin would throw away a version the manifest
 * states plainly and send the run to the registry for the latest.
 *
 * The cross-checks against `pm` still run whenever both are present. They no
 * longer decide the answer, but a manifest whose two fields disagree is a
 * manifest whose author believes something false about what will run, and §12's
 * messages are how they find out.
 *
 * §02.3 — `field` selects which `devEngines` member speaks. For `"runtime"`
 * there is no top-level counterpart, so `pm` is `undefined` throughout and the
 * function collapses to its last branch: the cross-checks never run (the two
 * members describe different tools and cannot disagree), `hasPin` is false, and
 * the answer is the declaration itself. Everything else — the four validations,
 * the `onFail` routing, §03.7's sidecar — is one rule over both members.
 */
export function readSpecFromManifest(
  manifest: unknown,
  manifestPath: string,
  field: DevEnginesField = "packageManager",
): {
  raw: unknown;
  range?: DevEnginesRange;
  /** §03.7 — the declaration itself, present even when it names no version. */
  devEngines?: DevEnginesDeclaration;
  hasPin: boolean;
  /**
   * §03.4 — whether `raw` is the `packageManager` field's own bytes.
   *
   * `hasPin` cannot answer this any more. It says the field holds a string;
   * since §03.3 lets a versioned `devEngines` member outrank it, that string is
   * often not the one being returned, and the runtime refusal keyed off it
   * would then be about a field the spec did not come from.
   */
  fromPackageManagerField: boolean;
} {
  void manifestPath; // Reserved: §03.1/§03.7 need it to report *which* file is at fault.

  const data = (manifest ?? {}) as Manifest;
  // §02.3 — a runtime has no top-level field, so there is nothing here to win
  // over its `devEngines` member, and nothing for the cross-checks to compare.
  const pm = field === "packageManager" ? data.packageManager : undefined;
  const de = data.devEngines?.[field];

  // Only a *string* counts as a declared pin: `packageManager: 42` is a spec
  // error waiting to be reported, not a range `up` could refresh.
  const hasPin = typeof pm === "string";

  if (de === undefined || de === null) {
    return { raw: pm, hasPin, fromPackageManagerField: hasPin };
  }

  // These first two never throw, whatever `onFail` says: the field is too
  // malformed for its own `onFail` to be trustworthy.
  if (typeof de !== "object") {
    warn(messages.devEnginesNotObject(de, field));
    return { raw: pm, hasPin, fromPackageManagerField: hasPin };
  }
  if (Array.isArray(de)) {
    warn(messages.devEnginesArray(field));
    return { raw: pm, hasPin, fromPackageManagerField: hasPin };
  }

  const { name, version, onFail } = de as DevEnginesEntry;
  // §03.7 — the sidecar spelling of the pin. Read here so the same `onFail`
  // routing governs it as governs every other field of the block.
  const integrity = (de as Record<string, unknown>).integrity;

  if (typeof name !== "string" || name.includes("@")) {
    warnOrThrow(messages.devEnginesBadName(name, field), onFail);
    return { raw: pm, hasPin, fromPackageManagerField: hasPin };
  }
  if (version !== undefined && version !== null) {
    if (typeof version !== "string" || !isValidRange(version)) {
      warnOrThrow(messages.devEnginesBadVersion(version, field), onFail);
      return { raw: pm, hasPin, fromPackageManagerField: hasPin };
    }
  }

  const failure = typeof onFail === "string" ? onFail : undefined;
  const range: DevEnginesRange | undefined =
    typeof version === "string" ? { name, range: version, onFail: failure } : undefined;

  // §03.7 — reported whether or not a version was declared. A block naming only
  // a package manager still says which one the project is for, and `writePin`
  // has to honour that or it writes a pin §03.3 refuses to read.
  const devEngines: DevEnginesDeclaration = { name, onFail: failure };
  if (typeof version === "string") devEngines.version = version;

  if (pm !== undefined && pm !== null) {
    if (typeof pm !== "string" || !pm.startsWith(`${name}@`)) {
      warnOrThrow(messages.devEnginesNameMismatch(pm, name), onFail);
    } else if (
      typeof version === "string" &&
      // §04.4 — the cross-check compares a *version* against a range, so it
      // only applies when the pin carries one. Once the pin may itself be a
      // range or a tag (`pnpm@^11.0.0` beside a declared `>=11`), asking
      // `satisfies("^11.0.0", ">=11")` answers `false` for every input and would
      // turn the pnpm-generated shape §04.4 exists to support into a hard
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
    // §03.3 — the third cross-check, and the one the member's own precedence
    // would otherwise skip past. `withSidecarIntegrity` reports two disagreeing
    // digests only when it finds both on the *same* string, which was enough
    // while `packageManager` was the string being returned. Now the member is,
    // so a suffix on the top-level field is never examined — and two hashes for
    // one artifact means at most one of them describes what will run, which is
    // worth saying whichever field is going to win.
    if (typeof integrity === "string" && typeof pm === "string") {
      const suffix = parse(pm.slice(name.length + 1))?.build.join(".");
      const declaredHash = hashFromIntegrity(integrity);
      if (
        suffix !== undefined &&
        suffix !== "" &&
        declaredHash !== undefined &&
        suffix.toLowerCase() !== declaredHash
      ) {
        warnOrThrow(messages.devEnginesIntegrityMismatch(pm, integrity), onFail);
      }
    }

    // §03.3 — a member that names no version has not answered the question, so
    // the more specific `packageManager` stands. Anything else and the member
    // wins, warning or no warning: the disagreement has been reported, and
    // reporting it is not a reason to run the field jup no longer treats as
    // the pin.
    if (typeof version !== "string") {
      return {
        raw: withSidecarIntegrity(pm, integrity, version, onFail),
        range,
        devEngines,
        hasPin,
        fromPackageManagerField: hasPin,
      };
    }
  }

  return {
    raw: withSidecarIntegrity(`${name}@${version ?? "*"}`, integrity, version, onFail),
    range,
    devEngines,
    hasPin,
    fromPackageManagerField: false,
  };
}

/**
 * §03.7 — fold `devEngines.packageManager.integrity` into the spec string.
 *
 * Both suffix and sidecar spellings MUST be accepted. An SRI beside a clean
 * `yarn@4.14.1` becomes `yarn@4.14.1+sha512.…`
 * here, and from that point §06.1 row 1 treats it exactly as it treats a
 * hand-written suffix — including §06.1's "a pinned hash is a verification
 * tier".
 *
 * Three shapes are deliberately left alone:
 *
 * * a spec that already carries a build suffix — the explicit spelling wins,
 *   and a *disagreeing* sidecar is reported through `onFail` rather than
 *   silently discarded, because two digests for one artifact means at most one
 *   of them describes what will run;
 * * a range or a dist-tag, which no single digest can describe. §04.4's
 *   `jup.lock` is where a range's resolved digest lives, and it records
 *   one on the first resolve;
 * * a URL reference, which carries its hash in the fragment (§02.1).
 */
function withSidecarIntegrity(
  raw: unknown,
  integrity: unknown,
  declared: unknown,
  onFail: unknown,
): unknown {
  if (integrity === undefined || integrity === null) return raw;
  if (typeof raw !== "string") return raw;

  // §03.7 — the sidecar describes the `version` beside it, and only that. A
  // range describes no single release, so there is no one artifact for the
  // digest to name and it is left where it is (§03.3, §04.4).
  if (typeof declared === "string" && !isValidVersion(declared)) return raw;

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
      warn(`${VALIDATION_WARNING_PREFIX}${message}`);
    }
  }
}

/**
 * §12.5 — manifests at or above the home directory are outside a project.
 * Path comparison, not `realpath`: this only decorates an error already being
 * thrown, so a `stat` per mismatch is not worth a symlinked home directory.
 */
export function isOutsideProject(manifestPath: string): boolean {
  const home = homedir();
  if (home === "") return false;

  const dir = dirname(resolve(manifestPath));
  const target = resolve(home);
  // `dir + sep` doubles the separator at the root, where `dir` is already `/`.
  return target === dir || target.startsWith(dir.endsWith(sep) ? dir : dir + sep);
}

/** §03.5 — reconcile the discovered spec with the requested binary. */
export function reconcile(
  result: ProjectSpec,
  fallback: LazyResolvedSpec,
  options: { requestedName: string; transparent: boolean; binaryVersion?: string },
): Spec | LazyResolvedSpec {
  const { requestedName, binaryVersion } = options;

  // An explicit CLI version replaces the range, never the package-manager name.
  const withBinaryVersion = (descriptor: Spec | LazyResolvedSpec): Spec | LazyResolvedSpec =>
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
      const spec = result.getSpec({ requireVersion: binaryVersion === undefined });
      if (spec.name !== requestedName) {
        // §03.5 — a package-manager pin is no reason to refuse a runtime, and
        // the entries that are both arrive here where `node` cannot. Read off
        // the *requested* name, so a bun-pinned project still refuses pnpm.
        if (transparent || runsAsRuntime(requestedName)) {
          return withBinaryVersion(fallback);
        }
        throw new UsageError(
          messages.projectConfigured(
            spec.name,
            result.target,
            isOutsideProject(result.target),
            result.specField,
          ),
        );
      }
      return withBinaryVersion(spec);
    }
  }
}
