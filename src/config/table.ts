/**
 * The embedded registry table — §02.5, §14.20.
 *
 * This is the only "configuration" the tool has, and it is compiled in: there is
 * deliberately no mechanism for a user to supply a different one at runtime.
 * Static structures, not a JSON blob parsed at startup.
 *
 * `ranges` is an **ordered list** and is matched in **reverse** — last declared
 * wins (§02.3). Dist-tags always resolve against the **last** entry's registry,
 * which is why `yarn@latest` consults repo.yarnpkg.com even though `yarn@1.22.22`
 * comes from npm.
 */

import { messages, UsageError } from "../errors.ts";
import { parse, satisfiesWithPrereleases } from "../version/semver.ts";
import type { Locator, NpmRegistrySpec, RegistrySpec, Role, Tool, ToolSpec } from "../types.ts";

export const DEFINITIONS: Record<string, Tool> = {
  npm: {
    roles: ["package-manager"],
    default: "11.14.1+sha1.4a6839650da0005f323fec6abd39d77ee24f842f",
    fetchLatestFrom: { type: "npm", package: "npm" },
    transparent: {
      commands: [["npm", "init"], ["npx"]],
    },
    ranges: [
      [
        "*",
        {
          url: "https://registry.npmjs.org/npm/-/npm-{}.tgz",
          bin: { npm: "./bin/npm-cli.js", npx: "./bin/npx-cli.js" },
          registry: { type: "npm", package: "npm" },
          commands: { use: ["npm", "install"] },
        },
      ],
    ],
  },

  pnpm: {
    roles: ["package-manager"],
    default: "11.1.2+sha1.ed39d701687311ce9345771c62376f9fe7286694",
    fetchLatestFrom: { type: "npm", package: "pnpm" },
    transparent: {
      commands: [["pnpm", "init"], ["pnpx"], ["pnpm", "dlx"]],
    },
    ranges: [
      [
        "<6.0.0",
        {
          url: "https://registry.npmjs.org/pnpm/-/pnpm-{}.tgz",
          bin: { pnpm: "./bin/pnpm.js", pnpx: "./bin/pnpx.js" },
          registry: { type: "npm", package: "pnpm" },
          commands: { use: ["pnpm", "install"] },
        },
      ],
      [
        "6.x || 7.x || 8.x || 9.x || 10.x",
        {
          url: "https://registry.npmjs.org/pnpm/-/pnpm-{}.tgz",
          bin: { pnpm: "./bin/pnpm.cjs", pnpx: "./bin/pnpx.cjs" },
          registry: { type: "npm", package: "pnpm" },
          commands: { use: ["pnpm", "install"] },
        },
      ],
      [
        ">=11.0.0",
        {
          url: "https://registry.npmjs.org/pnpm/-/pnpm-{}.tgz",
          bin: { pnpm: "./bin/pnpm.mjs", pnpx: "./bin/pnpx.mjs" },
          registry: { type: "npm", package: "pnpm" },
          commands: { use: ["pnpm", "install"] },
        },
      ],
    ],
  },

  yarn: {
    roles: ["package-manager"],
    // §15.33 bullet 2 overrides §02.5's literal and §14.21's "deliberately not
    // changed": an embedded `default` MUST track the current supported major,
    // and Classic 1.22.22 has been unsupported since 2020 (#812). So `default`
    // now equals `transparent.default` — the same release at the same digest,
    // a pin this table already ships rather than a fresh unverified one.
    // `scripts/refresh-table.mjs` (§16.9) is what stops both rotting; the fields
    // stay separate because §15.33 bullet 1 floors only the transparent one.
    default: "4.14.1+sha224.88b7a7244bbd9040380c417f7eb556d85c67640b651f113cb4c72113",
    fetchLatestFrom: { type: "npm", package: "yarn" },
    transparent: {
      default: "4.14.1+sha224.88b7a7244bbd9040380c417f7eb556d85c67640b651f113cb4c72113",
      commands: [
        ["yarn", "init"],
        ["yarn", "dlx"],
      ],
    },
    ranges: [
      [
        "<2.0.0",
        {
          url: "https://registry.yarnpkg.com/yarn/-/yarn-{}.tgz",
          bin: { yarn: "./bin/yarn.js", yarnpkg: "./bin/yarn.js" },
          registry: { type: "npm", package: "yarn" },
          commands: { use: ["yarn", "install"] },
        },
      ],
      [
        ">=2.0.0",
        {
          url: "https://repo.yarnpkg.com/{}/packages/yarnpkg-cli/bin/yarn.js",
          // BinList, single-file form: both names run `<location>/yarn.js`.
          bin: ["yarn", "yarnpkg"],
          registry: {
            type: "url",
            url: "https://repo.yarnpkg.com/tags",
            fields: { tags: "aliases", versions: "tags" },
          },
          // `repo.yarnpkg.com` is not an npm registry and cannot be mirrored, so a
          // custom npm registry switches to `@yarnpkg/cli-dist` (§05.3, §07.4).
          npmRegistry: { type: "npm", package: "@yarnpkg/cli-dist", bin: "bin/yarn.js" },
          commands: { use: ["yarn", "install"] },
        },
      ],
    ],
  },
};

