/**
 * §15.25 — symmetric manifest-walk stop conditions (rows 187–188).
 *
 * Corepack's loop condition is `!selection || !selection.data.packageManager`,
 * so only one of the two package-manager fields halts the climb (#779, fix PR
 * #811 open and unmerged). A nested project declaring `devEngines.packageManager`
 * is walked straight past, and a parent's spec — or the machine default —
 * silently wins.
 *
 * Both rows are built so the old behaviour and the new one give visibly
 * different answers: the ancestor always declares a *different* package manager,
 * so "the walk kept climbing" is never mistakable for "the walk stopped".
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cleanupFixtures, createFixture, run, seedPackageManager } from "./_harness/index.ts";

afterAll(cleanupFixtures);

/** A manifest in an *ancestor* of the fixture's project directory. */
function ancestorManifest(fixture: { root: string }, data: unknown): void {
  writeFileSync(join(fixture.root, "package.json"), `${JSON.stringify(data, undefined, 2)}\n`);
}

describe("§15.25 walk stop conditions", () => {
  it("187: a devEngines-only manifest stops the walk; the parent's pin does not win", async () => {
    const fixture = createFixture({
      name: "nested",
      devEngines: { packageManager: { name: "pnpm", version: "11.1.2" } },
    });
    // Without the fix the walk climbs past the nested manifest, selects this one,
    // and `pnpm --version` fails §03.5's name check against yarn.
    ancestorManifest(fixture, { name: "root", packageManager: "yarn@1.22.4" });

    seedPackageManager(fixture.home, "pnpm", "11.1.2");
    seedPackageManager(fixture.home, "yarn", "1.22.4");

    const result = await run(["pnpm", "--version"], fixture);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("11.1.2\n");
    expect(result.stderr).toBe("");
  });

  it("187: and the ancestor's own package manager is no longer reachable from there", async () => {
    const fixture = createFixture({
      name: "nested",
      devEngines: { packageManager: { name: "pnpm", version: "11.1.2" } },
    });
    ancestorManifest(fixture, { name: "root", packageManager: "yarn@1.22.4" });
    seedPackageManager(fixture.home, "yarn", "1.22.4");

    const result = await run(["yarn", "--version"], fixture);

    // The nested project declares pnpm, so running yarn inside it is §12.5's
    // error — the same one a nested `packageManager` field has always produced.
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("This project is configured to use pnpm because");
    expect(result.stderr).toContain(fixture.path("package.json"));
  });

  it("188: `packageManager: null` stops the walk and is a parse error, not 'absent'", async () => {
    const fixture = createFixture({ name: "nested", packageManager: null });
    ancestorManifest(fixture, { name: "root", packageManager: "yarn@1.22.4" });
    seedPackageManager(fixture.home, "yarn", "1.22.4");

    const result = await run(["yarn", "--version"], fixture);

    expect(result.exitCode).toBe(1);
    // "declared but invalid": §12.2's non-string message, naming the *nested*
    // manifest. Treated as absent, the run would silently have used the
    // ancestor's yarn@1.22.4 and printed `1.22.4`.
    expect(result.stderr).toBe(
      `Invalid package manager specification in package.json; expected a string\n`,
    );
    expect(result.stdout).toBe("");
  });

  it("188: an empty `devEngines.packageManager` is absent, and the walk continues", async () => {
    // The counterpart the rule must not over-reach into: `devEngines: {}` and
    // `devEngines.packageManager: null` declare nothing at all (§03.3 returns
    // `pm` for both), so treating them as stop conditions would strand a project
    // that legitimately inherits its ancestor's pin.
    const fixture = createFixture({ name: "nested", devEngines: { packageManager: null } });
    ancestorManifest(fixture, { name: "root", packageManager: "yarn@1.22.4" });
    seedPackageManager(fixture.home, "yarn", "1.22.4");

    const result = await run(["yarn", "--version"], fixture);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("1.22.4\n");
  });

  it("187: a vendored devEngines declaration still cannot hijack its host", async () => {
    // §03.1 step 1 runs before the stop condition, so widening the latter must
    // not widen the former.
    const fixture = createFixture({ packageManager: "yarn@1.22.4" });
    mkdirSync(fixture.path("node_modules/dep"), { recursive: true });
    fixture.write(
      "node_modules/dep/package.json",
      `{"devEngines":{"packageManager":{"name":"pnpm","version":"11.1.2"}}}\n`,
    );
    seedPackageManager(fixture.home, "yarn", "1.22.4");

    const result = await run(["yarn", "--version"], {
      ...fixture,
      cwd: fixture.path("node_modules/dep"),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("1.22.4\n");
  });
});
