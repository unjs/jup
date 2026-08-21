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
import { satisfiesWithPrereleases } from "../semver.ts";
import type { PackageManagerDefinition, PackageManagerSpec } from "../types.ts";

export const DEFINITIONS: Record<string, PackageManagerDefinition> = {
  npm: {
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
    // §02.5, §14.21: `default` is Yarn 1.x while `transparent.default` is Yarn 4.x.
    // The asymmetry is intentional — bare `yarn` behaves like the classic global
    // yarn, while `yarn dlx`, which classic yarn lacks, gets a modern release.
    default: "1.22.22+sha1.ac34549e6aa8e7ead463a7407e1c7390f61a6610",
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

export const SUPPORTED_NAMES: readonly string[] = Object.keys(DEFINITIONS);

export function getDefinition(name: string): PackageManagerDefinition | undefined {
  return Object.hasOwn(DEFINITIONS, name) ? DEFINITIONS[name] : undefined;
}

export function isSupportedPackageManager(name: string): boolean {
  return getDefinition(name) !== undefined;
}

/**
 * §02.3 — reverse the ordered range list and return the first spec whose range
 * the version satisfies, using prerelease-tolerant satisfaction. No match is an
 * internal assertion failure, not a user error.
 */
export function getSpecFor(name: string, version: string): PackageManagerSpec {
  const definition = getDefinition(name);
  if (definition === undefined) throw new UsageError(messages.unsupportedByBuild(name));

  for (let i = definition.ranges.length - 1; i >= 0; i--) {
    const entry = definition.ranges[i]!;
    if (satisfiesWithPrereleases(version, entry[0])) return entry[1];
  }

  throw new Error(
    messages.noRangeBand(
      version,
      definition.ranges.map(([range]) => range),
    ),
  );
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
    for (const binName of Array.isArray(spec.bin) ? spec.bin : Object.keys(spec.bin)) {
      binNames.add(binName);
      if (!NAME_BY_BINARY.has(binName)) NAME_BY_BINARY.set(binName, name);
    }
  }
  BINARIES_BY_NAME.set(name, [...binNames]);
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