/**
 * Every name the table carries.
 *
 * The array identity is stable and its contents are refilled by
 * {@link reindexTable}, so a caller may hold on to it.
 */
const NAMES: string[] = [];
export const SUPPORTED_NAMES: readonly string[] = NAMES;

export function getDefinition(name: string): Tool | undefined {
  return Object.hasOwn(DEFINITIONS, name) ? DEFINITIONS[name] : undefined;
}

export function isSupportedPackageManager(name: string): boolean {
  return getDefinition(name) !== undefined;
}

/**
 * §17.4 R10 row 2 — the fixed order every role-iterating command uses:
 * **package manager first, then runtime**.
 *
 * A list rather than a `Role[]` derived from a `Record` so the order is written
 * down where the rule is, and so `install`, `pack` and `up` all read it from one
 * place: R10 makes the order observable ("each prints its own line, in order"),
 * which means it is contract and not an implementation detail. Adding a role is
 * an entry here and in §03's `PIN_FIELDS`, both of them data (R3).
 */
export const ROLE_ORDER: readonly Role[] = ["package-manager", "runtime"];

/**
 * §10.5 / §17.6 C5 — the role `enable` and `disable` target with no scope word.
 * Here, not in `shims.ts`, because R3 keeps roles data; spelled out rather than
 * `ROLE_ORDER[0]`, because shim policy is not a presentation order.
 */
export const DEFAULT_SHIM_ROLE: Role = "package-manager";

/**
 * §17.3 R1 — the roles this tool fills, or `undefined` for a name the table
 * does not carry.
 *
 * One entry per tool, not per role: a tool that is both a runtime and a package
 * manager has one directory, one recorded default, and two roles here.
 */
export function getRoles(name: string): readonly Role[] | undefined {
  return getDefinition(name)?.roles;
}

/**
 * §17.3 R4 — does this tool fill that role?
 *
 * The one place a role may be *asked about* outside the table. R3 forbids
 * branching on a literal role anywhere else, so a caller passes the role its
 * own concern is scoped to rather than testing for a spelling.
 */
export function hasRole(name: string, role: Role): boolean {
  return getDefinition(name)?.roles.includes(role) === true;
}

/**
 * §02.3 — reverse the ordered range list, first match wins, using
 * prerelease-tolerant satisfaction. `undefined` when no band covers the version.
 */
function findBand(definition: Tool, version: string): ToolSpec | undefined {
  for (let i = definition.ranges.length - 1; i >= 0; i--) {
    const entry = definition.ranges[i]!;
    if (satisfiesWithPrereleases(version, entry[0])) return entry[1];
  }
  return undefined;
}

/**
 * §02.3 — the spec governing this version.
 *
 * §15.17: a version outside every declared band falls forward to the **newest**
 * band rather than throwing. That is the band §04.1 already resolves dist-tags
 * against, so its registry and URL template describe wherever the project is
 * heading. What must *not* be inherited is that band's `bin` — #775 is a
 * hardcoded entry point outliving the layout it described — so
 * {@link hasRangeBand} lets `install.resolveBin` tell "the table knows this
 * version" from "the table is guessing".
 */
export function getSpecFor(name: string, version: string): ToolSpec {
  const definition = getDefinition(name);
  if (definition === undefined) throw new UsageError(messages.unsupportedByBuild(name));

  return findBand(definition, version) ?? definition.ranges.at(-1)![1];
}

