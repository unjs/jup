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
    // §03.7 — the member's `version` is read as a semver range, so the digest
    // goes beside it as SRI. Row 169 owns that spelling and its opt-out.
    expect(written.devEngines?.packageManager).toEqual({
      name: "pnpm",
      version: "11.1.2",
      integrity: expect.stringMatching(/^sha512-/),
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

  // §03.7 reversed this row. While `packageManager` carried the pin and won the
  // read, a declared range beside it was a statement of intent worth keeping.
  // Now the member *is* the pin, so a range left there would be what the next
  // run resolves — and `use pnpm@11.1.2` would never have taken. §09.4's
  // cross-major `up` is unaffected: on a range descriptor it refreshes
  // `jup.lock` and writes no pin, so only an explicit `use` reaches this path.
  it("190: an explicit `use` replaces a declared range with the version it pinned", async () => {
    const fixture = createFixture({
      name: "project",
      packageManager: "pnpm@11.0.0",
      devEngines: { packageManager: { name: "pnpm", version: "^11.0.0" } },
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
    expect(rerun.stderr).toBe("");
  });

  // §03.7 reversed this row too, and for the same reason as row 190 above. The
  // declared range was a pure constraint only while `packageManager` carried the
  // pin; now the member *is* the pin, and `use` replaces pins. Left enforced,
  // the range `jup use pnpm@^11.0.0` writes would refuse the very next
  // `jup use pnpm@10.0.0`, with nothing but a hand edit to get out.
  it("190: an explicit `use` moves the pin outside a declared range", async () => {
    const fixture = createFixture({
      name: "project",
      devEngines: { packageManager: { name: "pnpm", version: "^11.0.0" } },
    });

    const outside = await run(["use", "pnpm@10.0.0"], { ...fixture, registry, env: env() });

    expect(outside.exitCode).toBe(0);
    expect(manifestOf(fixture).devEngines?.packageManager).toEqual({
      name: "pnpm",
      version: "10.0.0",
      integrity: expect.stringMatching(/^sha512-/),
    });

    // And the project reads back cleanly at the version it was moved to.
    registry.reset();
    const rerun = await run(["pnpm", "--version"], { ...fixture, registry, env: env() });
    expect(rerun.exitCode).toBe(0);
    expect(rerun.stdout).toBe("10.0.0\n");
    expect(rerun.stderr).toBe("");
  });

  // The surviving guard: a member naming *another* tool is a statement no write
  // can make true, so §03.7 refuses rather than overwriting it.
  it("190: a member naming another package manager still refuses the pin", async () => {
    const fixture = createFixture({
      name: "project",
      devEngines: { packageManager: { name: "yarn", version: "^1.0.0" } },
    });

    const result = await run(["use", "pnpm@11.1.2"], { ...fixture, registry, env: env() });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("does not match the devEngines specification (yarn@^1.0.0)");
    expect(manifestOf(fixture).packageManager).toBeUndefined();
    expect(manifestOf(fixture).devEngines?.packageManager).toEqual({
      name: "yarn",
      version: "^1.0.0",
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
