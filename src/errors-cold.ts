/**
 * The half of `errors.ts` no warm invocation can reach — see `.agents/12-errors.md`.
 *
 * Every string here is still part of the same observable contract, and the same
 * byte-for-byte rules apply. The split is about *when* they are parsed.
 *
 * A `yarn`, `npm` or `pnpm` invocation against a warm cache resolves a pin,
 * stats one marker and hands over (§01.3, §16.3). It downloads nothing,
 * verifies nothing, opens no socket and runs no management command — so the
 * messages those paths raise are dead text on the path that runs a few hundred
 * times a day. Kept in `errors.ts` they cost ~7 kB of the emitted warm chunk to
 * parse and discard, which was its single largest resident.
 *
 * So the table is split along the one line that already exists: `errors.ts`
 * holds what a warm module can raise, this file holds the rest, and
 * {@link messages} here is **both halves merged**. Nothing at a call site
 * changes — a cold module reads `messages.anything` exactly as before, and gets
 * the whole vocabulary. What changes is the import specifier, and with it which
 * chunk the bytes land in.
 *
 * The rule the compiler enforces for free: a warm module importing from
 * `errors.ts` cannot name a message that lives here, because the type does not
 * have it. A cold module reaching for `errors.ts` compiles until it needs one of
 * these, and `test/unit/main.test.ts` fails the moment a warm module imports
 * *this* file — the warm chunk is pinned to an exact module set.
 *
 * The functions moved for the same reason. `redactUserinfo` and the two network
 * helpers only ever run with a URL in hand, and {@link explainFetchFailure} only
 * ever runs in a `catch` around a download or a resolution — both of which are
 * already behind a dynamic import at their `main.ts` call sites.
 */

import { ENV, jupSpelling } from "./config/env-vars.ts";
import { messages as warm, UsageError } from "./errors.ts";

export * from "./errors.ts";

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

/**
 * §12's strings, complete: {@link warm}'s half plus the ones only a download, a
 * verification, a registry lookup or a management command can raise.
 *
 * Merged rather than separate so that "which object holds this message?" is
 * never a question a call site has to answer. Cold modules import this name and
 * nothing else changes.
 */
