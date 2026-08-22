/**
 * §15.35e — `COREPACK_MINIMUM_RELEASE_AGE` (row 203). **Not implemented.**
 *
 * The row is skipped rather than absent, because "no test" and "no feature" look
 * identical in a green suite and only one of them is a conformance failure.
 *
 * ## What is missing
 *
 * `COREPACK_MINIMUM_RELEASE_AGE` appears nowhere in `src/`. That is the small
 * half. The structural half is that the tool has no way to *learn* a version's
 * publish time:
 *
 * 1. `fetchAvailableVersions` (`src/registry.ts`) returns `string[]` — the keys
 *    of the packument's `versions` object, with every other field dropped. §04.1
 *    step 6 filters that list by range and takes the semver maximum
 *    (`src/resolve.ts`), so there is nothing for an age filter to read.
 * 2. The npm request asks for the **abbreviated** packument —
 *    `application/vnd.npm.install-v1+json` (`src/registry.ts`, `NPM_ACCEPT_HEADER`)
 *    — and that document deliberately carries no `time` map. The full packument
 *    does, and it is an order of magnitude larger; §15.5's and §01.3's budgets
 *    are the reason the abbreviated form was chosen, so switching wholesale is a
 *    cost decision, not a typo fix.
 * 3. `url`-typed registries (Yarn Berry's `/tags` document, §05.3) publish no
 *    times at all, so §15.35e has to say what happens for them — filter nothing,
 *    or refuse. This spec does not currently say.
 *
 * ## What would unblock it
 *
 * * A `fetchVersionTimes` (or a `fetchAvailableVersions` that returns
 *   `{ version, time }`) reading `time[<version>]` from the npm packument,
 *   fetched from the full document or from the per-version endpoint.
 * * A `time` map in the mock registry (`test/conformance/_harness/registry.ts`),
 *   which is what `publishedAt` below stands in for. It is an **additive**
 *   harness change: a new optional `publish` option plus a `time` key in the
 *   served packument.
 * * `COREPACK_MINIMUM_RELEASE_AGE` (hours) read in §04.1 step 6 only — §15.35e
 *   says an explicitly pinned exact version is never filtered, and step 5
 *   returns before step 6 is reached, so the third row below should hold with no
 *   extra code.
 *
 * Un-skip this file once those exist; `publishedAt` throws until then, so a
 * premature un-skip fails loudly instead of passing vacuously.
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

/** The published-a-month-ago release, and the one published an hour ago. */
const SETTLED = "11.1.2";
const FRESH = "11.2.0";

const HOUR = 60 * 60 * 1000;

/**
 * Publish `version` with a registry-recorded publish time.
 *
 * The mock has no `time` map yet, so this is the single line standing between
 * this file and a running row. Throwing rather than silently ignoring the time
 * is deliberate: a version of this helper that dropped its second argument would
 * make every row below pass against an implementation that ignores
 * `COREPACK_MINIMUM_RELEASE_AGE` entirely, which is exactly the shape of
 * coverage that is worse than none.
 */
function publishedAt(version: string, _time: Date): void {
  registry.publish("pnpm", version, packageManagerTarball("pnpm", version));
  throw new Error(
    "§15.35e is not implemented: the mock registry cannot record a publish time, " +
      "and the abbreviated packument the client requests carries no `time` map",
  );
}

beforeAll(async () => {
  await registry.start();
});

afterAll(async () => {
  cleanupFixtures();
  await registry.stop();
});

beforeEach(() => registry.reset());

function env(extra?: Record<string, string | undefined>): Record<string, string | undefined> {
  return { COREPACK_INTEGRITY_KEYS: registry.trustStore(), CI: undefined, ...extra };
}

describe.skip("§15.35e COREPACK_MINIMUM_RELEASE_AGE (not implemented)", () => {
  beforeEach(() => {
    const now = Date.now();
    publishedAt(SETTLED, new Date(now - 30 * 24 * HOUR));
    publishedAt(FRESH, new Date(now - 1 * HOUR));
    registry.publish("pnpm", FRESH, packageManagerTarball("pnpm", FRESH), {
      distTags: { latest: FRESH },
    });
  });

  it("203: a release younger than the age is filtered out of implicit resolution", async () => {
    const fixture = createFixture({ name: "app", packageManager: "pnpm@^11.0.0" });

    const result = await run(["pnpm", "--version"], {
      ...fixture,
      registry,
      env: env({ COREPACK_MINIMUM_RELEASE_AGE: "24" }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${SETTLED}\n`);
  });

  it("203: without the variable the newest release still wins", async () => {
    // The control. Without it the row cannot tell "the fresh release was
    // filtered" from "the fresh release was never a candidate".
    const fixture = createFixture({ name: "app", packageManager: "pnpm@^11.0.0" });

    const result = await run(["pnpm", "--version"], { ...fixture, registry, env: env() });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${FRESH}\n`);
  });

  it("203: an exact pin is never filtered, however young it is", async () => {
    const fixture = createFixture({ name: "app", packageManager: `pnpm@${FRESH}` });

    const result = await run(["pnpm", "--version"], {
      ...fixture,
      registry,
      env: env({ COREPACK_MINIMUM_RELEASE_AGE: "24" }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${FRESH}\n`);
  });

  it("203: `use` and `up` obey it too — they are implicit resolution", async () => {
    const fixture = createFixture({ name: "app" });

    const result = await run(["use", "pnpm"], {
      ...fixture,
      registry,
      env: env({ COREPACK_MINIMUM_RELEASE_AGE: "24" }),
    });

    expect(result.exitCode).toBe(0);
    expect((fixture.json("package.json") as { packageManager: string }).packageManager).toContain(
      `pnpm@${SETTLED}`,
    );
  });
});
