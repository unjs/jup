/**
 * `corepack info` — the supportability surface (§15.30).
 *
 * The corepack tracker's recurring shape is *"the tool resolved something
 * surprising and I cannot see why"* (#180, #440, #566, #679, #686). This module
 * answers that in one command: which file and which field declared the package
 * manager, what that resolved to and from where, which registry each package
 * manager would be fetched from, what the store holds, and what the shims on
 * `PATH` actually point at.
 *
 * Two properties are the whole point of the command, and both are asserted by
 * the conformance suite rather than merely intended:
 *
 * * **It performs no network request.** Nothing here calls `resolveDescriptor`,
 *   expands a dist-tag, or touches the registry: a spec that would need the
 *   network is *reported* as unresolved-without-network. A diagnostic that hangs
 *   behind a firewall diagnoses nothing.
 * * **It never fails on a bad project spec.** Every parse error, `devEngines`
 *   mismatch and unparseable manifest is caught and reported as the diagnosis —
 *   reporting *why* the project is broken is precisely what the command is for,
 *   so exiting 1 with the same sentence every other command already prints would
 *   make it useless in exactly the case it exists for.
 *
 * `--json` is a documented, stable contract carrying its own
 * {@link INFO_REPORT_VERSION}; see the README.
 */

import {
  accessSync,
  closeSync,
  constants as fsConstants,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { delimiter, dirname, join, resolve as resolvePath } from "node:path";
import { DEFAULT_REGISTRY } from "./config/keys.ts";
import { DEFINITIONS, getBinariesFor, SUPPORTED_NAMES } from "./config/table.ts";
import { isCI, isEnvFileEligible, parseEnvFile } from "./env.ts";
import { redactUserinfo, UsageError } from "./errors.ts";
import { parseManifest } from "./json.ts";
import { LOCKFILE_NAME, readLockfile, resolutionKey, usesLockfile } from "./lockfile.ts";
import { discoverProjectSpec, NODE_MODULES_RE, parseSpec } from "./manifest.ts";
import { getOwnRoot, getOwnVersion } from "./self.ts";
import { isValidRange, isValidVersion, parse } from "./semver.ts";
import { resolveInstallDirectory, SHIM_MARKER } from "./shims.ts";
import {
  findInstalledVersion,
  getHomeFolder,
  getInstallFolder,
  LAST_KNOWN_GOOD_NAME,
  listInstalled,
  readLastKnownGood,
} from "./store.ts";
import type { Descriptor, Manifest } from "./types.ts";

/**
 * The `--json` schema version.
 *
 * Bumped only for a **breaking** change to the shape below; adding a field is
 * not one. Consumers should read this before anything else.
 */
export const INFO_REPORT_VERSION = 1;

/** Variables whose value is a credential: reported as present, never printed. */
const SECRET_VARIABLES = new Set([
  "COREPACK_NPM_TOKEN",
  "COREPACK_NPM_PASSWORD",
  "COREPACK_NPM_USERNAME",
]);

/** Long values (a trust store, a proxy list) are elided rather than dumped. */
const MAX_VALUE_LENGTH = 120;

/* -------------------------------------------------------------------------- */
/* The report                                                                  */
/* -------------------------------------------------------------------------- */

/** What kind of thing the version half of a spec is (§04.1, §15.23). */
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
   * `pinned` — the field names the version outright; `locked` — `.corepack.lock`
   * answers it; `cache` — nothing is recorded, but an installed version
   * satisfies the range; `network` — resolving needs a request, which `info`
   * does not make; `frozen` — a request is needed and is refused; `fallback` —
   * no project spec, so the global default decides; `unknown` — the spec is
   * unusable.
   */
  status: "pinned" | "locked" | "cache" | "network" | "frozen" | "fallback" | "unknown";
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
  resolution: { resolved: string; integrity?: string } | null;
  /** §15.23 / §15.37 — whether the file may be written or refreshed. */
  frozen: boolean;
  frozenSource: "COREPACK_FROZEN_LOCKFILE" | "CI" | "default";
}

