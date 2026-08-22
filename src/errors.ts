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

/**
 * Strip `user:pass@` from a URL before it reaches a message.
 *
 * §11.2 lets `COREPACK_NPM_REGISTRY` embed credentials, so any message that
 * interpolates a registry or artifact URL is a potential disclosure — into CI
 * logs, terminal scrollback, and pasted error reports. Redacting inside the
 * builders rather than at each call site means a new message cannot leak by
 * forgetting to opt in.
 *
 * The regex fallback matters: a URL too malformed for `new URL` is exactly the
 * kind that ends up in an error message.
 */
export function redactUserinfo(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.username === "" && url.password === "") return raw;
    url.username = "";
    url.password = "";
    return url.href;
  } catch {
    return raw.replace(/^([a-z][\d+.a-z-]*:\/\/)[^#/?]*@/i, "$1");
  }
}

/**
 * The same redaction, applied to a URL appearing *anywhere* in free text.
 *
 * {@link redactUserinfo} is anchored, because it is given a URL and nothing
 * else. A transport error's message is prose with a URL somewhere inside it, and
 * that is exactly the text {@link describeCause} is about to append to a stack
 * trace, so it needs the unanchored form.
 */
export function redactUserinfoAnywhere(text: string): string {
  return text.replace(/([a-z][\d+.a-z-]*:\/\/)[^\s#/?]*@/gi, "$1");
}

const url_ = redactUserinfo;

/**
 * A network failure whose message is already the best thing to say.
 *
 * §15.4's three TLS sentences replace §12.6's transport-failure message rather
 * than hiding underneath it — "MUST NOT surface a bare transport error" — and a
 * failure classified deep in the transport (an `https://` proxy's own
 * certificate, say) must not be re-classified against the wrong host on the way
 * out. This class is that marker.
 */
export class NetworkError extends Error {
  override readonly name = "NetworkError";
}

/**
 * One line per link of an error's `cause` chain, redacted.
 *
 * §15.5 — "the final error MUST include the underlying cause, the errno or TLS
 * reason, not just the wrapper message". §12.6's wrapper is a fixed string that
 * real scripts match on, so the cause is carried alongside it rather than
 * spliced into it.
 */
function describeCause(cause: unknown): string[] {
  const lines: string[] = [];
  const seen = new Set<unknown>();
  let current = cause;

  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error) {
      const code = (current as { code?: unknown }).code;
      const suffix =
        typeof code === "string" && !current.message.includes(code) ? ` (${code})` : ``;
      lines.push(redactUserinfoAnywhere(`${current.message}${suffix}`));
      current = current.cause;
    } else {
      lines.push(redactUserinfoAnywhere(String(current)));
      break;
    }
  }

  return lines;
}

/**
 * Build a network error that shows its cause.
 *
 * `main.ts` presents an unexpected error as its `stack`, and a `stack` does not
 * mention `cause` — so a `CONNECT` refused with `502 Bad Gateway`, or an
 * `ECONNRESET`, or a timeout, reached the user as §12.6's generic sentence and
 * nothing else. The cause is attached as `cause` (for programmatic callers) and
 * appended to the stack (for the human), and the message itself is left byte for
 * byte as §12.6 specifies it.
 */
export function networkError<T extends Error>(error: T, cause: unknown): T {
  if (cause === undefined) return error;

  Object.defineProperty(error, "cause", {
    value: cause,
    writable: true,
    enumerable: false,
    configurable: true,
  });

  const described = describeCause(cause);
  if (described.length > 0 && typeof error.stack === "string") {
    error.stack = [error.stack, ...described.map((line) => `Caused by: ${line}`)].join("\n");
  }

  return error;
}

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

  /**
   * §12.3 — the two name slots are **independent**: the first names what is about
   * to be pinned, the second what `devEngines.packageManager` declared. Passing
   * one name for both makes the cross-name form (`use pnpm@…` in a project whose
   * devEngines say `yarn`) unprintable.
   */
  devEnginesPinMismatch: (name: string, reference: string, rangeName: string, range: string) =>
    `The requested version of ${name}@${reference} does not match the devEngines specification (${rangeName}@${range})`,

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

  /**
   * §15.23 — verbatim. The file name is spelled out rather than imported from
   * `lockfile.ts` because every module imports this one, and it must stay free
   * of the imports that would make it a cycle.
   */
  lockfileUnresolved: (name: string, range: string) =>
    `${name}@${range} is not resolved in .corepack.lock and lockfile updates are disabled.`,

  /**
   * §15.35j — a version that was never published.
   *
   * §04.1 step 5 returns an exact version *without* asking whether it exists, so
   * the first sign of a typo used to be {@link badStatus} naming a tarball URL
   * the user never typed. This is the sentence that names what was asked for.
   */
  versionDoesNotExist: (name: string, version: string, registry: string) =>
    `${name}@${version} does not exist in ${url_(registry)}. Run 'corepack info' to see the resolved spec and where it came from.`,

  /**
   * §15.19 — the airgapped diagnostic.
   *
   * Two open issues (#448, #414) report the documented `pack -o` →
   * `install -g --cache-only` flow not working, with the missing steps found by
   * trial and error in the threads. Naming the seeding command in the failure is
   * the difference between a Dockerfile that can be fixed and one that cannot.
   */
  notInCacheOffline: (name: string, range: string) =>
    `${name}@${range} is not in the cache and network access is disabled. Seed it with 'corepack install -g --cache-only ${name}@${range}', or run 'corepack pack ${name}@${range}' on a networked machine.`,

  /* §12.5 — project enforcement ------------------------------------------ */

  projectConfigured: (name: string, manifestPath: string) =>
    `This project is configured to use ${name} because ${manifestPath} has a "packageManager" field`,

  /* §12.6 — network ------------------------------------------------------- */

  networkDisabledUrl: (url: string) =>
    `Network access disabled by the environment; can't reach ${url_(url)}`,

  /** Distinct from the above: the npm-registry layer names the *registry*, not the URL. */
  networkDisabledRegistry: (registryUrl: string) =>
    `Network access disabled by the environment; can't reach npm repository ${url_(registryUrl)}`,

  requestFailed: (url: string) =>
    `Error when performing the request to ${url_(url)}; for troubleshooting help, see https://github.com/nodejs/corepack#troubleshooting`,

  badStatus: (status: number, url: string) =>
    `Server answered with HTTP ${status} when performing the request to ${url_(url)}; for troubleshooting help, see https://github.com/nodejs/corepack#troubleshooting`,

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

  /* §15.4 — TLS ------------------------------------------------------------ */

  /**
   * The three sentences §15.4 requires in place of a bare transport error, each
   * verbatim (the spec wraps them across lines; they are one logical string).
   *
   * `<host>` is the authority whose certificate was rejected — the target's, or
   * the proxy's when the proxy is itself `https://`.
   */
  tlsUnknownAuthority: (host: string) =>
    `TLS certificate verification failed for ${host}: the certificate was issued by an unknown authority. If your network uses a TLS-inspecting proxy, point COREPACK_CAFILE at its CA bundle.`,

  tlsBadValidity: (host: string) =>
    `TLS certificate for ${host} is expired or not yet valid (check the system clock).`,

  tlsHostnameMismatch: (host: string) =>
    `TLS certificate for ${host} does not match that hostname.`,

  /** Verbatim. `<source>` names where the setting came from, not what it does. */
  strictSslDisabled: (source: string) =>
    `! TLS certificate verification is disabled (set by ${source})`,

  cafileUnreadable: (path: string) =>
    `Unable to read the TLS certificate bundle at ${path} (set by COREPACK_CAFILE)`,

  cafileEmpty: (path: string) =>
    `The TLS certificate bundle at ${path} contains no PEM certificate`,

  /* §15.5 — resilience ----------------------------------------------------- */

  /**
   * Attached as the cause of §12.6's transport-failure message, never in place
   * of it: §05.1 requires a timeout to "surface as the transport-failure
   * message", and §15.5 requires the underlying reason to survive alongside it.
   */
  networkTimeout: (milliseconds: number, url: string) =>
    `Timed out after ${milliseconds}ms waiting for ${url_(url)} (set COREPACK_NETWORK_TIMEOUT to allow longer)`,

  /** The last of several attempts; the wrapper above still names the URL. */
  retriesExhausted: (attempts: number) =>
    `Giving up after ${attempts} attempt${attempts === 1 ? "" : "s"} (set COREPACK_NETWORK_RETRIES to change)`,

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

  aboutToDownload: (url: string) => `! Corepack is about to download ${url_(url)}`,

  /** Trailing space, no newline. */
  downloadPrompt: () => `? Do you want to continue? [Y/n] `,

  autoPinNotice: (name: string, reference: string) =>
    `! The local project doesn't define a 'packageManager' field. Corepack will now add one referencing ${name}@${reference}.`,

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

  /** §15.35l — `cache clean` must distinguish a successful clean from a no-op. */
  removedFromCache: (count: number, path: string) =>
    `Removed ${count} cached version(s) from ${path}`,

  /** §15.18 — the `--all` form, which also retires the recorded defaults. */
  removedFromCacheAll: (versions: number, defaults: number, path: string) =>
    `Removed ${versions} cached version(s) and ${defaults} recorded default(s) from ${path}`,

  nothingToRemove: () => `Nothing to remove`,

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
    `Refusing to download from ${url_(host)}: it does not match the configured registry ${url_(registry)}`,

  binEscapes: (binPath: string, name: string, version: string) =>
    `The bin path '${binPath}' declared by ${name}@${version} escapes its installation directory`,

  unsupportedHashAlgo: (algo: string) =>
    `Unsupported hash algorithm '${algo}' in the packageManager field`,

  /* §15.7 — registry metadata tiering ------------------------------------- */

  /**
   * Tier 1: no `dist` at all. Corepack destructures it and throws a raw
   * `TypeError: Cannot read properties of undefined`, which is the whole of
   * #570/#725/#808; this says which registry answered and what was wrong with
   * the answer.
   */
  noDistSection: (packageName: string, version: string, registry: string) =>
    `${packageName}@${version} metadata from ${url_(registry)} has no "dist" section; this registry may not be npm-compatible`,

  /**
   * Tier 2's refusal half: the registry signed nothing *and* published no digest
   * of any kind, so there is nothing for the downloaded bytes to be checked
   * against. §15.7 says refuse rather than install unverified bytes.
   */
  noRegistryDigest: (packageName: string, version: string, registry: string) =>
    `${packageName}@${version} metadata from ${url_(registry)} has neither "dist.integrity" nor "dist.shasum"`,

  /**
   * Tier 2's soft-fail half, verbatim from §15.7.
   *
   * Emitted once per package/version: Artifactory, Nexus and friends strip
   * `signatures` routinely, and the pre-§15.7 remedy — `COREPACK_INTEGRITY_KEYS=0`
   * — traded a metadata-shape problem for a permanent, global security
   * downgrade. The bytes are still checked against the registry's own digest;
   * what is lost is the signature that would have covered it.
   */
  unsignedRegistry: (registry: string, packageName: string, version: string) =>
    `! ${url_(registry)} does not publish signatures for ${packageName}@${version}; falling back to integrity-only verification`,

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
   * §15.28 — a native `bin` target that could not be executed at all.
   *
   * Distinct from a package manager that ran and failed: this is `spawn`
   * refusing, which on POSIX is almost always `EACCES` (the executable bit did
   * not survive extraction, §07.4 rule 6) or `ENOEXEC` (an artifact for the
   * wrong platform).
   */
  cannotExecute: (binPath: string, reason: string) => `Unable to execute ${binPath}: ${reason}`,

  /* §15.11 — one verification tier ---------------------------------------- */

  /**
   * §15.11's refusal, byte-exact.
   *
   * `<source>` is the origin the artifact would have come from, because that is
   * the thing that failed to vouch for it: `repo.yarnpkg.com` publishes no
   * signatures at all (§06.6), and a custom URL publishes nothing by
   * construction. TLS is not a verification tier, so neither clears one.
   */
  refusingUnverified: (name: string, version: string, source: string) =>
    `Refusing to install ${name}@${version}: ${source} provides no signature and no hash was pinned. Pin a hash in the packageManager field, or set COREPACK_ALLOW_UNVERIFIED=1.`,

  /**
   * The opt-out's warning half. §15.11 requires the escape hatch to be loud:
   * a per-run downgrade that printed nothing would be indistinguishable from
   * the verified path it replaces.
   */
  allowingUnverified: (name: string, version: string, source: string) =>
    `! Installing ${name}@${version} from ${source} with no signature and no pinned hash (COREPACK_ALLOW_UNVERIFIED=1)`,

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

/**
 * The inverse of {@link messages.badStatus} — `{status, url}`, or `null`.
 *
 * §15.35j needs to recognise "the artifact was not there" and re-report it as
 * "that version does not exist", and the only carrier the transport gives us is
 * the rendered sentence: `http.ts` throws a plain `Error` and the proxy path
 * must not import it to find out otherwise. Reading it back here keeps the
 * pattern next to the template it inverts, and `test/unit/errors.test.ts`
 * asserts the round trip so the two cannot drift apart.
 */
const BAD_STATUS_RE = new RegExp(
  String.raw`^Server answered with HTTP (\d{3}) when performing the request to ` +
    String.raw`(\S+); for troubleshooting help, see https://github\.com/nodejs/corepack#troubleshooting$`,
);

export function parseBadStatus(error: unknown): { status: number; url: string } | null {
  if (!(error instanceof Error)) return null;

  const match = BAD_STATUS_RE.exec(error.message);
  if (match === null) return null;

  return { status: Number(match[1]), url: match[2]! };
}

/** §12.6's two network-disabled sentences share this prefix; §15.19 keys off it. */
const NETWORK_DISABLED_PREFIX = "Network access disabled by the environment;";

/**
 * §15.19, §15.35j — re-report a fetch failure as a sentence about what was asked
 * for, or `null` to leave the original error alone.
 *
 * Two cases, and both exist because the transport's own message names a URL the
 * user never typed:
 *
 * * **Network disabled.** The airgapped flow (#448, #414) fails with "can't
 *   reach <url>", which says nothing about which package manager was missing or
 *   how to seed it. §15.19 requires both.
 * * **HTTP 404 on the artifact.** §04.1 step 5 hands back an exact version
 *   without checking that it exists, so a typo'd pin surfaces as a bare
 *   `Server answered with HTTP 404` (#204). §15.35j requires the version to be
 *   named as nonexistent.
 *
 * Deliberately a `UsageError`: both are things the user asked for that cannot be
 * done, so a stack trace would bury the sentence that explains them (§12.1).
 */
export function explainFetchFailure(
  error: unknown,
  what: { name: string; range: string; version?: string },
): UsageError | null {
  if (!(error instanceof Error)) return null;

  if (error.message.startsWith(NETWORK_DISABLED_PREFIX)) {
    return new UsageError(messages.notInCacheOffline(what.name, what.range));
  }

  const bad = parseBadStatus(error);
  if (bad === null || bad.status !== 404 || what.version === undefined) return null;

  // The origin actually contacted, which for Yarn Berry is not the npm registry
  // and for a mirrored setup is not the public one either. Naming the URL's own
  // origin is therefore both truthful and the answer to "where did it look?".
  let registry = bad.url;
  try {
    registry = new URL(bad.url).origin;
  } catch {
    // A URL too malformed to parse is still better in the message than nothing.
  }

  return new UsageError(messages.versionDoesNotExist(what.name, what.version, registry));
}
