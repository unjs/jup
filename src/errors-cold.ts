/**
 * Cold-only messages and network helpers live here. `messages` merges both halves; warm modules must not import this file.
 */

const { join } = process.getBuiltinModule("node:path");
import { ENV } from "./config/env-vars.ts";
import { getSpecFor } from "./config/table.ts";
import { messages as warm, UsageError } from "./errors.ts";
import { CACHE_DIRECTORY, LOCKFILE_NAME } from "./project/lockfile.ts";
import type { Palette } from "./utils/log.ts";
import { lt } from "./version/semver.ts";

export * from "./errors.ts";

/** §04.4's memo, as the advisories naming it have to spell it. */
const MEMO_FILE = join(CACHE_DIRECTORY, LOCKFILE_NAME);

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
 * §05.1's three TLS sentences replace §12.6's transport-failure message rather
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
 * §05.1 — "the final error MUST include the underlying cause, the errno or TLS
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

export const messages = {
  ...warm,
  invalidSpecExpectedVersion: (source: string, raw: string) =>
    `Invalid package manager specification in ${source} (${raw}); expected a semver version`,

  invalidSpecExpectedVersionRangeOrTag: (source: string, raw: string) =>
    `Invalid package manager specification in ${source} (${raw}); expected a semver version, range, or tag`,
  /**
   * §12.3 — the two name slots are **independent**: the first names what is about
   * to be pinned, the second what `devEngines.packageManager` declared. Passing
   * one name for both makes the cross-name form (`use pnpm@…` in a project whose
   * devEngines say `yarn`) unprintable.
   */
  devEnginesPinMismatch: (name: string, reference: string, rangeName: string, range: string) =>
    `The requested version of ${name}@${reference} does not match the devEngines specification (${rangeName}@${range})`,
  tagNotFound: (tag: string) => `Tag not found (${tag})`,

  tagsNotAllowed: () => `Packages managers can't be referenced via tags in this context`,

  /** Debug-level notice when verified package metadata supplies an unbanded entry point. */
  binFromPackage: (name: string, version: string) =>
    `${name}@${version} matches no declared range band; reading "bin" from the verified package. Add a range band for it.`,

  /**
   * §07.7 — the band still covers this version, but its entry points
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

  /** Reframe an exact-version artifact 404 in terms of the requested version. */
  versionDoesNotExist: (name: string, version: string, registry: string) =>
    `${name}@${version} does not exist in ${url_(registry)}. Run 'jup info' to see the resolved spec and where it came from.`,

  /**
   * §04.1 — the same 404, for a version a band covers but its npm package was
   * never published over ({@link NpmRegistrySpec.publishedFrom}).
   *
   * The first sentence is `versionDoesNotExist`'s, verbatim: it is still true,
   * it is what a user greps for, and keeping it means the two messages differ
   * only where they have something different to say. What follows is the part
   * the bare form got wrong — the version *does* exist, somewhere jup does not
   * read — and the pin that would work instead.
   */
  versionBelowPublished: (
    name: string,
    version: string,
    registry: string,
    packageName: string,
    from: string,
  ) =>
    `${name}@${version} does not exist in ${url_(registry)}. jup installs ${name} from ${packageName}, whose earliest published version is ${from}; releases before it were only ever distributed elsewhere. Pin ${from} or newer.`,

  /** An offline miss must name the requested tool and the cache-seeding command. */
  notInCacheOffline: (name: string, range: string) =>
    `${name}@${range} is not in the cache and network access is disabled. Seed it with 'jup cache install -g --cache-only ${name}@${range}', or run 'jup pack ${name}@${range}' on a networked machine.`,
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

  /**
   * Both env var names here are load-bearing: the conformance suite asserts they
   * are exactly `JUP_INTEGRITY_KEYS` and `JUP_DEFAULT_TO_LATEST` — the canonical
   * spelling of §11's pair — and asserts the never-existing
   * `INTEGRITY_CHECK` / `USE_LATEST` names do **not** appear.
   */
  cannotDownloadLatest: (packageName: string) =>
    `jup cannot download the latest stable version of ${packageName}; you can disable signature verification by setting JUP_INTEGRITY_KEYS to 0 in your env, or instruct jup to use the latest stable release known by this version of jup by setting JUP_DEFAULT_TO_LATEST to 0`,
  /**
   * The three sentences §05.1 requires in place of a bare transport error, each
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
    `⚠ TLS certificate verification is disabled (set by ${source})`,

  /**
   * `<source>` names where the bundle came from, exactly as
   * {@link strictSslDisabled} does: the variable under the spelling the user
   * actually set, or `cafile (/home/u/.npmrc)` when a file supplied it. Saying
   * `JUP_CAFILE` unconditionally is a lie in the `.npmrc` case, and §05.1's
   * whole point is that a TLS failure names what to go and fix.
   */
  cafileUnreadable: (path: string, source: string = ENV.CAFILE) =>
    `Unable to read the TLS certificate bundle at ${path} (set by ${source})`,

  cafileEmpty: (path: string) =>
    `The TLS certificate bundle at ${path} contains no PEM certificate`,

  /**
   * §05.1 — the configuration was applied and did not stick. Naming the source
   * is the whole point: without it the run fails later with a bare
   * `UNABLE_TO_GET_ISSUER_CERT`, which is the unexplained certificate error
   * §05.1 exists to abolish — reached by someone who already fixed it.
   */
  cafileNotApplied: (source: string) =>
    `The TLS certificates from ${source} were installed, but this runtime's trust store does not reflect them; requests would fail with an unexplained certificate error`,

  cafileUnsupported: (source: string) =>
    `This runtime cannot apply the TLS certificates from ${source}: node:tls provides no setDefaultCACertificates`,
  /**
   * Attached as the cause of §12.6's transport-failure message, never in place
   * of it: §05.1 requires a timeout to "surface as the transport-failure
   * message", and §05.1 requires the underlying reason to survive alongside it.
   */
  networkTimeout: (milliseconds: number, url: string) =>
    `Timed out after ${milliseconds}ms waiting for ${url_(url)} (set JUP_NETWORK_TIMEOUT to allow longer)`,

  /** The last of several attempts; the wrapper above still names the URL. */
  retriesExhausted: (attempts: number) =>
    `Giving up after ${attempts} attempt${attempts === 1 ? "" : "s"} (set JUP_NETWORK_RETRIES to change)`,
  noCompatibleSignature: () => `No compatible signature found in package metadata`,

  notSignedByTrustedKeys: (details: unknown) =>
    `The package was not signed by any trusted keys: ${JSON.stringify(details, undefined, 2)}`,

  signatureMismatch: () => `Signature does not match`,
  unableToLocateBin: () => `Unable to locate bin in package.json`,

  invalidArchiveFormat: () => `Invalid archive format; did it get generated by 'jup pack'?`,

  unsupportedPackageManagerName: (name: string) => `Unsupported package manager '${name}'`,
  couldntFindProject: () =>
    `Couldn't find a project in the local directory - please specify the package manager to pack, or run this command from a valid project`,

  noSpecInProject: () =>
    `The local project doesn't feature a 'packageManager' field nor a 'devEngines.packageManager' field - please specify the package manager to pack, or update the manifest to reference it`,

  invalidPackageManagerName: (name: string) => `Invalid package manager name '${name}'`,

  assertStubFolderMissing: () => `Assertion failed: The stub folder doesn't exist`,

  yarnSwitchSkip: (binName: string, file: string) =>
    `${binName} is already installed in ${file} and points to a Yarn Switch install - skipping`,
  addingToCache: (name: string, reference: string) => `Adding ${name}@${reference} to the cache...`,

  installing: (name: string, reference: string) => `Installing ${name}@${reference}...`,

  installingInProject: (name: string, reference: string) =>
    `Installing ${name}@${reference} in the project...`,

  allDone: () => `All done!`,

  /**
   * §05.4 — the artifact download notice, one line on stderr.
   *
   * What a reader wants first is *what* is being fetched, so the entry leads
   * and the URL trails: the name and version are the fact worth reading at a
   * glance, the URL the fact worth auditing. Colour is passed in rather than
   * reached for, because §12.11 still fixes the text: with the palette off
   * (`NO_COLOR`, a pipe, an agent) every paint is identity, and what is left is
   * §12.11's line byte for byte.
   *
   * `tool` is optional, and its version separately so, because a caller does
   * not always know either: a URL reference carries no version, and an artifact
   * the table never described carries no name.
   *
   * The line opens with `↓` rather than §12's `⚠ ` marker, and so is the one
   * §12.11 string that does not: a download is not an advisory, it is not muted
   * with the advisories (§11.3), and `⚠` in front of a routine fetch trains a
   * reader to ignore the glyph that matters.
   */
  aboutToDownload: (url: string, colors: Palette, tool?: { name: string; version?: string }) => {
    const what =
      tool === undefined
        ? ""
        : tool.version === undefined
          ? `${colors.cyan(tool.name)} from `
          : `${colors.cyan(tool.name)} ${colors.yellow(tool.version)} from `;
    return `${colors.cyan("↓")} Downloading ${what}${colors.dim(url_(url))}`;
  },

  /** §07.9 — `cache clean` must distinguish a successful clean from a no-op. */
  removedFromCache: (count: number, path: string) =>
    `Removed ${count} cached version(s) from ${path}`,

  /** §07.9 — the `--all` form, which also retires the recorded defaults. */
  removedFromCacheAll: (versions: number, defaults: number, path: string) =>
    `Removed ${versions} cached version(s) and ${defaults} recorded default(s) from ${path}`,

  nothingToRemove: () => `Nothing to remove`,

  /**
   * §07.9 — one line saying why the count is lower than the user expected.
   *
   * It has to carry three things or it is not worth printing: *what* survived,
   * *why* (the shims run through it, and `bad interpreter` is what removing it
   * would produce), and the way out — a re-`enable` under a runtime that will
   * outlive the cache, which §10.2 then pins outside `<home>` for good.
   */
  interpreterKept: (name: string, version: string, interpreter: string, home: string) =>
    `⚠ Kept ${name}@${version}: jup's shims name ${interpreter} as their interpreter, so removing it would leave every one of them failing with 'bad interpreter'. Re-run 'jup enable' under a node installed outside ${home} to repin them, then clean again.`,

  /**
   * §09.7 — one entry the clean could not delete.
   *
   * `rm -rf` forgives a missing path and nothing else, so what reaches here is a
   * permission or a lock: a tree left root-owned by an earlier `sudo` run, an
   * immutable file, a handle Windows has not let go of. The command carries on
   * and reports its real count; this line is what stops the difference between
   * "removed" and "still there" from being invisible.
   */
  cacheEntryNotRemoved: (path: string) =>
    `⚠ Could not remove ${path}; it is still in the cache. Remove it by hand, or re-run with permission to delete it.`,

  /**
   * §04.4 — the memo stood in because the registry could not be reached.
   *
   * A fallback that printed nothing was indistinguishable from a normal run, and
   * stayed so: the memo's stamp is deliberately not extended, so it recurs on
   * every later invocation. The user has to be told what they are running and why.
   *
   * Here rather than in `main.ts` for the reason the whole file exists: this is
   * text a warm run cannot print. Both call sites sit behind the dynamic import
   * that already had to be taken to classify the failure.
   */
  staleResolutionUnreachable: (name: string, range: string, version: string) =>
    `⚠ Unable to reach the registry to resolve ${name}@${range}; running ${name}@${version}, the expired resolution recorded in ${MEMO_FILE}. Its stamp is not extended, so this repeats until the registry answers again.`,

  /** The same notice for the other half of "degraded": it answered, with nothing usable. */
  staleResolutionUnmatched: (name: string, range: string, version: string) =>
    `⚠ The registry lists no release matching ${name}@${range}; running ${name}@${version}, the expired resolution recorded in ${MEMO_FILE}. Its stamp is not extended, so this repeats until a matching release is published.`,

  /**
   * §07.9 — the `--all` counterpart. Present tense, because it is printed
   * *before* the removal: afterwards there is no working `jup` left to print it.
   */
  interpreterRemoved: (name: string, version: string, interpreter: string, home: string) =>
    `⚠ Removing ${name}@${version}, which jup's shims name as their interpreter (${interpreter}): they will fail with 'bad interpreter' until 'jup enable' is re-run under a node installed outside ${home}.`,

  expiredKey: (keyid: string, expires: string) =>
    `The package was signed with an expired key (${keyid}, expired ${expires})`,

  /** §06.5 — report acceptance of a verified signature whose key expired. */
  expiredKeyAccepted: (name: string, version: string, keyid: string, expires: string) =>
    `⚠ jup integrity warning: ${name}@${version} carries a valid signature from ${keyid}, a key that expired ${expires}; accepting it`,

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
  /** Missing `dist` metadata must identify the package, version, and registry. */
  noDistSection: (packageName: string, version: string, registry: string) =>
    `${packageName}@${version} metadata from ${url_(registry)} has no "dist" section; this registry may not be npm-compatible`,

  /**
   * Tier 2's refusal half: the registry signed nothing *and* published no digest
   * of any kind, so there is nothing for the downloaded bytes to be checked
   * against. §06.1 says refuse rather than install unverified bytes.
   */
  noRegistryDigest: (packageName: string, version: string, registry: string) =>
    `${packageName}@${version} metadata from ${url_(registry)} has neither "dist.integrity" nor "dist.shasum"`,

  /**
   * Tier 2's soft-fail half, verbatim from §06.1.
   *
   * Emitted once per package/version. The bytes remain checked against the
   * registry's digest, but no signature covers that digest.
   */
  unsignedRegistry: (registry: string, packageName: string, version: string) =>
    `⚠ ${url_(registry)} does not publish signatures for ${packageName}@${version}; falling back to integrity-only verification`,
  /**
   * A native `bin` target that could not be executed at all.
   *
   * Distinct from a package manager that ran and failed: this is `spawn`
   * refusing, which on POSIX is almost always `EACCES` (the executable bit did
   * not survive extraction, §07.4 rule 6) or `ENOEXEC` (an artifact for the
   * wrong platform).
   */
  cannotExecute: (binPath: string, reason: string) => `Unable to execute ${binPath}: ${reason}`,
  /**
   * §06.1's refusal, byte-exact.
   *
   * `<source>` is the origin the artifact would have come from, because that is
   * the thing that failed to vouch for it: a registry that strips signatures
   * (§06.1 tier 3) publishes nothing to check, and a custom URL publishes
   * nothing by construction. TLS is not a verification tier, so neither
   * clears one.
   */
  refusingUnverified: (name: string, version: string, source: string) =>
    `Refusing to install ${name}@${version}: ${source} provides no signature and no hash was pinned. Pin a hash in the packageManager field, or set JUP_ALLOW_UNVERIFIED=1.`,

  /**
   * The opt-out's warning half. §06.1 requires the escape hatch to be loud:
   * a per-run downgrade that printed nothing would be indistinguishable from
   * the verified path it replaces.
   */
  allowingUnverified: (name: string, version: string, source: string) =>
    `⚠ Installing ${name}@${version} from ${source} with no signature and no pinned hash (JUP_ALLOW_UNVERIFIED=1)`,
} as const;