export const messages = {
  ...warm,

  /* §12.2 — spec parsing ------------------------------------------------- */

  invalidSpecExpectedVersion: (source: string, raw: string) =>
    `Invalid package manager specification in ${source} (${raw}); expected a semver version`,

  /** Unreachable in corepack (the check is guarded by `enforceExactVersion`), kept for fidelity. */
  invalidSpecExpectedVersionRangeOrTag: (source: string, raw: string) =>
    `Invalid package manager specification in ${source} (${raw}); expected a semver version, range, or tag`,

  /* §12.3 — devEngines validation ---------------------------------------- */

  /**
   * §12.3 — the two name slots are **independent**: the first names what is about
   * to be pinned, the second what `devEngines.packageManager` declared. Passing
   * one name for both makes the cross-name form (`use pnpm@…` in a project whose
   * devEngines say `yarn`) unprintable.
   */
  devEnginesPinMismatch: (name: string, reference: string, rangeName: string, range: string) =>
    `The requested version of ${name}@${reference} does not match the devEngines specification (${rangeName}@${range})`,

  /* §12.4 — resolution ---------------------------------------------------- */

  tagNotFound: (tag: string) => `Tag not found (${tag})`,

  tagsNotAllowed: () => `Packages managers can't be referenced via tags in this context`,

  /**
   * §15.17 — a version no declared band covers. Corepack's equivalent is an
   * assertion failure that kills the run; this is a debug-level note, because
   * the run now succeeds by reading `bin` from the verified package.
   */
  binFromPackage: (name: string, version: string) =>
    `${name}@${version} matches no declared range band; reading "bin" from the verified package. Add a range band for it.`,

  /**
   * §15.17 point 3 — the band still covers this version, but its entry points
   * are not the ones the package ships. The package won, so the run succeeds;
   * this note is the only thing that will ever say the band has rotted.
   */
  binBandStale: (
    name: string,
    version: string,
    band: Record<string, string>,
    declared: Record<string, string>,
  ) =>
    `${name}@${version} declares "bin" ${JSON.stringify(declared)}, but its range band says ${JSON.stringify(band)}. The package won; update the range band.`,

  upNotSemver: () =>
    `The 'jup up' command can only be used when your project's packageManager field is set to a semver version or semver range`,

  upNoHighest: (name: string, major: number) =>
    `Failed to find the highest release for ${name} ${major}.x`,

  /**
   * §15.35j — a version that was never published.
   *
   * §04.1 step 5 returns an exact version *without* asking whether it exists, so
   * the first sign of a typo used to be {@link badStatus} naming a tarball URL
   * the user never typed. This is the sentence that names what was asked for.
   */
  versionDoesNotExist: (name: string, version: string, registry: string) =>
    `${name}@${version} does not exist in ${url_(registry)}. Run 'jup info' to see the resolved spec and where it came from.`,

  /**
   * §15.19 — the airgapped diagnostic.
   *
   * Two open issues (#448, #414) report the documented `pack -o` →
   * `install -g --cache-only` flow not working, with the missing steps found by
   * trial and error in the threads. Naming the seeding command in the failure is
   * the difference between a Dockerfile that can be fixed and one that cannot.
   */
  notInCacheOffline: (name: string, range: string) =>
    `${name}@${range} is not in the cache and network access is disabled. Seed it with 'jup install -g --cache-only ${name}@${range}', or run 'jup pack ${name}@${range}' on a networked machine.`,

  /* §12.6 — network ------------------------------------------------------- */

  networkDisabledUrl: (url: string) =>
    `Network access disabled by the environment; can't reach ${url_(url)}`,

  /** Distinct from the above: the npm-registry layer names the *registry*, not the URL. */
  networkDisabledRegistry: (registryUrl: string) =>
    `Network access disabled by the environment; can't reach npm repository ${url_(registryUrl)}`,

  requestFailed: (url: string) =>
    `Error when performing the request to ${url_(url)}; for troubleshooting help, see https://github.com/unjs/jup#troubleshooting`,

  badStatus: (status: number, url: string) =>
    `Server answered with HTTP ${status} when performing the request to ${url_(url)}; for troubleshooting help, see https://github.com/unjs/jup#troubleshooting`,

  noValidTarball: (packageName: string, version: string) =>
    `${packageName}@${version} does not have a valid tarball.`,

  abortedByUser: () => `Aborted by the user`,

  /**
   * Both env var names here are load-bearing: the conformance suite asserts they
   * are exactly `JUP_INTEGRITY_KEYS` and `JUP_DEFAULT_TO_LATEST` — the canonical
   * spelling of §11's pair (§14.22) — and asserts the never-existing
   * `INTEGRITY_CHECK` / `USE_LATEST` names do **not** appear.
   */
  cannotDownloadLatest: (packageName: string) =>
    `jup cannot download the latest stable version of ${packageName}; you can disable signature verification by setting JUP_INTEGRITY_KEYS to 0 in your env, or instruct jup to use the latest stable release known by this version of jup by setting JUP_DEFAULT_TO_LATEST to 0`,

  /* §15.4 — TLS ------------------------------------------------------------ */

  /**
   * The three sentences §15.4 requires in place of a bare transport error, each
   * verbatim (the spec wraps them across lines; they are one logical string).
   *
   * `<host>` is the authority whose certificate was rejected — the target's, or
   * the proxy's when the proxy is itself `https://`.
   */
  tlsUnknownAuthority: (host: string) =>
    `TLS certificate verification failed for ${host}: the certificate was issued by an unknown authority. If your network uses a TLS-inspecting proxy, point JUP_CAFILE at its CA bundle.`,

  tlsBadValidity: (host: string) =>
    `TLS certificate for ${host} is expired or not yet valid (check the system clock).`,

  tlsHostnameMismatch: (host: string) =>
    `TLS certificate for ${host} does not match that hostname.`,

  /** Verbatim. `<source>` names where the setting came from, not what it does. */
  strictSslDisabled: (source: string) =>
    `! TLS certificate verification is disabled (set by ${source})`,

  /**
   * `<source>` names where the bundle came from, exactly as
   * {@link strictSslDisabled} does: the variable under the spelling the user
   * actually set, or `cafile (/home/u/.npmrc)` when a file supplied it. Saying
   * `JUP_CAFILE` unconditionally is a lie in the `.npmrc` case, and §15.4's
   * whole point is that a TLS failure names what to go and fix.
   */
  cafileUnreadable: (path: string, source: string = jupSpelling(ENV.CAFILE)) =>
    `Unable to read the TLS certificate bundle at ${path} (set by ${source})`,

  cafileEmpty: (path: string) =>
    `The TLS certificate bundle at ${path} contains no PEM certificate`,

  /**
   * §15.4 — the configuration was applied and did not stick. Naming the source
   * is the whole point: without it the run fails later with a bare
   * `UNABLE_TO_GET_ISSUER_CERT`, which is the unexplained certificate error
   * §15.4 exists to abolish — reached by someone who already fixed it.
   */
  cafileNotApplied: (source: string) =>
    `The TLS certificates from ${source} were installed, but this runtime's trust store does not reflect them; requests would fail with an unexplained certificate error`,

  cafileUnsupported: (source: string) =>
    `This runtime cannot apply the TLS certificates from ${source}: node:tls provides no setDefaultCACertificates`,

  /* §15.5 — resilience ----------------------------------------------------- */

  /**
   * Attached as the cause of §12.6's transport-failure message, never in place
   * of it: §05.1 requires a timeout to "surface as the transport-failure
   * message", and §15.5 requires the underlying reason to survive alongside it.
   */
  networkTimeout: (milliseconds: number, url: string) =>
    `Timed out after ${milliseconds}ms waiting for ${url_(url)} (set JUP_NETWORK_TIMEOUT to allow longer)`,

  /** The last of several attempts; the wrapper above still names the URL. */
  retriesExhausted: (attempts: number) =>
    `Giving up after ${attempts} attempt${attempts === 1 ? "" : "s"} (set JUP_NETWORK_RETRIES to change)`,

  /* §12.7 — integrity ----------------------------------------------------- */

  noCompatibleSignature: () => `No compatible signature found in package metadata`,

  notSignedByTrustedKeys: (details: unknown) =>
    `The package was not signed by any trusted keys: ${JSON.stringify(details, undefined, 2)}`,

  signatureMismatch: () => `Signature does not match`,

  /* §12.8 — store & filesystem -------------------------------------------- */

  cannotLocateBinInTarball: (binPath: string) => `Cannot locate '${binPath}' in downloaded tarball`,

  unableToLocateBin: () => `Unable to locate bin in package.json`,

  /** `hydrate` says `'jup prepare'` instead — pass the command name. */
  invalidArchiveFormat: (command: "pack" | "prepare" = "pack") =>
    `Invalid archive format; did it get generated by 'jup ${command}'?`,

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

  aboutToDownload: (url: string) => `! jup is about to download ${url_(url)}`,

  /** Trailing space, no newline. */
  downloadPrompt: () => `? Do you want to continue? [Y/n] `,

  /** §15.35l — `cache clean` must distinguish a successful clean from a no-op. */
  removedFromCache: (count: number, path: string) =>
    `Removed ${count} cached version(s) from ${path}`,

  /** §15.18 — the `--all` form, which also retires the recorded defaults. */
  removedFromCacheAll: (versions: number, defaults: number, path: string) =>
    `Removed ${versions} cached version(s) and ${defaults} recorded default(s) from ${path}`,

  nothingToRemove: () => `Nothing to remove`,

  /**
   * §15.35c — a deprecated command names its replacement and still works.
   *
   * #624: corepack prints nothing, so `prepare` looks current in every CI log
   * still using it. Verbatim for `prepare`; `hydrate` is the same sentence with
   * its own replacement, since the rule is about deprecated commands at large.
   */
  deprecatedCommand: (command: string, replacement: string) =>
    `'jup ${command}' is deprecated; use 'jup ${replacement}' instead.`,

  /* §12.12 — new in this spec --------------------------------------------- */

  expiredKey: (keyid: string, expires: string) =>
    `The package was signed with an expired key (${keyid}, expired ${expires})`,

  /**
   * §06.5/§14.4 — the leniency, and never silent. The signature *verified*; only
   * the key that made it has since been rotated out, which is the permanent
   * state of everything npm published before 2025-01-29. So the line says what
   * was accepted, not that the reader has something to fix.
   */
  expiredKeyAccepted: (name: string, version: string, keyid: string, expires: string) =>
    `! jup integrity warning: ${name}@${version} carries a valid signature from ${keyid}, a key that expired ${expires}; accepting it`,

  noNodeRuntime: (binName: string) =>
    `Unable to locate a Node.js runtime to execute ${binName}; set JUP_NODE_EXECPATH to point at one`,

  noShimDirectory: () => `Unable to determine where to install the shims; pass --install-directory`,

  shimNotOurs: (binName: string, file: string) =>
    `${binName} already exists at ${file} and was not installed by this tool - skipping (use --force to overwrite)`,

  refusingToExtract: (entry: string) =>
    `Refusing to extract '${entry}': path escapes the extraction directory`,

  refusingToDownload: (host: string, registry: string) =>
    `Refusing to download from ${url_(host)}: it does not match the configured registry ${url_(registry)}`,

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
    `Refusing to install ${name}@${version}: ${source} provides no signature and no hash was pinned. Pin a hash in the packageManager field, or set JUP_ALLOW_UNVERIFIED=1.`,

  /**
   * The opt-out's warning half. §15.11 requires the escape hatch to be loud:
   * a per-run downgrade that printed nothing would be indistinguishable from
   * the verified path it replaces.
   */
  allowingUnverified: (name: string, version: string, source: string) =>
    `! Installing ${name}@${version} from ${source} with no signature and no pinned hash (JUP_ALLOW_UNVERIFIED=1)`,
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
    String.raw`(\S+); for troubleshooting help, see https://github\.com/unjs/jup#troubleshooting$`,
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
