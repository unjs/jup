/**
 * row 169 — the sidecar integrity (§03.7).
 *
 * `<version>+<algo>.<hex>` is valid semver build metadata, and corepack's
 * maintainers defend it as a deliberate tradeoff (#316) — but it means
 * `packageManager` no longer round-trips through tooling that reads the field as
 * a version, which is what #726 and #620 keep asking about. §03.7's answer is
 * the sidecar: the member holds a clean version with the digest beside it in
 * `integrity`, the top-level string keeps the suffix because it has nowhere else
 * to put one, and both are read as the same hash-bearing pin. `--no-integrity`
 * is the opt-out for a project that wants no digest committed at all.
 *
 * "Treated exactly like a build-suffix hash (§06.1)" is the requirement, so the
 * rows below assert the consequence rather than the storage: a wrong sidecar
 * must fail the download with §06.2's hash mismatch, in a run that is otherwise
 * identical to one that succeeds.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupFixtures,
  createFixture,
  type Fixture,
  MockRegistry,
  packageManagerTarball,
  run,
  sriOf,
  withoutDownloadNotices,
} from "./_harness/index.ts";

const registry = new MockRegistry();

const TARBALL = packageManagerTarball("pnpm", "6.6.2");
/** What §03.7's `integrity` field holds: the SRI of the published tarball. */
const INTEGRITY = sriOf(TARBALL);
/** A validly shaped SRI describing something else entirely. */
const WRONG = `sha512-${Buffer.alloc(64).toString("base64")}`;

function trusted(extra?: Record<string, string | undefined>): Record<string, string | undefined> {
  return { COREPACK_INTEGRITY_KEYS: registry.trustStore(), ...extra };
}

function manifest(integrity?: string): unknown {
  const packageManager: Record<string, unknown> = { name: "pnpm", version: "6.6.2" };
  if (integrity !== undefined) packageManager.integrity = integrity;
  return { packageManager: "pnpm@6.6.2", devEngines: { packageManager } };
}

/** The top-level field's own bytes — these rows are about *which* field. */
function pinOf(fixture: Fixture): string | undefined {
  return (fixture.json("package.json") as { packageManager?: string }).packageManager;
}

