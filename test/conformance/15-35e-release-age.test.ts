/**
 * §04.1 — `COREPACK_MINIMUM_RELEASE_AGE` (row 203).
 *
 * The gate exists to stop a freshly-published, compromised release being picked
 * up within minutes of publication, and it is the same `minimumReleaseAge`
 * npm and pnpm now ship. Three things decide where it applies:
 *
 * * §04.1 **step 6** is implicit resolution — nobody chose the version — so the
 *   gate filters its candidate set.
 * * §04.1 **step 3**'s dist-tag is the *registry* choosing on the user's behalf,
 *   which is exactly what a fresh malicious publish subverts, so the tag's
 *   target is capped rather than trusted.
 * * §04.1 **step 5**'s exact version is never filtered — the text says so
 *   outright — and it returns before either of the above runs.
 *
 * ## The two fixtures that would make this file worthless
 *
 * Both are avoided deliberately, because §13's whole point is that a test which
 * cannot distinguish the bug from the fix is worse than no test:
 *
 * 1. **A fixture whose filtered and unfiltered answers coincide.** Every row
 *    below publishes a `FRESH` release that is the semver maximum *and* the
 *    `latest` dist-tag, so "the gate did nothing" and "the gate worked" produce
 *    different versions. The unset control asserts `FRESH`; the gated rows
 *    assert `SETTLED`.
 * 2. **A "costs nothing when unset" row that would pass even if the extra
 *    request were always made.** The row below compares the *exact* request log
 *    of a gated and an ungated run and asserts the `Accept` header of every one
 *    of them — and the mock serves `time` **only** to a client that actually
 *    asked for the full document, so an implementation that forgot to switch its
 *    header fails the age rows rather than passing them.
 *
 * **The `undated source fails closed` rows are gone.** They asserted the other
 * half of blocker 3 — that a source publishing no dates refuses under the gate
 * rather than resolving unchecked — against `repo.yarnpkg.com`'s `/tags`
 * document, the table's only url-type registry. §02.5 moved Yarn Berry onto
 * `@yarnpkg/cli-dist`, so every source the table names is an npm packument with
 * a `time` field and nothing reachable can be undated. `undatedSourceError` and
 * the branch that raises it are still there for a band that is not an npm
 * registry; there is simply no longer one to point a row at.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NPM_ACCEPT_HEADER, NPM_FULL_ACCEPT_HEADER } from "../../src/net/registry.ts";
import {
  cleanupFixtures,
  createFixture,
  MockRegistry,
  packageManagerTarball,
  run,
  seedPackageManager,
} from "./_harness/index.ts";

const registry = new MockRegistry();

/** The published-a-month-ago release, and the one published an hour ago. */
const SETTLED = "11.1.2";
const FRESH = "11.2.0";

const HOUR = 60 * 60 * 1000;

/** Yarn Classic, so the `<2.0.0` band has something dated to answer with. */
const YARN_CLASSIC = "1.22.4";

beforeAll(async () => {
  await registry.start();

  const now = Date.now();
  registry.publish("pnpm", SETTLED, packageManagerTarball("pnpm", SETTLED), {
    time: new Date(now - 30 * 24 * HOUR),
  });
  // The fresh one is both the semver maximum and `latest`, so no row below can
  // pass by accident: the two answers are always different versions.
  registry.publish("pnpm", FRESH, packageManagerTarball("pnpm", FRESH), {
    distTags: { latest: FRESH },
    time: new Date(now - 1 * HOUR),
  });

  registry.publish("yarn", YARN_CLASSIC, packageManagerTarball("yarn", YARN_CLASSIC), {
    distTags: { latest: YARN_CLASSIC },
    time: new Date(now - 365 * 24 * HOUR),
  });
});

afterAll(async () => {
  cleanupFixtures();
  await registry.stop();
});

beforeEach(() => registry.reset());