/** §15.17 — does a *declared* band cover this version, or is {@link getSpecFor} guessing? */
export function hasRangeBand(name: string, version: string): boolean {
  const definition = getDefinition(name);
  return definition !== undefined && findBand(definition, version) !== undefined;
}

/**
 * The embedded table's spec for this locator, or `undefined` when there is none
 * — an unknown package manager, or a URL reference, which is its own spec.
 */
export function getTableSpec(locator: Locator): ToolSpec | undefined {
  const parsed = parse(locator.reference);
  if (parsed === null || !isSupportedPackageManager(locator.name)) return undefined;
  return getSpecFor(locator.name, parsed.version);
}

/* -------------------------------------------------------------------------- */
/* §15.28 — per-platform URL templates                                         */
/* -------------------------------------------------------------------------- */

/**
 * §15.28 — the normalised platform names `{platform}` resolves against.
 *
 * The spec fixes the vocabulary at `linux` / `darwin` / `win32`, which is also
 * what Node reports, so on this host the table is very nearly an identity. It is
 * written out anyway because it is the *allow-list*: a host outside it must
 * produce the error below rather than a URL still carrying `{platform}`.
 */
const PLATFORMS: Record<string, string> = {
  darwin: "darwin",
  linux: "linux",
  win32: "win32",
};

/**
 * §15.28 — the same for `{arch}`: `x64` / `arm64`.
 *
 * The two aliases are there because a re-implementation in another language
 * reads the machine name from `uname`, which spells the same two architectures
 * `amd64` and `aarch64`. Accepting them costs one map entry and keeps the
 * normalisation honest about what "normalised" means; it changes nothing on a
 * Node host, which never reports either.
 */
const ARCHITECTURES: Record<string, string> = {
  arm64: "arm64",
  x64: "x64",
  aarch64: "arm64",
  amd64: "x64",
};

/**
 * §15.28 — substitute `{}`, `{platform}` and `{arch}` into a band's `url`.
 *
 * `{}` is §02.4's version placeholder and is always substituted. The other two
 * are opt-in per band, and the cheap `includes` guard is what keeps the common
 * case — every entry in the table today — at exactly the one `replace` it used
 * to be, on a path §16.3 counts.
 *
 * An unrecognised platform or architecture is an error naming *which* half was
 * unrecognised. It is deliberately not a 404 later on: a URL that still contains
 * the literal `{arch}` blames the registry for the host's own unsupportedness.
 */
export function resolveSpecUrl(spec: ToolSpec, locator: Locator, version: string): string {
  const url = spec.url.replace("{}", version);

  const wantsPlatform = url.includes("{platform}");
  const wantsArch = url.includes("{arch}");
  if (!wantsPlatform && !wantsArch) return url;

  let resolved = url;

  if (wantsPlatform) {
    const platform = PLATFORMS[process.platform];
    if (platform === undefined) {
      throw new UsageError(
        messages.unsupportedPlatform(locator.name, locator.reference, process.platform),
      );
    }
    resolved = resolved.replaceAll("{platform}", platform);
  }

  if (wantsArch) {
    const arch = ARCHITECTURES[process.arch];
    if (arch === undefined) {
      throw new UsageError(messages.unsupportedArch(locator.name, locator.reference, process.arch));
    }
    resolved = resolved.replaceAll("{arch}", arch);
  }

  return resolved;
}

/**
 * §08.1 — the package manager spec's **download URL**, with `{}` substituted.
 *
 * `exec.ts` needs the whole URL, not just its extension: a `bin` *list* resolves
 * to `<location>/<basename of the URL path>`. A URL reference is its own spec
 * URL, exactly as §07.3 treats it.
 */
export function getSpecUrl(locator: Locator): string {
  const spec = getTableSpec(locator);
  if (spec === undefined) return locator.reference;
  return resolveSpecUrl(spec, locator, parse(locator.reference)!.version);
}

/**
 * Is this exact reference one the embedded table ships?
 *
 * Used to scope §06.2's weak-algorithm warning. Every built-in default is
 * currently sha1-pinned (§02.5), so without this check a plain `yarn` in a
 * directory with no pin warns the user about an algorithm we chose for them.
 */
export function isEmbeddedReference(name: string, reference: string): boolean {
  const definition = getDefinition(name);
  if (definition === undefined) return false;
  return reference === definition.default || reference === definition.transparent.default;
}

