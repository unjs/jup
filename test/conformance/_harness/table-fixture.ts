/**
 * §17.9's test-only table fixture: a table carrying one `roles: ["runtime"]`
 * tool and one dual-role tool, served by the same mock registry as every other
 * row.
 *
 * §02.5 ships no runtime, so every role-sensitive requirement — R4's
 * enforcement row, R9, R10 row 2, R11, C5 — is vacuously satisfied by an
 * implementation that ignores roles entirely. These two entries are what make
 * those rows able to fail.
 *
 * **This is a test seam, not the user-extensible registry §01.7 and §15.21
 * forbid.** The substitution happens in two places, neither of which a released
 * binary contains:
 *
 * * in the *test* process, {@link useFixtureTable} mutates the table module the
 *   fixture helpers import, so `packageManagerTarball` and `seedPackageManager`
 *   can build artifacts with the fixture's own `bin` layout;
 * * in the *spawned* process, `run({ table })` hands the same entries to
 *   `table-preload.ts` through `JUP_TEST_TABLE` — a `--import` module under
 *   `test/`, read by nothing in `src/` and shipped in no package.
 *
 * The environment variable is therefore not an extension mechanism: it is inert
 * unless the harness's own preload is loaded, `run()` is what loads it, and
 * `cleanEnv()` strips the variable from an inherited environment so a developer
 * cannot even accidentally set it for a row that did not ask.
 *
 * The names are deliberately unusable as anything else. §17.4 R8 requires
 * `NAMES`, `SCOPE_WORDS` (`pm`, `package-manager`, `rt`, `runtime`), the §09
 * verbs and `RESERVED` (`run`, `exec`, `shim`, `self`, `doctor`, `env`, `list`,
 * `ls`, `which`, `clean`, `add`, `remove`, `init`, `version`, `node`, `deno`,
 * `bun`) to be pairwise disjoint, asserted at build time — so a fixture named
 * `runtime` or `node` would fail that assertion rather than exercise it.
 */

import { DEFINITIONS, reindexTable } from "../../../src/config/table.ts";
import type { Role, Tool } from "../../../src/types.ts";

/** Entries to merge into the table, keyed by tool name. */
export type FixtureTable = Record<string, Tool>;

/** The runtime-only fixture tool (§17.9 rows 222–226, 230). */
export const RUNTIME_TOOL = "fixture-runtime";

/** The dual-role fixture tool: one entry, two roles, one store directory (R1). */
export const DUAL_TOOL = "fixture-dual";

/** The version each fixture tool publishes by default. */
export const FIXTURE_VERSION = "1.0.0";

/**
 * A table entry shaped like `pnpm`'s: an npm-protocol registry, one band
 * covering everything, and a `bin` map naming a `.js` entry point.
 *
 * The host is `registry.npmjs.org` because `intercept.ts` rewrites exactly that
 * host onto the mock, which keeps the fixture on `https:` and clear of §14.9's
 * and §05.2's rewriting rules.
 *
 * `commands.use` is a package-manager concept (§17.7 #6), so only an entry with
 * that role declares one — the difference between the two fixtures is data the
 * table already knew how to express, which is R3's point.
 */
function fixtureTool(name: string, roles: Role[]): Tool {
  const registry = { type: "npm", package: name } as const;
  return {
    roles,
    default: FIXTURE_VERSION,
    fetchLatestFrom: registry,
    transparent: { commands: [] },
    ranges: [
      [
        "*",
        {
          url: `https://registry.npmjs.org/${name}/-/${name}-{}.tgz`,
          bin: { [name]: `./bin/${name}.js` },
          registry,
          ...(roles.includes("package-manager") ? { commands: { use: [name, "install"] } } : {}),
        },
      ],
    ],
  };
}

/** Both fixture tools, which is what a row wanting "a runtime exists" asks for. */
export const FIXTURE_TOOLS: FixtureTable = {
  [RUNTIME_TOOL]: fixtureTool(RUNTIME_TOOL, ["runtime"]),
  [DUAL_TOOL]: fixtureTool(DUAL_TOOL, ["package-manager", "runtime"]),
};

/**
 * Merge `tools` into **this** process's table and re-derive its indexes.
 *
 * Call it from a `beforeAll` and pass the same entries to `run({ table })`: the
 * test process needs them so `packageManagerTarball` and `seedPackageManager`
 * read the fixture's `bin` layout out of the table rather than being told it
 * twice, and the spawned process needs them because it is a different process.
 *
 * Merging, not replacing, so the built-in three stay reachable; an entry whose
 * name is already in the table overrides it, which is how a row that wants a
 * *different* `npm` gets one. Vitest isolates a module registry per test file,
 * so there is nothing to undo afterwards.
 */
export function useFixtureTable(tools: FixtureTable = FIXTURE_TOOLS): FixtureTable {
  Object.assign(DEFINITIONS, tools);
  reindexTable();
  return tools;
}
