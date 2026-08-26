/**
 * §15.24 — a prerelease never wins implicit resolution (rows 184–186).
 *
 * The defect recurs on every package-manager prerelease cycle (#473, and its
 * duplicate #774, both open with no maintainer response in roughly two years):
 * `satisfiesWithPrereleases` strips the prerelease tag before testing, so
 * `11.0.0-dev.1005` satisfies `*`, `rcompare` sorts it above every stable
 * release, and `corepack use pnpm` installs a dev build.
 *
 * The hazard §15.24 warns about is a test that cannot tell the bug from the fix,
 * so every row here publishes **both** a stable release and a higher prerelease
 * and asserts which one came back. A fixture with only stable versions would
 * pass whether or not the filter exists.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupFixtures,
  createFixture,
  MockRegistry,
  packageManagerTarball,
  run,
} from "./_harness/index.ts";

const registry = new MockRegistry();

function env(extra?: Record<string, string | undefined>): Record<string, string | undefined> {
  return { COREPACK_INTEGRITY_KEYS: registry.trustStore(), CI: undefined, ...extra };
}

function pinOf(fixture: { json(relative: string): unknown }): string | undefined {
  return (fixture.json("package.json") as { packageManager?: string }).packageManager;
}

beforeAll(async () => {
  await registry.start();

  // The exact shape of #774: a stable line, and a dev build that is the semver
  // maximum of everything published.
  for (const version of ["10.5.0", "11.1.2", "11.2.0-dev.1005"]) {
    registry.publish("pnpm", version, packageManagerTarball("pnpm", version), {
      // `latest` deliberately points at the stable release, as npm's own does
      // for a prerelease publish — the dist-tag is the publisher's statement.
      distTags: { latest: "11.1.2", next: "11.2.0-dev.1005" },
    });
  }
});

afterAll(async () => {
  cleanupFixtures();
  await registry.stop();
});

beforeEach(() => registry.reset());

describe("§15.24 prereleases in implicit resolution", () => {
  it("184: `use pnpm` resolves to the stable release, not the higher prerelease", async () => {
    const fixture = createFixture({ name: "project" });

    const result = await run(["use", "pnpm"], { ...fixture, registry, env: env() });

    expect(result.exitCode).toBe(0);
    expect(pinOf(fixture)).toMatch(/^pnpm@11\.1\.2\+sha512\./);
  });

  it("184: a bare range does the same — `pnpm@>=11` skips 11.2.0-dev.1005", async () => {
    const fixture = createFixture({ name: "project" });

    const result = await run(["use", "pnpm@>=11"], { ...fixture, registry, env: env() });

    expect(result.exitCode).toBe(0);
    expect(pinOf(fixture)).toMatch(/^pnpm@11\.1\.2\+sha512\./);
  });

  it("184: takes the semver maximum, not `latest` — §15.24's SHOULD is not implemented", async () => {
    // The §15 audit's finding about this row, made explicit rather than left as
    // a blind spot: rows 184 above cannot tell "resolved via the `latest`
    // dist-tag" from "took the stable semver maximum", because the fixture's
    // `latest` *is* its stable maximum. This row separates them by publishing a
    // `latest` that points at an older release than the stable maximum.
    //
    // §15.24 says a bare name SHOULD resolve via `latest`. It deliberately does
    // not here: §04.1 step 6 unions candidates across *every* range band, while
    // a dist-tag is resolved against the last band's registry only — so honouring
    // the SHOULD for `yarn` would silently drop every Yarn Classic candidate.
    // That trade is recorded in `.agents/PLAN.md`; this row is what makes
    // changing the decision a deliberate act rather than an accident.
    const scoped = new MockRegistry();
    await scoped.start();
    try {
      for (const version of ["11.0.0", "11.1.2"]) {
        scoped.publish("pnpm", version, packageManagerTarball("pnpm", version), {
          distTags: { latest: "11.0.0" },
        });
      }

      const fixture = createFixture({ name: "project" });
      const result = await run(["use", "pnpm"], {
        ...fixture,
        registry: scoped,
        env: { COREPACK_INTEGRITY_KEYS: scoped.trustStore(), CI: undefined },
      });

      expect(result.exitCode).toBe(0);
      // 11.1.2, the semver maximum — *not* 11.0.0, which `latest` names.
      expect(pinOf(fixture)).toMatch(/^pnpm@11\.1\.2\+sha512\./);
    } finally {
      await scoped.stop();
    }
  });

  it("185: COREPACK_ENABLE_PRERELEASES=1 opts back in", async () => {
    const fixture = createFixture({ name: "project" });

    const result = await run(["use", "pnpm"], {
      ...fixture,
      registry,
      env: env({ COREPACK_ENABLE_PRERELEASES: "1" }),
    });

    expect(result.exitCode).toBe(0);
    expect(pinOf(fixture)).toMatch(/^pnpm@11\.2\.0-dev\.1005\+sha512\./);
  });

  it("185: and it is env-file eligible, so a project can opt in for itself", async () => {
    // §15.37 marks it eligible, and eligibility is a deny-list, so nothing had to
    // be registered for this to work. Asserted through the proxy path because
    // that is where §03.2's walk loads the file (`corepack use` takes its spec
    // from the command line and never walks — see the note in the report).
    const fixture = createFixture({ name: "project", packageManager: "pnpm@>=11" });
    fixture.write(".jup.env", "COREPACK_ENABLE_PRERELEASES=1\n");

    const result = await run(["pnpm", "--version"], { ...fixture, registry, env: env() });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("11.2.0-dev.1005\n");
  });

  it("186: an explicitly pinned prerelease still resolves and matches its band", async () => {
    const fixture = createFixture({ name: "project" });

    // §04.1 step 5 returns an exact version before the range query runs, and
    // §02.3's band lookup keeps the lenient rule — which is what puts
    // `11.2.0-dev.1005` in the `>=11.0.0` band and gives it the right `bin`.
    const result = await run(["use", "pnpm@11.2.0-dev.1005"], {
      ...fixture,
      registry,
      env: env(),
    });

    expect(result.exitCode).toBe(0);
    expect(pinOf(fixture)).toMatch(/^pnpm@11\.2\.0-dev\.1005\+sha512\./);
  });

  it("186: a range that itself names a prerelease re-admits one", async () => {
    const fixture = createFixture({ name: "project" });

    // "unless the range itself names a prerelease": the user asked for the
    // prerelease band explicitly, so nothing is being chosen on their behalf.
    const result = await run(["use", "pnpm@>=11.0.0-0"], { ...fixture, registry, env: env() });

    expect(result.exitCode).toBe(0);
    expect(pinOf(fixture)).toMatch(/^pnpm@11\.2\.0-dev\.1005\+sha512\./);
  });

  it("186: a pinned prerelease keeps running from the cache on later runs", async () => {
    const fixture = createFixture({ name: "project" });

    expect(
      (await run(["use", "pnpm@11.2.0-dev.1005"], { ...fixture, registry, env: env() })).exitCode,
    ).toBe(0);

    // §14.2's cache probe keeps the lenient rule too, so the second run answers
    // from the store rather than going back to the registry.
    registry.reset();
    const again = await run(["pnpm", "--version"], { ...fixture, registry, env: env() });

    expect(again.exitCode).toBe(0);
    expect(again.stdout).toBe("11.2.0-dev.1005\n");
    expect(registry.requests).toEqual([]);
  });
});
