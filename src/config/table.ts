/**
 * The embedded registry table — §02.5, §14.20.
 *
 * This is the only "configuration" the tool has, and it is compiled in: there is
 * deliberately no mechanism for a user to supply a different one at runtime.
 * Static structures, not a JSON blob parsed at startup.
 *
 * `ranges` is an **ordered list** and is matched in **reverse** — last declared
 * wins (§02.3). Dist-tags always resolve against the **last** entry's registry,
 * which is why `yarn@latest` reads `@yarnpkg/cli-dist`'s tags even though
 * `yarn@1.22.22` comes from the `yarn` package.
 *
 * §15.41 — every `url` and every `registry` here names the npm registry. Nothing
 * in this table reaches a vendor's own distribution host, which is what lets
 * §15.11's verification tier hold for every entry without an opt-in, and what
 * lets `COREPACK_NPM_REGISTRY` mirror all of it.
 */

import { existsSync } from "node:fs";
import { messages, UsageError } from "../errors.ts";
import { parse, satisfiesWithPrereleases } from "../version/semver.ts";
import type {
  BinSpec,
  DevEnginesField,
  Locator,
  NpmRegistrySpec,
  RegistrySpec,
  ToolDefinition,
  ToolKind,
  ToolSpec,
  VersionFileSpec,
} from "../types.ts";

/**
 * Native tools publish versions through a launcher package but executable bytes through per-host artifact packages. Because jup runs no lifecycle scripts or dependency installation, `registry` selects versions and `artifactRegistry` selects the signed artifact. Bun and bunx share one executable and dispatch by `argv[0]`.
 */
const BUN_BAND = {
  url: "https://registry.npmjs.org/@oven/bun-{target}/-/bun-{target}-{}.tgz",
  bin: { bun: "./bin/bun{exe}", bunx: "./bin/bun{exe}" },
  registry: { type: "npm", package: "bun" },
  artifactRegistry: { type: "npm", package: "@oven/bun-{target}" },
  exec: "native",
  commands: { use: ["bun", "install"] },
} as const satisfies Omit<ToolSpec, "targets">;

/** The four hosts every published bun artifact covers. */
const BUN_POSIX_TARGETS = {
  "darwin-arm64": "darwin-aarch64",
  "darwin-x64": "darwin-x64",
  "linux-arm64": "linux-aarch64",
  "linux-x64": "linux-x64",
} as const;

/** Bun's Alpine builds, published from 1.1.39 on. */
const BUN_MUSL_TARGETS = {
  "linux-arm64-musl": "linux-aarch64-musl",
  "linux-x64-musl": "linux-x64-musl",
} as const;

/**
 * aube uses the launcher/artifact split. Its target map intentionally excludes unavailable `darwin-x64`; its three commands dispatch by `argv[0]`.
 */
const AUBE_BAND = {
  url: "https://registry.npmjs.org/@endevco/aube-{target}/-/aube-{target}-{}.tgz",
  bin: { aube: "./bin/aube{exe}", aubr: "./bin/aubr{exe}", aubx: "./bin/aubx{exe}" },
  registry: { type: "npm", package: "@endevco/aube" },
  artifactRegistry: { type: "npm", package: "@endevco/aube-{target}" },
  exec: "native",
  commands: { use: ["aube", "install"] },
} as const satisfies Omit<ToolSpec, "targets">;

/** aube's glibc and native hosts. Note the absent `darwin-x64`: there is none. */
const AUBE_TARGETS = {
  "darwin-arm64": "darwin-arm64",
  "linux-arm64": "linux-arm64",
  "linux-x64": "linux-x64",
  "win32-arm64": "win32-arm64",
  "win32-x64": "win32-x64",
} as const;

/** aube's Alpine builds, published from `1.0.0-beta.12` on. */
const AUBE_MUSL_TARGETS = {
  "linux-arm64-musl": "linux-arm64-musl",
  "linux-x64-musl": "linux-x64-musl",
} as const;

