/**
 * Errors and user-facing strings — see `.agents/12-errors.md`.
 *
 * These strings are part of the observable contract. Scripts, CI logs, and
 * support docs match on them, so they are reproduced byte for byte: the leading
 * `! `, the absent trailing periods, the trailing space on the prompt.
 *
 * `<JSON x>` in the spec means `JSON.stringify(x)` — strings appear quoted.
 *
 * This file is the **warm** half: the error classes, the advisory gate, and the
 * messages a module in §16.3's warm chunk can raise. Everything a download, a
 * verification, a registry lookup or a management command raises lives in
 * `errors-cold.ts`, which re-exports this module and merges the two message
 * tables into one — so a cold call site sees no difference, and a warm run does
 * not parse text it cannot print. See that file for why.
 */

import { ENV, readEnv } from "./config/env-vars.ts";

/**
 * §12.1 — the user asked for something impossible or contradictory.
 *
 * Only this class gets the friendly treatment. Presentation differs by mode:
 * proxy mode writes the bare message to stderr; management mode writes
 * `Usage Error: <message>` to **stdout**, then a blank line, then the usage
 * line. Anything else is an `Error` and prints with a stack, because a stack
 * trace is the correct output for a bug.
 */
export class UsageError extends Error {
  override readonly name = "UsageError";

  constructor(message: string) {
    super(message);
  }
}

const json = (value: unknown): string => JSON.stringify(value);

/** §12.3 — prefix applied when a validation failure warns instead of throwing. */
export const VALIDATION_WARNING_PREFIX = "! jup validation warning: ";

/**
 * §11.5 — an advisory line **this** implementation adds, which
 * `COREPACK_QUIET_ADVISORIES=1` silences. Split by origin, not by severity.
 *
 * The six advisory sites jup inherits from corepack — the download notice and
 * its prompt, the auto-pin notice, the three `devEngines` warnings,
 * `enable`/`disable`'s Yarn Switch skip — call `console.warn`/`stderr` directly
 * and are never routed here, because §13's rows match their text (jup's name in
 * place of corepack's) byte for byte. Routing only what §14/§15 add is what
 * lets "quiet" mean the extra lines rather than a blunt mute that takes the
 * contract text with it (§14.23).
 *
 * `readEnv`, not `envFlag`: `project/env.ts` imports this module, so reaching
 * for its flag reader would close a cycle over the warm path.
 */
export function advisory(message: string): void {
  if (readEnv(ENV.QUIET_ADVISORIES) === "1") return;
  console.warn(message);
}

/**
 * §12's strings — the half a **warm** invocation can raise.
 *
 * That is the whole of the split: these are the messages reachable from a
 * module in the warm chunk (`config/table.ts`, `project/manifest.ts`,
 * `cache/store.ts`, `run/exec.ts`, `main.ts` and the rest of §16.3's set), and
 * every other string §12 defines lives in `errors-cold.ts`, which re-exports
 * this object merged with its own. A download, a signature check, a registry
 * lookup and every management command are all cold, so their vocabulary is
 * parsed only by the runs that can reach it.
 *
 * Adding a message here is therefore a decision, not a default: if the only
 * thing that raises it is a cold module, it belongs in the other file.
 */
