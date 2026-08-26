/**
 * Errors and user-facing strings — see `.agents/12-errors.md`.
 *
 * These strings are part of the observable contract. Scripts, CI logs, and
 * support docs match on them, so they are reproduced byte for byte: the leading
 * `! `, the absent trailing periods, the trailing space on the prompt.
 *
 * `<JSON x>` in the spec means `JSON.stringify(x)` — strings appear quoted.
 */

import { ENV, readEnv } from "./config/env-vars.ts";
import { getEntryName } from "./utils/self.ts";

/**
 * §17.6 C10 — the tool's own name, spelled as the user invoked it.
 *
 * Corepack's messages name it in their *bodies*, not only in usage lines, and
 * under the `corepack` entry point those bodies are frozen byte for byte (§13.1,
 * §17.4 R12). Under `jup` the name is substituted — and nothing else is: same
 * sentence, same punctuation, same interpolations, so a reader can still match
 * the two.
 *
 * Writing `${toolName()}` at the call site rather than running a replacement over
 * finished text is what makes that a property of the code instead of a promise:
 * there is one copy of each sentence, and the only thing that varies is a name.
 *
 * Three kinds of "corepack" are deliberately **not** routed through here, per
 * §12.1 and C10 — a name that belongs to something else is not our name:
 *
 * * `packageManager`, `devEngines`, and the `https://nodejs.org/…#packagemanager`
 *   URL, which are the manifest's vocabulary and Node's documentation;
 * * a `COREPACK_*` variable under its legacy spelling (§11.6);
 * * `https://github.com/nodejs/corepack#troubleshooting`. This one is a
 *   judgement call and it goes the same way: the URL names a **repository**, not
 *   this tool. `https://github.com/nodejs/jup#troubleshooting` does not exist,
 *   so substituting would turn a working pointer into a 404 — and pointing the
 *   sentence somewhere else entirely would be a rewrite, which C10 forbids.
 *
 * The corepack-named *files* were §17.6 C9's rename, not C10's substitution:
 * `.jup.lock`, `.jup.env`, `jup.tgz` and the `.jup` marker are what a message
 * names today, and each is still *read* under its old spelling. Where a message
 * names one, the name comes from the module that owns the file — the tool name
 * around it is the only thing this file substitutes.
 */
export const toolName = getEntryName;

/**
 * The same name at the start of a sentence: `! Corepack …` / `! Jup …`.
 *
 * Named `ToolName` rather than `Tool` because `Tool` is §17.3's table entry —
 * one identifier, two meanings, in a file that would eventually import both.
 */
export function ToolName(): string {
  const name = getEntryName();
  return name[0]!.toUpperCase() + name.slice(1);
}

/**
 * §17.6 C10a — how the messages below name **the kind of tool** the command is
 * acting on, and the manifest fields that go with it.
 *
 * C10's sibling. Where {@link toolName} substitutes *our* name, this substitutes
 * the noun: `Unsupported package manager specification` under `jup pm`,
 * `Unsupported runtime specification` under `jup runtime`. Same discipline —
 * the same sentence, the same punctuation, the same interpolations, one word
 * different — and the same exclusion: a `packageManager` or
 * `devEngines.packageManager` **field name** is not this noun, so the messages
 * that validate that field (`Invalid package manager specification in <source>;
 * expected a string`) are untouched under every scope.
 *
 * The noun is the **scope in effect** and never the role of anything resolved:
 * a command that fails before it has resolved a name has no role to report.
 */
export interface ScopeNaming {
  /** §17.4's `ROLE_NOUN` for the scope in effect — `package manager`, `runtime`. */
  noun: string;
  /**
   * The manifest fields that scope's role reads (§17.5 R14), primary first, for
   * the one sentence that names the noun *and* the fields. `manifest.ts`'s
   * `pinFieldLabels` is the mapping; nothing here derives it.
   */
  pinFields: readonly string[];
}

