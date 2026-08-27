/**
 * §15.38 rows 162–164 — trust-key freshness, decoupled from release cadence
 * (§15.9).
 *
 * The incident these rows exist for is #612/#616: npm rotated its signing keys
 * in February 2025 and every released corepack broke worldwide, because the
 * trust store is baked into the bundle at release time. The remedy §15.9
 * prescribes is narrow on purpose — one refresh, on one failure, from one
 * registry — so the rows have to pin the *absences* as tightly as the success:
 *
 * * a run that verifies makes **no** key request (row 164, §01.3);
 * * a warm run makes no requests at all;
 * * a pinned `COREPACK_INTEGRITY_KEYS` is final and refreshes nothing (row 163);
 * * the refreshed set is cached, so the second failure-shaped run is free.
 *
 * Every one of those is asserted against the mock's request log rather than
 * against an exit code, because a row that only checks "it worked" cannot tell a
 * refresh that fired once from one that fires on every invocation.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupFixtures,
  createFixture,
  KEYS_PATH,
  MockRegistry,
  packageManagerTarball,
  run,
} from "./_harness/index.ts";

/**
 * Stands in for `registry.npmjs.org` (see `intercept.ts`), which is what makes
 * these rows meaningful: the mock signs with a key the **embedded** trust store
 * has never heard of, so every run below starts from a genuine keyid miss
 * against the real §02.6 table, with no `COREPACK_INTEGRITY_KEYS` in sight.
 */
const registry = new MockRegistry();

const TARBALL = packageManagerTarball("pnpm", "6.6.2");
const NEWER = packageManagerTarball("pnpm", "6.6.3");

/** Every `/-/npm/v1/keys` request the mock answered, and the URL it was asked as. */
function keyRequests(): string[] {
  return registry.requests.filter((request) => request.path === KEYS_PATH).map((r) => r.original);
}

function cachedKeys(home: string): unknown {
  return JSON.parse(readFileSync(join(home, "keys.json"), "utf8"));
}

beforeAll(async () => {
  await registry.start();
  registry.publish("pnpm", "6.6.2", TARBALL, { distTags: { latest: "6.6.2" } });
  registry.publish("pnpm", "6.6.3", NEWER);
});

afterAll(async () => {
  cleanupFixtures();
  await registry.stop();
});

beforeEach(() => registry.reset());