/**
 * nub uses the launcher/artifact split. Its published targets match host names, and nub/nubx share one executable distinguished by `argv[0]`.
 */
const NUB_BAND = {
  url: "https://registry.npmjs.org/@nubjs/nub-{target}/-/nub-{target}-{}.tgz",
  bin: { nub: "./bin/nub{exe}", nubx: "./bin/nub{exe}" },
  registry: { type: "npm", package: "@nubjs/nub" },
  artifactRegistry: { type: "npm", package: "@nubjs/nub-{target}" },
  exec: "native",
  commands: { use: ["nub", "install"] },
} as const satisfies Omit<ToolSpec, "targets">;

/**
 * nub's hosts: every name the table knows, spelled the way the table spells it.
 *
 * The identity is complete — unlike aube's, which has a `darwin-x64` hole — and
 * the map is still written out for the same reason aube's is. It is where a host
 * leaving the set would be *said*, and a band with no `targets` is a band that
 * claims every host forever.
 */
const NUB_TARGETS = {
  "darwin-arm64": "darwin-arm64",
  "darwin-x64": "darwin-x64",
  "linux-arm64": "linux-arm64",
  "linux-arm64-musl": "linux-arm64-musl",
  "linux-x64": "linux-x64",
  "linux-x64-musl": "linux-x64-musl",
  "win32-arm64": "win32-arm64",
  "win32-x64": "win32-x64",
} as const;

/**
 * Node uses the launcher/artifact split. As a runtime, its project pin belongs to `devEngines.runtime`; the resolution and execution pipeline is otherwise shared.
 */
const NODE_BAND = {
  url: "https://registry.npmjs.org/node-{target}/-/node-{target}-{}.tgz",
  bin: { node: "./bin/node{exe}" },
  registry: { type: "npm", package: "node" },
  artifactRegistry: { type: "npm", package: "node-{target}" },
  exec: "native",
} as const satisfies Omit<ToolSpec, "targets">;

/**
 * node's six published hosts, and the three renames `{target}` exists for.
 *
 * The per-host packages are `node-<platform>-<arch>` with `win32` spelled `win`,
 * and on Apple Silicon the prefix is `node-bin-` rather than `node-`, because
 * `node-darwin-arm64` belongs to an unrelated publisher and stops at 18.9.0.
 * `node-bin-setup` makes exactly that substitution, unconditionally — this map
 * is that rule, not an invention of this table, which is also why one band is
 * enough: the mapping has not moved.
 *
 * There is no musl entry because Node publishes no musl build, so an Alpine host
 * is told `unsupportedTarget` before any request rather than handed a glibc
 * binary — deno's situation exactly (§15.28). `linux-armv7l`, which node *does*
 * publish, is outside {@link ARCHITECTURES}' vocabulary altogether and is the
 * other error.
 */
const NODE_TARGETS = {
  "darwin-arm64": "bin-darwin-arm64",
  "darwin-x64": "darwin-x64",
  "linux-arm64": "linux-arm64",
  "linux-x64": "linux-x64",
  "win32-arm64": "win-arm64",
  "win32-x64": "win-x64",
} as const;

/**
 * pnpm 12 uses signed per-host artifacts because its launcher depends on lifecycle installation. Target names match the host vocabulary.
 */
const PNPM_EXE_TARGETS = {
  "darwin-arm64": "darwin-arm64",
  "darwin-x64": "darwin-x64",
  "linux-arm64": "linux-arm64",
  "linux-arm64-musl": "linux-arm64-musl",
  "linux-x64": "linux-x64",
  "linux-x64-musl": "linux-x64-musl",
  "win32-arm64": "win32-arm64",
  "win32-x64": "win32-x64",
} as const;