/**
 * The union of every `bin` name across every range entry, in both directions.
 *
 * Built once at module load rather than per call: `getPackageManagerFor` runs on
 * every proxy invocation to classify argv (§01.2), and §16.3 counts allocations
 * on that path. The table is static, so the maps can be too.
 */
const BINARIES_BY_NAME = new Map<string, string[]>();
const NAME_BY_BINARY = new Map<string, string>();

function indexBinaries(): void {
  BINARIES_BY_NAME.clear();
  NAME_BY_BINARY.clear();

  for (const [name, definition] of Object.entries(DEFINITIONS)) {
    const binNames = new Set<string>();
    for (const [, spec] of definition.ranges) {
      for (const binName of Array.isArray(spec.bin) ? spec.bin : Object.keys(spec.bin)) {
        binNames.add(binName);
        if (!NAME_BY_BINARY.has(binName)) NAME_BY_BINARY.set(binName, name);
      }
    }
    BINARIES_BY_NAME.set(name, [...binNames]);
  }
}

/* -------------------------------------------------------------------------- */
/* Which package manager does a registry spec belong to? — §15.2               */
/* -------------------------------------------------------------------------- */

/**
 * Registry spec -> the package manager that declares it, and (for a url-typed
 * spec) the npm-protocol alternative its band offers.
 *
 * Identity, not equality: `getSpecFor` hands back the very objects declared
 * above, so the lookup is a `Map` hit rather than a structural comparison. Both
 * maps exist because §15.2 needs the *name* to find `COREPACK_REGISTRY_<NAME>`,
 * and §05.2 rewrite 1 needs the alternative — and `registry.ts` is handed a
 * `RegistrySpec` alone, with no way back to either.
 *
 * Built once at module load, from static data.
 */
const NAME_BY_REGISTRY = new Map<RegistrySpec, string>();
const NPM_ALTERNATIVE_BY_REGISTRY = new Map<RegistrySpec, NpmRegistrySpec>();

function indexRegistries(): void {
  NAME_BY_REGISTRY.clear();
  NPM_ALTERNATIVE_BY_REGISTRY.clear();

  for (const [name, definition] of Object.entries(DEFINITIONS)) {
    NAME_BY_REGISTRY.set(definition.fetchLatestFrom, name);
    for (const [, spec] of definition.ranges) {
      NAME_BY_REGISTRY.set(spec.registry, name);
      if (spec.npmRegistry !== undefined) {
        NAME_BY_REGISTRY.set(spec.npmRegistry, name);
        NPM_ALTERNATIVE_BY_REGISTRY.set(spec.registry, spec.npmRegistry);
      }
    }
  }
}

/**
 * Derive {@link SUPPORTED_NAMES} and both index maps from {@link DEFINITIONS}.
 *
 * Called once at module load, which is the only call `src/` makes: the table is
 * compiled in and nothing changes it at runtime (§01.7, §15.21). The export
 * exists for §17.9's test-only table fixture, which substitutes a table before
 * the entry point runs and needs the derivations to describe what it put there —
 * re-deriving from the one source beats a harness that keeps its own copy of
 * this loop and drifts.
 */
export function reindexTable(): void {
  NAMES.length = 0;
  NAMES.push(...Object.keys(DEFINITIONS));
  indexBinaries();
  indexRegistries();
}

reindexTable();

/** The package manager whose table entry declares this registry spec, if any. */
export function packageManagerForRegistry(spec: RegistrySpec): string | undefined {
  return NAME_BY_REGISTRY.get(spec);
}

/**
 * §02.5's `npmRegistry` for the band that declares this registry spec.
 *
 * Only Yarn Berry has one: `repo.yarnpkg.com` is not an npm registry, so a
 * configured npm registry switches it to the `@yarnpkg/cli-dist` package.
 */
export function npmAlternativeFor(spec: RegistrySpec): NpmRegistrySpec | undefined {
  return NPM_ALTERNATIVE_BY_REGISTRY.get(spec);
}

/**
 * Every binary name this package manager declares, across all range entries,
 * deduped. This union is also the set of shims `enable` creates (§10.5).
 */
export function getBinariesFor(name: string): string[] {
  return BINARIES_BY_NAME.get(name) ?? [];
}

/** Reverse lookup: which package manager answers to this binary name? */
export function getPackageManagerFor(binName: string): string | undefined {
  return NAME_BY_BINARY.get(binName);
}