describe("§15.9 — key refresh on an unknown keyid", () => {
  it("162: a keyid no embedded key matches is refreshed once, then verifies", async () => {
    registry.publishedKeys = [registry.keyEntry()];
    const fixture = createFixture({ packageManager: "pnpm@6.6.2" });

    const result = await run(["pnpm", "--version"], { ...fixture, registry });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("6.6.2\n");
    expect(result.stderr).toBe("");

    // Exactly one refresh, and — §15.10's anti-circularity rule — asked of npm's
    // own registry rather than of whatever registry served the package.
    expect(keyRequests()).toEqual(["https://registry.npmjs.org/-/npm/v1/keys"]);

    // And it came *after* the metadata that failed to verify: the refresh is a
    // repair, not a preflight.
    const paths = registry.requests.map((request) => request.path);
    expect(paths.indexOf(KEYS_PATH)).toBeGreaterThan(paths.indexOf("/pnpm/6.6.2"));

    // §15.9 — cached with a fetch timestamp, at `<home>/keys.json`.
    const cache = cachedKeys(fixture.home) as {
      registries: Record<string, { fetchedAt: string; keys: Array<{ keyid: string }> }>;
    };
    const entry = cache.registries["https://registry.npmjs.org"]!;
    expect(entry.keys.map((key) => key.keyid)).toEqual([registry.keyid]);
    expect(Number.isNaN(Date.parse(entry.fetchedAt))).toBe(false);
  });

  it("162: the cached set carries the next run, with no second refresh", async () => {
    registry.publishedKeys = [registry.keyEntry()];
    const first = createFixture({ packageManager: "pnpm@6.6.2" });

    expect((await run(["pnpm", "--version"], { ...first, registry })).exitCode).toBe(0);
    expect(keyRequests()).toHaveLength(1);

    registry.requests = [];

    // A *different* version, so the store is cold and the whole verification
    // path runs again — the one thing reused is `<home>/keys.json`.
    const second = createFixture({ packageManager: "pnpm@6.6.3" });
    const result = await run(["pnpm", "--version"], {
      cwd: second.cwd,
      home: first.home,
      registry,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("6.6.3\n");
    expect(registry.requests.map((request) => request.path)).toEqual([
      "/pnpm/6.6.3",
      "/pnpm/-/pnpm-6.6.3.tgz",
    ]);
    expect(keyRequests()).toEqual([]);
  });

  it("162: a refresh that does not help fails, and is not repeated on the next run", async () => {
    // The negative control for the row above. `publishedKeys` answers with a key
    // that is not the one the packument was signed with, so the refresh happens,
    // is cached, and changes nothing — which must still be one request per
    // refresh interval rather than one per run.
    registry.publishedKeys = [registry.keyEntry({ keyid: "SHA256:some-other-key" })];
    const fixture = createFixture({ packageManager: "pnpm@6.6.2" });

    const first = await run(["pnpm", "--version"], { ...fixture, registry });
    expect(first.exitCode).toBe(1);
    expect(first.stderr).toContain("The package was not signed by any trusted keys");
    // The diagnostic lists what was actually tried, refreshed keys included.
    expect(first.stderr).toContain("SHA256:some-other-key");
    expect(keyRequests()).toHaveLength(1);

    registry.requests = [];
    const second = await run(["pnpm", "--version"], { ...fixture, registry });

    expect(second.exitCode).toBe(1);
    // §15.9's timestamp doing its job: a failing build in a loop must not put a
    // request on `/-/npm/v1/keys` every time round.
    expect(keyRequests()).toEqual([]);
  });

  it("162: a refreshed key that npm has expired installs, naming the key it accepted", async () => {
    // Every package manager npm published before 2025-01-29, reproduced
    // hermetically: the signature's keyid is one the embedded table does not
    // ship (§14.4 ships only unexpired keys), and `/-/npm/v1/keys` marks it
    // `expires: 2025-01-29`. Before §15.9 the only available answer was "not
    // signed by any trusted keys", which reads like a bug in the tool. The
    // refresh supplies the key, and §06.5's leniency accepts the signature that
    // verifies under it rather than refusing half the registry's history.
    registry.publishedKeys = [registry.keyEntry({ expires: "2025-01-29T00:00:00.000Z" })];
    const fixture = createFixture({ packageManager: "pnpm@6.6.2" });

    const result = await run(["pnpm", "--version"], { ...fixture, registry });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("6.6.2\n");
    expect(result.stderr).toContain(
      `carries a valid signature from ${registry.keyid}, a key that expired 2025-01-29T00:00:00.000Z`,
    );
    expect(result.stderr).not.toContain("The package was not signed by any trusted keys");
    expect(keyRequests()).toHaveLength(1);
    // The refresh is what made it verifiable, so the install is cached (§07).
    expect(existsSync(join(fixture.home, "v1", "pnpm"))).toBe(true);
  });

  it("163: a pinned COREPACK_INTEGRITY_KEYS is final — nothing is refreshed", async () => {
    registry.publishedKeys = [registry.keyEntry()];
    const fixture = createFixture({ packageManager: "pnpm@6.6.2" });

    const result = await run(["pnpm", "--version"], {
      ...fixture,
      registry,
      // A store that would be repaired by the refresh, if a refresh were allowed.
      env: { COREPACK_INTEGRITY_KEYS: registry.trustStore({ keyid: "SHA256:pinned-and-wrong" }) },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("The package was not signed by any trusted keys");
    expect(keyRequests()).toEqual([]);
    expect(existsSync(join(fixture.home, "keys.json"))).toBe(false);
  });

  it("163: COREPACK_ENABLE_NETWORK=0 refreshes nothing", async () => {
    registry.publishedKeys = [registry.keyEntry()];
    const fixture = createFixture({ packageManager: "pnpm@6.6.2" });

    const result = await run(["pnpm", "--version"], {
      ...fixture,
      registry,
      env: { COREPACK_ENABLE_NETWORK: "0" },
    });

    expect(result.exitCode).toBe(1);
    // The metadata request is refused first, so this row can only witness the
    // absence; `test/unit/trust.test.ts` drives the flag against a verification
    // that has already failed, which is where the branch actually lives.
    expect(result.stderr).toContain("network access is disabled");
    expect(registry.requests).toEqual([]);
  });

  it("164: a warm run makes no request at all, key refresh included", async () => {
    registry.publishedKeys = [registry.keyEntry()];
    const fixture = createFixture({ packageManager: "pnpm@6.6.2" });

    expect((await run(["pnpm", "--version"], { ...fixture, registry })).exitCode).toBe(0);
    registry.requests = [];

    const warm = await run(["pnpm", "--version"], { ...fixture, registry });

    expect(warm.exitCode).toBe(0);
    expect(warm.stdout).toBe("6.6.2\n");
    // §01.3: the warm path is a `stat` and an `exec`. §15.9 must not have added
    // a request, a key read, or anything else to it.
    expect(registry.requests).toEqual([]);
  });

  it("164: a verification that succeeds never asks for keys", async () => {
    // The other half of row 164, and the one that would catch a refresh moved to
    // the front of `verifySignature`: this run's trust store matches on the
    // first attempt, so `/-/npm/v1/keys` must never be touched — even though the
    // mock is publishing a perfectly good document.
    registry.publishedKeys = [registry.keyEntry()];
    const fixture = createFixture({ packageManager: "pnpm@6.6.2" });

    const result = await run(["pnpm", "--version"], {
      ...fixture,
      registry,
      env: { COREPACK_INTEGRITY_KEYS: registry.trustStore() },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("6.6.2\n");
    expect(keyRequests()).toEqual([]);
    expect(existsSync(join(fixture.home, "keys.json"))).toBe(false);
  });
});