export const DEFINITIONS: Record<string, ToolDefinition> = {
  npm: {
    default: "12.0.2+sha1.788d93dc8869000b1078e0395c60748a0aadc4f1",
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
    default: "11.24.0+sha1.a042a648b5e519c43c5b2c3ff99901448190cd66",
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
      // §15.28 — pnpm is native from 12.0.0, and the first entry in this table
      // to cross that line rather than to have been born on one side of it. The
      // version line and the dist-tags stay on `pnpm`; the bytes come from
      // `@pnpm/exe.<host>` (see {@link PNPM_EXE_TARGETS}).
      //
      // `pnpx` is the one thing the per-host package cannot express by itself.
      // Its binary dispatches on `current_exe()` rather than `argv[0]`, so the
      // name jup invokes it under does not reach the decision — pnpm's own
      // The installer hardlinks `pnpx` to the same executable; `binArgs`
      // supplies the equivalent `dlx` dispatch.
      [
        ">=12.0.0",
        {
          url: "https://registry.npmjs.org/@pnpm/exe.{target}/-/exe.{target}-{}.tgz",
          bin: { pnpm: "./pnpm{exe}", pnpx: "./pnpm{exe}" },
          binArgs: { pnpx: ["dlx"] },
          registry: { type: "npm", package: "pnpm" },
          artifactRegistry: { type: "npm", package: "@pnpm/exe.{target}" },
          targets: PNPM_EXE_TARGETS,
          exec: "native",
          commands: { use: ["pnpm", "install"] },
        },
      ],
    ],
  },

  yarn: {
    // §15.33 — the default and transparent floor share the current supported
    // major but remain separate fields. The SHA-1 digest covers the signed npm
    // tarball and is refreshed by `scripts/refresh-table.mjs`.
    default: "4.18.0+sha1.5f508685a3a4b84783972c25f392f75232b17f85",
    fetchLatestFrom: { type: "npm", package: "yarn" },
    transparent: {
      default: "4.18.0+sha1.5f508685a3a4b84783972c25f392f75232b17f85",
      commands: [
        ["yarn", "init"],
        ["yarn", "dlx"],
      ],
    },
    ranges: [
      [
        "<2.0.0",
        {
          url: "https://registry.npmjs.org/yarn/-/yarn-{}.tgz",
          bin: { yarn: "./bin/yarn.js", yarnpkg: "./bin/yarn.js" },
          registry: { type: "npm", package: "yarn" },
          commands: { use: ["yarn", "install"] },
        },
      ],
      [
        ">=2.0.0",
        {
          // Yarn Berry uses its signed npm tarball and standard registry overrides.
          url: "https://registry.npmjs.org/@yarnpkg/cli-dist/-/cli-dist-{}.tgz",
          bin: { yarn: "./bin/yarn.js", yarnpkg: "./bin/yarn.js" },
          registry: { type: "npm", package: "@yarnpkg/cli-dist" },
          commands: { use: ["yarn", "install"] },
        },
      ],
    ],
  },

  // §15.28, §15.21 — the entries the table's per-host machinery exists for;
  // `BUN_BAND` above explains the launcher-versus-artifact split they share.
  bun: {
    default: "1.4.0",
    fetchLatestFrom: { type: "npm", package: "bun" },
    transparent: {
      commands: [["bun", "init"], ["bun", "create"], ["bun", "x"], ["bunx"]],
    },
    shimByDefault: false,
    // Version bands encode Bun's supported host set at each boundary.
    // Reversed, the newest is tested first (§02.3), so a version gets the
    // narrowest true answer — and a host outside it is named as unsupported
    // *for that version*, rather than 404ing on a URL nobody typed.
    ranges: [
      ["*", { ...BUN_BAND, targets: BUN_POSIX_TARGETS }],
      // Open-ended and matched in reverse, exactly as pnpm's bands are: this one
      // is only reached for a version the band below it did not claim.
      [">=1.1.0", { ...BUN_BAND, targets: { ...BUN_POSIX_TARGETS, "win32-x64": "windows-x64" } }],
      [
        ">=1.1.39",
        {
          ...BUN_BAND,
          targets: { ...BUN_POSIX_TARGETS, ...BUN_MUSL_TARGETS, "win32-x64": "windows-x64" },
        },
      ],
      [
        ">=1.3.10",
        {
          ...BUN_BAND,
          targets: {
            ...BUN_POSIX_TARGETS,
            ...BUN_MUSL_TARGETS,
            "win32-arm64": "windows-aarch64",
            "win32-x64": "windows-x64",
          },
        },
      ],
    ],
  },

  deno: {
    default: "2.9.5",
    fetchLatestFrom: { type: "npm", package: "deno" },
    // `deno init` scaffolds into an empty directory, exactly as `npm init` and
    // `pnpm init` do. Nothing else on the deno CLI is project-independent:
    // `deno run`, `deno task` and `deno add` all act on the project they are
    // standing in, so they stay subject to §03.5's enforcement.
    transparent: {
      commands: [["deno", "init"]],
    },
    shimByDefault: false,
    // Per-target packages contain one executable at the package root.
    ranges: [
      [
        "*",
        {
          url: "https://registry.npmjs.org/@deno/{target}/-/{target}-{}.tgz",
          bin: { deno: "./deno{exe}" },
          registry: { type: "npm", package: "deno" },
          artifactRegistry: { type: "npm", package: "@deno/{target}" },
          targets: {
            "darwin-arm64": "darwin-arm64",
            "darwin-x64": "darwin-x64",
            "linux-arm64": "linux-arm64-glibc",
            "linux-x64": "linux-x64-glibc",
            "win32-arm64": "win32-arm64",
            "win32-x64": "win32-x64",
          },
          exec: "native",
          commands: { use: ["deno", "install"] },
        },
      ],
    ],
  },

  // §15.21 — a package manager, not a runtime, so unlike bun and deno it takes
  // part in a bare `jup enable`: `aube`, `aubr` and `aubx` are names that mean
  // nothing outside a project, which is exactly what §10.5's default set is for.
  aube: {
    default: "2.2.0",
    fetchLatestFrom: { type: "npm", package: "@endevco/aube" },
    // `aube init` scaffolds a `package.json` and `aube create` runs a `create-*`
    // starter kit through dlx; both are how a project comes to exist, so §03.5
    // has nothing to enforce yet. `aube dlx` and its `aubx` spelling fetch into a
    // throwaway environment and are project-independent for the same reason
    // `yarn dlx` is. Everything else — `aube install`, `aubr <script>`,
    // `aube exec` — acts on the project it is standing in and stays enforced.
    transparent: {
      commands: [["aube", "init"], ["aube", "create"], ["aube", "dlx"], ["aubx"]],
    },
    // The musl boundary at `1.0.0-beta.12` is unexpressible: §02.3
    // matches bands with `satisfiesWithPrereleases`, which strips the prerelease
    // from both sides, so `>=1.0.0-beta.12` and `>=1.0.0` are the same range and
    // neither excludes `1.0.0-beta.2`. Declaring a second band would therefore
    // be a promise the lookup cannot keep, and the honest alternative is this
    // one: the eleven prereleases before Alpine support 404 on Alpine, and every
    // release since is covered.
    ranges: [["*", { ...AUBE_BAND, targets: { ...AUBE_TARGETS, ...AUBE_MUSL_TARGETS } }]],
  },

  // §15.21 — a package manager *and* a runtime, which is what this entry adds to
  // the flag below: `nub install` is pnpm-compatible, and `nub server.ts` runs a
  // file. Being a package manager is not what earns a place in the default shim
  // set; meaning nothing outside a project is, and `nub` means plenty (§10.5).
  nub: {
    default: "0.7.5",
    fetchLatestFrom: { type: "npm", package: "@nubjs/nub" },
    // `nub init` scaffolds a project, and `nub dlx` — spelled `nub x`, and
    // reached under its own name as `nubx` — fetches into a throwaway
    // environment. Both are project-independent for the reasons `pnpm init` and
    // `pnpm dlx` are. `nub run`, `nub install` and `nub <file>` all act on the
    // project they stand in and stay subject to §03.5.
    transparent: {
      commands: [["nub", "init"], ["nub", "dlx"], ["nub", "x"], ["nubx"]],
    },
    shimByDefault: false,
    // Nub supports these eight hosts and exposes `bin/nub{exe}`.
    ranges: [["*", { ...NUB_BAND, targets: NUB_TARGETS }]],
  },

  // §15.39 — the first entry that is not a package manager. `kind` is the only
  // field that says so, and the four things it decides all live in §03 and §10.
  node: {
    kind: "runtime",
    // The current LTS line, bare per §02.3: node's artifact is per-host, so
    // there is no portable digest to pin and the registry signature over this
    // host's own `node-<target>` is what clears §15.11's tier.
    default: "24.20.0",
    // §04.1 step 3 — `lts` is ours to answer, because npm's tags cannot.
    //
    // The `node` package's dist-tags are `v4-lts` … `v20-lts` plus `latest`:
    // there is no bare `lts`, and the newest line they name is v20 (20.11.1)
    // even though the same package publishes 22.x and 24.x. So every reading of
    // those tags is wrong — the highest `v<N>-lts` is two LTS majors behind, and
    // its value is nine patches behind its own line. nodejs.org/dist/index.json
    // knows the answer and is exactly the second source §15.21 refuses.
    //
    // A literal is the honest remaining option, and it is the same kind of
    // literal as `default` above: human-reviewed, refreshed by §16.9's script,
    // and correct at the moment someone looked. Bare, for the reason `default`
    // is bare — node's artifact is per-host, so there is no portable digest.
    tags: { lts: "24.20.0" },
    fetchLatestFrom: { type: "npm", package: "node" },
    // Empty, and not an oversight: §01.4's transparency exists to let a
    // bootstrapping command escape §03.5's enforcement, and a runtime is never
    // enforced against in the first place. There is nothing to bypass.
    transparent: { commands: [] },
    // Required of a runtime (§02.3, §10.5), not a judgement call: `node` means
    // something outside a project on every machine that has ever had one.
    shimByDefault: false,
    // §15.40 — the file node's own ecosystem already writes the wanted version
    // into. `devEngines.runtime` outranks it and is the only field jup writes;
    // this is read, in the directories §03.1 was walking anyway, and only where
    // the manifest said nothing about the runtime.
    versionFile: { path: ".nvmrc", format: "nvm" },
    // One band. See {@link NODE_TARGETS} for why the map has not had to move.
    ranges: [["*", { ...NODE_BAND, targets: NODE_TARGETS }]],
  },
};

