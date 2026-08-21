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

/** A project pinned to {@link PIN} with `pnpm@6.6.2` already in its store. */
function pinnedProject(devEngines: unknown, pin: unknown = PIN) {
  const manifest: Record<string, unknown> = { devEngines: { packageManager: devEngines } };
  if (pin !== undefined) manifest.packageManager = pin;
  const fixture = createFixture(manifest);
  seedPackageManager(fixture.home, "pnpm", "6.6.2");
  return fixture;
}

describe("§13.4 devEngines", () => {
  it("22: {name: yarn} with no packageManager needs an exact version", async () => {
    const fixture = createFixture({ devEngines: { packageManager: { name: "yarn" } } });

    const result = await run(["yarn", "--version"], fixture);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      `Invalid package manager specification in package.json (yarn@*); expected a semver version\n`,
    );
  });

  it("23: {name: pnpm, version: 6.x} with no packageManager needs an exact version", async () => {
    const fixture = createFixture({
      devEngines: { packageManager: { name: "pnpm", version: "6.x" } },
    });

    const result = await run(["pnpm", "--version"], fixture);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      `Invalid package manager specification in package.json (pnpm@6.x); expected a semver version\n`,
    );
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
      `! Corepack does not currently support array values for devEngines.packageManager\n`,
    );
    expect(result.stdout).toBe("6.6.2\n");
  });

  it("28: a string value warns unconditionally and is ignored", async () => {
    const fixture = pinnedProject("pnpm@10.x");

    const result = await run(["pnpm", "--version"], fixture);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe(
      `! Corepack only supports objects as valid value for devEngines.packageManager. The current value ("pnpm@10.x") will be ignored.\n`,
    );
  });

  it("29: a number value warns unconditionally and is ignored", async () => {
    const fixture = pinnedProject(10);

    const result = await run(["pnpm", "--version"], fixture);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe(
      `! Corepack only supports objects as valid value for devEngines.packageManager. The current value (10) will be ignored.\n`,
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
      `! Corepack validation warning: "packageManager" field is set to "${PIN}" which does not match the "devEngines.packageManager" field set to "yarn"\n`,
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
      `! Corepack validation warning: "packageManager" field is set to "${PIN}" which does not match the value defined in "devEngines.packageManager" for "pnpm" of "10.x"\n`,
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
