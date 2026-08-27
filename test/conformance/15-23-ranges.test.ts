/**
 * §15.23 — ranges in the pin, and `.jup.lock` (rows 181–183).
 *
 * The reconciliation the corepack tracker circled for four years: a range is
 * what a human writes, and a recorded resolution is what makes it reproducible.
 * Row 182 is the load-bearing one — a recorded resolution that still satisfies
 * its range must resolve with **no network at all**, so it is asserted against
 * the mock's own request log rather than against a successful exit.
 */

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupFixtures,
  createFixture,
  MockRegistry,
  packageManagerTarball,
  run,
  seedPackageManager,
  sriOf,
} from "./_harness/index.ts";

const registry = new MockRegistry();

function env(extra?: Record<string, string | undefined>): Record<string, string | undefined> {
  // Every row here downloads for real, so the mock's key has to be trusted; `CI`
  // is spelled out in both directions because it is what decides the
  // frozen-lockfile default, and the harness scrubs it from the parent process.
  return { COREPACK_INTEGRITY_KEYS: registry.trustStore(), CI: undefined, ...extra };
}

/** The lockfile as the tool wrote it, parsed. */
function lockOf(fixture: { json(relative: string): unknown }): {
  version: number;
  resolutions: Record<string, { resolved: string; integrity?: string }>;
} {
  return fixture.json(".jup.lock") as {
    version: number;
    resolutions: Record<string, { resolved: string; integrity?: string }>;
  };
}

beforeAll(async () => {
  await registry.start();

  for (const version of ["10.5.0", "11.0.0", "11.1.2"]) {
    registry.publish("pnpm", version, packageManagerTarball("pnpm", version));
  }
});

afterAll(async () => {
  cleanupFixtures();
  await registry.stop();
});

beforeEach(() => registry.reset());