export const SUPPORTED_NAMES: readonly string[] = Object.keys(DEFINITIONS);

export function getDefinition(name: string): ToolDefinition | undefined {
  return Object.hasOwn(DEFINITIONS, name) ? DEFINITIONS[name] : undefined;
}

export function isSupportedPackageManager(name: string): boolean {
  return getDefinition(name) !== undefined;
}

/**
 * §02.3, §15.39 — what sort of tool this is. Absent in the table means
 * `"package-manager"`, which is every entry but `node`.
 */
export function toolKind(name: string): ToolKind {
  return getDefinition(name)?.kind ?? "package-manager";
}

/** §15.39 — is this entry a runtime? The four questions below are the only callers. */
export function isRuntime(name: string): boolean {
  return getDefinition(name)?.kind === "runtime";
}

/**
 * §03.1, §15.40 — the version file this entry declares, if it declares one.
 *
 * The only reader of the field, and the reason §03.1 can consult `.nvmrc`
 * without the string `.nvmrc` appearing outside this file.
 */
export function versionFileFor(name: string): VersionFileSpec | undefined {
  return getDefinition(name)?.versionFile;
}

/**
 * §03.3, §15.39 — which `devEngines` member speaks for this tool.
 *
 * Chosen by the requested tool's kind, never by what the manifest happens to
 * declare: a project may carry both members, and neither constrains the other.
 * An unknown name answers `"packageManager"`, because an unknown name is on its
 * way to §12.2's "unsupported specification" and must take the path it always
 * took to get there.
 */