export interface EnvFileInfo {
  path: string;
  /** Eligible, and not shadowed by the real environment: these took effect. */
  applied: string[];
  /** Eligible, but the real environment already set them (§11.6). */
  overridden: string[];
  /** `COREPACK_`-prefixed but refused from a file (§03.2, §14.5). */
  refused: string[];
  /** Not `COREPACK_`-prefixed, so dropped before the merge. */
  ignored: string[];
}

export interface PackageManagerInfo {
  name: string;
  binaries: string[];
  /** The npm registry metadata and tarballs would come from. */
  registry: string;
  registrySource: "COREPACK_NPM_REGISTRY" | "built-in";
  /** Anything about this package manager's fetch path worth saying out loud. */
  notes: string[];
  /** The compiled-in, hash-pinned fallback (§02.5). */
  builtinDefault: string;
  /** `lastKnownGood.json`'s entry, if any (§04.4). */
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
  /** A shim is installed, but something else on `PATH` wins (§15.29). */
  shadowed: boolean;
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
  /** §15.1 is not implemented; this says so rather than staying silent. */
  npmrc: { consulted: boolean; note: string };
  store: {
    home: string;
    path: string;
    writable: boolean;
    versions: Array<{ name: string; version: string }>;
  };
  defaults: { path: string; entries: Record<string, string> };
  shims: { directory: string | null; problem: string | null; entries: ShimInfo[] };
}

/* -------------------------------------------------------------------------- */
/* Builder                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Collect everything, touching only the filesystem.
 *
 * Order matters once: the `COREPACK_*` snapshot is taken **before** the env file
 * is discovered, because `applyEnvFile` merges the file into `process.env` and
 * afterwards there is no way to tell a variable the user exported from one the
 * project supplied — which is exactly the distinction §15.30 asks for.
 */
export function buildReport(cwd: string = process.cwd()): InfoReport {
  const realEnvironment = snapshotEnvironment();

  // The env-file walk (§03.2), which also *applies* the file — the same thing
  // every other command does, so what is reported below is what a run sees.
  const envLookup = discoverProjectSpec(cwd, { envOnly: true });
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
    tool: { name: "pipack", version: getOwnVersion(), root: getOwnRoot(import.meta.url) },
    project,
    resolution,
    lockfile,
    envFile,
    environment: realEnvironment,
    packageManagers: describePackageManagers(versions, defaults),
    npmrc: {
      consulted: false,
      // The seam §15.1 fills in. Saying nothing here would let a user conclude
      // from a correct-looking report that their `.npmrc` registry was honoured.
      note: `.npmrc files are not read yet (§15.1); set COREPACK_NPM_REGISTRY to point at a mirror`,
    },
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

/* -------------------------------------------------------------------------- */
/* The project spec                                                            */
/* -------------------------------------------------------------------------- */

/**
 * §03 — what the project declares, and why it cannot be used when it cannot.
 *
 * `discoverProjectSpec` is authoritative and is asked first, so the manifest
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
    const lookup = discoverProjectSpec(cwd);
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
  // as the error a `yarn` invocation would actually hit. §15.23 widened what the
  // version may *be* — a range, a dist-tag — not whether a pin has to carry one.
  try {
    const descriptor = parseSpec(declared.raw, "package.json", { requireVersion: true });
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

/** §04.1 / §15.23 — an exact version, a range, a dist-tag, or a URL. */
export function classifySpec(descriptor: Descriptor): SpecKind {
  const { range } = descriptor;
  if (URL.canParse(range)) return "url";
  if (isValidVersion(range)) return "exact";
  if (isValidRange(range)) return "range";
  return "tag";
}

/**
 * Which field carries the pin, read from the manifest itself.
 *
 * `SpecResult.hasPin` cannot answer this: it is `typeof pm === "string"`, so a
 * `packageManager: 42` — one of the shapes §12.2 exists for — would be reported
 * as coming from `devEngines`, naming the wrong field in the one report whose
 * job is to name the right one.
 */
function describeDeclaration(manifest: Manifest | undefined): {
  field: string | null;
  spec: string | null;
  raw: unknown;
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

  if (manifest !== undefined && Object.hasOwn(manifest, "packageManager")) {
    const pm = manifest.packageManager;
    return {
      field: "packageManager",
      // A non-string field still has to be *shown*: `packageManager: 42` is
      // reported as `42`, next to the sentence explaining why it is not a spec.
      spec: typeof pm === "string" ? pm : (JSON.stringify(pm) ?? String(pm)),
      raw: pm,
      devEngines,
    };
  }

  if (devEngines !== null) {
    // §03.3 — with no `packageManager` the spec is synthesised from the two
    // devEngines fields, and `*` stands in for an absent version.
    const name = typeof devEngines.name === "string" ? devEngines.name : undefined;
    const version = typeof devEngines.version === "string" ? devEngines.version : undefined;
    const spec = name === undefined ? null : `${name}@${version ?? "*"}`;
    return { field: "devEngines.packageManager", spec, raw: spec ?? undefined, devEngines };
  }

  return { field: null, spec: null, raw: undefined, devEngines };
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
    // to name — and a truthy `packageManager` is §03.1's own stop condition.
    let data: unknown;
    try {
      data = parseManifest(content);
    } catch {
      return target;
    }
    if (typeof data !== "object" || data === null) return target;
    if ((data as Manifest).packageManager) return target;
  }

  return selected;
}

