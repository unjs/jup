/**
 * The §17.9 table fixture's own test — **not** a numbered row.
 *
 * Rows 208–233 are what §17.9 asks for; this file is what makes the ones marked
 * *(fixture)* able to fail. A seam that silently substituted nothing would leave
 * every role-sensitive row passing against the three package managers §02.5
 * already ships, which is exactly the "a mock that collapses two sources into
 * one cannot distinguish them" failure that survived a green suite once already.
 * So the four things the later steps rely on are proven here, in order:
 *
 * 1. the entries reach the spawned tool's table at all, with their roles;
 * 2. they resolve, download, verify and install through the mock registry, so a
 *    row can install a runtime the way it installs a package manager;
 * 3. an installed one runs, so a row can invoke a runtime's binary;
 * 4. **nothing** substitutes them without `run({ table })` — the seam is opt-in,
 *    which is what keeps it a test seam rather than the user-extensible registry
 *    §01.7 and §15.21 forbid.
 */

import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getRoles, hasRole } from "../../src/config/table.ts";
import {
  cleanupFixtures,
  createFixture,
  DUAL_TOOL,
  FIXTURE_TOOLS,
  FIXTURE_VERSION,
  MockRegistry,
  packageManagerTarball,
  REPO_ROOT,
  run,
  RUNTIME_TOOL,
  useFixtureTable,
} from "./_harness/index.ts";

const registry = new MockRegistry();

/** The mock's key is not a compiled-in one, so every row has to trust it (§06.3). */
function trusted(extra?: Record<string, string | undefined>): Record<string, string | undefined> {
  return { COREPACK_INTEGRITY_KEYS: registry.trustStore(), ...extra };
}

beforeAll(async () => {
  useFixtureTable();
  await registry.start();

  for (const name of [RUNTIME_TOOL, DUAL_TOOL]) {
    registry.publish(name, FIXTURE_VERSION, packageManagerTarball(name, FIXTURE_VERSION), {
      distTags: { latest: FIXTURE_VERSION },
    });
  }
});

afterAll(async () => {
  cleanupFixtures();
  await registry.stop();
});

beforeEach(() => registry.reset());

describe("§17.9 the test-only table fixture", () => {
  it("carries a runtime-only tool and a dual-role tool, as data", () => {
    expect(getRoles(RUNTIME_TOOL)).toEqual(["runtime"]);
    expect(hasRole(RUNTIME_TOOL, "runtime")).toBe(true);
    expect(hasRole(RUNTIME_TOOL, "package-manager")).toBe(false);

    // R1: one entry with two roles, not two entries — so one name, one store
    // directory, one recorded default.
    expect(getRoles(DUAL_TOOL)).toEqual(["package-manager", "runtime"]);
    expect(hasRole(DUAL_TOOL, "package-manager")).toBe(true);
    expect(hasRole(DUAL_TOOL, "runtime")).toBe(true);

    // The built-in three are untouched by the merge (§17.3: every §02.5 entry is
    // valid unchanged with `roles: ["package-manager"]`).
    for (const name of ["npm", "pnpm", "yarn"]) {
      expect(getRoles(name)).toEqual(["package-manager"]);
    }
  });

  it("substitutes the table of the spawned tool, not only of this process", async () => {
    const fixture = createFixture();

    const result = await run(["info", "--json"], { ...fixture, table: FIXTURE_TOOLS });

    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout) as { packageManagers: { name: string }[] };
    const names = report.packageManagers.map((entry) => entry.name);
    // Both fixtures *and* the built-in three: a substitution that replaced the
    // table rather than merging into it would break every other row's fixtures.
    expect(names).toEqual(expect.arrayContaining([RUNTIME_TOOL, DUAL_TOOL, "npm", "pnpm", "yarn"]));
  });

  it("installs a runtime-role tool through the mock registry", async () => {
    const fixture = createFixture();

    const result = await run(["install", "-g", `${RUNTIME_TOOL}@${FIXTURE_VERSION}`], {
      ...fixture,
      registry,
      table: FIXTURE_TOOLS,
      env: trusted(),
    });

    expect(result.stderr).not.toContain("Usage Error");
    expect(result.exitCode).toBe(0);
    // §07.2's layout, and the request that filled it: nothing here is
    // package-manager-specific, which is §17.2's "the machinery already
    // generalises" stated as a test.
    expect(existsSync(join(fixture.home, "v1", RUNTIME_TOOL, FIXTURE_VERSION, ".corepack"))).toBe(
      true,
    );
    expect(registry.requests.map((request) => request.path)).toContain(
      `/${RUNTIME_TOOL}/${FIXTURE_VERSION}`,
    );
  });

  it("runs a dual-role tool a project pins, downloading it on the way", async () => {
    const fixture = createFixture({
      name: "app",
      packageManager: `${DUAL_TOOL}@${FIXTURE_VERSION}`,
    });

    const result = await run([DUAL_TOOL, "--version"], {
      ...fixture,
      registry,
      table: FIXTURE_TOOLS,
      env: trusted(),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${FIXTURE_VERSION}\n`);
  });

  it("is opt-in: a run that asks for no table has never heard of the fixtures", async () => {
    const fixture = createFixture();

    // Same environment, same mock, no `table` — and the name is unknown. This is
    // the assertion that makes the seam a seam: `JUP_TEST_TABLE` alone does
    // nothing, because `run()` is what loads the preload that reads it.
    const result = await run([`${RUNTIME_TOOL}@${FIXTURE_VERSION}`, "--version"], {
      ...fixture,
      registry,
      env: trusted({ JUP_TEST_TABLE: JSON.stringify({ module: "", tools: FIXTURE_TOOLS }) }),
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      `Unsupported package manager specification (${RUNTIME_TOOL}@${FIXTURE_VERSION})`,
    );
  });

  it("is reachable from no shipped code: `src/` never reads the variable", async () => {
    const sources = await walk(join(REPO_ROOT, "src"));
    expect(sources.length).toBeGreaterThan(0);

    for (const file of sources) {
      // §01.7 and §15.21 forbid a user-supplied table. The preload is the only
      // reader of `JUP_TEST_TABLE` anywhere, and it lives under `test/`.
      expect(await readFile(file, "utf8")).not.toContain("JUP_TEST_TABLE");
    }
  });
});

/** Every file under `directory`, recursively. */
async function walk(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await walk(path)));
    else found.push(path);
  }
  return found;
}