export function devEnginesFieldFor(name: string): DevEnginesField {
  return isRuntime(name) ? "runtime" : "packageManager";
}

/**
 * §02.3 — reverse the ordered range list, first match wins, using
 * prerelease-tolerant satisfaction. `undefined` when no band covers the version.
 */
function findBand(definition: ToolDefinition, version: string): ToolSpec | undefined {
  for (let i = definition.ranges.length - 1; i >= 0; i--) {
    const entry = definition.ranges[i]!;
    if (satisfiesWithPrereleases(version, entry[0])) return entry[1];
  }
  return undefined;
}

/**
 * §15.17 — uncovered versions use the newest band's registry and URL, but not
 * its `bin`; {@link hasRangeBand} distinguishes declared and fallback bands.
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
 * §15.28 — the dynamic loader each libc puts at a fixed absolute path.
 *
 * Only the two architectures {@link ARCHITECTURES} normalises to are listed,
 * spelled the way the loader filenames spell them rather than the way Node does.
 */
const LIBC_LOADERS: Record<string, { musl: string; glibc: string }> = {
  arm64: { musl: "/lib/ld-musl-aarch64.so.1", glibc: "/lib/ld-linux-aarch64.so.1" },
  x64: { musl: "/lib/ld-musl-x86_64.so.1", glibc: "/lib64/ld-linux-x86-64.so.2" },
};

