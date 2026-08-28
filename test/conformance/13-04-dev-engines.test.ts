/**
 * §13.4 — `devEngines.packageManager` (rows 22–37).
 *
 * The validation order in §03.3 is what these rows pin down: which failures warn
 * unconditionally, which respect `onFail`, and that `packageManager` wins
 * whenever it is present.
 */

import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupFixtures,
  createFixture,
  MockRegistry,
  packageManagerTarball,
  run,
  seedPackageManager,
} from "./_harness/index.ts";

const registry = new MockRegistry();

/** The pin every mismatch row uses, quoted verbatim in the expected messages. */
const PIN = "pnpm@6.6.2+sha1.111";

beforeAll(async () => {
  await registry.start();
  registry.publish("pnpm", "6.6.2", packageManagerTarball("pnpm", "6.6.2"));
});

afterAll(async () => {
  cleanupFixtures();
  await registry.stop();
});

beforeEach(() => registry.reset());

/**
 * A project pinned to {@link PIN} with `pnpm@6.6.2` already in its store.
 *
 * §15.11 — the seeded install has to stand for the reference the manifest pins,
 * digest included: a cache hit is now checked against the pin, so a marker
 * recording some other hash is a *miss* and these rows would go to the network
 * for a version that is sitting in the store. Nothing about what they assert
 * changes; the fixture simply stopped contradicting itself.
 */
function pinnedProject(devEngines: unknown, pin: unknown = PIN) {
  const manifest: Record<string, unknown> = { devEngines: { packageManager: devEngines } };
  if (pin !== undefined) manifest.packageManager = pin;
  const fixture = createFixture(manifest);
  const reference =
    typeof pin === "string" && pin.startsWith("pnpm@") ? pin.slice("pnpm@".length) : "6.6.2";
  seedPackageManager(fixture.home, "pnpm", reference);
  return fixture;
}

/** §15.23 — the resolutions an ordinary run memoed in `node_modules/.jup`. */
function memoOf(fixture: { json(relative: string): unknown }): Record<string, unknown> {
  return (fixture.json("node_modules/.jup/jup.lock") as { resolutions: Record<string, unknown> })
    .resolutions;
}

