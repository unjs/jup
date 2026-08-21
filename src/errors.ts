/**
 * Errors and user-facing strings — see `.agents/12-errors.md`.
 *
 * These strings are part of the observable contract. Scripts, CI logs, and
 * support docs match on them, so they are reproduced byte for byte: the leading
 * `! `, the absent trailing periods, the trailing space on the prompt.
 *
 * `<JSON x>` in the spec means `JSON.stringify(x)` — strings appear quoted.
 */

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
export const VALIDATION_WARNING_PREFIX = "! Corepack validation warning: ";

export const messages = {
  /* §12.2 — spec parsing ------------------------------------------------- */

  invalidSpecNotString: (source: string) =>
    `Invalid package manager specification in ${source}; expected a string`,

  noVersionSpecified: (raw: string, source: string) =>
    `No version specified for ${raw} in "packageManager" of ${source}`,

  unsupportedSpec: (raw: string) => `Unsupported package manager specification (${raw})`,

  invalidSpecExpectedVersion: (source: string, raw: string) =>
    `Invalid package manager specification in ${source} (${raw}); expected a semver version`,

  /** Unreachable in corepack (the check is guarded by `enforceExactVersion`), kept for fidelity. */
  invalidSpecExpectedVersionRangeOrTag: (source: string, raw: string) =>
    `Invalid package manager specification in ${source} (${raw}); expected a semver version, range, or tag`,

  illegalUrl: (raw: string) =>
    `Illegal use of URL for known package manager. Instead, select a specific version, or set COREPACK_ENABLE_UNSAFE_CUSTOM_URLS=1 in your environment (${raw})`,

  invalidPackageJson: (relativePath: string) => `Invalid package.json in ${relativePath}`,

  /* §12.3 — devEngines validation ---------------------------------------- */

  /** Unconditional warning, regardless of `onFail`. Emitted with the `! ` already attached. */
  devEnginesNotObject: (value: unknown) =>
    `! Corepack only supports objects as valid value for devEngines.packageManager. The current value (${json(value)}) will be ignored.`,

  /** Unconditional warning, regardless of `onFail`. */
  devEnginesArray: () =>
    `! Corepack does not currently support array values for devEngines.packageManager`,

  devEnginesBadName: (value: unknown) =>
    `The value of devEngines.packageManager.name ${json(value)} is not a supported string value`,

  devEnginesBadVersion: (value: unknown) =>
    `The value of devEngines.packageManager.version ${json(value)} is not a valid semver range`,

  devEnginesNameMismatch: (packageManager: unknown, name: unknown) =>
    `"packageManager" field is set to ${json(packageManager)} which does not match the "devEngines.packageManager" field set to ${json(name)}`,

  devEnginesVersionMismatch: (packageManager: unknown, name: unknown, version: unknown) =>
    `"packageManager" field is set to ${json(packageManager)} which does not match the value defined in "devEngines.packageManager" for ${json(name)} of ${json(version)}`,

  devEnginesPinMismatch: (name: string, reference: string, range: string) =>
    `The requested version of ${name}@${reference} does not match the devEngines specification (${name}@${range})`,

  /* §12.4 — resolution ---------------------------------------------------- */

  failedToResolve: (range: string, name: string) =>
    `Failed to successfully resolve '${range}' to a valid ${name} release`,

  tagNotFound: (tag: string) => `Tag not found (${tag})`,

  tagsNotAllowed: () => `Packages managers can't be referenced via tags in this context`,

  unsupportedByBuild: (name: string) =>
    `This package manager (${name}) isn't supported by this corepack build`,

  noRangeBand: (reference: string, ranges: readonly string[]) =>
    `Assertion failed: Specified resolution (${reference}) isn't supported by any of ${ranges.join(", ")}`,

  upNotSemver: () =>
    `The 'corepack up' command can only be used when your project's packageManager field is set to a semver version or semver range`,

  upNoHighest: (name: string, major: number) =>
    `Failed to find the highest release for ${name} ${major}.x`,

  /* §12.5 — project enforcement ------------------------------------------ */

  projectConfigured: (name: string, manifestPath: string) =>
    `This project is configured to use ${name} because ${manifestPath} has a "packageManager" field`,

  /* §12.6 — network ------------------------------------------------------- */

  networkDisabledUrl: (url: string) =>
    `Network access disabled by the environment; can't reach ${url}`,

  /** Distinct from the above: the npm-registry layer names the *registry*, not the URL. */
  networkDisabledRegistry: (registryUrl: string) =>
    `Network access disabled by the environment; can't reach npm repository ${registryUrl}`,

  requestFailed: (url: string) =>
    `Error when performing the request to ${url}; for troubleshooting help, see https://github.com/nodejs/corepack#troubleshooting`,

  badStatus: (status: number, url: string) =>
    `Server answered with HTTP ${status} when performing the request to ${url}; for troubleshooting help, see https://github.com/nodejs/corepack#troubleshooting`,

  noValidTarball: (packageName: string, version: string) =>
    `${packageName}@${version} does not have a valid tarball.`,

  abortedByUser: () => `Aborted by the user`,

  /**
   * Both env var names here are load-bearing: the conformance suite asserts they
   * are exactly `COREPACK_INTEGRITY_KEYS` and `COREPACK_DEFAULT_TO_LATEST`, and
   * asserts the never-existing `COREPACK_INTEGRITY_CHECK` / `COREPACK_USE_LATEST`
   * do **not** appear.
   */
  cannotDownloadLatest: (packageName: string) =>
    `Corepack cannot download the latest stable version of ${packageName}; you can disable signature verification by setting COREPACK_INTEGRITY_KEYS to 0 in your env, or instruct Corepack to use the latest stable release known by this version of Corepack by setting COREPACK_DEFAULT_TO_LATEST to 0`,

  /* §12.7 — integrity ----------------------------------------------------- */

  noCompatibleSignature: () => `No compatible signature found in package metadata`,

  notSignedByTrustedKeys: (details: unknown) =>
    `The package was not signed by any trusted keys: ${JSON.stringify(details, undefined, 2)}`,

  signatureMismatch: () => `Signature does not match`,

  /** Users read the `got` value and paste it into their `packageManager` field. Keep the format. */
  mismatchHashes: (expected: string, actual: string) =>
    `Mismatch hashes. Expected ${expected}, got ${actual}`,

  /* §12.8 — store & filesystem -------------------------------------------- */

  failedToCreateCacheDir: (target: string) =>
    `Failed to create cache directory. Please ensure the user has write access to the target directory (${target}). If the user's home directory does not exist, create it first.`,

  cannotLocateBinInTarball: (binPath: string) => `Cannot locate '${binPath}' in downloaded tarball`,

  unableToLocateBin: () => `Unable to locate bin in package.json`,

  assertUnableToLocateBinPath: (binName: string) =>
    `Assertion failed: Unable to locate path for bin '${binName}'`,

  /** `hydrate` says `'corepack prepare'` instead — pass the command name. */
  invalidArchiveFormat: (command: "pack" | "prepare" = "pack") =>
    `Invalid archive format; did it get generated by 'corepack ${command}'?`,

  unsupportedPackageManagerName: (name: string) => `Unsupported package manager '${name}'`,

  /* §12.9 — commands ------------------------------------------------------ */

  couldntFindProject: () =>
    `Couldn't find a project in the local directory - please specify the package manager to pack, or run this command from a valid project`,

  noSpecInProject: () =>
    `The local project doesn't feature a 'packageManager' field nor a 'devEngines.packageManager' field - please specify the package manager to pack, or update the manifest to reference it`,

  /** The deprecated `prepare` command omits the devEngines mention. */
  noSpecInProjectLegacy: () =>
    `The local project doesn't feature a 'packageManager' field - please specify the package manager to pack, or update the manifest to reference it`,

  invalidPackageManagerName: (name: string) => `Invalid package manager name '${name}'`,

  assertStubFolderMissing: () => `Assertion failed: The stub folder doesn't exist`,

  yarnSwitchSkip: (binName: string, file: string) =>
    `${binName} is already installed in ${file} and points to a Yarn Switch install - skipping`,

  /* §12.10 — informational output ----------------------------------------- */

  addingToCache: (name: string, reference: string) => `Adding ${name}@${reference} to the cache...`,

  installing: (name: string, reference: string) => `Installing ${name}@${reference}...`,

  installingInProject: (name: string, reference: string) =>
    `Installing ${name}@${reference} in the project...`,

  allDone: () => `All done!`,

  aboutToDownload: (url: string) => `! Corepack is about to download ${url}`,

  /** Trailing space, no newline. */
  downloadPrompt: () => `? Do you want to continue? [Y/n] `,

  autoPinNotice: (name: string, reference: string) =>
    `! The local project doesn't define a 'packageManager' field. Corepack will now add one referencing ${name}@${reference}.`,

  autoPinDocs: () =>
    `! For more details about this field, consult the documentation at https://nodejs.org/api/packages.html#packagemanager`,

  /* §12.12 — new in this spec --------------------------------------------- */

  expiredKey: (keyid: string, expires: string) =>
    `The package was signed with an expired key (${keyid}, expired ${expires})`,

  noNodeRuntime: (binName: string) =>
    `Unable to locate a Node.js runtime to execute ${binName}; set COREPACK_NODE_EXECPATH to point at one`,

  noShimDirectory: () => `Unable to determine where to install the shims; pass --install-directory`,

  shimNotOurs: (binName: string, file: string) =>
    `${binName} already exists at ${file} and was not installed by this tool - skipping (use --force to overwrite)`,

  refusingToExtract: (entry: string) =>
    `Refusing to extract '${entry}': path escapes the extraction directory`,

  refusingToDownload: (host: string, registry: string) =>
    `Refusing to download from ${host}: it does not match the configured registry ${registry}`,

  binEscapes: (binPath: string, name: string, version: string) =>
    `The bin path '${binPath}' declared by ${name}@${version} escapes its installation directory`,

  unsupportedHashAlgo: (algo: string) =>
    `Unsupported hash algorithm '${algo}' in the packageManager field`,

  /* §14.5 — env-file eligibility ------------------------------------------ */

  ignoringEnvVar: (name: string, path: string) =>
    `! Ignoring ${name} from ${path}: this variable can only be set in the environment`,
} as const;
