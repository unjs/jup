/**
 * Every environment variable name this implementation reads or writes — §11.
 *
 * Reading the environment is the only configuration input the tool has (§03.2),
 * so the *set of names* is part of the observable contract: §11's table, §03.2's
 * env-file deny-list and §13's conformance rows all key off the exact spellings.
 * Holding them in one file means the inventory can be audited against §11 by
 * reading a single table, and that `env.ts`'s eligibility sets and `info.ts`'s
 * masking list are built from the same constants as the read sites they govern
 * — which is what stops a new variable being *readable* but not *classified*.
 *
 * A misspelt `process.env.JUP_STRICT_SSL` is `undefined`, which is also its
 * unset value, so nothing ever fails loudly; through these constants it is a
 * compile error instead.
 *
 * Names are written out in full rather than composed from a prefix, so that
 * grepping the contract spelling still finds its definition. The only behaviour
 * here is the handful of accessors at the bottom, which exist because the
 * *compatibility* settings have **two** spellings (see
 * {@link COMPATIBILITY_ENV}) and a bare `process.env[name]` would silently see
 * only one of them. That keeps this module a leaf, so every other file can
 * import it without a cycle.
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
 * This tool's own prefix, and the canonical spelling of every setting.
 *
 * §11 — a setting corepack itself defined answers to `COREPACK_X` as well, and
 * the two are one variable with `JUP_X` winning when both are set, since it is
 * the more specific statement about *this* tool. {@link COMPATIBILITY_ENV} is
 * that set, and it is closed: everything jup invented is `JUP_`-only, because a
 * CI that predates jup cannot be setting a name corepack never had.
 */
export const JUP_PREFIX = "JUP_";

/** §05.2 / §11.2 — the per-package-manager registry override. */
export const REGISTRY_PREFIX = "JUP_REGISTRY_";

/**
 * The tool's own variables, keyed by name minus the prefix.
 *
 * The spelling here is the **canonical** one: `COREPACK_` for the compatibility
 * settings of {@link COMPATIBILITY_ENV}, `JUP_` for everything jup invented.
 */
export const ENV = {
  // §11.1 — behaviour.
  ENABLE_PROJECT_SPEC: "COREPACK_ENABLE_PROJECT_SPEC",
  ENABLE_STRICT: "COREPACK_ENABLE_STRICT",
  ENABLE_AUTO_PIN: "COREPACK_ENABLE_AUTO_PIN",
  DEFAULT_TO_LATEST: "COREPACK_DEFAULT_TO_LATEST",
  ENABLE_NETWORK: "COREPACK_ENABLE_NETWORK",
  ENABLE_UNSAFE_CUSTOM_URLS: "COREPACK_ENABLE_UNSAFE_CUSTOM_URLS",
  ENV_FILE: "COREPACK_ENV_FILE",
  HOME: "COREPACK_HOME",

  // §11.2 — registry and auth.
  NPM_REGISTRY: "COREPACK_NPM_REGISTRY",
  NPM_TOKEN: "COREPACK_NPM_TOKEN",
  NPM_USERNAME: "COREPACK_NPM_USERNAME",
  NPM_PASSWORD: "COREPACK_NPM_PASSWORD",
  INTEGRITY_KEYS: "COREPACK_INTEGRITY_KEYS",

  // §11.4 — set by the tool, read by the package manager it runs.
  ROOT: "COREPACK_ROOT",
  MIGRATE_FROM: "COREPACK_MIGRATE_FROM",

  // §08.3 — set by the tool, read by *the tool*, one process further down: the
  // realpath of the runtime hosting a chain that has since entered the store.
  HOST_RUNTIME: "JUP_HOST_RUNTIME",

  // Now split across §11.3 (execution and shims), §11.1 (behaviour) and §11.2
  // (registry, auth and trust) — interleaved below rather than regrouped, so
  // this table's key order stays untouched by the docs' reshuffle.
  NODE_EXECPATH: "JUP_NODE_EXECPATH", // §11.3
  CAFILE: "JUP_CAFILE", // §11.2
  STRICT_SSL: "JUP_STRICT_SSL", // §11.2
  NETWORK_TIMEOUT: "JUP_NETWORK_TIMEOUT", // §11.2
  NETWORK_RETRIES: "JUP_NETWORK_RETRIES", // §11.2
  MINIMUM_RELEASE_AGE: "JUP_MINIMUM_RELEASE_AGE", // §11.1
  DEFAULT_TTL: "JUP_DEFAULT_TTL", // §11.1
  ALLOW_UNVERIFIED: "JUP_ALLOW_UNVERIFIED", // §11.2
  REQUIRE_SIGNATURES: "JUP_REQUIRE_SIGNATURES", // §11.2
  ENABLE_PRERELEASES: "JUP_ENABLE_PRERELEASES", // §11.1
  FROZEN_LOCKFILE: "JUP_FROZEN_LOCKFILE", // §11.1
  SPEC_FILE: "JUP_SPEC_FILE", // §11.1
  SHIM_DIRECTORY: "JUP_SHIM_DIRECTORY", // §11.3
  QUIET_ADVISORIES: "JUP_QUIET_ADVISORIES", // §11.3
} as const;

