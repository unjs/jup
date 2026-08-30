/**
 * `jup info` produces a versioned support report without network requests and tolerates malformed project specifications.
 */

const {
  accessSync,
  constants: fsConstants,
  readFileSync,
  realpathSync,
  statSync,
} = process.getBuiltinModule("node:fs");
const { delimiter, dirname, join, resolve: resolvePath } = process.getBuiltinModule("node:path");
import { ENV, envEntry, envSpellings, isToolEnvName, SYSTEM_ENV } from "../config/env-vars.ts";
import { DEFINITIONS, getBinariesFor, hostTarget, SUPPORTED_NAMES } from "../config/table.ts";
import { isEnvFileEligible, parseEnvFile } from "../project/env.ts";
import { redactUserinfo, UsageError } from "../errors-cold.ts";
import { parseManifest } from "../utils/json.ts";
import {
  CACHE_DIRECTORY,
  integrityForHost,
  LOCKFILE_NAME,
  readCachedEntry,
  readEntry,
  readLockfile,
  type Resolution,
  resolutionKey,
  usesLockfile,
} from "../project/lockfile.ts";
import { findProjectSpec, NODE_MODULES_RE, parseSpec, stopsWalk } from "../project/manifest.ts";
import {
  loadNpmrc,
  type NpmrcLevel,
  type RegistryDecision,
  resolveRegistry,
} from "../net/npmrc.ts";
import { getOwnRoot, getOwnVersion } from "../utils/self.ts";
import { out } from "../utils/log.ts";
import { isValidRange, isValidVersion, parse } from "../version/semver.ts";
import { resolveInstallDirectory } from "./shims.ts";
import { isOurShim } from "../run/exec.ts";
import { tlsSettings } from "../net/tls.ts";
import {
  findInstalledVersion,
  getHomeFolder,
  getInstallFolder,
  LAST_KNOWN_GOOD_NAME,
  listInstalled,
  readLastKnownGood,
} from "../cache/store.ts";
import type { Spec, Manifest } from "../types.ts";

/**
 * The `--json` schema version.
 *
 * Bumped only for a **breaking** change to the shape below; adding a field is
 * not one. Consumers should read this before anything else.
 */
export const INFO_REPORT_VERSION = 1;

/** Variables whose value is a credential: reported as present, never printed. */
const SECRET_VARIABLES = new Set<string>(
  [ENV.NPM_TOKEN, ENV.NPM_PASSWORD, ENV.NPM_USERNAME].flatMap(envSpellings),
);

/** Long values (a trust store, a proxy list) are elided rather than dumped. */
const MAX_VALUE_LENGTH = 120;
/** What kind of thing the version half of a spec is (§02.1, §04.1). */
export type SpecKind = "exact" | "range" | "tag" | "url";

export interface ProjectInfo {
  /**
   * `found` — a usable spec was read; `invalid` — one was declared but cannot be
   * used; `no-spec` — a project declaring none; `no-project` — no manifest.
   */
  status: "found" | "invalid" | "no-spec" | "no-project";
  /** Absolute path of the manifest §03.1's walk selected, or `null`. */
  manifest: string | null;
  /** `packageManager` or `devEngines.packageManager`. */
  field: string | null;
  /** The spec exactly as written. */
  spec: string | null;
  name: string | null;
  range: string | null;
  kind: SpecKind | null;
  /** Why the spec cannot be used — the sentence any other command would print. */
  problem: string | null;
  devEngines: { name: unknown; version: unknown; onFail: unknown } | null;
}

export interface ResolutionInfo {
  /**
   * `pinned` — the field names the version outright; `locked` — the recorded
   * `jup.lock` answers it; `cached` — the memo in `node_modules/.jup` answers it
   * and has not expired (§04.4); `cache` — nothing is recorded or memoed, but an
   * installed version satisfies the range; `network` — resolving needs a
   * request, which `info` does not make; `fallback` — no project spec, so the
   * global default decides; `unknown` — the spec is unusable.
   */
  status: "pinned" | "locked" | "cached" | "cache" | "network" | "fallback" | "unknown";
  name: string | null;
  version: string | null;
  /** `<algo>.<hex>`, the build-suffix spelling of §02.1. */
  hash: string | null;
  /** Where the answer came from, in prose. */
  source: string | null;
  /** Present when nothing could be decided without a network request. */
  reason: string | null;
  /** Whether that version is in the store right now. */
  installed: boolean | null;
}

export interface LockfileInfo {
  path: string;
  present: boolean;
  /** `<name>@<range as written>` — the key this project's spec would use. */
  key: string | null;
  resolution: Resolution | null;
  /** §04.4 — whether `use` and `up` may write the recorded file. */
  frozen: boolean;
  frozenSource: typeof ENV.FROZEN_LOCKFILE | "default";
  /** §04.4 — the resolution cache in `node_modules/.jup`, which ordinary runs write. */
  cache: {
    path: string;
    present: boolean;
    resolution: Resolution | null;
    /** Whether that entry has aged past its 24-hour window; `false` with none. */
    expired: boolean;
  };
}

export interface EnvFileInfo {
  path: string;
  /** Eligible, and not shadowed by the real environment: these took effect. */
  applied: string[];
  /** Eligible, but the real environment already set them (§11.6). */
  overridden: string[];
  /** `COREPACK_`-prefixed but refused from a file (§03.2). */
  refused: string[];
  /** Not `COREPACK_`-prefixed, so dropped before the merge. */
  ignored: string[];
}