/**
 * §15.28 — is this Linux host musl or glibc?
 *
 * Linux is the one platform where the pair `<platform>-<arch>` does not name a
 * binary interface: a glibc build does not run on Alpine, and a publisher that
 * ships both says so in the artifact's name (`@endevco/aube-linux-x64-musl`,
 * `@oven/bun-linux-x64-musl`). Without this the tool would pick a glibc artifact
 * on a musl host, verify its signature, cache it, and hand the user a loader
 * error naming a `.so` they never asked about.
 *
 * **Both** loaders are checked, and musl wins only when it is the *only* one
 * present. Alpine has no glibc loader; a glibc distribution with `musl` merely
 * installed as a package has both, and is a glibc host. One `stat` each, and the
 * §16.3 cost is nil for the entries that are not per-host: the only callers are
 * a `targets` lookup and §15.23's per-host integrity map, neither of which npm,
 * pnpm or yarn ever reaches.
 *
 * Memoised by architecture rather than outright, because the suite reaches the
 * unsupported branches by redefining `process.arch` and a single cached answer
 * would outlive the pretence.
 *
 * A re-implementation MAY answer this any way its runtime allows — reading its
 * own ELF interpreter, or `ldd --version` — as long as the answer is about the
 * host rather than about the build machine.
 */
const LIBC_BY_ARCH = new Map<string, string>();

function linuxLibc(arch: string): string {
  const cached = LIBC_BY_ARCH.get(arch);
  if (cached !== undefined) return cached;

  const loaders = LIBC_LOADERS[arch];
  const libc =
    loaders !== undefined && existsSync(loaders.musl) && !existsSync(loaders.glibc)
      ? "musl"
      : "glibc";

  LIBC_BY_ARCH.set(arch, libc);
  return libc;
}

/**
 * §15.28 — the normalised name of this host: `<platform>-<arch>`, and on a musl
 * Linux `<platform>-<arch>-musl`.
 *
 * The key `targets` is indexed by, and the vocabulary `{platform}` and `{arch}`
 * draw on, so a band that uses either spelling agrees with one that uses the
 * other. An unrecognised half is passed through verbatim: the only consumer is
 * a `targets` lookup, which will miss and report the host it could not place,
 * and a made-up normalisation would only make that message wrong.
 *
 * glibc targets are unsuffixed; musl targets use the `-musl` suffix.
 */
export function hostTarget(): string {
  const platform = PLATFORMS[process.platform] ?? process.platform;
  const arch = ARCHITECTURES[process.arch] ?? process.arch;
  const pair = `${platform}-${arch}`;
  return platform === "linux" && linuxLibc(arch) === "musl" ? `${pair}-musl` : pair;
}

/**
 * `.exe` on Windows, empty everywhere else — what `{exe}` expands to in a band's
 * `bin` paths.
 *
 * Read once. `process.platform` cannot change within a process, and §16.3 counts
 * the work on the path `resolveSpecBin` sits on.
 */