/**
 * §11.5 — variables owned by the host environment: consumed, never set.
 *
 * The proxy family is deliberately not here. §05.1 looks each one up in *both*
 * cases and the scheme decides which one, so {@link PROXY_ENV} holds them.
 */
export const SYSTEM_ENV = {
  /** §11.5 — a value containing `jup` (or `corepack`) enables diagnostic logging. */
  DEBUG: "DEBUG",
  /** §07.1 / §10.5 — store and shim-directory fallback chains. */
  HOME: "HOME",
  USERPROFILE: "USERPROFILE",
  LOCALAPPDATA: "LOCALAPPDATA",
  XDG_CACHE_HOME: "XDG_CACHE_HOME",
  XDG_BIN_HOME: "XDG_BIN_HOME",
  /** §10.5 — `--system`'s directory on Windows, which has no `/usr/local`. */
  PROGRAMDATA: "ProgramData",
  /** §08.3 / §10.5 — executable lookup. */
  PATH: "PATH",
  PATHEXT: "PATHEXT",
  /** §05.3 — npm's own prefix, which locates the global `.npmrc`. */
  NPM_CONFIG_PREFIX: "npm_config_prefix",
  PREFIX: "PREFIX",
  /** §10 — shell detection for `enable`'s hints. */
  SHELL: "SHELL",
  PSMODULEPATH: "PSModulePath",
} as const;

/**
 * §11.5 / §05.1 — the proxy variables, lowercase-canonical.
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

/** The `JUP_*` spelling of a `COREPACK_*` name, at the type level. */
export type JupSpelling<N extends string> = N extends `${typeof COREPACK_PREFIX}${infer Rest}`
  ? `${typeof JUP_PREFIX}${Rest}`
  : N;

/**
 * §11 — the settings corepack itself defined, which therefore answer to a
 * `COREPACK_` spelling as well as jup's own. Held by the `JUP_` spelling, since
 * that is the one {@link envSpellings} canonicalises to before asking.
 *
 * This set is the whole of the compatibility surface, and it is closed. jup
 * accepting `COREPACK_NPM_REGISTRY` from a CI written against corepack *is* the
 * migration story (§01), which is why these stay; a name corepack never had has
 * no such CI to migrate, so it is `JUP_`-only and adding to this set would be
 * inventing a compatibility burden rather than honouring one.
 *
 * §11.4's two output variables are here too: they are written under both
 * spellings, and {@link writeEnvInto} reads this set to know it.
 */
export const COMPATIBILITY_ENV: ReadonlySet<string> = new Set(
  [
    ENV.ENABLE_PROJECT_SPEC,
    ENV.ENABLE_STRICT,
    ENV.ENABLE_AUTO_PIN,
    ENV.DEFAULT_TO_LATEST,
    ENV.ENABLE_NETWORK,
    ENV.ENABLE_UNSAFE_CUSTOM_URLS,
    ENV.ENV_FILE,
    ENV.HOME,
    ENV.NPM_REGISTRY,
    ENV.NPM_TOKEN,
    ENV.NPM_USERNAME,
    ENV.NPM_PASSWORD,
    ENV.INTEGRITY_KEYS,
    ENV.ROOT,
    ENV.MIGRATE_FROM,
  ].map(jupSpelling),
);

/**
 * §05.2's `JUP_REGISTRY_<NAME>`: the *upper-cased package manager name*.
 *
 * Non-alphanumerics are folded to `_` so an unknown, hyphenated package-manager
 * name still has a spellable variable rather than an unreachable one. jup
 * invented this one, so it has the single spelling {@link COMPATIBILITY_ENV}
 * explains.
 */