describe("§13.4 devEngines", () => {
  // Rows 22 and 23 are superseded by §15.23, whose first requirement is that
  // `devEngines.packageManager.version` accept a range: the derived `yarn@*` and
  // `pnpm@6.x` specs are now usable rather than rejected. This is the shape pnpm
  // 11.21 generates, and rejecting it is why pnpm dropped corepack from its docs.
  it("22: {name: yarn} with no packageManager resolves as yarn@*", async () => {
    const fixture = createFixture({ devEngines: { packageManager: { name: "yarn" } } });
    seedPackageManager(fixture.home, "yarn", "1.22.4");
    fixture.write("node_modules/.keep", "");

    const result = await run(["yarn", "--version"], fixture);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("1.22.4\n");
    expect(result.stderr).toBe("");
    // §15.23 — memoed, not recorded: a proxy run never writes the project's own
    // `jup.lock`.
    expect(fixture.exists("jup.lock")).toBe(false);
    expect(memoOf(fixture)["yarn@*"]).toMatchObject({
      // Seeded, not downloaded: its placeholder hash is not a usable digest, so
      // none is recorded. Row 181 asserts the recorded digest of real bytes.
      resolved: "1.22.4",
    });
  });

  it("23: {name: pnpm, version: 6.x} with no packageManager resolves as pnpm@6.x", async () => {
    const fixture = createFixture({
      devEngines: { packageManager: { name: "pnpm", version: "6.x" } },
    });
    seedPackageManager(fixture.home, "pnpm", "6.6.2");
    fixture.write("node_modules/.keep", "");

    const result = await run(["pnpm", "--version"], fixture);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("6.6.2\n");
    expect(result.stderr).toBe("");
    expect(fixture.exists("jup.lock")).toBe(false);
    expect(memoOf(fixture)["pnpm@6.x"]).toMatchObject({ resolved: "6.6.2" });
  });

  it("24: the same, plus a matching hash-bearing packageManager, runs 6.6.2", async () => {
    const fixture = pinnedProject(
      { name: "pnpm", version: "6.x" },
      `pnpm@6.6.2+sha224.${"a".repeat(56)}`,
    );

    const result = await run(["pnpm", "--version"], fixture);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("6.6.2\n");
    expect(result.stderr).toBe("");
  });

  it("25: {name: pnpm} with no version imposes no constraint", async () => {
    const fixture = pinnedProject({ name: "pnpm" }, `pnpm@6.6.2+sha224.${"a".repeat(56)}`);

    const result = await run(["pnpm", "--version"], fixture);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("6.6.2\n");
    expect(result.stderr).toBe("");
  });

  it("26: version yarn@1.x is not a semver range", async () => {
    const fixture = createFixture({
      devEngines: { packageManager: { name: "yarn", version: "yarn@1.x" } },
    });

    const result = await run(["yarn", "--version"], fixture);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      `The value of devEngines.packageManager.version "yarn@1.x" is not a valid semver range\n`,
    );
  });

  it("27: an array value warns unconditionally and is ignored", async () => {
    const fixture = pinnedProject([{ name: "pnpm", version: "6.x" }]);

    const result = await run(["pnpm", "--version"], fixture);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe(
      `! jup does not currently support array values for devEngines.packageManager\n`,
    );
    expect(result.stdout).toBe("6.6.2\n");
  });

  it("28: a string value warns unconditionally and is ignored", async () => {
    const fixture = pinnedProject("pnpm@10.x");

    const result = await run(["pnpm", "--version"], fixture);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe(
      `! jup only supports objects as valid value for devEngines.packageManager. The current value ("pnpm@10.x") will be ignored.\n`,
    );
  });

  it("29: a number value warns unconditionally and is ignored", async () => {
    const fixture = pinnedProject(10);

    const result = await run(["pnpm", "--version"], fixture);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe(
      `! jup only supports objects as valid value for devEngines.packageManager. The current value (10) will be ignored.\n`,
    );
  });

  it("30: a name mismatch with onFail: ignore is silent", async () => {
    const fixture = pinnedProject({ name: "yarn", onFail: "ignore" });

    const result = await run(["pnpm", "--version"], fixture);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("6.6.2\n");
  });

  it("31: a name mismatch with onFail: warn warns and continues", async () => {
    const fixture = pinnedProject({ name: "yarn", onFail: "warn" });

    const result = await run(["pnpm", "--version"], fixture);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe(
      `! jup validation warning: "packageManager" field is set to "${PIN}" which does not match the "devEngines.packageManager" field set to "yarn"\n`,
    );
    expect(result.stdout).toBe("6.6.2\n");
  });

  it("32: a name mismatch with onFail: error fails without the warning prefix", async () => {
    const fixture = pinnedProject({ name: "yarn", onFail: "error" });

    const result = await run(["pnpm", "--version"], fixture);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      `"packageManager" field is set to "${PIN}" which does not match the "devEngines.packageManager" field set to "yarn"\n`,
    );
  });

  it("33: a name mismatch with onFail omitted behaves identically to onFail: error", async () => {
    const fixture = pinnedProject({ name: "yarn" });

    const result = await run(["pnpm", "--version"], fixture);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      `"packageManager" field is set to "${PIN}" which does not match the "devEngines.packageManager" field set to "yarn"\n`,
    );
  });

  it("34: a version-range mismatch with onFail: warn warns and continues", async () => {
    const fixture = pinnedProject({ name: "pnpm", version: "10.x", onFail: "warn" });

    const result = await run(["pnpm", "--version"], fixture);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe(
      `! jup validation warning: "packageManager" field is set to "${PIN}" which does not match the value defined in "devEngines.packageManager" for "pnpm" of "10.x"\n`,
    );
    expect(result.stdout).toBe("6.6.2\n");
  });

  it("35: a version-range mismatch with no onFail fails", async () => {
    const fixture = pinnedProject({ name: "pnpm", version: "10.x" });

    const result = await run(["pnpm", "--version"], fixture);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      `"packageManager" field is set to "${PIN}" which does not match the value defined in "devEngines.packageManager" for "pnpm" of "10.x"\n`,
    );
  });

  it("36: an explicit CLI version outside the devEngines range wins", async () => {
    const fixture = createFixture({
      devEngines: { packageManager: { name: "npm", version: "^10.7.0" } },
    });
    seedPackageManager(fixture.home, "npm", "6.14.2");

    const result = await run(["npm@6.14.2", "--version"], fixture);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("6.14.2\n");
    expect(result.stderr).toBe("");
  });

  it("37: conflicting hashes — packageManager's hash is authoritative", async () => {
    const fixture = createFixture({
      packageManager: "pnpm@6.6.2+sha1.11111",
      devEngines: { packageManager: { name: "pnpm", version: "6.6.2+sha1.22222" } },
    });
    const actual = createHash("sha1").update(registry.tarballOf("pnpm", "6.6.2")).digest("hex");

    const result = await run(["pnpm", "--version"], {
      ...fixture,
      registry,
      env: { COREPACK_INTEGRITY_KEYS: registry.trustStore() },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`Mismatch hashes. Expected 11111, got ${actual}`);
  });
});