/**
 * The inverse of {@link messages.badStatus} — `{status, url}`, or `null`.
 *
 * §04.1 needs to recognise "the artifact was not there" and re-report it as
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

/** §12.6's two network-disabled sentences share this prefix. */
const NETWORK_DISABLED_PREFIX = "Network access disabled by the environment;";

/**
 * §12.6, §04.1 — re-report a fetch failure as a sentence about what was asked
 * for, or `null` to leave the original error alone.
 *
 * Network-disabled failures name the cache-seeding action; exact-version
 * artifact 404s name the missing version. Both are deliberate `UsageError`s so
 * the actionable sentence is not buried under a stack trace.
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

  const below = publishedFromFor(what.name, what.version);
  if (below !== null) {
    return new UsageError(
      messages.versionBelowPublished(
        what.name,
        what.version,
        registry,
        below.package,
        below.publishedFrom,
      ),
    );
  }

  return new UsageError(messages.versionDoesNotExist(what.name, what.version, registry));
}

/**
 * §04.1 — the band's npm package and its first published version, when the
 * requested version predates it. `null` otherwise, which is every tool but Yarn
 * Berry today.
 *
 * Table data only, and read only after a 404 has already happened: this decides
 * which sentence to print, never whether to make the request. A version outside
 * the table, or one the band declares no `publishedFrom` for, falls through to
 * the bare form rather than guessing.
 */
function publishedFromFor(
  name: string,
  version: string,
): { package: string; publishedFrom: string } | null {
  let registry;
  try {
    registry = getSpecFor(name, version).registry;
  } catch {
    // An unsupported name has no band; `getSpecFor` throws and the caller's
    // original 404 is the better message anyway.
    return null;
  }

  if (registry.type !== "npm") return null;
  const { publishedFrom } = registry;
  if (publishedFrom === undefined || !lt(version, publishedFrom)) return null;

  return { package: registry.package, publishedFrom };
}