export function registryVariableFor(name: string): string {
  return `${REGISTRY_PREFIX}${name.toUpperCase().replace(/[^\dA-Z]/g, "_")}`;
}
/** `COREPACK_HOME` -> `JUP_HOME`. Any other name is returned unchanged. */
export function jupSpelling<N extends string>(name: N): JupSpelling<N> {
  return (
    name.startsWith(COREPACK_PREFIX) ? JUP_PREFIX + name.slice(COREPACK_PREFIX.length) : name
  ) as JupSpelling<N>;
}

/**
 * `JUP_HOME` -> `COREPACK_HOME`: the compatibility spelling, where there is one.
 *
 * Names that are already `COREPACK_`, and names that are neither — an ambient
 * `PATH`, an `.npmrc` origin string — are returned unchanged, which is what lets
 * callers translate unconditionally. It says nothing about whether the result is
 * a spelling this tool answers to: {@link COMPATIBILITY_ENV} decides that, and
 * {@link envSpellings} is the accessor that applies it.
 */
export function corepackSpelling(name: string): string {
  return name.startsWith(JUP_PREFIX) ? COREPACK_PREFIX + name.slice(JUP_PREFIX.length) : name;
}

/** Whether a name belongs to this tool under either spelling (§03.2's filter). */
export function isToolEnvName(name: string): boolean {
  return name.startsWith(JUP_PREFIX) || name.startsWith(COREPACK_PREFIX);
}

/**
 * Every spelling one setting answers to, **highest precedence first** — §11.6.
 *
 * This is the single definition of "how many names does this variable have", and
 * every reader in the tool iterates it rather than testing prefixes of its own:
 * a prefix test cannot tell `JUP_HOME`, whose `COREPACK_HOME` must still be
 * honoured, from `JUP_CAFILE`, whose `COREPACK_CAFILE` must not be — they are
 * the same shape and different settings.
 *
 * Accepts either spelling and answers the same way for both, so a name read out
 * of an env file needs no canonicalising at the call site.
 */
export function envSpellings(name: string): readonly string[] {
  const jup = jupSpelling(name);
  return COMPATIBILITY_ENV.has(jup) ? [jup, corepackSpelling(name)] : [jup];
}

/**
 * The value of a variable under any spelling it answers to, `JUP_` first.
 *
 * Presence, not truthiness: an explicitly empty `JUP_NPM_TOKEN` shadows a
 * `COREPACK_NPM_TOKEN` that is set, because §11.2 makes the empty string a
 * meaningful value for several of these.
 */
export function readEnv(name: string): string | undefined {
  return envEntry(name)?.value;
}

/**
 * As {@link readEnv}, but reports *which* spelling supplied the value.
 *
 * Diagnostics name the variable the user actually set — §11.6's "set by
 * COREPACK_HOME" is a lie when `JUP_HOME` is what did it — so the sites that
 * print a source use this instead.
 */
export function envEntry<N extends string>(
  name: N,
): { name: N | JupSpelling<N>; value: string } | undefined {
  for (const spelling of envSpellings(name)) {
    const value = process.env[spelling];
    if (value !== undefined) return { name: spelling as N | JupSpelling<N>, value };
  }
  return undefined;
}

/**
 * Set a variable under every spelling it answers to, for the package manager we
 * exec into.
 *
 * §11.4's two variables are the only ones written rather than read, and they are
 * read by something else entirely: a package manager that wants to know it is
 * running under a version manager looks for `COREPACK_ROOT`. Both are in
 * {@link COMPATIBILITY_ENV}, so both get both names, and a tool that has learnt
 * the new one finds it too. §08.3's forwarded `JUP_HOST_RUNTIME` is jup's own
 * invention and travels under its own name alone.
 */
export function writeEnv(name: string, value: string): void {
  writeEnvInto(process.env, name, value);
}

/**
 * As {@link writeEnv}, but into a **child** environment block rather than our own:
 * §08.3's native handover builds one by hand so its edits cannot leak back into
 * this process, and the forwarded runtime travels the same way.
 */
export function writeEnvInto(env: NodeJS.ProcessEnv, name: string, value: string): void {
  for (const spelling of envSpellings(name)) env[spelling] = value;
}