const EXE = process.platform === "win32" ? ".exe" : "";

/**
 * §15.28 — what `{target}` expands to for this host, or an error naming the host.
 *
 * A band declaring `targets` is declaring the complete set of hosts that band
 * ships for, so a miss is a real answer — "bun 1.2.0 has no Windows arm64
 * build" — and it is worth more than the 404 the alternative produces. The set
 * is listed in the message because it is short and because the user's next move
 * depends on it.
 */
function targetFor(spec: ToolSpec, locator: Locator): string {
  const host = hostTarget();
  const target = spec.targets?.[host];
  if (target === undefined) {
    throw new UsageError(
      messages.unsupportedTarget(
        locator.name,
        locator.reference,
        host,
        Object.keys(spec.targets ?? {}).sort(),
      ),
    );
  }
  return target;
}

/**
 * §15.28 — substitute `{}`, `{platform}` and `{arch}` into a band's `url`.
 *
 * `{}` is always substituted; the host placeholders are opt-in per band. An
 * `includes` guard avoids unnecessary host resolution on the common path.
 *
 * An unrecognised platform or architecture is an error naming *which* half was
 * unrecognised. It is deliberately not a 404 later on: a URL that still contains
 * the literal `{arch}` blames the registry for the host's own unsupportedness.
 */