export interface PackageManagerInfo {
  name: string;
  binaries: string[];
  /** The npm registry metadata and tarballs would come from. */
  registry: string;
  /**
   * The setting that decided it: `JUP_REGISTRY_<NAME>`,
   * `COREPACK_NPM_REGISTRY`, `.npmrc <key> (<path>)`, or `built-in` (§05.2,
   * §05.3). Naming the *actual* source is the whole point of the field — "a
   * mirror is not being honoured" is the report people run this command for.
   */
  registrySource: string;
  /** Anything about this package manager's fetch path worth saying out loud. */
  notes: string[];
  /** The compiled-in, hash-pinned fallback (§02.5). */
  builtinDefault: string;
  /** `lastKnownGood.json`'s entry, if any (§04.5). */
  recordedDefault: string | null;
  /** Versions present in the store. */
  cached: string[];
}

export interface ShimInfo {
  binary: string;
  packageManager: string;
  /** Absolute path of our shim, when one is installed in the shim directory. */
  shim: string | null;
  /** What this name resolves to on `PATH` right now, or `null`. */
  path: string | null;
  /** Whether that `PATH` entry is one of ours. */
  ours: boolean;
  /** A shim is installed, but something else on `PATH` wins (§10.5). */
  shadowed: boolean;
}

/** One `.npmrc`, and what §05.3 took from it. */
export interface NpmrcFileInfo {
  path: string;
  level: NpmrcLevel;
  /** Honoured keys, in file order. Values are never reported: some are secrets. */
  keys: string[];
  /**
   * Keys refused because a project-level `.npmrc` may only set `registry` and
   * `@scope:registry` (§05.3). This is the line that explains a token which
   * "should" have been picked up and was not.
   */
  refused: string[];
}

export interface NpmrcInfo {
  /** Files read, **lowest precedence first**: global, user, then project. */
  files: NpmrcFileInfo[];
  /** The effective `registry`, and the file that set it. */
  registry: { value: string; source: string } | null;
  /** `@scope` -> registry, with the file that set each. */
  scopes: Array<{ scope: string; value: string; source: string }>;
  /**
   * Credential *scopes* only. The prefix and its kind say whether a request
   * would be authenticated; the credential itself is never reported, and this
   * report is pasted into issues.
   */
  auth: Array<{ prefix: string; type: "token" | "basic"; source: string }>;
}

/** §05.1 — what verification the next request would do, and who decided. */
export interface TlsInfo {
  /** A PEM bundle replacing the platform trust store, if one is configured. */
  cafile: string | null;
  /** `JUP_CAFILE`, or `.npmrc`'s `cafile`/`ca` with its path. */
  cafileSource: string | null;
  /** `false` only when verification has been switched off. */
  verify: boolean;
  /** What switched it off. */
  verifySource: string | null;
}

export interface InfoReport {
  version: number;
  tool: { name: string; version: string; root: string };
  project: ProjectInfo;
  resolution: ResolutionInfo;
  lockfile: LockfileInfo;
  envFile: EnvFileInfo | null;
  /** `COREPACK_*` as it stood in the *real* environment, credentials masked. */
  environment: Record<string, string>;
  packageManagers: PackageManagerInfo[];
  /** §05.3 — which files were read, what each contributed, what was refused. */
  npmrc: NpmrcInfo;
  /** §05.1 — the trust store in force, and where it was configured. */
  tls: TlsInfo;
  store: {
    home: string;
    path: string;
    writable: boolean;
    versions: Array<{ name: string; version: string }>;
  };
  defaults: { path: string; entries: Record<string, string> };
  shims: { directory: string | null; problem: string | null; entries: ShimInfo[] };
}
/**
 * Collect everything, touching only the filesystem.
 *
 * Order matters once: the `COREPACK_*` snapshot is taken **before** the env file
 * is discovered, because `applyEnvFile` merges the file into `process.env` and
 * afterwards there is no way to tell a variable the user exported from one the
 * project supplied — which is exactly the distinction §09.9 asks for.
 */
export function buildReport(cwd: string = process.cwd()): InfoReport {
  const realEnvironment = snapshotEnvironment();

  // The env-file walk (§03.2), which also *applies* the file — the same thing
  // every other command does, so what is reported below is what a run sees.
  const envLookup = findProjectSpec(cwd, { envOnly: true });
  const envFile =
    envLookup.envFilePath === undefined
      ? null
      : describeEnvFile(envLookup.envFilePath, realEnvironment);

  const project = describeProject(cwd);
  const lockfileDir = project.manifest === null ? resolvePath(cwd) : dirname(project.manifest);
  const lockfile = describeLockfile(lockfileDir, project);
  const resolution = describeResolution(project, lockfile);

  const installFolder = getInstallFolder();
  const versions = listInstalled();
  const defaults = readLastKnownGood();

  return {
    version: INFO_REPORT_VERSION,
    tool: { name: "jup", version: getOwnVersion(), root: getOwnRoot(import.meta.url) },
    project,
    resolution,
    lockfile,
    envFile,
    environment: realEnvironment,
    packageManagers: describePackageManagers(versions, defaults),
    npmrc: describeNpmrc(cwd),
    tls: describeTls(),
    store: {
      home: getHomeFolder(),
      path: installFolder,
      writable: isWritable(installFolder),
      versions,
    },
    defaults: { path: join(getHomeFolder(), LAST_KNOWN_GOOD_NAME), entries: defaults },
    shims: describeShims(),
  };
}
/**
 * §03 — what the project declares, and why it cannot be used when it cannot.
 *
 * `findProjectSpec` is authoritative and is asked first, so the manifest
 * `info` names is the very file every other command reads. It *throws* for an
 * unparseable manifest and for a `devEngines` failure whose `onFail` is `error`
 * (the default), and those are among the cases most worth reporting — so the
 * throw is caught and {@link locateManifest} recovers the path §03.1's walk
 * would have selected.
 */
