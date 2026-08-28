/**
 * Every environment variable name this implementation reads or writes — §11.
 *
 * Reading the environment is the only configuration input the tool has (§03.2),
 * so the *set of names* is part of the observable contract: §11's table, §14.5's
 * env-file deny-list and §13's conformance rows all key off the exact spellings.
 * Holding them in one file means the inventory can be audited against §11 by
 * reading a single table, and that `env.ts`'s eligibility sets and `info.ts`'s
 * masking list are built from the same constants as the read sites they govern
 * — which is what stops a new variable being *readable* but not *classified*.
 *
 * A misspelt `process.env.COREPACK_STRICT_SSL` is `undefined`, which is also its
 * unset value, so nothing ever fails loudly; through these constants it is a
 * compile error instead.
 *
 * Names are written out in full rather than composed from {@link COREPACK_PREFIX},
 * so that grepping the contract spelling still finds its definition. The only
 * behaviour here is the handful of accessors at the bottom, which exist because
 * every variable has **two** spellings (see below) and a bare `process.env[name]`
 * would silently see only one of them. That keeps this module a leaf, so every
 * other file can import it without a cycle.
 *
 * Doc comments and `errors.ts`' user-facing messages keep their literal
 * `COREPACK_` spellings on purpose: §12's strings are matched byte-for-byte by
 * CI scripts, and reading one should not require resolving an identifier.
 */

/**
 * §03.2 — the prefix filter that is the entire sandbox against a hostile
 * repository: an env file's keys without it (`HTTP_PROXY`, `PATH`,
 * `NODE_OPTIONS`, …) are dropped before anything is merged.
 */
export const COREPACK_PREFIX = "COREPACK_";

/**
 * This tool's own prefix — the spelling every `COREPACK_` variable also answers to.
 *
 * The tool is `jup`; `corepack` is the name of the implementation it replaces, and
 * §11's table is written in its spelling because that is what existing projects,
 * CI configuration and the conformance suite already set. Rather than pick one, a
 * variable is read under **both**: `JUP_X` and `COREPACK_X` name the same setting,
 * with `JUP_X` winning when both are set, since it is the more specific statement
 * about *this* tool. Everything downstream — the env-file prefix filter (§03.2),
 * the eligibility deny-lists (§14.5), `info`'s environment snapshot — treats the
 * pair as one variable.
 */
export const JUP_PREFIX = "JUP_";

/** Both prefixes, highest precedence first. */
export const ENV_PREFIXES = [JUP_PREFIX, COREPACK_PREFIX] as const;

/** §15.2 — the per-package-manager registry override. */
export const REGISTRY_PREFIX = "COREPACK_REGISTRY_";

