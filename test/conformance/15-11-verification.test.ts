/**
 * §15.38 rows 167–168 — one verification tier for every source (§15.11).
 *
 * Corepack's trust model is two-tiered and §06.6 records the holes: npm-hosted
 * packages get a signature chain, Yarn Berry from `repo.yarnpkg.com` gets TLS
 * and nothing else, and Yarn Berry through a custom npm registry gets nothing at
 * all (§14.10). Open PR #548 would have closed the first; it has sat unmerged
 * since, and #495 is a Node.js TSC member arguing in twenty-two comments that
 * the asymmetry is a supply-chain risk.
 *
 * **Row 167 is gone.** It asserted the refusal itself — Berry from
 * `repo.yarnpkg.com`, unsigned and unpinned, turned away byte for byte — and
 * §15.41 removed the source it was written against. Every entry in the table is
 * an npm package with a signature now, so no fixture built from the table can
 * reach the unverified path, and the row could only have been kept by inventing
 * a band that does not exist.
 *
 * What that costs is worth stating plainly: §15.11's central rule — TLS alone is
 * not a verification tier — no longer has a row of its own. The guard that
 * replaces it is upstream, in `test/unit/config.test.ts`, which sweeps the table
 * and fails if any band names an origin other than the npm registry. A future
 * band on a vendor's own host trips that instead.
 *
 * Row 168 stays: it is the other half, and the half that still has an artifact —
 * `@yarnpkg/cli-dist` checked against the digest the registry signed, rather
 * than skipped because a single file was extracted (§14.10).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupFixtures,
  createFixture,
  hashOf,
  MockRegistry,
  packageManagerTarball,
  pmScript,
  run,
} from "./_harness/index.ts";

/** Stands in for `registry.npmjs.org` (see `intercept.ts`). */
const registry = new MockRegistry();

/** The entry point the fake Berry runs, shared by the tarball and its digest. */
const BERRY = pmScript("yarn", "4.0.0");

/** Berry as npm publishes it, which since §15.41 is the only way the table asks. */
const CLI_DIST = packageManagerTarball("yarn", "4.0.0", {
  packageName: "@yarnpkg/cli-dist",
  binPaths: ["bin/yarn.js"],
  script: BERRY,
});

/**
 * The digest a `packageManager` pin names (§06.2) — the *tarball* now. It was
 * the single file's while Berry came from `repo.yarnpkg.com`.
 */
const BERRY_HASH = hashOf(CLI_DIST);

beforeAll(async () => {
  await registry.start();
  registry.publish("@yarnpkg/cli-dist", "4.0.0", CLI_DIST, { distTags: { latest: "4.0.0" } });
  // §04.1 step 6 unions both of yarn's bands, so the Classic packument has to
  // answer as well or a range fails before §15.11 has anything to say.
  registry.publish("yarn", "1.22.4", packageManagerTarball("yarn", "1.22.4"), {
    distTags: { latest: "1.22.4" },
  });
});

afterAll(async () => {
  cleanupFixtures();
  await registry.stop();
});

beforeEach(() => registry.reset());

describe("§15.11 — every artifact clears a verification tier", () => {
  it("168: Berry via a custom npm registry is checked against the signed integrity", async () => {
    const fixture = createFixture({ packageManager: "yarn@4.0.0" });

    const result = await run(["yarn", "--version"], {
      ...fixture,
      registry,
      env: {
        COREPACK_NPM_REGISTRY: registry.origin,
        COREPACK_INTEGRITY_KEYS: registry.trustStore(),
      },
    });

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("4.0.0\n");
    // The `npmRegistry` fallback: `@yarnpkg/cli-dist`, filtered down to the one
    // entry §07.4 extracts. No pin was needed because the signature chain
    // supplied the tier.
    expect(registry.requests.map((request) => request.path)).toEqual([
      "/@yarnpkg/cli-dist/4.0.0",
      "/@yarnpkg/cli-dist/-/cli-dist-4.0.0.tgz",
    ]);
  });

  it("168: a validly signed integrity describing other bytes fails the digest check", async () => {
    // §14.10's actual content: corepack's guard is `!registry.bin`, so this
    // whole comparison was skipped whenever a single file was extracted, and a
    // compromised mirror could serve anything. `invalid_integrity` signs
    // metadata correctly but describes bytes other than the ones served, which
    // is the only shape that tells a signature check from a digest check apart.
    registry.mode = "invalid_integrity";
    const fixture = createFixture({ packageManager: "yarn@4.0.0" });

    const result = await run(["yarn", "--version"], {
      ...fixture,
      registry,
      env: {
        COREPACK_NPM_REGISTRY: registry.origin,
        COREPACK_INTEGRITY_KEYS: registry.trustStore(),
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Mismatch hashes.");
    expect(existsSync(join(fixture.home, "v1", "yarn"))).toBe(false);
  });

  it("a pinned hash the cache does not prove is not adopted from another pin", async () => {
    // Recorded against §15.11 in `.agents/S15-AUDIT.md`, traced on the built binary:
    // §07.2 makes the store directory the plain version, so two references that
    // differ only in their digest share one directory and the second silently
    // runs whatever the first installed. A pin that is never checked is not a
    // verification tier (§15.11).
    const first = createFixture({ packageManager: `yarn@4.0.0+sha512.${BERRY_HASH}` });

    const warm = await run(["yarn", "--version"], { ...first, registry });
    expect(warm.exitCode).toBe(0);
    expect(existsSync(join(first.home, "v1", "yarn", "4.0.0", ".jup"))).toBe(true);

    // A second project, same version, a digest that describes something else,
    // sharing the store the first run warmed.
    const second = createFixture({ packageManager: `yarn@4.0.0+sha512.${"0".repeat(128)}` });
    const result = await run(["yarn", "--version"], {
      cwd: second.cwd,
      home: first.home,
      registry,
    });

    // Not "4.0.0\n": the cached artifact does not carry this digest, so it is
    // re-fetched into a pin-qualified directory and fails its own hash check.
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Mismatch hashes.");
    // The entry the first project verified is untouched.
    expect(existsSync(join(first.home, "v1", "yarn", "4.0.0", ".jup"))).toBe(true);
  });

  it("a differing-algorithm pin re-verifies rather than refusing", async () => {
    // The collision nobody misconfigured: the embedded defaults pin sha1
    // (§02.5) while `corepack use` writes the registry's sha512, so refusing on
    // any marker mismatch would break a legitimate pair whose only remedy is
    // wiping the cache. The pin-qualified directory is what lets both live.
    const home = createFixture().home;

    const sha512 = createFixture({ packageManager: `yarn@4.0.0+sha512.${BERRY_HASH}` });
    const first = await run(["yarn", "--version"], { cwd: sha512.cwd, home, registry });
    expect(first.exitCode).toBe(0);

    const sha256 = createFixture({
      packageManager: `yarn@4.0.0+sha256.${hashOf(CLI_DIST, "sha256")}`,
    });
    const second = await run(["yarn", "--version"], { cwd: sha256.cwd, home, registry });

    expect(second.exitCode).toBe(0);
    expect(second.stdout).toBe("4.0.0\n");
    expect(existsSync(join(home, "v1", "yarn", "4.0.0", ".jup"))).toBe(true);
    expect(
      existsSync(join(home, "v1", "yarn", `4.0.0+sha256.${hashOf(CLI_DIST, "sha256")}`, ".jup")),
    ).toBe(true);
  });
});
