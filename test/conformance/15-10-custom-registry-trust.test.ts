/**
 * §15.38 rows 165–166 — custom-registry trust, without circular trust (§15.10).
 *
 * Driven by corepack #884 and its open PR #885: verification always used npm's
 * keys, whoever served the package, so every re-signing private registry
 * (Cloudsmith and the like) failed with "not signed by any trusted keys" and no
 * way to say otherwise. #741 is the compounding half — `.corepack.env` was not
 * loaded for `install`/`prepare`, so even the per-project workaround did not
 * work — and §14.5 answers it by making the variable environment-only, which
 * row 166 pins.
 *
 * The trap these rows are shaped around: a trust store with **one** origin in it
 * cannot distinguish "the store is keyed by origin" from "the store is
 * flattened and every configured key vouches for every registry". Both make the
 * happy path pass. So every positive here is paired with the same key published
 * under a *different* origin, which must fail.
 */

import { existsSync } from "node:fs";
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

const registry = new MockRegistry();

const TARBALL = packageManagerTarball("pnpm", "6.6.2");

/** A trust store in §15.10's origin-keyed shape. */
function keysFor(...origins: string[]): string {
  return JSON.stringify(
    Object.fromEntries(origins.map((origin) => [origin, [registry.keyEntry()]])),
  );
}

beforeAll(async () => {
  await registry.start();
  registry.publish("pnpm", "6.6.2", TARBALL, { distTags: { latest: "6.6.2" } });
});

afterAll(async () => {
  cleanupFixtures();
  await registry.stop();
});

beforeEach(() => registry.reset());

describe("§15.10 — trust keyed by registry origin", () => {
  it("165: a store keyed by the serving origin verifies", async () => {
    const fixture = createFixture({ packageManager: "pnpm@6.6.2" });

    const result = await run(["pnpm", "--version"], {
      ...fixture,
      env: {
        COREPACK_NPM_REGISTRY: registry.origin,
        COREPACK_INTEGRITY_KEYS: keysFor(registry.origin),
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("6.6.2\n");
    expect(result.stderr).toBe("");
  });

  it("165: the same key under a different origin does not vouch for this one", async () => {
    // The discriminating half. A flattened store — the shape this had while
    // §15.10 was outstanding — passes this row, which is exactly why it is here.
    const fixture = createFixture({ packageManager: "pnpm@6.6.2" });

    const result = await run(["pnpm", "--version"], {
      ...fixture,
      env: {
        COREPACK_NPM_REGISTRY: registry.origin,
        COREPACK_INTEGRITY_KEYS: keysFor("https://npm.internal.example"),
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("The package was not signed by any trusted keys");
    // Nothing was configured for the origin that served it, so nothing was tried.
    expect(result.stderr).toContain(`"trustedKeys": []`);
    expect(existsSync(join(fixture.home, "v1", "pnpm"))).toBe(false);
  });

  it("165: a trailing slash and a path-scoped registry select the same origin", async () => {
    // Origins are compared parsed, not as strings: an Artifactory-style registry
    // URL carries a path, and a store written with the bare origin must still
    // apply to it.
    const fixture = createFixture({ packageManager: "pnpm@6.6.2" });

    const result = await run(["pnpm", "--version"], {
      ...fixture,
      env: {
        COREPACK_NPM_REGISTRY: `${registry.origin}/`,
        COREPACK_INTEGRITY_KEYS: keysFor(`${registry.origin}/api/npm/npm-remote`),
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("6.6.2\n");
  });

  it("165: npm's own keys still vouch for a package a mirror served (§06.6)", async () => {
    // The rule pulling the other way, and the reason this cannot be a plain
    // per-origin lookup: npm's signature travels *with* the package, so a
    // compromised mirror cannot forge it — and a mirror whose users have not
    // configured anything must keep verifying against npm's keys.
    const fixture = createFixture({ packageManager: "pnpm@6.6.2" });

    const result = await run(["pnpm", "--version"], {
      ...fixture,
      env: {
        COREPACK_NPM_REGISTRY: registry.origin,
        COREPACK_INTEGRITY_KEYS: keysFor("https://registry.npmjs.org"),
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("6.6.2\n");
  });

  it("165: §15.9's refresh is asked of npm, never of the registry that served the package", async () => {
    // The circularity objection on #884, answered concretely. The mock stands in
    // for *both* hosts here, so the assertion is on the URL the tool asked for,
    // not on which server answered: a refresh aimed at the mirror would let a
    // compromised mirror hand out the keys for its own forgeries, which is the
    // one thing §06.6 relies on it not having.
    registry.publishedKeys = [registry.keyEntry()];
    const fixture = createFixture({ packageManager: "pnpm@6.6.2" });

    const result = await run(["pnpm", "--version"], {
      ...fixture,
      registry,
      env: { COREPACK_NPM_REGISTRY: registry.origin },
    });

    expect(result.exitCode).toBe(0);
    const keys = registry.requests.filter((request) => request.path === KEYS_PATH);
    expect(keys.map((request) => request.original)).toEqual([
      "https://registry.npmjs.org/-/npm/v1/keys",
    ]);
    // The metadata, by contrast, came from the mirror — so the two really are
    // different destinations in this run.
    expect(registry.requests[0]!.original).toBe(`${registry.origin}/pnpm/6.6.2`);
  });

  it("166: a project `.corepack.env` cannot supply keys for any origin", async () => {
    const fixture = createFixture({ packageManager: "pnpm@6.6.2" });
    fixture.write(".corepack.env", `COREPACK_INTEGRITY_KEYS=${keysFor(registry.origin)}\n`);
    fixture.write(".npmrc", `registry=${registry.origin}\n`);

    const result = await run(["pnpm", "--version"], { ...fixture });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      `! Ignoring COREPACK_INTEGRITY_KEYS from ${join(fixture.cwd, ".corepack.env")}: this variable can only be set in the environment`,
    );
    expect(result.stderr).toContain("The package was not signed by any trusted keys");
    expect(existsSync(join(fixture.home, "v1", "pnpm"))).toBe(false);
  });

  it("166: the same value from the real environment is honoured", async () => {
    // The positive control for the row above: without it, that row would pass
    // against a build that could not reach the mock at all.
    const fixture = createFixture({ packageManager: "pnpm@6.6.2" });
    fixture.write(".npmrc", `registry=${registry.origin}\n`);

    const result = await run(["pnpm", "--version"], {
      ...fixture,
      env: { COREPACK_INTEGRITY_KEYS: keysFor(registry.origin) },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("6.6.2\n");
  });
});