/** The tool's own variables, keyed by name minus {@link COREPACK_PREFIX}. */
export const ENV = {
  // §11.1 — behaviour.
  ENABLE_PROJECT_SPEC: "COREPACK_ENABLE_PROJECT_SPEC",
  ENABLE_STRICT: "COREPACK_ENABLE_STRICT",
  ENABLE_AUTO_PIN: "COREPACK_ENABLE_AUTO_PIN",
  DEFAULT_TO_LATEST: "COREPACK_DEFAULT_TO_LATEST",
  ENABLE_NETWORK: "COREPACK_ENABLE_NETWORK",
  ENABLE_UNSAFE_CUSTOM_URLS: "COREPACK_ENABLE_UNSAFE_CUSTOM_URLS",
  ENABLE_DOWNLOAD_PROMPT: "COREPACK_ENABLE_DOWNLOAD_PROMPT",
  ENV_FILE: "COREPACK_ENV_FILE",
  HOME: "COREPACK_HOME",

  // §11.2 — registry and auth.
  NPM_REGISTRY: "COREPACK_NPM_REGISTRY",
  NPM_TOKEN: "COREPACK_NPM_TOKEN",
  NPM_USERNAME: "COREPACK_NPM_USERNAME",
  NPM_PASSWORD: "COREPACK_NPM_PASSWORD",
  INTEGRITY_KEYS: "COREPACK_INTEGRITY_KEYS",

  // §11.3 — set by the tool, read by the package manager it runs.
  ROOT: "COREPACK_ROOT",
  MIGRATE_FROM: "COREPACK_MIGRATE_FROM",

  // §15.43 — set by the tool, read by *the tool*, one process further down: the
  // realpath of the runtime hosting a chain that has since entered the store.
  HOST_RUNTIME: "COREPACK_HOST_RUNTIME",

  // §11.5 / §15 — new in this spec.
  NODE_EXECPATH: "COREPACK_NODE_EXECPATH",
  CAFILE: "COREPACK_CAFILE",
  STRICT_SSL: "COREPACK_STRICT_SSL",
  NETWORK_TIMEOUT: "COREPACK_NETWORK_TIMEOUT",
  NETWORK_RETRIES: "COREPACK_NETWORK_RETRIES",
  MINIMUM_RELEASE_AGE: "COREPACK_MINIMUM_RELEASE_AGE",
  ALLOW_UNVERIFIED: "COREPACK_ALLOW_UNVERIFIED",
  REQUIRE_SIGNATURES: "COREPACK_REQUIRE_SIGNATURES",
  ENABLE_PRERELEASES: "COREPACK_ENABLE_PRERELEASES",
  FROZEN_LOCKFILE: "COREPACK_FROZEN_LOCKFILE",
  SPEC_FILE: "COREPACK_SPEC_FILE",
  SHIM_DIRECTORY: "COREPACK_SHIM_DIRECTORY",
  QUIET_ADVISORIES: "COREPACK_QUIET_ADVISORIES",
} as const;

/**
 * §11.4 — variables owned by the host environment: consumed, never set.
 *
 * The proxy family is deliberately not here. §05.1 looks each one up in *both*
 * cases and the scheme decides which one, so {@link PROXY_ENV} holds them.
 */
export const SYSTEM_ENV = {
  /** §08.6 — any non-empty value means an automated, non-interactive run. */
  CI: "CI",
  /** §16 — a value containing `jup` (or `corepack`) enables diagnostic logging. */
  DEBUG: "DEBUG",
  /** §07.1 / §10.4 — store and shim-directory fallback chains. */
  HOME: "HOME",
  USERPROFILE: "USERPROFILE",
  LOCALAPPDATA: "LOCALAPPDATA",
  XDG_CACHE_HOME: "XDG_CACHE_HOME",
  XDG_BIN_HOME: "XDG_BIN_HOME",
  /** §15.13 point 8 — `--system`'s directory on Windows, which has no `/usr/local`. */
  PROGRAMDATA: "ProgramData",
  /** §08.3 / §10.4 — executable lookup. */
  PATH: "PATH",
  PATHEXT: "PATHEXT",
  /** §15.1 — npm's own prefix, which locates the global `.npmrc`. */
  NPM_CONFIG_PREFIX: "npm_config_prefix",
  PREFIX: "PREFIX",
  /** §10 — shell detection for `enable`'s hints. */
  SHELL: "SHELL",
  PSMODULEPATH: "PSModulePath",
} as const;

/**
 * §11.4 / §14.8 — the proxy variables, lowercase-canonical.
 *
 * Each is looked up lowercase first, then uppercase — the CGI-safety rule, see
 * `net/proxy.ts`.
 */
export const PROXY_ENV = {
  HTTP: "http_proxy",
  HTTPS: "https_proxy",
  ALL: "all_proxy",
  NO: "no_proxy",
} as const;

/** A `COREPACK_*` variable name, as spelled in {@link ENV}. */
export type CorepackEnvVar = (typeof ENV)[keyof typeof ENV];

/** The `JUP_*` spelling of a `COREPACK_*` name, at the type level. */
export type JupSpelling<N extends string> = N extends `${typeof COREPACK_PREFIX}${infer Rest}`
  ? `${typeof JUP_PREFIX}${Rest}`
  : N;

/** Either spelling of one of this tool's variables. */
export type ToolEnvVar = CorepackEnvVar | JupSpelling<CorepackEnvVar>;