/* -------------------------------------------------------------------------- */
/* Resolution, without a network                                               */
/* -------------------------------------------------------------------------- */

/** §15.23 — the recorded resolution for this project's spec, and whether it may move. */
function describeLockfile(dir: string, project: ProjectInfo): LockfileInfo {
  const raw = process.env.COREPACK_FROZEN_LOCKFILE;
  const frozenSource =
    raw !== undefined && raw !== "" ? "COREPACK_FROZEN_LOCKFILE" : isCI() ? "CI" : "default";

  const descriptor = descriptorOf(project);
  const usable = project.name !== null && project.range !== null && usesLockfile(descriptor);
  const key = usable ? resolutionKey(descriptor) : null;

  const data = readLockfile(dir);

  return {
    path: join(dir, LOCKFILE_NAME),
    present: data !== null,
    key,
    resolution: key === null || data === null ? null : (data.resolutions[key] ?? null),
    // Mirrors `env.isFrozenLockfile()` with no `refresh`: `info` never writes.
    frozen: raw !== undefined && raw !== "" ? raw === "1" : isCI(),
    frozenSource,
  };
}

function descriptorOf(project: ProjectInfo): Descriptor {
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

  // An exact version (or a URL) is its own record: §15.23 keeps the lockfile out
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
    const { resolved, integrity } = lockfile.resolution;
    return {
      ...base,
      status: "locked",
      version: resolved,
      hash: integrity === undefined ? null : hashOfIntegrity(integrity),
      source: lockfile.path,
      installed: findInstalledVersion(project.name, resolved) !== null,
    };
  }

  // §15.23 — the refusal happens before any request, so this is a fact rather
  // than a prediction.
  if (lockfile.frozen) {
    return {
      ...base,
      status: "frozen",
      reason: `${project.name}@${project.range} is not resolved in ${LOCKFILE_NAME} and lockfile updates are disabled (${lockfile.frozenSource})`,
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

/* -------------------------------------------------------------------------- */
/* Environment                                                                 */
/* -------------------------------------------------------------------------- */

/** Every `COREPACK_*` variable in the real environment, credentials masked. */
function snapshotEnvironment(): Record<string, string> {
  const snapshot: Record<string, string> = {};
  for (const name of Object.keys(process.env).sort()) {
    if (!name.startsWith("COREPACK_")) continue;
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
 * `.corepack.env` not doing anything": it was refused for security (§14.5), it
 * was shadowed by a real environment variable (§11.6), or it was never
 * `COREPACK_`-prefixed in the first place.
 */
function describeEnvFile(path: string, realEnvironment: Record<string, string>): EnvFileInfo {
  const info: EnvFileInfo = { path, applied: [], overridden: [], refused: [], ignored: [] };

  let vars: Record<string, string>;
  try {
    vars = parseEnvFile(readFileSync(path, "utf8"));
  } catch {
    return info;
  }

  for (const name of Object.keys(vars).sort()) {
    if (!name.startsWith("COREPACK_")) info.ignored.push(name);
    else if (!isEnvFileEligible(name)) info.refused.push(name);
    else if (Object.hasOwn(realEnvironment, name)) info.overridden.push(name);
    else info.applied.push(name);
  }

  return info;
}

/* -------------------------------------------------------------------------- */
/* Registries, store and defaults                                              */
/* -------------------------------------------------------------------------- */

/**
 * The effective npm registry, and where the setting came from.
 *
 * Deliberately a mirror of `registry.getRegistryUrl` rather than an import:
 * `registry.ts` statically pulls in the HTTP and signature stack (and through it
 * `node:crypto`), and `info` is the command you reach for *because* downloads
 * are failing. §15.1 adds `.npmrc` as a third source here — that is the seam the
 * report's `npmrc` field marks — and a unit test pins this against the real
 * `getRegistryUrl` so the mirror cannot drift.
 */
export function effectiveRegistry(): {
  registry: string;
  source: "COREPACK_NPM_REGISTRY" | "built-in";
} {
  const configured = process.env.COREPACK_NPM_REGISTRY;
  if (configured === undefined || configured === "") {
    return { registry: DEFAULT_REGISTRY, source: "built-in" };
  }
  return { registry: configured.replace(/\/+$/, ""), source: "COREPACK_NPM_REGISTRY" };
}

function describePackageManagers(
  versions: Array<{ name: string; version: string }>,
  defaults: Record<string, string>,
): PackageManagerInfo[] {
  const { registry: configured, source } = effectiveRegistry();
  const overridden = source === "COREPACK_NPM_REGISTRY";
  // §11.2 lets the registry embed `user:pass@`, and a report is pasted into
  // issues and CI logs far more often than an error message is.
  const registry = redactUserinfo(configured);

  return SUPPORTED_NAMES.map((name) => {
    const definition = DEFINITIONS[name]!;
    const notes: string[] = [];

    for (const [range, spec] of definition.ranges) {
      // §05.3 — a band that is not an npm registry cannot be mirrored, so its
      // fetch path does not follow `COREPACK_NPM_REGISTRY` unless the table
      // gives it an npm fallback (§02.5's `@yarnpkg/cli-dist`).
      if (spec.registry.type === "npm") continue;

      if (overridden && spec.npmRegistry !== undefined) {
        notes.push(`${name}@${range} is fetched from ${registry} as ${spec.npmRegistry.package}`);
      } else {
        const origin = URL.canParse(spec.url) ? new URL(spec.url).origin : spec.url;
        notes.push(
          spec.npmRegistry === undefined
            ? `${name}@${range} is fetched from ${origin}, which no registry setting redirects`
            : `${name}@${range} is fetched from ${origin}; setting COREPACK_NPM_REGISTRY switches it to ${spec.npmRegistry.package}`,
        );
      }
    }

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

/* -------------------------------------------------------------------------- */
/* Shims                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * §10, §15.29 — for every binary name: is a shim installed, and what does that
 * name resolve to on `PATH` right now?
 *
 * The second half is what #686 asks for (*"there's no reliable way to determine
 * if corepack is enabled"*): a shim can be installed perfectly and still lose,
 * because another version manager sits earlier on `PATH`. Reporting only the
 * first half would answer "yes, enabled" to a user whose `yarn` is somebody
 * else's.
 */
function describeShims(): InfoReport["shims"] {
  let directory: string | null = null;
  let problem: string | null = null;

  try {
    // The resolver `disable` uses, so a report and a removal never disagree
    // about where the shims are. `forEnable: false` — no realpath.
    directory = resolveInstallDirectory({}, false);
  } catch (error) {
    // §12.9's "unable to determine where to install the shims" is a fine answer
    // to a *question*; it must not be the end of the whole report.
    problem = messageOf(error);
  }

  const entries: ShimInfo[] = [];
  for (const name of SUPPORTED_NAMES) {
    for (const binary of getBinariesFor(name)) {
      const onPath = lookupOnPath(binary);
      const ours = onPath !== null && isOurShim(onPath);

      // `PATH` first, because `enable --install-directory` puts shims somewhere
      // `resolveInstallDirectory` will never guess — and a shim that is on
      // `PATH` and winning is installed by any definition worth reporting. The
      // default directory is the fallback, and it is what turns up the case
      // that matters: a shim that exists and is being shadowed.
      const candidate = directory === null ? null : join(directory, binary);
      const shim = ours ? onPath : candidate !== null && isOurShim(candidate) ? candidate : null;

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

/**
 * §14.16 — a file is one of ours iff it carries the generated-stub marker.
 *
 * The read follows symlinks, which is what makes it work for a POSIX shim: the
 * link in the shim directory points at a stub next to the library entry, and the
 * marker lives in the stub. Only the head is read, because the same question
 * gets asked of whatever `PATH` turned up — which may be a large native binary.
 */
function isOurShim(file: string): boolean {
  const head = readHead(file, 1024);
  if (head === undefined) return false;
  if (head.includes(SHIM_MARKER)) return true;
  // §10.3 — on Windows the entry on PATH is a `.cmd`/`.ps1`/sh wrapper that
  // *invokes* the marked stub rather than carrying the marker itself.
  return process.platform === "win32" && head.includes("node") && /[\w-]+\.js/.test(head);
}

function readHead(file: string, length: number): string | undefined {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return undefined;
  }
  try {
    const buffer = Buffer.allocUnsafe(length);
    const bytes = readSync(fd, buffer, 0, length, 0);
    return buffer.toString("utf8", 0, bytes);
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

/** §10.4 — `which(name)`, returning the file rather than its directory. */
function lookupOnPath(name: string): string | null {
  const extensions =
    process.platform === "win32" ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";") : [""];

  for (const entry of (process.env.PATH ?? "").split(delimiter)) {
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

/* -------------------------------------------------------------------------- */
/* Rendering                                                                   */
/* -------------------------------------------------------------------------- */

const LABEL_WIDTH = 16;

function line(label: string, value: string): string {
  // A label wider than the column still gets a separating space; without the
  // guard, `COREPACK_ENABLE_DOWNLOAD_PROMPT0` is what a long variable renders as.
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
    out.push(line(`integrity`, report.lockfile.resolution.integrity ?? `(none recorded)`));
  }
  out.push(
    line(`frozen`, `${report.lockfile.frozen ? `yes` : `no`} (${report.lockfile.frozenSource})`),
  );

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
    out.push(line(`variables`, `(no COREPACK_* variables set)`));
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
  out.push(line(`.npmrc`, report.npmrc.note));

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
 * §15.19 — `cache list` is the store half of the same report.
 *
 * §15.30 permits it as an alias, and this is that alias narrowed to the two
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

/* -------------------------------------------------------------------------- */
/* Commands                                                                    */
/* -------------------------------------------------------------------------- */

/** `--json`, and nothing else. A typo must not be silently ignored. */
function wantsJson(args: string[], command: string): boolean {
  let json = false;
  for (const arg of args) {
    if (arg === `--json`) json = true;
    else throw new UsageError(`The '${command}' command only accepts --json`);
  }
  return json;
}

/** §15.30 — `corepack info [--json]`. Always exits 0 unless the CLI was misused. */
// eslint-disable-next-line @typescript-eslint/require-await
export async function cmdInfo(args: string[]): Promise<number> {
  const json = wantsJson(args, `corepack info`);
  const report = buildReport();
  process.stdout.write(json ? `${JSON.stringify(report, undefined, 2)}\n` : formatReport(report));
  return 0;
}

/** §15.19 / §15.30 — `corepack cache list [--json]`, the aliased subset. */
// eslint-disable-next-line @typescript-eslint/require-await
export async function cmdCacheList(args: string[]): Promise<number> {
  const json = wantsJson(args, `corepack cache list`);
  const report = buildReport();
  process.stdout.write(
    json ? `${JSON.stringify(cacheListView(report), undefined, 2)}\n` : formatCacheList(report),
  );
  return 0;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