function env(extra?: Record<string, string | undefined>): Record<string, string | undefined> {
  return { COREPACK_INTEGRITY_KEYS: registry.trustStore(), CI: undefined, ...extra };
}

function pinOf(fixture: { json(relative: string): unknown }): string | undefined {
  return (fixture.json("package.json") as { packageManager?: string }).packageManager;
}

describe("§04.1 COREPACK_MINIMUM_RELEASE_AGE", () => {
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

  it("203: an exact pin is exempt in §04.1 itself, not only in the warm fast path", async () => {
    // The row above goes through `main.ts`'s `resolveExactPin`, which answers an
    // exact version from a single `stat` and never loads `resolve.ts` at all —
    // so on its own it cannot tell "§04.1 step 5 returns before the gate" from
    // "the gate is simply unreachable on that path". `use` has no such fast
    // path: it calls `resolveDescriptor` directly, so this row is what pins the
    // exemption where §04.1 puts it.
    const fixture = createFixture({ name: "app" });

    const result = await run(["use", `pnpm@${FRESH}`], {
      ...fixture,
      registry,
      env: env({ COREPACK_MINIMUM_RELEASE_AGE: "24" }),
    });

    expect(result.exitCode).toBe(0);
    expect(pinOf(fixture)).toContain(`pnpm@${FRESH}`);
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

  it("203: an explicit dist-tag is capped, not trusted", async () => {
    // `latest` points at FRESH. A tag is not an exact pin — the user named a
    // channel and let the registry decide what is in it — so §04.1 applies and
    // the target is capped at the newest release old enough to be chosen.
    const fixture = createFixture({ name: "app" });

    const result = await run(["use", "pnpm@latest"], {
      ...fixture,
      registry,
      env: env({ COREPACK_MINIMUM_RELEASE_AGE: "24" }),
    });

    expect(result.exitCode).toBe(0);
    expect(pinOf(fixture)).toContain(`pnpm@${SETTLED}`);
  });

  it("203: the same dist-tag resolves to the fresh release without the variable", async () => {
    const fixture = createFixture({ name: "app" });

    const result = await run(["use", "pnpm@latest"], { ...fixture, registry, env: env() });

    expect(result.exitCode).toBe(0);
    expect(pinOf(fixture)).toContain(`pnpm@${FRESH}`);
  });

  it("203: `0` and an empty value mean no minimum, as npm and pnpm spell it", async () => {
    for (const value of ["0", ""]) {
      const fixture = createFixture({ name: "app", packageManager: "pnpm@^11.0.0" });

      const result = await run(["pnpm", "--version"], {
        ...fixture,
        registry,
        env: env({ COREPACK_MINIMUM_RELEASE_AGE: value }),
      });

      expect(result.exitCode, `COREPACK_MINIMUM_RELEASE_AGE=${JSON.stringify(value)}`).toBe(0);
      expect(result.stdout).toBe(`${FRESH}\n`);
    }
  });

  it("203: an unparseable or negative value is refused, never silently ignored", async () => {
    // The fail-open shape this whole item exists to close: a user who typed
    // `24h` believes the gate is on. Falling back to "off" — which is what every
    // other numeric variable here does — would leave them unprotected and quiet.
    for (const value of ["24h", "-1", "later"]) {
      const fixture = createFixture({ name: "app", packageManager: "pnpm@^11.0.0" });

      const result = await run(["pnpm", "--version"], {
        ...fixture,
        registry,
        env: env({ COREPACK_MINIMUM_RELEASE_AGE: value }),
      });

      expect(result.exitCode, `COREPACK_MINIMUM_RELEASE_AGE=${value}`).toBe(1);
      expect(result.stderr).toContain(
        "JUP_MINIMUM_RELEASE_AGE must be a non-negative number of hours",
      );
      // And it did not quietly resolve anything first.
      expect(result.stdout).toBe("");
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Blocker 3 — a source that publishes no release dates                        */
/* -------------------------------------------------------------------------- */

describe("§04.1 — unset costs nothing", () => {
  it("203: the same command makes the same requests, with the abbreviated header", async () => {
    const ungated = createFixture({ name: "app" });
    expect((await run(["use", "pnpm"], { ...ungated, registry, env: env() })).exitCode).toBe(0);
    const withoutGate = registry.requests.map((request) => ({
      path: request.path,
      accept: request.accept,
    }));

    registry.reset();

    const gated = createFixture({ name: "app" });
    expect(
      (
        await run(["use", "pnpm"], {
          ...gated,
          registry,
          env: env({ COREPACK_MINIMUM_RELEASE_AGE: "24" }),
        })
      ).exitCode,
    ).toBe(0);
    const withGate = registry.requests.map((request) => ({
      path: request.path,
      accept: request.accept,
    }));

    // Not one extra request. §04.1 step 6 queries pnpm's three bands, and the
    // gate changes which document those three ask for — never how many are sent.
    // A `fetchVersionTimes` bolted on as a *second* request would double the
    // `/pnpm` count here and fail, whether or not the versions came out right.
    //
    // The version in a path differs between the two runs — that is the whole
    // point of the feature — so paths are compared with it blanked out.
    const shape = (requests: { path: string }[]): string[] =>
      requests.map((request) => request.path.replaceAll(/\d+\.\d+\.\d+/g, "<version>"));

    expect(withGate.length).toBe(withoutGate.length);
    expect(shape(withGate)).toEqual(shape(withoutGate));

    // Every ungated request asks for the abbreviated packument — §05.2's exact
    // header, byte for byte, on every path. An implementation that switched the
    // header unconditionally, or that "just added `application/json`", fails
    // here rather than passing quietly at the cost of an order of magnitude more
    // bytes on every resolution anyone ever performs.
    // (Tarball downloads are not metadata requests and send no `Accept` of
    // their own; `/-/` is what distinguishes them.)
    const metadata = (requests: { path: string }[]): { path: string; accept?: string }[] =>
      requests.filter((request) => !request.path.includes("/-/"));

    expect(metadata(withoutGate).length).toBeGreaterThan(0);
    for (const request of metadata(withoutGate)) {
      expect(request.accept, `unset run asked ${request.path} for ${request.accept}`).toBe(
        NPM_ACCEPT_HEADER,
      );
    }

    // And with the gate on, only the candidate-list request changes.
    const packumentRequests = withGate.filter((request) => request.path === "/pnpm");
    expect(packumentRequests.length).toBeGreaterThan(0);
    for (const request of packumentRequests) {
      expect(request.accept).toBe(NPM_FULL_ACCEPT_HEADER);
    }
    for (const request of metadata(withGate).filter((request) => request.path !== "/pnpm")) {
      expect(request.accept, `gated run asked ${request.path} for ${request.accept}`).toBe(
        NPM_ACCEPT_HEADER,
      );
    }
  });

  it("203: the gate applies to resolution, not to what is already installed", async () => {
    // A stated limitation rather than an oversight: enforcing the age on §04.1
    // step 4's cache probe would mean a registry request on every warm run, and
    // §01.3 requires a warm run to make none. The store records no publish
    // times, so there is nothing local to check either.
    //
    // `COREPACK_ENABLE_NETWORK=0` is what makes this row honest: the answer can
    // only have come from the seeded store, never from a fallback over the wire.
    const fixture = createFixture({ name: "app", packageManager: "pnpm@^11.0.0" });
    seedPackageManager(fixture.home, "pnpm", FRESH);

    const result = await run(["pnpm", "--version"], {
      ...fixture,
      registry,
      env: env({ COREPACK_MINIMUM_RELEASE_AGE: "24", COREPACK_ENABLE_NETWORK: "0" }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${FRESH}\n`);
    expect(registry.requests).toEqual([]);
  });
});
