/**
 * §03.7 — one logical pin, updated atomically (rows 189–190).
 *
 * #874: `corepack use pnpm@latest` on a devEngines-only project writes a
 * top-level `packageManager` that then conflicts with the declaration beside it,
 * and §03.3 rejects on the next read — a mutating command creating the very
 * mismatch the reader refuses. Fix PR #880 is open.
 *
 * Every row here re-runs the tool after the write, because "the manifest looks
 * right" and "the manifest reads back" are different claims and only the second
 * one is the requirement.
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

function manifestOf(fixture: { json(relative: string): unknown }): {
  packageManager?: string;
  devEngines?: { packageManager?: { name?: string; version?: string; integrity?: string } };
} {
  return fixture.json("package.json") as ReturnType<typeof manifestOf>;
}

beforeAll(async () => {
  await registry.start();
  for (const version of ["10.0.0", "11.0.0", "11.1.2"]) {
    registry.publish("pnpm", version, packageManagerTarball("pnpm", version), {
      distTags: { latest: "11.1.2" },
    });
  }
});

afterAll(async () => {
  cleanupFixtures();
  await registry.stop();
});

beforeEach(() => registry.reset());

describe("§03.7 atomic pin updates", () => {
  it("189: `use` on a devEngines-only project updates devEngines and creates no packageManager", async () => {
    const fixture = createFixture({
      name: "project",
      devEngines: { packageManager: { name: "pnpm", version: "^11.0.0" } },
    });

    const result = await run(["use", "pnpm@latest"], { ...fixture, registry, env: env() });

    expect(result.exitCode).toBe(0);

    const written = manifestOf(fixture);
    expect(written.packageManager).toBeUndefined();
    expect(written.devEngines?.packageManager).toEqual({
      name: "pnpm",
      // §03.7's shape: the field stays a valid semver range, and the digest
      // lives beside it rather than as a `+sha512.…` suffix inside it.
      version: "11.1.2",
      integrity: expect.stringMatching(/^sha512-[\d+/A-Za-z]+=*$/),
    });

    // The requirement, not the appearance: the project reads back cleanly.
    registry.reset();
    const rerun = await run(["pnpm", "--version"], { ...fixture, registry, env: env() });
    expect(rerun.exitCode).toBe(0);
    expect(rerun.stdout).toBe("11.1.2\n");
    expect(rerun.stderr).toBe("");
  });

  it("189: the surgical edit leaves the rest of the manifest alone", async () => {
    const fixture = createFixture(
      `{\n  "name": "project",\n  "devEngines": {\n    "packageManager": {\n      "name": "pnpm",\n      "version": "^11.0.0"\n    }\n  },\n  "scripts": {\n    "build": "tsc"\n  }\n}\n`,
    );

    expect((await run(["use", "pnpm@11.1.2"], { ...fixture, registry, env: env() })).exitCode).toBe(
      0,
    );

    const text = fixture.read("package.json");
    // Key order, two-space indent, and the nested member's own indentation.
    expect(text.indexOf(`"name": "project"`)).toBeLessThan(text.indexOf(`"devEngines"`));
    expect(text.indexOf(`"devEngines"`)).toBeLessThan(text.indexOf(`"scripts"`));
    expect(text).toContain(`      "version": "11.1.2"`);
    expect(text).toContain(`      "integrity": "sha512-`);
    expect(text).toContain(`    "build": "tsc"`);
  });

  it("190: with both fields, an exact devEngines version is a pin and is updated too", async () => {
    // The #874 shape: two fields that both name one release, differing only in
    // whether they carry the digest. Left un-updated, the devEngines value
    // pins 11.0.0 while `packageManager` says 11.1.2.
    const fixture = createFixture({
      name: "project",
      packageManager: "pnpm@11.0.0",
      devEngines: { packageManager: { name: "pnpm", version: "11.0.0" } },
    });

    const result = await run(["use", "pnpm@11.1.2"], { ...fixture, registry, env: env() });

    expect(result.exitCode).toBe(0);

    const written = manifestOf(fixture);
    expect(written.packageManager).toMatch(/^pnpm@11\.1\.2\+sha512\./);
    expect(written.devEngines?.packageManager).toEqual({
      name: "pnpm",
      version: "11.1.2",
      integrity: expect.stringMatching(/^sha512-/),
    });

    registry.reset();
    const rerun = await run(["pnpm", "--version"], { ...fixture, registry, env: env() });
    expect(rerun.exitCode).toBe(0);
    expect(rerun.stdout).toBe("11.1.2\n");
    expect(rerun.stderr).toBe("");
  });

  it("190: a devEngines *range* is a constraint, honoured rather than collapsed", async () => {
    // The other half of the rule, and the reason §09.4 still works: a declared
    // range is what carries `corepack up` across a major boundary, so rewriting
    // it into the version just chosen would silently narrow the project.
    const fixture = createFixture({
      name: "project",
      packageManager: "pnpm@11.0.0",
      devEngines: { packageManager: { name: "pnpm", version: "^11.0.0" } },
    });

    const result = await run(["use", "pnpm@11.1.2"], { ...fixture, registry, env: env() });

    expect(result.exitCode).toBe(0);

    const written = manifestOf(fixture);
    expect(written.packageManager).toMatch(/^pnpm@11\.1\.2\+sha512\./);
    expect(written.devEngines?.packageManager).toEqual({ name: "pnpm", version: "^11.0.0" });

    registry.reset();
    const rerun = await run(["pnpm", "--version"], { ...fixture, registry, env: env() });
    expect(rerun.exitCode).toBe(0);
    expect(rerun.stderr).toBe("");
  });

  it("190: a declared range is still enforced — it is not silently rewritten away", async () => {
    const fixture = createFixture({
      name: "project",
      devEngines: { packageManager: { name: "pnpm", version: "^11.0.0" } },
    });

    // 10.0.0 is outside the declared range, and nothing about §03.7 makes that
    // acceptable: the constraint is the user's statement, and the default
    // `onFail` is an error (§03.3).
    const outside = await run(["use", "pnpm@10.0.0"], { ...fixture, registry, env: env() });

    expect(outside.exitCode).toBe(1);
    expect(outside.stdout).toContain("does not match the devEngines specification (pnpm@^11.0.0)");
    // Nothing was written: the declaration is exactly as the user left it.
    expect(manifestOf(fixture).devEngines?.packageManager).toEqual({
      name: "pnpm",
      version: "^11.0.0",
    });
  });

  it("189: `use` collapses a declared range into a pin, as it does for `packageManager`", async () => {
    // Consistency rather than a special case: `corepack use pnpm@latest` against
    // `packageManager: "pnpm@^11.0.0"` also replaces the range with the exact
    // release it chose. Pinning is the command's whole purpose.
    const fixture = createFixture({
      name: "project",
      devEngines: { packageManager: { name: "pnpm", version: "^11.0.0" } },
    });

    expect((await run(["use", "pnpm@latest"], { ...fixture, registry, env: env() })).exitCode).toBe(
      0,
    );

    expect(manifestOf(fixture).devEngines?.packageManager?.version).toBe("11.1.2");
  });

  it("189: a devEngines block naming a *different* package manager is not a write target", async () => {
    // §03.7 is about the pin's own fields. A declaration for another tool is a
    // conflict to report (§03.3's name check), not a field to overwrite — and
    // before this it imposed nothing at all, because `writePin` only reached the
    // check through a declared *version*.
    const fixture = createFixture({
      name: "project",
      devEngines: { packageManager: { name: "yarn" } },
    });

    const result = await run(["use", "pnpm@11.1.2"], { ...fixture, registry, env: env() });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("does not match the devEngines specification (yarn@*)");
    expect(manifestOf(fixture).packageManager).toBeUndefined();
    expect(manifestOf(fixture).devEngines?.packageManager).toEqual({ name: "yarn" });
  });
});