/**
 * The default, and the reason it is the safe one: it is corepack's frozen
 * wording, byte for byte.
 *
 * Unlike {@link toolName}, which *derives* its answer from `process.argv[1]`,
 * this is set by whoever knows the scope — and only the command router does
 * (§17.4 R7 step 4), which is cold-path code the warm proxy path never loads.
 * So the state has to start somewhere, and it starts where every unset caller is
 * already correct: proxy mode never sets a scope (§17.6 C10a), unscoped `jup`
 * keeps corepack's wording deliberately, and the `corepack` entry point is
 * frozen by R12. A scope that fails to be entered therefore under-reports
 * rather than mis-reports — the failure mode C10a calls "merely dated" instead
 * of the one it calls "wrong".
 */
const FROZEN_SCOPE: ScopeNaming = {
  noun: "package manager",
  pinFields: ["packageManager", "devEngines.packageManager"],
};

let currentScope: ScopeNaming = FROZEN_SCOPE;

/**
 * Enter a scope, returning the one it replaced so a caller can restore it.
 *
 * `null` restores {@link FROZEN_SCOPE}. The router hands this the naming for the
 * route it just classified (`commands/router.ts`'s `scopeNamingFor`), which is
 * why the dependency runs cold → warm and never the other way: `errors.ts` is
 * loaded on every proxy invocation and must not pull the router in behind it.
 */
export function setScopeNaming(next: ScopeNaming | null): ScopeNaming {
  const previous = currentScope;
  currentScope = next ?? FROZEN_SCOPE;
  return previous;
}

/** The noun of the scope in effect (§17.6 C10a). */
function noun(): string {
  return currentScope.noun;
}

/**
 * `a 'packageManager' field nor a 'devEngines.packageManager' field` — the
 * fields of the scope in effect, in the shape §12.9's sentence already had.
 *
 * A role with one field (`devEngines.runtime`, §17.5 R14) renders the single-
 * field form, which is the shape §12.9's other no-spec sentence already uses.
 */
function pinFieldClause(): string {
  return currentScope.pinFields.map((field) => `a '${field}' field`).join(" nor ");
}

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

/**
 * §12.3 — prefix applied when a validation failure warns instead of throwing.
 *
 * A function rather than a constant since §17.6 C10: the name it carries depends
 * on the entry point the user invoked.
 */
export function validationWarningPrefix(): string {
  return `! ${ToolName()} validation warning: `;
}

/**
 * §11.5 — an advisory line **this** implementation adds, which
 * `COREPACK_QUIET_ADVISORIES=1` silences. Split by origin, not by severity.
 *
 * Corepack's own six advisory sites — the download notice and its prompt, the
 * auto-pin notice, the three `devEngines` warnings, `enable`/`disable`'s Yarn
 * Switch skip — call `console.warn`/`stderr` directly and are never routed
 * here, because §13's rows and existing CI jobs match their text byte for byte.
 * Routing only what §14/§15 add is what lets "quiet" mean the extra lines
 * rather than a blunt mute that takes the contract text with it (§14.23).
 *
 * `readEnv`, not `envFlag`: `project/env.ts` imports this module, so reaching
 * for its flag reader would close a cycle over the warm path.
 */
export function advisory(message: string): void {
  if (readEnv(ENV.QUIET_ADVISORIES) === "1") return;
  console.warn(message);
}