describe("§15.23 ranges and .jup.lock", () => {
  it("181: a range pin resolves, and records the version and its integrity", async () => {
    const fixture = createFixture({ packageManager: "pnpm@^11.0.0" });

    const result = await run(["pnpm", "--version"], { ...fixture, registry, env: env() });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("11.1.2\n");
    expect(result.stderr).toBe("");

    // The recorded digest is the one the install path verified — the sha512 of
    // the bytes the registry actually served — so the next run pins them.
    expect(lockOf(fixture)).toEqual({
      version: 1,
      resolutions: {
        "pnpm@^11.0.0": {
          resolved: "11.1.2",
          integrity: sriOf(registry.tarballOf("pnpm", "11.1.2")),
        },
      },
    });

    // Human-diffable, and stable: two-space indent, one key per line, trailing
    // newline. Re-recording an unchanged resolution must not churn the file.
    expect(fixture.read(".jup.lock")).toBe(`${JSON.stringify(lockOf(fixture), undefined, 2)}\n`);
  });

  it("182: a second run with that lockfile present makes no network request", async () => {
    const fixture = createFixture({ packageManager: "pnpm@^11.0.0" });

    const first = await run(["pnpm", "--version"], { ...fixture, registry, env: env() });
    expect(first.exitCode).toBe(0);
    expect(registry.requests.length).toBeGreaterThan(0);

    const before = fixture.read(".jup.lock");
    registry.reset();

    const second = await run(["pnpm", "--version"], { ...fixture, registry, env: env() });

    expect(second.exitCode).toBe(0);
    expect(second.stdout).toBe("11.1.2\n");
    expect(second.stderr).toBe("");
    // §01.3's fast-path budget, extended to ranges: not one request, of any kind.
    expect(registry.requests).toEqual([]);
    // And nothing was rewritten, so the file stays out of `git status`.
    expect(fixture.read(".jup.lock")).toBe(before);
  });

  it("183: a range with no lockfile and COREPACK_FROZEN_LOCKFILE=1 is refused", async () => {
    const fixture = createFixture({ packageManager: "pnpm@^11.0.0" });

    const result = await run(["pnpm", "--version"], {
      ...fixture,
      registry,
      env: env({ COREPACK_FROZEN_LOCKFILE: "1" }),
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      `pnpm@^11.0.0 is not resolved in .jup.lock and lockfile updates are disabled.\n`,
    );
    expect(result.stdout).toBe("");
    // Refused *before* the registry was consulted: a frozen lockfile is a
    // statement about the network as much as about the file.
    expect(registry.requests).toEqual([]);
    expect(fixture.exists(".jup.lock")).toBe(false);
  });

  it("183: CI defaults to frozen, and an explicit value wins in both directions", async () => {
    const inCI = createFixture({ packageManager: "pnpm@^11.0.0" });
    const refused = await run(["pnpm", "--version"], {
      ...inCI,
      registry,
      env: env({ CI: "1" }),
    });

    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toBe(
      `pnpm@^11.0.0 is not resolved in .jup.lock and lockfile updates are disabled.\n`,
    );

    // `COREPACK_FROZEN_LOCKFILE=0` thaws it again, inside CI and out.
    const thawed = createFixture({ packageManager: "pnpm@^11.0.0" });
    const allowed = await run(["pnpm", "--version"], {
      ...thawed,
      registry,
      env: env({ CI: "1", COREPACK_FROZEN_LOCKFILE: "0" }),
    });

    expect(allowed.exitCode).toBe(0);
    expect(allowed.stdout).toBe("11.1.2\n");
    expect(lockOf(thawed).resolutions["pnpm@^11.0.0"]?.resolved).toBe("11.1.2");
  });

  it("183: a frozen lockfile that *does* resolve the range still runs, offline", async () => {
    const fixture = createFixture({ packageManager: "pnpm@^11.0.0" });
    expect((await run(["pnpm", "--version"], { ...fixture, registry, env: env() })).exitCode).toBe(
      0,
    );
    registry.reset();

    const result = await run(["pnpm", "--version"], {
      ...fixture,
      registry,
      env: env({ COREPACK_FROZEN_LOCKFILE: "1", CI: "1" }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("11.1.2\n");
    expect(registry.requests).toEqual([]);
  });

  it("re-resolves when the recorded version no longer satisfies the range", async () => {
    const fixture = createFixture({ packageManager: "pnpm@^11.0.0" });
    fixture.write(
      ".jup.lock",
      `${JSON.stringify({ version: 1, resolutions: { "pnpm@^11.0.0": { resolved: "10.5.0" } } })}\n`,
    );

    const result = await run(["pnpm", "--version"], { ...fixture, registry, env: env() });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("11.1.2\n");
    expect(lockOf(fixture).resolutions["pnpm@^11.0.0"]?.resolved).toBe("11.1.2");
  });

  it("uses the recorded integrity as a pin: wrong bytes fail the same way a bad pin does", async () => {
    const fixture = createFixture({ packageManager: "pnpm@^11.0.0" });
    const wrong = sriOf(registry.tarballOf("pnpm", "11.0.0"));
    fixture.write(
      ".jup.lock",
      `${JSON.stringify({
        version: 1,
        resolutions: { "pnpm@^11.0.0": { resolved: "11.1.2", integrity: wrong } },
      })}\n`,
    );

    const result = await run(["pnpm", "--version"], { ...fixture, registry, env: env() });

    // Recording a digest that is never checked would buy reproducibility and no
    // integrity at all; §15.23 asks for both.
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Mismatch hashes. Expected");
  });

  it("leaves an exact pin alone: no read, no write, no lockfile", async () => {
    const fixture = createFixture({ packageManager: "pnpm@11.1.2" });
    seedPackageManager(fixture.home, "pnpm", "11.1.2");
    // A resolution that would send an exact pin somewhere else entirely, so a
    // run that consulted the file at all could not answer 11.1.2.
    const planted = `${JSON.stringify({
      version: 1,
      resolutions: { "pnpm@11.1.2": { resolved: "10.5.0" } },
    })}\n`;
    fixture.write(".jup.lock", planted);

    const result = await run(["pnpm", "--version"], { ...fixture, registry, env: env() });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("11.1.2\n");
    expect(registry.requests).toEqual([]);
    expect(fixture.read(".jup.lock")).toBe(planted);
  });

  it("writes no lockfile for a project that pins exactly", async () => {
    const fixture = createFixture({ packageManager: "pnpm@11.1.2" });
    seedPackageManager(fixture.home, "pnpm", "11.1.2");

    expect((await run(["pnpm", "--version"], { ...fixture, registry, env: env() })).exitCode).toBe(
      0,
    );
    expect(fixture.exists(".jup.lock")).toBe(false);
  });

  it("degrades to a normal resolution when the lockfile is unreadable or unknown", async () => {
    for (const content of [
      "{ not json",
      `{"version":2,"resolutions":{"pnpm@^11.0.0":{"resolved":"10.5.0"}}}`,
      `[]`,
      `{"version":1,"resolutions":{"pnpm@^11.0.0":{"resolved":42}}}`,
    ]) {
      const fixture = createFixture({ packageManager: "pnpm@^11.0.0" });
      fixture.write(".jup.lock", content);

      const result = await run(["pnpm", "--version"], { ...fixture, registry, env: env() });

      expect(result.exitCode, content).toBe(0);
      expect(result.stdout).toBe("11.1.2\n");
      // Rewritten in the canonical shape, rather than left broken.
      expect(lockOf(fixture).resolutions["pnpm@^11.0.0"]?.resolved).toBe("11.1.2");
    }
  });

  it("does not record a CLI version override, even a range one", async () => {
    const fixture = createFixture({ packageManager: "pnpm@^11.0.0" });

    const result = await run(["pnpm@^10.0.0", "--version"], { ...fixture, registry, env: env() });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("10.5.0\n");
    // `pnpm@^10.0.0 …` is one invocation (§04.6), not a statement about the
    // project, and the project's own range is not what it resolved either.
    expect(fixture.exists(".jup.lock")).toBe(false);
  });

  it("does not record a fallback version in the project that fell back", async () => {
    // A name mismatch under `COREPACK_ENABLE_STRICT=0` runs the *machine's*
    // yarn, not the project's pnpm. Nothing about that answer belongs in this
    // project's lockfile — the recorded default supplies it, and §04.4 tolerates
    // whatever that file happens to say.
    const fixture = createFixture({ packageManager: "pnpm@^11.0.0" });
    seedPackageManager(fixture.home, "yarn", "1.22.4");
    writeFileSync(join(fixture.home, "lastKnownGood.json"), `{"yarn":"^1.0.0"}\n`);

    const result = await run(["yarn", "--version"], {
      ...fixture,
      registry,
      env: env({ COREPACK_ENABLE_STRICT: "0" }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("1.22.4\n");
    expect(fixture.exists(".jup.lock")).toBe(false);
  });

  it("leaves a recorded resolution exactly as the project wrote it", async () => {
    const fixture = createFixture({ packageManager: "pnpm@^11.0.0" });
    // Hand-written: compact, and carrying no digest. §15.23 refreshes a
    // resolution only on `corepack up`, so a run that merely *uses* one must not
    // rewrite the file — not to reformat it, and not to add what it now knows.
    const planted = `{"version":1,"resolutions":{"pnpm@^11.0.0":{"resolved":"11.1.2"}}}\n`;
    fixture.write(".jup.lock", planted);

    const result = await run(["pnpm", "--version"], { ...fixture, registry, env: env() });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("11.1.2\n");
    expect(fixture.read(".jup.lock")).toBe(planted);
  });

  it("records the resolution beside the manifest that declared it, not beside the cwd", async () => {
    const fixture = createFixture({ packageManager: "pnpm@^11.0.0" });
    fixture.write("packages/app/keep.txt", "");

    const result = await run(["pnpm", "--version"], {
      ...fixture,
      cwd: fixture.path("packages/app"),
      registry,
      env: env(),
    });

    expect(result.exitCode).toBe(0);
    expect(fixture.exists("packages/app/.jup.lock")).toBe(false);
    expect(lockOf(fixture).resolutions["pnpm@^11.0.0"]?.resolved).toBe("11.1.2");
  });

  it("accepts a range in both packageManager and devEngines — the pnpm 11.21 shape", async () => {
    const fixture = createFixture({
      packageManager: "pnpm@^11.0.0",
      devEngines: { packageManager: { name: "pnpm", version: ">=11", onFail: "error" } },
    });

    const result = await run(["pnpm", "--version"], { ...fixture, registry, env: env() });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("11.1.2\n");
    expect(result.stderr).toBe("");
    expect(lockOf(fixture).resolutions["pnpm@^11.0.0"]?.resolved).toBe("11.1.2");
  });

  it("install warms the cache with the recorded version, not the newest match", async () => {
    const fixture = createFixture({ packageManager: "pnpm@^11.0.0" });
    fixture.write(
      ".jup.lock",
      `${JSON.stringify({ version: 1, resolutions: { "pnpm@^11.0.0": { resolved: "11.0.0" } } })}\n`,
    );

    const result = await run(["install"], { ...fixture, registry, env: env() });

    // Caching 11.1.2 here and then running 11.0.0 offline is the whole failure
    // mode `install` exists to prevent (§09.2 — "warming a Docker layer").
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("Adding pnpm@11.0.0 to the cache...\n");
    expect(existsSync(join(fixture.home, "v1", "pnpm", "11.0.0"))).toBe(true);
    expect(existsSync(join(fixture.home, "v1", "pnpm", "11.1.2"))).toBe(false);
  });

  it("install looks the resolution up under the pin's key, not the devEngines range", async () => {
    const fixture = createFixture({
      packageManager: "pnpm@^11.0.0",
      devEngines: { packageManager: { name: "pnpm", version: ">=10", onFail: "error" } },
    });
    fixture.write(
      ".jup.lock",
      `${JSON.stringify({ version: 1, resolutions: { "pnpm@^11.0.0": { resolved: "11.0.0" } } })}\n`,
    );

    const result = await run(["install"], { ...fixture, registry, env: env() });

    // §09.1 lets a `devEngines` range outrank the pin for `up`, and that is the
    // descriptor `install` inherits — but the key the *proxy* path will look up
    // is the pin's, and warming the cache under any other key warms the wrong
    // version.
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("Adding pnpm@11.0.0 to the cache...\n");
  });

  it("up refreshes the recorded resolution and keeps the range in the manifest", async () => {
    const fixture = createFixture({ packageManager: "pnpm@^11.0.0" });
    fixture.write(
      ".jup.lock",
      `${JSON.stringify({ version: 1, resolutions: { "pnpm@^11.0.0": { resolved: "11.0.0" } } })}\n`,
    );

    const result = await run(["up"], { ...fixture, registry, env: env() });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Installing pnpm@11.1.2 in the project...");
    // The range is the user's own statement of intent; `up` updates what it
    // resolved to, not what they wrote.
    expect((fixture.json("package.json") as { packageManager: string }).packageManager).toBe(
      "pnpm@^11.0.0",
    );
    expect(lockOf(fixture).resolutions["pnpm@^11.0.0"]).toEqual({
      resolved: "11.1.2",
      integrity: sriOf(registry.tarballOf("pnpm", "11.1.2")),
    });
  });

  it("up refuses to refresh under an explicit COREPACK_FROZEN_LOCKFILE=1", async () => {
    const fixture = createFixture({ packageManager: "pnpm@^11.0.0" });

    const frozen = await run(["up"], {
      ...fixture,
      registry,
      env: env({ COREPACK_FROZEN_LOCKFILE: "1" }),
    });

    expect(frozen.exitCode).toBe(1);
    expect(frozen.stdout).toContain(
      `Usage Error: pnpm@^11.0.0 is not resolved in .jup.lock and lockfile updates are disabled.`,
    );

    // But CI on its own does not block a command the user ran *to* refresh it.
    const inCI = await run(["up"], { ...fixture, registry, env: env({ CI: "1" }) });
    expect(inCI.exitCode).toBe(0);
    expect(lockOf(fixture).resolutions["pnpm@^11.0.0"]?.resolved).toBe("11.1.2");
  });

  it("use replaces a range with an exact pin and retires its resolution", async () => {
    const fixture = createFixture({ packageManager: "pnpm@^10.0.0" });

    const first = await run(["pnpm", "--version"], { ...fixture, registry, env: env() });
    expect(first.exitCode).toBe(0);
    expect(lockOf(fixture).resolutions["pnpm@^10.0.0"]?.resolved).toBe("10.5.0");

    const used = await run(["use", "pnpm@11.1.2"], { ...fixture, registry, env: env() });

    expect(used.exitCode).toBe(0);
    expect((fixture.json("package.json") as { packageManager: string }).packageManager).toMatch(
      /^pnpm@11\.1\.2\+sha512\./,
    );
    // The last resolution went with the range it belonged to, and an empty
    // resolution map is no file at all.
    expect(fixture.exists(".jup.lock")).toBe(false);
  });
});