function describeProject(cwd: string): ProjectInfo {
  const empty: ProjectInfo = {
    status: "no-project",
    manifest: null,
    field: null,
    spec: null,
    name: null,
    range: null,
    kind: null,
    problem: null,
    devEngines: null,
  };

  let target: string | undefined;
  let status: ProjectInfo["status"] = "no-project";
  let problem: string | null = null;

  try {
    const lookup = findProjectSpec(cwd);
    target = lookup.type === "NoProject" ? undefined : lookup.target;
    status =
      lookup.type === "Found" ? "found" : lookup.type === "NoSpec" ? "no-spec" : "no-project";
  } catch (error) {
    // An unparseable manifest, or a `devEngines` block whose own `onFail` says
    // to fail. Both are the diagnosis, not a reason to stop diagnosing.
    status = "invalid";
    problem = messageOf(error);
    target = locateManifest(cwd);
  }

  if (target === undefined) return { ...empty, status, problem };

  const declared = describeDeclaration(readManifest(target));

  const info: ProjectInfo = {
    ...empty,
    status,
    manifest: target,
    field: declared.field,
    spec: declared.spec,
    devEngines: declared.devEngines,
    problem,
  };

  if (declared.raw === undefined) return info;

  // `requireVersion: true` is what the proxy path passes for a manifest read
  // with no CLI override (§03.5), so a bare `packageManager: "yarn"` is reported
  // as the error a `yarn` invocation would actually hit. §04.4 widened what the
  // version may *be* — a range, a dist-tag — not whether a pin has to carry one.
  try {
    const descriptor = parseSpec(declared.raw, {
      source: "package.json",
      requireVersion: true,
      packageManagerField: declared.packageManagerField,
    });
    return {
      ...info,
      status: status === "invalid" ? "invalid" : "found",
      name: descriptor.name,
      range: descriptor.range,
      kind: classifySpec(descriptor),
    };
  } catch (error) {
    return { ...info, status: "invalid", problem: problem ?? messageOf(error) };
  }
}

/** §02.1 / §04.1 — an exact version, a range, a dist-tag, or a URL. */
export function classifySpec(descriptor: Spec): SpecKind {
  const { range } = descriptor;
  if (URL.canParse(range)) return "url";
  if (isValidVersion(range)) return "exact";
  if (isValidRange(range)) return "range";
  return "tag";
}

/**
 * Which field carries the pin, read from the manifest itself.
 *
 * The order is §03.3's: a `devEngines.packageManager` naming a version outranks
 * the top-level field, and one naming no version does not, because it has not
 * said which release the project wants. `packageManager` answers for everything
 * else it is present for — including the shapes it is present for *badly*, like
 * the `packageManager: 42` of §12.2, which this report has to show rather than
 * skip past on its way to a `devEngines` block that is not the field at fault.
 *
 * `ProjectSpec.hasPin` cannot answer this. It is `typeof pm === "string"`, which
 * neither notices the non-string shapes nor knows about the precedence above.
 */
function describeDeclaration(manifest: Manifest | undefined): {
  field: string | null;
  spec: string | null;
  raw: unknown;
  /** §02.3's refusal is about the *field*, so it travels with the declaration. */
  packageManagerField: boolean;
  devEngines: ProjectInfo["devEngines"];
} {
  const de = manifest?.devEngines?.packageManager;
  const devEngines =
    typeof de === "object" && de !== null && !Array.isArray(de)
      ? {
          name: (de as Record<string, unknown>).name,
          version: (de as Record<string, unknown>).version,
          onFail: (de as Record<string, unknown>).onFail,
        }
      : null;

  // §03.3 — the versioned member wins, so it is named first.
  if (
    devEngines !== null &&
    typeof devEngines.name === "string" &&
    typeof devEngines.version === "string"
  ) {
    return {
      field: "devEngines.packageManager",
      spec: `${devEngines.name}@${devEngines.version}`,
      raw: `${devEngines.name}@${devEngines.version}`,
      // Read out of `devEngines`, so §02.3 does not apply: a runtime named
      // there is exactly where a runtime belongs.
      packageManagerField: false,
      devEngines,
    };
  }

  if (manifest !== undefined && Object.hasOwn(manifest, "packageManager")) {
    const pm = manifest.packageManager;
    return {
      field: "packageManager",
      // A non-string field still has to be *shown*: `packageManager: 42` is
      // reported as `42`, next to the sentence explaining why it is not a spec.
      spec: typeof pm === "string" ? pm : (JSON.stringify(pm) ?? String(pm)),
      raw: pm,
      // The same condition `manifest.ts`'s own `describe` uses: the field is
      // only speaking for itself when it actually carries a string pin.
      packageManagerField: typeof pm === "string",
      devEngines,
    };
  }

  if (devEngines !== null) {
    // §03.3 — with no `packageManager` the spec is synthesised from the two
    // devEngines fields, and `*` stands in for an absent version.
    const name = typeof devEngines.name === "string" ? devEngines.name : undefined;
    const version = typeof devEngines.version === "string" ? devEngines.version : undefined;
    const spec = name === undefined ? null : `${name}@${version ?? "*"}`;
    return {
      field: "devEngines.packageManager",
      spec,
      raw: spec ?? undefined,
      // Synthesised out of `devEngines`, so §02.3 does not apply: a runtime
      // named there is exactly where a runtime belongs.
      packageManagerField: false,
      devEngines,
    };
  }

  return { field: null, spec: null, raw: undefined, packageManagerField: false, devEngines };
}