export const messages = {
  /* §12.2 — spec parsing ------------------------------------------------- */

  invalidSpecNotString: (source: string) =>
    `Invalid package manager specification in ${source}; expected a string`,

  noVersionSpecified: (raw: string, source: string) =>
    `No version specified for ${raw} in "packageManager" of ${source}`,

  unsupportedSpec: (raw: string) => `Unsupported package manager specification (${raw})`,

  illegalUrl: (raw: string) =>
    `Illegal use of URL for known package manager. Instead, select a specific version, or set JUP_ENABLE_UNSAFE_CUSTOM_URLS=1 in your environment (${raw})`,

  invalidPackageJson: (relativePath: string) => `Invalid package.json in ${relativePath}`,

  /* §12.3 — devEngines validation ---------------------------------------- */

  /*
   * §15.39 — these four take the member they are about, defaulting to
   * `packageManager`.
   *
   * The default is what keeps §12.3's four strings byte-identical: every caller
   * that existed before the `node` entry passes nothing and gets exactly the
   * text §13 asserts. `devEngines.runtime` substitutes into the same sentence,
   * which is new text and so free to be worded this way (§12.12) — and a reader
   * who has seen one of these messages can read the other without learning
   * anything.
   *
   * The two cross-check messages below take no member: they are about
   * `packageManager` versus its own `devEngines` half, and a runtime has no
   * top-level field to disagree with.
   */
  /** Unconditional warning, regardless of `onFail`. Emitted with the `! ` already attached. */
  devEnginesNotObject: (value: unknown, field: string = "packageManager") =>
    `! jup only supports objects as valid value for devEngines.${field}. The current value (${json(value)}) will be ignored.`,

  /** Unconditional warning, regardless of `onFail`. */
  devEnginesArray: (field: string = "packageManager") =>
    `! jup does not currently support array values for devEngines.${field}`,

  devEnginesBadName: (value: unknown, field: string = "packageManager") =>
    `The value of devEngines.${field}.name ${json(value)} is not a supported string value`,

  devEnginesBadVersion: (value: unknown, field: string = "packageManager") =>
    `The value of devEngines.${field}.version ${json(value)} is not a valid semver range`,

  devEnginesNameMismatch: (packageManager: unknown, name: unknown) =>
    `"packageManager" field is set to ${json(packageManager)} which does not match the "devEngines.packageManager" field set to ${json(name)}`,

  devEnginesVersionMismatch: (packageManager: unknown, name: unknown, version: unknown) =>
    `"packageManager" field is set to ${json(packageManager)} which does not match the value defined in "devEngines.packageManager" for ${json(name)} of ${json(version)}`,

  /* §12.4 — resolution ---------------------------------------------------- */

  failedToResolve: (range: string, name: string) =>
    `Failed to successfully resolve '${range}' to a valid ${name} release`,

  unsupportedByBuild: (name: string) =>
    `This package manager (${name}) isn't supported by this jup build`,

  /**
   * §15.23 — verbatim. The file name is spelled out rather than imported from
   * `lockfile.ts` because every module imports this one, and it must stay free
   * of the imports that would make it a cycle.
   */
  lockfileUnresolved: (name: string, range: string) =>
    `${name}@${range} is not resolved in .jup.lock and lockfile updates are disabled.`,

  /* §12.5 — project enforcement ------------------------------------------ */

  /**
   * §12.5, with §15.35k's suffix: set when the governing manifest sits at the
   * home directory or above, where a stray `packageManager` field governs
   * *every* directory on the machine (#424). Without the clause the user is
   * named a file they have no memory of creating and left to work out why.
   */
  projectConfigured: (name: string, manifestPath: string, outsideProject?: boolean) =>
    `This project is configured to use ${name} because ${manifestPath} has a "packageManager" field${
      outsideProject === true
        ? ` (this manifest is outside any project — a stray "packageManager" field there affects every directory)`
        : ""
    }`,

  /* §12.7 — integrity ----------------------------------------------------- */

  /** Users read the `got` value and paste it into their `packageManager` field. Keep the format. */
  mismatchHashes: (expected: string, actual: string) =>
    `Mismatch hashes. Expected ${expected}, got ${actual}`,

  /* §12.8 — store & filesystem -------------------------------------------- */

  failedToCreateCacheDir: (target: string) =>
    `Failed to create cache directory. Please ensure the user has write access to the target directory (${target}). If the user's home directory does not exist, create it first.`,

  assertUnableToLocateBinPath: (binName: string) =>
    `Assertion failed: Unable to locate path for bin '${binName}'`,

  /** §07.5 — the rename lost to something that is not a completed install. */
  occupiedInstallDir: (target: string) =>
    `Refusing to use ${target}: a directory is already there but carries no ${"`"}.jup${"`"} marker, so it is not a complete install. Remove it and run again.`,

  /* §12.10 — informational output ----------------------------------------- */

  autoPinNotice: (name: string, reference: string) =>
    `! The local project doesn't define a 'packageManager' field. jup will now add one referencing ${name}@${reference}.`,

  autoPinDocs: () =>
    `! For more details about this field, consult the documentation at https://nodejs.org/api/packages.html#packagemanager`,

  /**
   * §15.27, §15.35l — every mutating command names the file it touched.
   *
   * The single highest-value line in §15: the whole "corepack edited a file I
   * did not expect" class (#607) is a walk that silently chose an ancestor, and
   * one printed path retires it. It covers auto-pin (§03.6) too, where it goes
   * to **stderr** because stdout belongs to the package manager (§09.11).
   */
  updatedManifest: (path: string, name: string, reference: string) =>
    `Updated ${path} to use ${name}@${reference}`,

  /**
   * §15.35d — `COREPACK_SPEC_FILE` names a file that is not there. Falling back
   * to the manifest is the worst outcome available: the variable exists for
   * trees whose manifest says the *wrong* thing, so ignoring a typo runs the
   * package manager the file was pointed at to override.
   */
  specFileMissing: (path: string) => `JUP_SPEC_FILE points at ${path}, which does not exist`,

  /* §12.12 — new in this spec --------------------------------------------- */

  binEscapes: (binPath: string, name: string, version: string) =>
    `The bin path '${binPath}' declared by ${name}@${version} escapes its installation directory`,

  /* §15.28 — native package managers -------------------------------------- */

  /**
   * A `{platform}` placeholder this host cannot fill.
   *
   * The failure mode this exists to prevent is a URL that still carries the
   * literal `{platform}`, which 404s and blames the registry. Name the host
   * value that was not recognised, and the set that would have been.
   */
  unsupportedPlatform: (name: string, reference: string, platform: string) =>
    `${name}@${reference} ships per-platform artifacts, and there is none for platform '${platform}' (supported: darwin, linux, win32)`,

  /** The same for `{arch}`. Reported separately so the message names the half that failed. */
  unsupportedArch: (name: string, reference: string, arch: string) =>
    `${name}@${reference} ships per-platform artifacts, and there is none for architecture '${arch}' (supported: arm64, x64)`,

  /**
   * §15.28 — a `{target}` this band does not ship for.
   *
   * Distinct from the two above, and more specific than either: `{platform}` and
   * `{arch}` fail when the *host* is outside the tool's vocabulary, whereas this
   * fails when the host is perfectly ordinary and the **version** has no build
   * for it — bun published no Windows artifact before 1.1.0, and none for
   * Windows on arm64 before 1.3.10. The version is therefore named alongside the
   * host, because bumping it is usually the fix.
   */
  unsupportedTarget: (name: string, reference: string, host: string, supported: string[]) =>
    `${name}@${reference} publishes no artifact for ${host} (this version ships: ${supported.join(", ")})`,

  /**
   * §12.12, §03.4, §15.39 — a runtime named in the manifest's `packageManager`.
   *
   * Raised on the *field*, never on `parseSpec` in general: `jup node@22`,
   * `jup use node@22` and `jup install -g node@24` all put a runtime name
   * through the same parser from `CLI arguments` and are ordinary. It is only
   * the committed pin that must not claim a runtime is the project's package
   * manager, because that is the field §03.5 enforces `pnpm` and `yarn` with —
   * so the message names the field that *would* have worked.
   */
  runtimeInPackageManager: (name: string) =>
    `"packageManager" cannot name ${name}: it is a runtime, not a package manager - declare it in "devEngines.runtime" instead`,

  /* §15.40 — version files ------------------------------------------------ */

  /**
   * The file exists and does not carry exactly one version.
   *
   * Not a fallback: a file written to be obeyed and unreadable is a mistake to
   * report, not a reason to quietly run the compiled-in default. nvm refuses the
   * same input (`nvm_nvmrc_invalid_msg`), so an `.nvmrc` this rejects was already
   * broken for the tool that reads it every day.
   */
  versionFileInvalid: (source: string) =>
    `Invalid ${source}: expected a single version, optionally with # comments and key=value lines`,

  /**
   * The file carries one version and it is not a version.
   *
   * `lts/*` and `lts/<codename>` are the words that reach this most often, and
   * the message deliberately does not single them out: every nvm alias fails for
   * its own reason and the remedy is the same one. Naming `devEngines.runtime`
   * is the point — it is the field that can express what the alias meant.
   */
  versionFileUnsupported: (declared: string, source: string) =>
    `Unsupported version ${json(declared)} in ${source}: jup resolves semver versions and ranges, not nvm aliases - write a version or range there, or declare it in "devEngines.runtime"`,

  /* §15.12 — the sidecar integrity ---------------------------------------- */

  /**
   * `devEngines.packageManager.integrity` that is not an SRI string this
   * implementation can turn into a build-suffix hash. Routed through `onFail`
   * like every other `devEngines` complaint (§03.3): a pin nobody can check is
   * exactly the state §15.11 exists to refuse, so silence is the wrong default.
   */
  devEnginesBadIntegrity: (value: unknown) =>
    `Invalid "devEngines.packageManager.integrity" field: ${JSON.stringify(value) ?? String(value)}`,

  /**
   * Both spellings of the pin are present and they disagree. §15.12 requires
   * both forms to be *accepted*; it does not make one silently outrank a
   * conflicting other, and two different digests for one artifact means at most
   * one of them describes what will run.
   */
  devEnginesIntegrityMismatch: (packageManager: string, integrity: string) =>
    `The "packageManager" field (${packageManager}) and "devEngines.packageManager.integrity" (${integrity}) pin different hashes`,

  /* §14.5 — env-file eligibility ------------------------------------------ */

  ignoringEnvVar: (name: string, path: string) =>
    `! Ignoring ${name} from ${path}: this variable can only be set in the environment`,
} as const;
