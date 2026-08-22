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
 * These rows pin both halves: the refusal, byte for byte, and the fact that the
 * `@yarnpkg/cli-dist` path is now checked against the digest the registry signed
 * rather than skipped because a single file was extracted.
 *
 * A note on what makes these rows load-bearing. The trap in testing a refusal is
 * a row that passes because the artifact was going to fail anyway, so every
 * refusal here is paired with a *positive* control on the same fixture and the
 * same mock: the pinned form, or `COREPACK_ALLOW_UNVERIFIED=1`, must run the
 * package manager and print its version.
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

/** Stands in for `registry.npmjs.org` *and* `repo.yarnpkg.com` (see `intercept.ts`). */
const registry = new MockRegistry();

/** Berry's single bundled `.js` file, exactly as `repo.yarnpkg.com` serves it. */
const BERRY = pmScript("yarn", "4.0.0");
const BERRY_ARTIFACT = "/4.0.0/packages/yarnpkg-cli/bin/yarn.js";
const BERRY_TAGS = "/tags";
const TAG_DOCUMENT = JSON.stringify({ aliases: { stable: "4.0.0" }, tags: ["4.0.0", "3.8.0"] });

/** The same Berry release as npm publishes it: a tarball with `bin/yarn.js`. */
const CLI_DIST = packageManagerTarball("yarn", "4.0.0", {
  packageName: "@yarnpkg/cli-dist",
  binPaths: ["bin/yarn.js"],
  script: BERRY,
});

/** The digest of the *file*, which is what a `packageManager` pin names (§06.2). */
const BERRY_HASH = hashOf(Buffer.from(BERRY, "utf8"));

const REFUSAL =
  `Refusing to install yarn@4.0.0: https://repo.yarnpkg.com provides no signature ` +
  `and no hash was pinned. Pin a hash in the packageManager field, or set ` +
  `COREPACK_ALLOW_UNVERIFIED=1.`;

beforeAll(async () => {
  await registry.start();
  registry.publishFile(BERRY_ARTIFACT, BERRY, "application/javascript");
  registry.publishFile(BERRY_TAGS, TAG_DOCUMENT, "application/json");
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
  it("167: Yarn Berry from repo.yarnpkg.com with no pinned hash is refused", async () => {
    const fixture = createFixture({ packageManager: "yarn@4.0.0" });

    const result = await run(["yarn", "--version"], { ...fixture, registry });

    expect(result.exitCode).toBe(1);
    // Byte-exact, and bare on stderr: §12.1's proxy-mode presentation.
    expect(result.stderr).toBe(`${REFUSAL}\n`);
    expect(result.stdout).toBe("");
    // Refused *before* the download, so nothing reached the store and — the
    // part TLS could never establish — nothing was executed.
    expect(existsSync(join(fixture.home, "v1", "yarn"))).toBe(false);
    expect(registry.requests.map((request) => request.path)).toEqual([]);
  });

  it("167: the same version with a pinned hash installs", async () => {
    // The positive control. Without it this file would pass just as well
    // against a build that refused Yarn Berry unconditionally, or that could not
    // reach the mock at all.
    const fixture = createFixture({ packageManager: `yarn@4.0.0+sha512.${BERRY_HASH}` });

    const result = await run(["yarn", "--version"], { ...fixture, registry });

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("4.0.0\n");
  });

  it("167: COREPACK_ALLOW_UNVERIFIED=1 permits it, loudly", async () => {
    const fixture = createFixture({ packageManager: "yarn@4.0.0" });

    const result = await run(["yarn", "--version"], {
      ...fixture,
      registry,
      env: { COREPACK_ALLOW_UNVERIFIED: "1" },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("4.0.0\n");
    // §15.11's opt-out is per-run and must never be silent.
    expect(result.stderr).toBe(
      `! Installing yarn@4.0.0 from https://repo.yarnpkg.com with no signature and no pinned hash (COREPACK_ALLOW_UNVERIFIED=1)\n`,
    );
  });

  it("167: a dynamically resolved Berry range is refused just the same", async () => {
    // The breaking half of §15.11, and the reason P12 was sequenced last: a
    // range resolves through `/tags`, which publishes versions and no digests at
    // all, so the resolved locator carries no pin for §06.1 row 1 to check.
    const fixture = createFixture({ packageManager: "yarn@4.x" });

    const result = await run(["yarn", "--version"], { ...fixture, registry });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(`${REFUSAL}\n`);
    // The tag document was read — the refusal is about the *artifact*, not a
    // failure to resolve.
    expect(registry.requests.map((request) => request.path).sort()).toEqual([BERRY_TAGS, "/yarn"]);
  });

  it("167: the env file cannot open the hole (§14.5)", async () => {
    const fixture = createFixture({ packageManager: "yarn@4.0.0" });
    fixture.write(".corepack.env", "COREPACK_ALLOW_UNVERIFIED=1\n");

    const result = await run(["yarn", "--version"], { ...fixture, registry });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      `! Ignoring COREPACK_ALLOW_UNVERIFIED from ${join(fixture.cwd, ".corepack.env")}: this variable can only be set in the environment`,
    );
    expect(result.stderr).toContain(REFUSAL);
  });

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
    // Recorded against P12 in `.agents/PLAN.md`, traced on the built binary:
    // §07.2 makes the store directory the plain version, so two references that
    // differ only in their digest share one directory and the second silently
    // runs whatever the first installed. A pin that is never checked is not a
    // verification tier (§15.11).
    const first = createFixture({ packageManager: `yarn@4.0.0+sha512.${BERRY_HASH}` });

    const warm = await run(["yarn", "--version"], { ...first, registry });
    expect(warm.exitCode).toBe(0);
    expect(existsSync(join(first.home, "v1", "yarn", "4.0.0", ".corepack"))).toBe(true);

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
    expect(existsSync(join(first.home, "v1", "yarn", "4.0.0", ".corepack"))).toBe(true);
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
      packageManager: `yarn@4.0.0+sha256.${hashOf(Buffer.from(BERRY, "utf8"), "sha256")}`,
    });
    const second = await run(["yarn", "--version"], { cwd: sha256.cwd, home, registry });

    expect(second.exitCode).toBe(0);
    expect(second.stdout).toBe("4.0.0\n");
    expect(existsSync(join(home, "v1", "yarn", "4.0.0", ".corepack"))).toBe(true);
    expect(
      existsSync(
        join(
          home,
          "v1",
          "yarn",
          `4.0.0+sha256.${hashOf(Buffer.from(BERRY, "utf8"), "sha256")}`,
          ".corepack",
        ),
      ),
    ).toBe(true);
  });
});