export const messages = {
  /* §12.2 — spec parsing ------------------------------------------------- */

  /**
   * §17.6 C10a's exclusion, and §17.9 row 236: **not** `${noun()}`. All three
   * `Invalid package manager specification in <source>…` sentences are about a
   * malformed `packageManager` *field* — the field is the subject and there is
   * no noun about the command in them — so they read the same under every scope.
   */
  invalidSpecNotString: (source: string) =>
    `Invalid package manager specification in ${source}; expected a string`,

  noVersionSpecified: (raw: string, source: string) =>
    `No version specified for ${raw} in "packageManager" of ${source}`,

  unsupportedSpec: (raw: string) => `Unsupported ${noun()} specification (${raw})`,

  invalidSpecExpectedVersion: (source: string, raw: string) =>
    `Invalid package manager specification in ${source} (${raw}); expected a semver version`,

  /** Unreachable in corepack (the check is guarded by `enforceExactVersion`), kept for fidelity. */
  invalidSpecExpectedVersionRangeOrTag: (source: string, raw: string) =>
    `Invalid package manager specification in ${source} (${raw}); expected a semver version, range, or tag`,

  illegalUrl: (raw: string) =>
    `Illegal use of URL for known ${noun()}. Instead, select a specific version, or set COREPACK_ENABLE_UNSAFE_CUSTOM_URLS=1 in your environment (${raw})`,

  invalidPackageJson: (relativePath: string) => `Invalid package.json in ${relativePath}`,

  /* §12.3 — devEngines validation ---------------------------------------- */

  /**
   * §17.5 R14 — `block` is the `devEngines` sub-key the complaint is about, and
   * it defaults to `packageManager` so every one of these renders byte for byte
   * as §12.3 froze it for the only role §02.5's table has. A `devEngines.runtime`
   * validated "by the same rules" (R14) has to be able to say so: a message
   * naming `devEngines.packageManager` for a fault in the field beside it sends
   * the reader to the wrong line of their manifest.
   */

  /** Unconditional warning, regardless of `onFail`. Emitted with the `! ` already attached. */
  devEnginesNotObject: (value: unknown, block = "packageManager") =>
    `! ${ToolName()} only supports objects as valid value for devEngines.${block}. The current value (${json(value)}) will be ignored.`,

  /** Unconditional warning, regardless of `onFail`. */
  devEnginesArray: (block = "packageManager") =>
    `! ${ToolName()} does not currently support array values for devEngines.${block}`,

  devEnginesBadName: (value: unknown, block = "packageManager") =>
    `The value of devEngines.${block}.name ${json(value)} is not a supported string value`,

  devEnginesBadVersion: (value: unknown, block = "packageManager") =>
    `The value of devEngines.${block}.version ${json(value)} is not a valid semver range`,

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

  /**
   * The one §17.6 C10a judgement call, and it goes the way C10's `nodejs/corepack`
   * URL went: left alone. Corepack's noun here is plural *and* ungrammatical, so
   * a substitution would have to invent a plural and fix the typo — a rewrite,
   * which C10a forbids. It is also unreachable under a scope: every management
   * command resolves with `allowTags: true`, and the paths that do not (the
   * project spec, proxy mode) never set one.
   */
  tagsNotAllowed: () => `Packages managers can't be referenced via tags in this context`,

  unsupportedByBuild: (name: string) =>
    `This ${noun()} (${name}) isn't supported by this ${toolName()} build`,

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
    `The '${toolName()} up' command can only be used when your project's packageManager field is set to a semver version or semver range`,

  upNoHighest: (name: string, major: number) =>
    `Failed to find the highest release for ${name} ${major}.x`,

  /**
   * §15.23 — verbatim, except for the file name, which §17.6 C9 requires to be
   * **the file actually looked at**: `.jup.lock` normally, `.corepack.lock` for a
   * project still carrying the older name. It arrives as a parameter rather than
   * as an import from `lockfile.ts` because every module imports this one, and it
   * must stay free of the imports that would make it a cycle.
   */
  lockfileUnresolved: (name: string, range: string, file: string) =>
    `${name}@${range} is not resolved in ${file} and lockfile updates are disabled.`,

  /**
   * §15.35j — a version that was never published.
   *
   * §04.1 step 5 returns an exact version *without* asking whether it exists, so
   * the first sign of a typo used to be {@link badStatus} naming a tarball URL
   * the user never typed. This is the sentence that names what was asked for.
   */
  versionDoesNotExist: (name: string, version: string, registry: string) =>
    `${name}@${version} does not exist in ${url_(registry)}. Run '${toolName()} info' to see the resolved spec and where it came from.`,

  /**
   * §15.19 — the airgapped diagnostic.
   *
   * Two open issues (#448, #414) report the documented `pack -o` →
   * `install -g --cache-only` flow not working, with the missing steps found by
   * trial and error in the threads. Naming the seeding command in the failure is
   * the difference between a Dockerfile that can be fixed and one that cannot.
   */
  notInCacheOffline: (name: string, range: string) =>
    `${name}@${range} is not in the cache and network access is disabled. Seed it with '${toolName()} install -g --cache-only ${name}@${range}', or run '${toolName()} pack ${name}@${range}' on a networked machine.`,

  /* §12.5 — project enforcement ------------------------------------------ */

  /**
   * §12.5, with §15.35k's suffix: set when the governing manifest sits at the
   * home directory or above, where a stray `packageManager` field governs
   * *every* directory on the machine (#424). Without the clause the user is
   * named a file they have no memory of creating and left to work out why.
   */
  projectConfigured: (
    name: string,
    manifestPath: string,
    outsideProject?: boolean,
    // §17.3 R4 row 2 — the field that actually carries the pin the invocation
    // was reconciled against. `packageManager` for the only role §02.5 has, so
    // §12.5's text is unchanged; a runtime mismatch names the runtime's field
    // rather than pointing the reader at one their manifest may not even have.
    field = "packageManager",
  ) =>
    `This project is configured to use ${name} because ${manifestPath} has a "${field}" field${
      outsideProject === true
        ? ` (this manifest is outside any project — a stray "packageManager" field there affects every directory)`
        : ""
    }`,

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
    `${ToolName()} cannot download the latest stable version of ${packageName}; you can disable signature verification by setting COREPACK_INTEGRITY_KEYS to 0 in your env, or instruct ${ToolName()} to use the latest stable release known by this version of ${ToolName()} by setting COREPACK_DEFAULT_TO_LATEST to 0`,

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
   * §15.4. `<source>` names what supplied the path — `JUP_CAFILE`, the legacy
   * `COREPACK_CAFILE` when that is the spelling the user set (§11.6), or
   * `cafile (/home/u/.npmrc)`. §12's table words this as `(set by COREPACK_CAFILE)`,
   * which was exactly right for the environment and a lie for an `.npmrc`, so the
   * name is a parameter rather than a constant.
   */
  cafileUnreadable: (path: string, source: string) =>
    `Unable to read the TLS certificate bundle at ${path} (set by ${source})`,

  cafileEmpty: (path: string) =>
    `The TLS certificate bundle at ${path} contains no PEM certificate`,

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
    `Invalid archive format; did it get generated by '${toolName()} ${command}'?`,

  unsupportedPackageManagerName: (name: string) => `Unsupported ${noun()} '${name}'`,

  /* §12.9 — commands ------------------------------------------------------ */

  couldntFindProject: () =>
    `Couldn't find a project in the local directory - please specify the ${noun()} to pack, or run this command from a valid project`,

  noSpecInProject: () =>
    `The local project doesn't feature ${pinFieldClause()} - please specify the ${noun()} to pack, or update the manifest to reference it`,

  /** The deprecated `prepare` command omits the devEngines mention. */
  noSpecInProjectLegacy: () =>
    `The local project doesn't feature a '${currentScope.pinFields[0]}' field - please specify the ${noun()} to pack, or update the manifest to reference it`,

  invalidPackageManagerName: (name: string) => `Invalid ${noun()} name '${name}'`,

  assertStubFolderMissing: () => `Assertion failed: The stub folder doesn't exist`,

  yarnSwitchSkip: (binName: string, file: string) =>
    `${binName} is already installed in ${file} and points to a Yarn Switch install - skipping`,

  /* §12.10 — informational output ----------------------------------------- */

  addingToCache: (name: string, reference: string) => `Adding ${name}@${reference} to the cache...`,

  installing: (name: string, reference: string) => `Installing ${name}@${reference}...`,

  installingInProject: (name: string, reference: string) =>
    `Installing ${name}@${reference} in the project...`,

  allDone: () => `All done!`,

  aboutToDownload: (url: string) => `! ${ToolName()} is about to download ${url_(url)}`,

  /** Trailing space, no newline. */
  downloadPrompt: () => `? Do you want to continue? [Y/n] `,

  autoPinNotice: (name: string, reference: string) =>
    `! The local project doesn't define a 'packageManager' field. ${ToolName()} will now add one referencing ${name}@${reference}.`,

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

  /**
   * §15.35c — a deprecated command names its replacement and still works.
   *
   * #624: corepack prints nothing, so `prepare` looks current in every CI log
   * still using it. Verbatim for `prepare`; `hydrate` is the same sentence with
   * its own replacement, since the rule is about deprecated commands at large.
   */
  deprecatedCommand: (command: string, replacement: string) =>
    `'${toolName()} ${command}' is deprecated; use '${toolName()} ${replacement}' instead.`,

  /**
   * §15.35d — `COREPACK_SPEC_FILE` names a file that is not there. Falling back
   * to the manifest is the worst outcome available: the variable exists for
   * trees whose manifest says the *wrong* thing, so ignoring a typo runs the
   * package manager the file was pointed at to override.
   */
  specFileMissing: (path: string) => `JUP_SPEC_FILE points at ${path}, which does not exist`,

  /* §12.12 — new in this spec --------------------------------------------- */

  expiredKey: (keyid: string, expires: string) =>
    `The package was signed with an expired key (${keyid}, expired ${expires})`,

  noNodeRuntime: (binName: string) =>
    `Unable to locate a Node.js runtime to execute ${binName}; set JUP_NODE_EXECPATH to point at one`,

  /**
   * §08.3.1 step 4 / §17.6 C7. Not run through `toolName()`: §12.12 freezes the
   * spelling, and a generated shim (§10.3) emits this long after any invocation.
   */
  everyInterpreterIsShim: () =>
    `Every 'node' on PATH is a jup shim; set JUP_NODE_EXECPATH to a real runtime`,

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
    `Refusing to install ${name}@${version}: ${source} provides no signature and no hash was pinned. Pin a hash in the packageManager field, or set JUP_ALLOW_UNVERIFIED=1.`,

  /**
   * The opt-out's warning half. §15.11 requires the escape hatch to be loud:
   * a per-run downgrade that printed nothing would be indistinguishable from
   * the verified path it replaces.
   */
  allowingUnverified: (name: string, version: string, source: string) =>
    `! Installing ${name}@${version} from ${source} with no signature and no pinned hash (JUP_ALLOW_UNVERIFIED=1)`,

  /* §15.12 — the sidecar integrity ---------------------------------------- */

  /**
   * `devEngines.packageManager.integrity` that is not an SRI string this
   * implementation can turn into a build-suffix hash. Routed through `onFail`
   * like every other `devEngines` complaint (§03.3): a pin nobody can check is
   * exactly the state §15.11 exists to refuse, so silence is the wrong default.
   */
  devEnginesBadIntegrity: (value: unknown, block = "packageManager") =>
    `Invalid "devEngines.${block}.integrity" field: ${JSON.stringify(value) ?? String(value)}`,

  /**
   * Both spellings of the pin are present and they disagree. §15.12 requires
   * both forms to be *accepted*; it does not make one silently outrank a
   * conflicting other, and two different digests for one artifact means at most
   * one of them describes what will run.
   */
  devEnginesIntegrityMismatch: (
    packageManager: string,
    integrity: string,
    field = "packageManager",
    block = "packageManager",
  ) =>
    `The "${field}" field (${packageManager}) and "devEngines.${block}.integrity" (${integrity}) pin different hashes`,

  /**
   * §17.5 R14 — a pin whose only field could not be written surgically.
   *
   * The package-manager role always has `packageManager` to fall back to, so
   * this is unreachable for it; a role whose pin lives only inside a
   * `devEngines` block has nowhere else, and R14 forbids inventing a top-level
   * field to make one. Reporting the manifest as unwritable beats reporting a
   * success that changed nothing.
   */
  pinFieldUnwritable: (field: string) =>
    `Couldn't write the "${field}" field into package.json; the file's shape is not one ${toolName()} can edit surgically`,

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