export function resolveSpecUrl(spec: ToolSpec, locator: Locator, version: string): string {
  const url = spec.url.replace("{}", version);

  const wantsTarget = url.includes("{target}");
  const wantsPlatform = url.includes("{platform}");
  const wantsArch = url.includes("{arch}");
  if (!wantsTarget && !wantsPlatform && !wantsArch) return url;

  let resolved = url;

  if (wantsTarget) {
    resolved = resolved.replaceAll("{target}", targetFor(spec, locator));
  }

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
 * Is this exact reference one the embedded table ships?
 *
 * Scopes §06.2's weak-algorithm warning. Every built-in default is currently
 * SHA-1-pinned (§02.5), so without this check a plain `yarn` in a
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

for (const [name, definition] of Object.entries(DEFINITIONS)) {
  const binNames = new Set<string>();
  for (const [, spec] of definition.ranges) {
    for (const binName of Object.keys(spec.bin)) {
      binNames.add(binName);
      if (!NAME_BY_BINARY.has(binName)) NAME_BY_BINARY.set(binName, name);
    }
  }
  BINARIES_BY_NAME.set(name, [...binNames]);
}
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

/**
 * Band -> the package manager that declares it.
 *
 * Needed because {@link resolveArtifactRegistry} mints a registry spec at call
 * time (the package name carries `{target}`) and has to enter it into
 * `NAME_BY_REGISTRY` under the right name, or §15.2's `JUP_REGISTRY_<NAME>`
 * would stop finding a native entry.
 */
const NAME_BY_SPEC = new Map<ToolSpec, string>();

for (const [name, definition] of Object.entries(DEFINITIONS)) {
  NAME_BY_REGISTRY.set(definition.fetchLatestFrom, name);
  for (const [, spec] of definition.ranges) {
    NAME_BY_SPEC.set(spec, name);
    NAME_BY_REGISTRY.set(spec.registry, name);
    if (spec.npmRegistry !== undefined) {
      NAME_BY_REGISTRY.set(spec.npmRegistry, name);
      NPM_ALTERNATIVE_BY_REGISTRY.set(spec.registry, spec.npmRegistry);
    }
  }
}

/** The package manager whose table entry declares this registry spec, if any. */
export function packageManagerForRegistry(spec: RegistrySpec): string | undefined {
  return NAME_BY_REGISTRY.get(spec);
}

/** Return the npm alternative declared by this spec, if any. None currently do. */
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
/**
 * Does this band's artifact differ from host to host?
 *
 * Three consequences hang off the answer, and all three are about a **digest
 * that is not portable**: `use` must not write one into `packageManager`
 * (§15.28), `jup.lock` must record one per host rather than one flat
 * (§15.23), and the install must not fold one into the locator's reference.
 *
 * Derived rather than declared, so a band cannot say one thing and do another:
 * anything that makes the URL or the artifact package host-dependent makes the
 * bytes host-dependent too.
 */
export function isPerHostSpec(spec: ToolSpec): boolean {
  if (spec.targets !== undefined || spec.artifactRegistry !== undefined) return true;
  return spec.url.includes("{platform}") || spec.url.includes("{arch}");
}

/** {@link isPerHostSpec} for a locator, `false` for a URL or an unknown name. */
export function isPerHost(locator: Locator): boolean {
  const spec = getTableSpec(locator);
  return spec !== undefined && isPerHostSpec(spec);
}

/**
 * §15.28 — a band's `bin` with `{exe}` substituted.
 *
 * Memoised on the band object: the table is static, the answer cannot change
 * within a process, and this is read on the install path for every native
 * entry. Every band declares a `BinSpec` of paths (§15.41 retired the list form),
 * so there is one shape to walk.
 */
const BIN_CACHE = new WeakMap<ToolSpec, BinSpec>();

export function resolveSpecBin(spec: ToolSpec): BinSpec {
  const cached = BIN_CACHE.get(spec);
  if (cached !== undefined) return cached;

  let resolved: BinSpec = spec.bin;
  const entries = Object.entries(spec.bin);
  if (entries.some(([, path]) => path.includes("{exe}"))) {
    resolved = Object.fromEntries(
      entries.map(([binName, path]) => [binName, path.replaceAll("{exe}", EXE)]),
    );
  }

  BIN_CACHE.set(spec, resolved);
  return resolved;
}

/**
 * §15.28 — the npm package this band's **artifact** is published as, with
 * `{target}`, `{platform}` and `{arch}` substituted, or `undefined` when the
 * band's own `registry` is already that package.
 *
 * Memoised for the same reason as `resolveSpecBin`, and additionally because the
 * result has to keep its **identity**: `packageManagerForRegistry` is a `Map`
 * lookup on the spec object, so minting a fresh one per call would lose §15.2's
 * per-package-manager registry override on exactly the entries that need it.
 */
const ARTIFACT_REGISTRY_CACHE = new WeakMap<ToolSpec, NpmRegistrySpec>();

export function resolveArtifactRegistry(
  spec: ToolSpec,
  locator: Locator,
): NpmRegistrySpec | undefined {
  const declared = spec.artifactRegistry;
  if (declared === undefined) return undefined;

  const cached = ARTIFACT_REGISTRY_CACHE.get(spec);
  if (cached !== undefined) return cached;

  let packageName = declared.package;
  if (packageName.includes("{target}")) {
    packageName = packageName.replaceAll("{target}", targetFor(spec, locator));
  }
  if (packageName.includes("{platform}") || packageName.includes("{arch}")) {
    const platform = PLATFORMS[process.platform];
    if (platform === undefined) {
      throw new UsageError(
        messages.unsupportedPlatform(locator.name, locator.reference, process.platform),
      );
    }
    const arch = ARCHITECTURES[process.arch];
    if (arch === undefined) {
      throw new UsageError(messages.unsupportedArch(locator.name, locator.reference, process.arch));
    }
    packageName = packageName.replaceAll("{platform}", platform).replaceAll("{arch}", arch);
  }

  const resolved: NpmRegistrySpec = { ...declared, package: packageName };
  ARTIFACT_REGISTRY_CACHE.set(spec, resolved);

  // Enter it under the name that declares the band, so §15.2 keeps working.
  const name = NAME_BY_SPEC.get(spec);
  if (name !== undefined) NAME_BY_REGISTRY.set(resolved, name);

  return resolved;
}

/**
 * §10.5 — whether a bare `jup enable` / `disable` covers this tool. Absent means yes.
 */
export function shimsByDefault(name: string): boolean {
  return getDefinition(name)?.shimByDefault !== false;
}