function sidecarOf(fixture: Fixture): Record<string, unknown> {
  return (
    fixture.json("package.json") as { devEngines?: { packageManager?: Record<string, unknown> } }
  ).devEngines?.packageManager as Record<string, unknown>;
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

describe("§03.7 — devEngines.packageManager.integrity", () => {
  it("169: a correct sidecar beside a clean `packageManager` installs", async () => {
    const fixture = createFixture(manifest(INTEGRITY));

    const result = await run(["pnpm", "--version"], { ...fixture, registry });

    expect(withoutDownloadNotices(result.stderr)).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("6.6.2\n");
    // §06.1 row 1: an explicit hash is the check, so no trust store was needed
    // and no signature was consulted — the sidecar behaved as a build suffix
    // down to which request the run made.
    expect(registry.requests.map((request) => request.path)).toEqual(["/pnpm/-/pnpm-6.6.2.tgz"]);
  });

  it("169: a wrong sidecar is enforced, not ignored", async () => {
    const fixture = createFixture(manifest(WRONG));

    const result = await run(["pnpm", "--version"], { ...fixture, registry });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Mismatch hashes.");
    expect(result.stdout).toBe("");
    // §06.2 — nothing is cached on a mismatch, so the next run fails the same way.
    expect(existsSync(join(fixture.home, "v1", "pnpm"))).toBe(false);
  });

  it("169: the same manifest with no sidecar installs, which is what makes the row mean something", async () => {
    // The control. Without it, the row above would pass against a build that
    // could not install this fixture at all.
    const fixture = createFixture(manifest());

    const result = await run(["pnpm", "--version"], { ...fixture, registry, env: trusted() });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("6.6.2\n");
  });

  it("169: a malformed sidecar is reported through devEngines' own onFail", async () => {
    const fixture = createFixture({
      packageManager: "pnpm@6.6.2",
      devEngines: {
        packageManager: { name: "pnpm", version: "6.6.2", integrity: "not-an-sri" },
      },
    });

    const result = await run(["pnpm", "--version"], { ...fixture, registry, env: trusted() });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`Invalid "devEngines.packageManager.integrity" field`);
  });

  it("169: a sidecar disagreeing with an explicit build suffix is refused", async () => {
    const fixture = createFixture({
      packageManager: `pnpm@6.6.2+sha512.${Buffer.alloc(64).toString("hex")}`,
      devEngines: { packageManager: { name: "pnpm", version: "6.6.2", integrity: INTEGRITY } },
    });

    const result = await run(["pnpm", "--version"], { ...fixture, registry, env: trusted() });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("pin different hashes");
  });

  // §03.7 — the pin's home moved to `devEngines`, and the member's `version` is
  // validated as a semver *range*, where a `+sha512.…` has no business. So the
  // digest goes beside it rather than into it, with no flag to ask for that.
  it("169: `use` writes the clean version and the SRI, and it reads back", async () => {
    const fixture = createFixture({ name: "project" });

    const written = await run(["use", "pnpm@6.6.2"], { ...fixture, registry, env: trusted() });

    expect(written.exitCode).toBe(0);
    expect(pinOf(fixture)).toBeUndefined();
    expect(sidecarOf(fixture)).toEqual({
      name: "pnpm",
      version: "6.6.2",
      integrity: INTEGRITY,
    });

    // §03.7's "the result re-reads cleanly" and "both forms MUST be
    // accepted on read" — from a cold store, so the pin is actually checked.
    const cold = createFixture();
    const reread = await run(["pnpm", "--version"], {
      cwd: fixture.cwd,
      home: cold.home,
      registry,
    });
    expect(reread.exitCode).toBe(0);
    expect(reread.stdout).toBe("6.6.2\n");
  });

  it("169: `use` updates an existing devEngines block in place", async () => {
    const fixture = createFixture({
      name: "project",
      devEngines: { packageManager: { name: "pnpm", version: "5.0.0", onFail: "ignore" } },
    });

    const result = await run(["use", "pnpm@6.6.2"], { ...fixture, registry, env: trusted() });

    expect(result.exitCode).toBe(0);
    // §03.7 bullet 2: a devEngines-only project gets no top-level
    // `packageManager` invented for it.
    expect(pinOf(fixture)).toBeUndefined();
    expect(sidecarOf(fixture)).toEqual({
      name: "pnpm",
      version: "6.6.2",
      onFail: "ignore",
      integrity: INTEGRITY,
    });
  });

  // §09 — the opt-out. Not a third spelling of the digest: no digest.
  it("169: `--no-integrity` pins the version alone, and it reads back", async () => {
    const fixture = createFixture({ name: "project" });

    const written = await run(["use", "--no-integrity", "pnpm@6.6.2"], {
      ...fixture,
      registry,
      env: trusted(),
    });

    expect(written.exitCode).toBe(0);
    expect(pinOf(fixture)).toBeUndefined();
    expect(sidecarOf(fixture)).toEqual({ name: "pnpm", version: "6.6.2" });

    // Still a working pin from a cold store — what it loses is §06.1's explicit
    // hash tier, so the signature is what verifies it and the trust store is
    // needed again.
    const cold = createFixture();
    const reread = await run(["pnpm", "--version"], {
      cwd: fixture.cwd,
      home: cold.home,
      registry,
      env: trusted(),
    });
    expect(reread.exitCode).toBe(0);
    expect(reread.stdout).toBe("6.6.2\n");
  });

  // A flag that asked for no integrity and left one in the file did nothing.
  it("169: `--no-integrity` removes a digest already in the manifest", async () => {
    const fixture = createFixture({
      name: "project",
      packageManager: "pnpm@6.6.2+sha512." + "0".repeat(128),
      devEngines: { packageManager: { name: "pnpm", version: "6.6.2", integrity: WRONG } },
    });

    const result = await run(["use", "--no-integrity", "pnpm@6.6.2"], {
      ...fixture,
      registry,
      env: trusted(),
    });

    expect(result.exitCode).toBe(0);
    expect(sidecarOf(fixture)).toEqual({ name: "pnpm", version: "6.6.2" });
    // The top-level string went out with §03.7's retirement, and its suffixed
    // digest with it — there is no second copy of the pin left to strip.
    expect(pinOf(fixture)).toBeUndefined();
  });
});