/**
 * §15.2's `COREPACK_REGISTRY_<NAME>`: the *upper-cased package manager name*.
 *
 * Non-alphanumerics are folded to `_` so an unknown, hyphenated package-manager
 * name still has a spellable variable rather than an unreachable one. Returns the
 * `COREPACK_` spelling; {@link jupSpelling} gives the other one, and every read
 * goes through {@link readEnv}, which accepts both.
 */
export function registryVariableFor(name: string): string {
  return `${REGISTRY_PREFIX}${name.toUpperCase().replace(/[^\dA-Z]/g, "_")}`;
}

/* -------------------------------------------------------------------------- */
/* Reading and writing a variable that has two spellings                       */
/* -------------------------------------------------------------------------- */

/** `COREPACK_HOME` -> `JUP_HOME`. Any other name is returned unchanged. */
export function jupSpelling<N extends string>(name: N): JupSpelling<N> {
  return (
    name.startsWith(COREPACK_PREFIX) ? JUP_PREFIX + name.slice(COREPACK_PREFIX.length) : name
  ) as JupSpelling<N>;
}

/**
 * `JUP_HOME` -> `COREPACK_HOME`: the spelling the deny-lists and §11 are keyed by.
 *
 * Names that are neither — an ambient `PATH`, an `.npmrc` origin string — are
 * returned unchanged, which is what lets callers canonicalise unconditionally.
 */
export function corepackSpelling(name: string): string {
  return name.startsWith(JUP_PREFIX) ? COREPACK_PREFIX + name.slice(JUP_PREFIX.length) : name;
}

/** Whether a name belongs to this tool under either spelling (§03.2's filter). */
export function isToolEnvName(name: string): boolean {
  return name.startsWith(JUP_PREFIX) || name.startsWith(COREPACK_PREFIX);
}

/**
 * The value of a variable under either spelling, `JUP_` first.
 *
 * Presence, not truthiness: an explicitly empty `JUP_NPM_TOKEN` shadows a
 * `COREPACK_NPM_TOKEN` that is set, because §11.2 makes the empty string a
 * meaningful value for several of these.
 */
export function readEnv(name: string): string | undefined {
  const preferred = process.env[jupSpelling(name)];
  return preferred === undefined ? process.env[name] : preferred;
}

/**
 * As {@link readEnv}, but reports *which* spelling supplied the value.
 *
 * Diagnostics name the variable the user actually set — §15.4's "set by
 * COREPACK_CAFILE" is a lie when `JUP_CAFILE` is what did it — so the sites that
 * print a source use this instead.
 */
export function envEntry<N extends string>(
  name: N,
): { name: N | JupSpelling<N>; value: string } | undefined {
  const jup = jupSpelling(name);
  const preferred = process.env[jup];
  if (preferred !== undefined) return { name: jup, value: preferred };

  const value = process.env[name];
  return value === undefined ? undefined : { name, value };
}

/**
 * Set a variable under **both** spellings, for the package manager we exec into.
 *
 * §11.3's two variables are the only ones written rather than read, and they are
 * read by something else entirely: a package manager that wants to know it is
 * running under a version manager looks for `COREPACK_ROOT`. It gets both, so a
 * tool that has learnt the new name finds it too.
 */
export function writeEnv(name: string, value: string): void {
  writeEnvInto(process.env, name, value);
}

/**
 * As {@link writeEnv}, but into a **child** environment block rather than our own:
 * §15.32's native handover builds one by hand so its edits cannot leak back into
 * this process, and §15.43's forwarded runtime travels the same way.
 */
export function writeEnvInto(env: NodeJS.ProcessEnv, name: string, value: string): void {
  env[name] = value;
  env[jupSpelling(name)] = value;
}

/**
 * A default that a real environment variable — under **either** spelling — beats.
 *
 * `??=` on one spelling is the bug this exists to prevent: it cannot see that the
 * user set the other one, so the default would win over an explicit setting.
 */
export function defaultEnv(name: string, value: string): void {
  if (readEnv(name) === undefined) process.env[name] = value;
}