/** A tolerant manifest read: anything unreadable is simply "no fields". */
function readManifest(target: string): Manifest | undefined {
  let content: string;
  try {
    content = readFileSync(target, "utf8");
  } catch {
    return undefined;
  }
  try {
    const data = parseManifest(content);
    return typeof data === "object" && data !== null ? (data as Manifest) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * §03.1's selection, recomputed for the case where the real walk threw before it
 * could report one.
 *
 * It mirrors the loop in `manifest.ts`: skip package directories inside
 * `node_modules`, stop at the first manifest with a truthy `packageManager`,
 * and otherwise keep the **outermost** manifest seen — which is why a monorepo
 * with no pin anywhere reports the root rather than the leaf. Reachable only
 * from the error path; the success path uses the walk's own answer, and a unit
 * test pins the two together.
 */
function locateManifest(cwd: string): string | undefined {
  let currentDir = "";
  let nextDir = resolvePath(cwd);
  let selected: string | undefined;

  while (nextDir !== currentDir) {
    currentDir = nextDir;
    nextDir = dirname(currentDir);

    if (NODE_MODULES_RE.test(currentDir)) continue;

    const target = join(currentDir, "package.json");
    let content: string;
    try {
      content = readFileSync(target, "utf8");
    } catch {
      continue;
    }

    selected = target;

    // An unparseable manifest is where the real walk stopped, so it is the file
    // to name.
    let data: unknown;
    try {
      data = parseManifest(content);
    } catch {
      return target;
    }
    if (typeof data !== "object" || data === null) return target;
    // Otherwise stop exactly where §03.1's walk stops. Sharing `stopsWalk` is
    // the point: a local re-statement of it drifted, testing `packageManager`
    // for truthiness and ignoring `devEngines` entirely — and since this runs
    // only after discovery *threw*, the commonest reason to be here is an
    // invalid `devEngines` block, the one case the copy sailed straight past to
    // name an ancestor manifest that had nothing to do with the failure.
    if (stopsWalk(data as Manifest, "packageManager")) return target;
  }

  return selected;
}
/** §04.4 — the recorded resolution for this project's spec, and whether it may move. */
function describeLockfile(dir: string, project: ProjectInfo): LockfileInfo {
  const frozen = envEntry(ENV.FROZEN_LOCKFILE);

  const descriptor = descriptorOf(project);
  const usable = project.name !== null && project.range !== null && usesLockfile(descriptor);
  const key = usable ? resolutionKey(descriptor) : null;

  const data = readLockfile(dir);
  const cacheDir = join(dir, CACHE_DIRECTORY);
  const cache = readLockfile(cacheDir);

  // Both entries come back through the lockfile readers rather than out of the
  // parsed file by key, because `info`'s whole contract is to report what the
  // next run would use. Indexing directly skipped §04.4's satisfaction gate, so
  // a `10.0.0` recorded under `^11.0.0` — a hand edit, a bad merge, a restored
  // `node_modules` — was reported as the locked version while the run resolved
  // straight past it. `readEntry` and `readCachedEntry` apply that gate, and the
  // expiry rule, in the one place they are written.
  const recorded = key === null ? null : readEntry(dir, descriptor);
  const memo = key === null ? null : readCachedEntry(dir, descriptor);

  return {
    path: join(dir, LOCKFILE_NAME),
    present: data !== null,
    key,
    resolution: recorded,
    // Mirrors `env.isFrozenLockfile()`: `info` itself never writes either file.
    frozen: frozen?.value === "1",
    frozenSource: frozen !== undefined && frozen.value !== "" ? frozen.name : "default",
    cache: {
      path: join(cacheDir, LOCKFILE_NAME),
      present: cache !== null,
      resolution: memo?.entry ?? null,
      expired: memo?.expired ?? false,
    },
  };
}

function descriptorOf(project: ProjectInfo): Spec {
  return { name: project.name ?? "", range: project.range ?? "" };
}

/**
 * What the *next* run would use, decided with no request of any kind.
 *
 * The branches follow §01.3's own order — lockfile, then the cache probe, then
 * the registry — so the answer is the one the proxy path would reach, and the
 * `network` status is the honest report of the one branch `info` refuses to
 * take.
 */
function describeResolution(project: ProjectInfo, lockfile: LockfileInfo): ResolutionInfo {
  const base: ResolutionInfo = {
    status: "unknown",
    name: project.name,
    version: null,
    hash: null,
    source: null,
    reason: null,
    installed: null,
  };

  if (project.status === "invalid") {
    return { ...base, reason: project.problem ?? `the project spec cannot be parsed` };
  }

  if (project.status !== "found" || project.name === null || project.range === null) {
    return {
      ...base,
      status: "fallback",
      reason:
        project.status === "no-project"
          ? `no package.json was found; each package manager falls back to its recorded or built-in default`
          : `the project declares no packageManager or devEngines.packageManager; each package manager falls back to its recorded or built-in default`,
    };
  }

  const descriptor = descriptorOf(project);
  const from = `${project.field} in ${project.manifest}`;

  // An exact version (or a URL) is its own record: §04.4 keeps the lockfile out
  // of that path entirely.
  if (!usesLockfile(descriptor)) {
    const parsed = parse(project.range);
    if (parsed === null) {
      // A URL reference (§02.1): its digest, if any, lives in the fragment.
      return { ...base, status: "pinned", version: project.range, source: from };
    }
    return {
      ...base,
      status: "pinned",
      version: parsed.version,
      hash: parsed.build.length > 0 ? parsed.build.join(".") : null,
      source: from,
      installed: findInstalledVersion(project.name, parsed.version) !== null,
    };
  }

  if (lockfile.resolution !== null) {
    const { resolved } = lockfile.resolution;
    // §04.4 — this host's key out of the recorded map, when the entry holds
    // one. A map with nothing for this host is still a *locked* version; it just
    // has no digest here yet, which `hash: null` says correctly.
    const integrity = integrityForHost(lockfile.resolution);
    return {
      ...base,
      status: "locked",
      version: resolved,
      hash: integrity === undefined ? null : hashOfIntegrity(integrity),
      source: lockfile.path,
      installed: findInstalledVersion(project.name, resolved) !== null,
    };
  }

  // §04.4 — nothing is recorded, so the memo in `node_modules/.jup` answers, while
  // it is still inside its window. An expired one is not reported here: the next
  // run would go and ask, and this command reports what that run would do, not
  // what it would fall back to if the registry were unreachable.
  const memo = lockfile.cache.resolution;
  if (memo !== null && !lockfile.cache.expired) {
    const integrity = integrityForHost(memo);
    return {
      ...base,
      status: "cached",
      version: memo.resolved,
      hash: integrity === undefined ? null : hashOfIntegrity(integrity),
      source: lockfile.cache.path,
      installed: findInstalledVersion(project.name, memo.resolved) !== null,
    };
  }

  // §04.1 step 4 — the cache probe runs before the registry, so an installed
  // version satisfying the range still answers offline.
  const cached = isValidRange(project.range)
    ? findInstalledVersion(project.name, project.range)
    : null;
  if (cached !== null) {
    return {
      ...base,
      status: "cache",
      version: cached,
      source: `the store (nothing recorded in ${LOCKFILE_NAME})`,
      installed: true,
    };
  }

  return {
    ...base,
    status: "network",
    reason: `${project.name}@${project.range} has no recorded resolution and nothing in the store satisfies it; resolving it needs a registry request, which 'info' does not make`,
  };
}

/** `sha512-<base64>` -> `sha512.<hex>`, for display beside a pinned hash. */
function hashOfIntegrity(integrity: string): string | null {
  const dash = integrity.indexOf("-");
  if (dash <= 0) return null;
  const hex = Buffer.from(integrity.slice(dash + 1), "base64").toString("hex");
  return hex === "" ? null : `${integrity.slice(0, dash).toLowerCase()}.${hex}`;
}
/** Every `COREPACK_*` variable in the real environment, credentials masked. */
function snapshotEnvironment(): Record<string, string> {
  const snapshot: Record<string, string> = {};
  for (const name of Object.keys(process.env).sort()) {
    if (!isToolEnvName(name)) continue;
    const value = process.env[name];
    if (value === undefined) continue;
    snapshot[name] = displayValue(name, value);
  }
  return snapshot;
}

/**
 * A value safe to print.
 *
 * Credentials are reported as present and never echoed; a registry URL may embed
 * `user:pass@` (§11.2) and goes through the same redaction every message uses;
 * anything long — a trust store, a proxy list — is elided rather than dumped
 * across the terminal.
 */
function displayValue(name: string, value: string): string {
  if (SECRET_VARIABLES.has(name)) return value === "" ? `<set, empty>` : `<set>`;
  const redacted = redactUserinfo(value);
  return redacted.length > MAX_VALUE_LENGTH
    ? `${redacted.slice(0, MAX_VALUE_LENGTH)}… (${redacted.length} chars)`
    : redacted;
}

/**
 * §03.2 — which of the env file's variables actually reached the run.
 *
 * The four buckets are the four things that can happen to a line in that file,
 * and the difference between them is the whole answer to "why is my
 * `.jup.env` not doing anything": it was refused for security (§03.2), it
 * was shadowed by a real environment variable (§11.6), or it was never
 * `COREPACK_`-prefixed in the first place.
 */
/**
 * §11.6 — whether the real environment already sets this variable, under any
 * spelling it answers to. `JUP_HOME` in the file is shadowed by a real
 * `COREPACK_HOME` just as surely as by a real `JUP_HOME`; `applyEnvFile` refuses
 * both, so `info` has to report both, or the two would disagree about why a line
 * did nothing. Both ask {@link envSpellings}, which is what keeps them agreeing.
 */
function isShadowed(realEnvironment: Record<string, string>, name: string): boolean {
  return envSpellings(name).some((spelling) => Object.hasOwn(realEnvironment, spelling));
}

function describeEnvFile(path: string, realEnvironment: Record<string, string>): EnvFileInfo {
  const info: EnvFileInfo = { path, applied: [], overridden: [], refused: [], ignored: [] };

  let vars: Record<string, string>;
  try {
    vars = parseEnvFile(readFileSync(path, "utf8"));
  } catch {
    return info;
  }

  for (const name of Object.keys(vars).sort()) {
    if (!isToolEnvName(name)) info.ignored.push(name);
    else if (!isEnvFileEligible(name)) info.refused.push(name);
    else if (isShadowed(realEnvironment, name)) info.overridden.push(name);
    else info.applied.push(name);
  }

  return info;
}
/**
 * The effective npm registry for one package manager, and the setting that
 * decided it.
 *
 * `npmrc.resolveRegistry` is the single implementation of §05.2's and §05.3's
 * precedence. `npmrc.ts` reaches for nothing heavier than `node:fs`, so `info`
 * loads no HTTP or signature stack when diagnosing download failures.
 *
 * @param name Omitted, the answer ignores §05.2's per-package-manager tier.
 * @param packageName The npm package, when §05.3's `@scope:registry` applies.
 */
export function effectiveRegistry(
  name?: string,
  packageName?: string,
): { registry: string; source: string; kind: RegistryDecision["kind"] } {
  const decision = resolveRegistry({ name, packageName });
  return { registry: decision.registry, source: decision.source, kind: decision.kind };
}

function describePackageManagers(
  versions: Array<{ name: string; version: string }>,
  defaults: Record<string, string>,
): PackageManagerInfo[] {
  return SUPPORTED_NAMES.map((name) => {
    const definition = DEFINITIONS[name]!;
    const { registry: configured, source } = effectiveRegistry(name);
    // §11.2 lets the registry embed `user:pass@`, and a report is pasted into
    // issues and CI logs far more often than an error message is.
    const registry = redactUserinfo(configured);
    // §02.2 — every band is on the npm registry, so `registry` above already
    // describes every one of them and there is no per-band exception to report.
    const notes: string[] = [];

    return {
      name,
      binaries: getBinariesFor(name),
      registry,
      registrySource: source,
      notes,
      builtinDefault: definition.default,
      recordedDefault: defaults[name] ?? null,
      cached: versions.filter((entry) => entry.name === name).map((entry) => entry.version),
    };
  });
}
/**
 * List every `.npmrc` read in precedence order, including supplied and refused
 * keys. Never print authentication values because support reports are routinely
 * shared.
 */
function describeNpmrc(cwd: string): NpmrcInfo {
  const config = loadNpmrc(cwd);

  return {
    files: config.files.map((file) => ({
      path: file.path,
      level: file.level,
      keys: file.keys,
      refused: file.refused,
    })),
    registry:
      config.registry === undefined
        ? null
        : {
            value: redactUserinfo(config.registry.value),
            source: config.registry.origin.path,
          },
    scopes: [...config.scoped.entries()].map(([scope, entry]) => ({
      scope,
      value: redactUserinfo(entry.value),
      source: entry.origin.path,
    })),
    auth: config.auth.map((entry) => ({
      prefix: entry.prefix,
      type: entry.type,
      source: entry.origin.path,
    })),
  };
}

/** §05.1 — the trust store in force, and who configured it. */
function describeTls(): TlsInfo {
  const settings = tlsSettings();
  return {
    cafile: settings.cafile ?? null,
    cafileSource: settings.cafileSource ?? settings.caSource ?? null,
    verify: settings.verify,
    verifySource: settings.verifySource ?? null,
  };
}

/**
 * §07.8 — can the store be written to?
 *
 * A store that does not exist yet is writable if the closest existing ancestor
 * is, which is the case that matters: a fresh machine, or a `COREPACK_HOME`
 * pointing somewhere the user cannot create.
 */
function isWritable(path: string): boolean {
  let dir = path;
  for (;;) {
    try {
      accessSync(dir, fsConstants.W_OK);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
      const parent = dirname(dir);
      if (parent === dir) return false;
      dir = parent;
    }
  }
}
/**
 * §10.5 — for every binary name: is a shim installed, and what does that
 * name resolve to on `PATH` right now?
 *
 * Report both the installed shim and the executable selected by `PATH`; another
 * version manager may shadow a valid shim.
 */
function describeShims(): InfoReport["shims"] {
  let directory: string | null = null;
  let problem: string | null = null;

  try {
    // The resolver `disable` uses, so a report and a removal never disagree
    // about where the shims are — and, per §10.5, one that reads no
    // `PATH`, so the answer does not depend on the shell this ran from.
    // `forEnable: false` — no realpath.
    directory = resolveInstallDirectory({}, false);
  } catch (error) {
    // §12.10's "unable to determine where to install the shims" is a fine answer
    // to a *question*; it must not be the end of the whole report.
    problem = messageOf(error);
  }

  const entries: ShimInfo[] = [];
  for (const name of SUPPORTED_NAMES) {
    for (const binary of getBinariesFor(name)) {
      const onPath = lookupOnPath(binary);
      const ours = onPath !== null && isOurShim(onPath, binary);

      // `PATH` first, because `enable --install-directory` puts shims somewhere
      // `resolveInstallDirectory` will never guess — and a shim that is on
      // `PATH` and winning is installed by any definition worth reporting. The
      // default directory is the fallback, and it is what turns up the case
      // that matters: a shim that exists and is being shadowed.
      const candidate = directory === null ? null : join(directory, binary);
      const shim = ours
        ? onPath
        : candidate !== null && isOurShim(candidate, binary)
          ? candidate
          : null;

      entries.push({
        binary,
        packageManager: name,
        shim,
        path: onPath,
        ours,
        shadowed: shim !== null && onPath !== null && !samePath(onPath, shim),
      });
    }
  }

  return { directory, problem, entries };
}

/** Two paths naming the same file, symlinks resolved. */
function samePath(left: string, right: string): boolean {
  if (left === right) return true;
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
}

/*
 * Use the shared ownership test, including dangling symlinks that still name a
 * generated stub. Such a shim is missing its target, not foreign.
 */

/** §10.5 — `which(name)`, returning the file rather than its directory. */
function lookupOnPath(name: string): string | null {
  const extensions =
    process.platform === "win32"
      ? (process.env[SYSTEM_ENV.PATHEXT] ?? ".COM;.EXE;.BAT;.CMD").split(";")
      : [""];

  for (const entry of (process.env[SYSTEM_ENV.PATH] ?? "").split(delimiter)) {
    if (entry === "") continue;
    for (const extension of extensions) {
      const candidate = join(entry, `${name}${extension}`);
      const stats = statSync(candidate, { throwIfNoEntry: false });
      if (stats === undefined || !stats.isFile()) continue;
      if (process.platform === "win32") return candidate;
      try {
        accessSync(candidate, fsConstants.X_OK);
        return candidate;
      } catch {
        continue;
      }
    }
  }

  return null;
}
const LABEL_WIDTH = 16;

function line(label: string, value: string): string {
  // A label wider than the column still gets a separating space; without the
  // guard, `COREPACK_ENABLE_UNSAFE_CUSTOM_URLS1` is what a long variable renders as.
  const padded = label.length < LABEL_WIDTH ? label.padEnd(LABEL_WIDTH) : `${label} `;
  return `  ${padded}${value}\n`;
}

function section(title: string): string {
  return `\n${title}\n`;
}

/** The human rendering. Sections mirror the JSON one for one. */
export function formatReport(report: InfoReport): string {
  const out: string[] = [];

  out.push(`${report.tool.name} ${report.tool.version}\n`);
  out.push(line(`root`, report.tool.root));

  out.push(section(`Project`));
  out.push(line(`status`, report.project.status));
  out.push(line(`manifest`, report.project.manifest ?? `(none found)`));
  if (report.project.field !== null) out.push(line(`field`, report.project.field));
  if (report.project.spec !== null) {
    out.push(
      line(
        `spec`,
        `${report.project.spec}${report.project.kind === null ? `` : `  (${report.project.kind})`}`,
      ),
    );
  }
  if (report.project.devEngines !== null) {
    const { name, version, onFail } = report.project.devEngines;
    out.push(
      line(
        `devEngines`,
        `${String(name)}@${version === undefined ? `*` : String(version)}${
          onFail === undefined ? `` : `  (onFail: ${String(onFail)})`
        }`,
      ),
    );
  }
  if (report.project.problem !== null) out.push(line(`problem`, report.project.problem));

  out.push(section(`Resolution`));
  out.push(line(`status`, report.resolution.status));
  out.push(line(`package manager`, report.resolution.name ?? `(undecided)`));
  out.push(line(`version`, report.resolution.version ?? `(unresolved)`));
  out.push(line(`hash`, report.resolution.hash ?? `(none)`));
  if (report.resolution.source !== null) out.push(line(`source`, report.resolution.source));
  if (report.resolution.installed !== null) {
    out.push(line(`in the store`, report.resolution.installed ? `yes` : `no`));
  }
  if (report.resolution.reason !== null) out.push(line(`reason`, report.resolution.reason));

  out.push(section(`Lockfile`));
  out.push(line(`path`, report.lockfile.path));
  out.push(line(`present`, report.lockfile.present ? `yes` : `no`));
  if (report.lockfile.key !== null) out.push(line(`key`, report.lockfile.key));
  if (report.lockfile.resolution !== null) {
    out.push(line(`resolved`, report.lockfile.resolution.resolved));
    // §04.4 — a per-host entry prints this host's digest and says how many
    // other hosts the file records, which is the fact a reader wants: whether
    // the colleague whose machine is failing has ever been recorded at all.
    const recorded = report.lockfile.resolution.integrity;
    if (typeof recorded === "object") {
      const others = Object.keys(recorded).filter((host) => host !== hostTarget()).length;
      const mine = integrityForHost(report.lockfile.resolution) ?? `(none for ${hostTarget()})`;
      out.push(line(`integrity`, others === 0 ? mine : `${mine} (+${others} other hosts)`));
    } else {
      out.push(line(`integrity`, recorded ?? `(none recorded)`));
    }
  }
  out.push(
    line(`frozen`, `${report.lockfile.frozen ? `yes` : `no`} (${report.lockfile.frozenSource})`),
  );
  out.push(line(`cache`, report.lockfile.cache.path));
  if (report.lockfile.cache.resolution !== null) {
    const memo = report.lockfile.cache.resolution;
    const age = report.lockfile.cache.expired ? ` (expired)` : ``;
    out.push(line(`cached`, `${memo.resolved}${age}`));
  }

  out.push(section(`Environment`));
  if (report.envFile === null) {
    out.push(line(`env file`, `(none)`));
  } else {
    out.push(line(`env file`, report.envFile.path));
    for (const [label, names] of [
      [`applied`, report.envFile.applied],
      [`overridden`, report.envFile.overridden],
      [`refused`, report.envFile.refused],
      [`ignored`, report.envFile.ignored],
    ] as const) {
      if (names.length > 0) out.push(line(label, names.join(`, `)));
    }
  }
  const variables = Object.keys(report.environment);
  if (variables.length === 0) {
    out.push(line(`variables`, `(no JUP_* or COREPACK_* variables set)`));
  } else {
    variables.forEach((name, index) => {
      out.push(line(index === 0 ? `variables` : ``, `${name}=${report.environment[name]!}`));
    });
  }

  out.push(section(`Package managers`));
  for (const pm of report.packageManagers) {
    out.push(line(pm.name, `${pm.registry}  (${pm.registrySource})`));
    out.push(line(``, `binaries: ${pm.binaries.join(`, `)}`));
    out.push(
      line(
        ``,
        `default: ${pm.recordedDefault ?? pm.builtinDefault}${pm.recordedDefault === null ? ` (built-in)` : ` (recorded)`}`,
      ),
    );
    out.push(line(``, `cached: ${pm.cached.length > 0 ? pm.cached.join(`, `) : `(none)`}`));
    for (const note of pm.notes) out.push(line(``, note));
  }

  out.push(section(`.npmrc`));
  if (report.npmrc.files.length === 0) {
    out.push(line(`files`, `(none found)`));
  } else {
    // Highest precedence first, which is the order a reader wants: the winner
    // is the top line, not the bottom one.
    const files = [...report.npmrc.files].reverse();
    files.forEach((file, index) => {
      out.push(line(index === 0 ? `files` : ``, `${file.path}  (${file.level})`));
      if (file.keys.length > 0) out.push(line(``, `  read: ${file.keys.join(`, `)}`));
      if (file.refused.length > 0) {
        out.push(line(``, `  refused (project-level): ${file.refused.join(`, `)}`));
      }
    });
  }
  if (report.npmrc.registry !== null) {
    out.push(line(`registry`, `${report.npmrc.registry.value}  (${report.npmrc.registry.source})`));
  }
  for (const scope of report.npmrc.scopes) {
    out.push(line(`${scope.scope}:registry`, `${scope.value}  (${scope.source})`));
  }
  if (report.npmrc.auth.length === 0) {
    out.push(line(`auth`, `(none)`));
  } else {
    report.npmrc.auth.forEach((entry, index) => {
      // The prefix and its kind, never the credential.
      out.push(
        line(index === 0 ? `auth` : ``, `${entry.prefix}  ${entry.type}  (${entry.source})`),
      );
    });
  }

  out.push(section(`TLS`));
  out.push(
    line(
      `verify`,
      report.tls.verify
        ? `yes`
        : `no  (disabled by ${report.tls.verifySource ?? `the environment`})`,
    ),
  );
  out.push(
    line(
      `trust store`,
      report.tls.cafileSource === null
        ? `(platform)`
        : `${report.tls.cafile ?? `(inline)`}  (${report.tls.cafileSource})`,
    ),
  );

  out.push(section(`Store`));
  out.push(line(`home`, report.store.home));
  out.push(line(`path`, report.store.path));
  out.push(line(`writable`, report.store.writable ? `yes` : `no`));
  out.push(line(`versions`, formatVersions(report)));
  out.push(line(`defaults`, report.defaults.path));
  const defaults = Object.keys(report.defaults.entries);
  if (defaults.length === 0) {
    out.push(line(``, `(none recorded)`));
  } else {
    for (const name of defaults) out.push(line(``, `${name}: ${report.defaults.entries[name]!}`));
  }

  out.push(section(`Shims`));
  out.push(line(`directory`, report.shims.directory ?? `(unknown)`));
  if (report.shims.problem !== null) out.push(line(`problem`, report.shims.problem));
  for (const entry of report.shims.entries) {
    const state = entry.shim === null ? `not installed` : `installed`;
    const target =
      entry.path === null
        ? `PATH: not found`
        : `PATH: ${entry.path}${entry.ours ? `` : ` (not ours)`}${entry.shadowed ? ` — shadowing the shim` : ``}`;
    out.push(line(entry.binary, `${state.padEnd(16)}${target}`));
  }

  return out.join(``);
}

function formatVersions(report: InfoReport): string {
  if (report.store.versions.length === 0) return `(none)`;
  return report.store.versions.map((entry) => `${entry.name}@${entry.version}`).join(`, `);
}

/**
 * §09.7 — `cache list` is the store half of the same report.
 *
 * §09.9 permits it as an alias, and this is that alias narrowed to the two
 * questions it exists to answer: what is in the image, and what does the machine
 * default to?
 */
export function cacheListView(report: InfoReport): {
  version: number;
  store: InfoReport["store"];
  defaults: InfoReport["defaults"];
} {
  return { version: report.version, store: report.store, defaults: report.defaults };
}

export function formatCacheList(report: InfoReport): string {
  const out: string[] = [];
  out.push(line(`store`, report.store.path));
  out.push(line(`writable`, report.store.writable ? `yes` : `no`));

  if (report.store.versions.length === 0) {
    out.push(line(`versions`, `(none)`));
  } else {
    report.store.versions.forEach((entry, index) => {
      out.push(line(index === 0 ? `versions` : ``, `${entry.name}@${entry.version}`));
    });
  }

  out.push(line(`defaults`, report.defaults.path));
  const defaults = Object.keys(report.defaults.entries);
  if (defaults.length === 0) {
    out.push(line(``, `(none recorded)`));
  } else {
    for (const name of defaults) out.push(line(``, `${name}: ${report.defaults.entries[name]!}`));
  }

  return out.join(``);
}
/** `--json`, and nothing else. A typo must not be silently ignored. */
function wantsJson(args: string[], command: string): boolean {
  let json = false;
  for (const arg of args) {
    if (arg === `--json`) json = true;
    else throw new UsageError(`The '${command}' command only accepts --json`);
  }
  return json;
}

/** §09.9 — `jup info [--json]`. Always exits 0 unless the CLI was misused. */
// eslint-disable-next-line @typescript-eslint/require-await
export async function cmdInfo(args: string[]): Promise<number> {
  const json = wantsJson(args, `jup info`);
  const report = buildReport();
  out(json ? `${JSON.stringify(report, undefined, 2)}\n` : formatReport(report));
  return 0;
}

/** §09.7 / §09.9 — `jup cache list [--json]`, the aliased subset. */
// eslint-disable-next-line @typescript-eslint/require-await
export async function cmdCacheList(args: string[]): Promise<number> {
  const json = wantsJson(args, `jup cache list`);
  const report = buildReport();
  out(json ? `${JSON.stringify(cacheListView(report), undefined, 2)}\n` : formatCacheList(report));
  return 0;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
