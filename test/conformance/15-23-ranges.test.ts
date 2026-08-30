/**
 * §04.4 — ranges in the pin, `jup.lock`, and the memo beside it (rows 181–183,
 * 256–258).
 *
 * The reconciliation the corepack tracker circled for four years: a range is
 * what a human writes, and a recorded resolution is what makes it reproducible.
 * Two rules split the file in two here, and most of the rows below exist to hold
 * one of them:
 *
 * * the project's `jup.lock` is written by `use` and `up` and by nothing else,
 *   so running a package manager can never change what the project runs on;
 * * an ordinary run memoes its resolution in `node_modules/.jup/jup.lock`
 *   instead,
 *   which keeps a range off the network without committing anybody to anything.
 *
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
  effectivePin,
  MockRegistry,
  packageManagerTarball,
  run,
  seedPackageManager,
  sriOf,
  withoutDownloadNotices,
} from "./_harness/index.ts";

const registry = new MockRegistry();

function env(extra?: Record<string, string | undefined>): Record<string, string | undefined> {
  // Every row here downloads for real, so the mock's key has to be trusted; `CI`
  // is spelled out in both directions because it is what decides the
  // frozen-lockfile default, and the harness scrubs it from the parent process.
  return { COREPACK_INTEGRITY_KEYS: registry.trustStore(), CI: undefined, ...extra };
}

interface Lockfile {
  version: number;
  resolutions: Record<string, { resolved: string; integrity?: string; expires?: number }>;
}

/** The recorded lockfile as the tool wrote it, parsed. */
function lockOf(fixture: { json(relative: string): unknown }): Lockfile {
  return fixture.json("jup.lock") as Lockfile;
}

/** The memo an ordinary run leaves in `node_modules/.jup`, parsed. */
function memoOf(fixture: { json(relative: string): unknown }): Lockfile {
  return fixture.json(MEMO) as Lockfile;
}

/**
 * Inside a dot-prefixed directory, because npm reads a visible entry in
 * `node_modules` as an installed package: a memo at `node_modules/jup.lock` is
 * `jup.lock@ extraneous` to `npm ls` and is deleted by the next `npm install` —
 * destroyed, with a `removed 1 package` line to show for it, by the very command
 * jup is there to run.
 */
const MEMO = "node_modules/.jup/jup.lock";

/**
 * A project that already has a `node_modules`, which is the only condition under
 * which jup memoes anything: the directory belongs to the package manager and
 * jup never conjures it into existence (§04.4).
 */
function withModules(manifest: unknown): ReturnType<typeof createFixture> {
  const fixture = createFixture(manifest);
  fixture.write("node_modules/.keep", "");
  return fixture;
}

/** A recorded resolution, hand-written the way `use` would have left it. */
function record(
  fixture: { write(relative: string, content: string): string },
  key: string,
  resolved: string,
  integrity?: string,
): void {
  fixture.write(
    "jup.lock",
    `${JSON.stringify(
      {
        version: 1,
        resolutions: { [key]: integrity === undefined ? { resolved } : { resolved, integrity } },
      },
      undefined,
      2,
    )}\n`,
  );
}

beforeAll(async () => {
  await registry.start();

  for (const version of ["10.5.0", "11.0.0", "11.1.2"]) {
    registry.publish("pnpm", version, packageManagerTarball("pnpm", version));
  }
  registry.publish("pnpm", "11.1.2", packageManagerTarball("pnpm", "11.1.2"), {
    distTags: { latest: "11.1.2" },
  });
});

afterAll(async () => {
  cleanupFixtures();
  await registry.stop();
});

beforeEach(() => registry.reset());

describe("§04.4 ranges and jup.lock", () => {
  it("181: `use` with a range keeps the range and records what it resolved to", async () => {
    const fixture = createFixture({ name: "demo" });

    const result = await run(["use", "pnpm@^11.0.0"], { ...fixture, registry, env: env() });

    expect(result.exitCode).toBe(0);
    // The range is the statement of intent, so the pin goes on making it.
    expect(effectivePin(fixture.json("package.json"))).toBe("pnpm@^11.0.0");
    expect(result.stdout).toContain(`Updated ${fixture.path("package.json")} to use pnpm@^11.0.0`);
    expect(result.stdout).toContain(`Updated ${fixture.path("jup.lock")} to use pnpm@11.1.2`);

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
    expect(fixture.read("jup.lock")).toBe(`${JSON.stringify(lockOf(fixture), undefined, 2)}\n`);
  });

  it("181: an exact `use` still pins exactly, and records nothing", async () => {
    const fixture = createFixture({ name: "demo" });

    const result = await run(["use", "pnpm@11.1.2"], { ...fixture, registry, env: env() });

    expect(result.exitCode).toBe(0);
    expect(effectivePin(fixture.json("package.json"))).toMatch(/^pnpm@11\.1\.2\+sha512\./);
    expect(fixture.exists("jup.lock")).toBe(false);
  });

  it("181: a dist-tag is a question, not a statement: `use pnpm@latest` pins exactly", async () => {
    const fixture = createFixture({ name: "demo" });

    const result = await run(["use", "pnpm@latest"], { ...fixture, registry, env: env() });

    expect(result.exitCode).toBe(0);
    expect(effectivePin(fixture.json("package.json"))).toMatch(/^pnpm@11\.1\.2\+sha512\./);
    expect(fixture.exists("jup.lock")).toBe(false);
  });

  it("182: a run with that lockfile present makes no network request", async () => {
    const fixture = withModules({ packageManager: "pnpm@^11.0.0" });

    const first = await run(["use", "pnpm@^11.0.0"], { ...fixture, registry, env: env() });
    expect(first.exitCode).toBe(0);
    expect(registry.requests.length).toBeGreaterThan(0);

    const before = fixture.read("jup.lock");
    registry.reset();

    const second = await run(["pnpm", "--version"], { ...fixture, registry, env: env() });

    expect(second.exitCode).toBe(0);
    expect(second.stdout).toBe("11.1.2\n");
    expect(second.stderr).toBe("");
    // §01.3's fast-path budget, extended to ranges: not one request, of any kind.
    expect(registry.requests).toEqual([]);
    // And nothing was rewritten, so the file stays out of `git status` — nor was
    // a memo written for an answer the recorded file already gave.
    expect(fixture.read("jup.lock")).toBe(before);
    expect(fixture.exists(MEMO)).toBe(false);
  });

  it("183: an unrecorded range resolves, and memoes it rather than the project", async () => {
    const fixture = withModules({ packageManager: "pnpm@^11.0.0" });

    const result = await run(["pnpm", "--version"], { ...fixture, registry, env: env() });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("11.1.2\n");
    expect(withoutDownloadNotices(result.stderr)).toBe("");

    // The project's own file is untouched: running a package manager is not a
    // decision about what the project runs on, and `git status` says so.
    expect(fixture.exists("jup.lock")).toBe(false);

    // The memo goes inside `.jup`, never loose in `node_modules`: npm reads a
    // visible entry there as an installed package, reports it as
    // `jup.lock@ extraneous`, and deletes it on the next `install` — so a memo
    // written the other way would be destroyed by the very command jup exists to
    // run, and would never live long enough for its 24-hour window to matter.
    expect(fixture.exists("node_modules/jup.lock")).toBe(false);

    const memo = memoOf(fixture).resolutions["pnpm@^11.0.0"]!;
    expect(memo.resolved).toBe("11.1.2");
    expect(memo.integrity).toBe(sriOf(registry.tarballOf("pnpm", "11.1.2")));
    // Stamped, which is the difference between a memo and a record.
    expect(memo.expires).toBeGreaterThan(Date.now());
    expect(memo.expires).toBeLessThanOrEqual(Date.now() + 24 * 60 * 60 * 1000);
  });

  it("183: CI no longer freezes an ordinary run — there is nothing left to freeze", async () => {
    const inCI = withModules({ packageManager: "pnpm@^11.0.0" });

    const result = await run(["pnpm", "--version"], { ...inCI, registry, env: env({ CI: "1" }) });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("11.1.2\n");
    expect(inCI.exists("jup.lock")).toBe(false);
    expect(memoOf(inCI).resolutions["pnpm@^11.0.0"]?.resolved).toBe("11.1.2");
  });

  it("183: JUP_FROZEN_LOCKFILE=1 leaves an ordinary run alone", async () => {
    const fixture = withModules({ packageManager: "pnpm@^11.0.0" });
    seedPackageManager(fixture.home, "pnpm", "11.1.2");
    record(fixture, "pnpm@^11.0.0", "11.1.2");
    const before = fixture.read("jup.lock");

    const result = await run(["pnpm", "--version"], {
      ...fixture,
      registry,
      env: env({ JUP_FROZEN_LOCKFILE: "1", CI: "1" }),
    });

    // The variable governs `use` and `up`; a proxy run never writes the file it
    // names, so freezing it changes nothing about this path at all.
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("11.1.2\n");
    expect(registry.requests).toEqual([]);
    expect(fixture.read("jup.lock")).toBe(before);
  });

  it("256: a second run inside the memo's window makes no request either", async () => {
    const fixture = withModules({ packageManager: "pnpm@^11.0.0" });
    expect((await run(["pnpm", "--version"], { ...fixture, registry, env: env() })).exitCode).toBe(
      0,
    );
    const before = fixture.read(MEMO);
    registry.reset();

    const second = await run(["pnpm", "--version"], { ...fixture, registry, env: env() });

    expect(second.exitCode).toBe(0);
    expect(second.stdout).toBe("11.1.2\n");
    expect(registry.requests).toEqual([]);
    // An unexpired memo is not re-stamped: nothing was learned to write down.
    expect(fixture.read(MEMO)).toBe(before);
  });

  it("257: an expired memo is re-resolved", async () => {
    const fixture = withModules({ packageManager: "pnpm@^11.0.0" });
    fixture.write(
      MEMO,
      `${JSON.stringify({
        version: 1,
        resolutions: { "pnpm@^11.0.0": { resolved: "11.0.0", expires: Date.now() - 1000 } },
      })}\n`,
    );

    const result = await run(["pnpm", "--version"], { ...fixture, registry, env: env() });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("11.1.2\n");
    const memo = memoOf(fixture).resolutions["pnpm@^11.0.0"]!;
    expect(memo.resolved).toBe("11.1.2");
    expect(memo.expires).toBeGreaterThan(Date.now());
  });

  it("257: an expired memo still answers when the resolution cannot be made", async () => {
    const fixture = withModules({ packageManager: "pnpm@^11.0.0" });
    fixture.write(
      MEMO,
      `${JSON.stringify({
        version: 1,
        resolutions: { "pnpm@^11.0.0": { resolved: "11.1.2", expires: Date.now() - 1000 } },
      })}\n`,
    );
    const before = fixture.read(MEMO);

    // The packument 5xxs; version documents and tarballs are fine. The TTL
    // exists so a range keeps moving, not so an install stops working during
    // somebody else's incident (§04.4).
    registry.mode = "packument_error";
    const result = await run(["pnpm", "--version"], { ...fixture, registry, env: env() });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("11.1.2\n");
    // And the failed refresh did not extend the memo's life: an outage is not a
    // reason to believe a stale answer for another day.
    expect(fixture.read(MEMO)).toBe(before);
  });

  it("258: a project with no node_modules resolves, and has nothing created for it", async () => {
    const fixture = createFixture({ packageManager: "pnpm@^11.0.0" });

    const result = await run(["pnpm", "--version"], { ...fixture, registry, env: env() });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("11.1.2\n");
    // `node_modules` belongs to the package manager; jup does not conjure it.
    expect(fixture.exists("node_modules")).toBe(false);
    expect(fixture.exists("jup.lock")).toBe(false);
  });

  it("re-resolves when the recorded version no longer satisfies the range", async () => {
    const fixture = withModules({ packageManager: "pnpm@^11.0.0" });
    record(fixture, "pnpm@^11.0.0", "10.5.0");
    const before = fixture.read("jup.lock");

    const result = await run(["pnpm", "--version"], { ...fixture, registry, env: env() });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("11.1.2\n");
    // The run resolves around a record it cannot use, and memoes the answer —
    // but correcting the record is a decision, and decisions are `up`'s.
    expect(fixture.read("jup.lock")).toBe(before);
    expect(memoOf(fixture).resolutions["pnpm@^11.0.0"]?.resolved).toBe("11.1.2");
  });

  it("uses the recorded integrity as a pin: wrong bytes fail the same way a bad pin does", async () => {
    const fixture = createFixture({ packageManager: "pnpm@^11.0.0" });
    const wrong = sriOf(registry.tarballOf("pnpm", "11.0.0"));
    fixture.write(
      "jup.lock",
      `${JSON.stringify({
        version: 1,
        resolutions: { "pnpm@^11.0.0": { resolved: "11.1.2", integrity: wrong } },
      })}\n`,
    );

    const result = await run(["pnpm", "--version"], { ...fixture, registry, env: env() });

    // Recording a digest that is never checked would buy reproducibility and no
    // integrity at all; §04.4 asks for both.
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
    fixture.write("jup.lock", planted);

    const result = await run(["pnpm", "--version"], { ...fixture, registry, env: env() });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("11.1.2\n");
    expect(registry.requests).toEqual([]);
    expect(fixture.read("jup.lock")).toBe(planted);
  });

  it("writes no lockfile for a project that pins exactly", async () => {
    const fixture = createFixture({ packageManager: "pnpm@11.1.2" });
    seedPackageManager(fixture.home, "pnpm", "11.1.2");

    expect((await run(["pnpm", "--version"], { ...fixture, registry, env: env() })).exitCode).toBe(
      0,
    );
    expect(fixture.exists("jup.lock")).toBe(false);
  });

  const DAMAGED = [
    "{ not json",
    `{"version":2,"resolutions":{"pnpm@^11.0.0":{"resolved":"10.5.0"}}}`,
    `[]`,
    `{"version":1,"resolutions":{"pnpm@^11.0.0":{"resolved":42}}}`,
  ];

  it("degrades to a normal resolution when the recorded file is unreadable", async () => {
    for (const content of DAMAGED) {
      const fixture = withModules({ packageManager: "pnpm@^11.0.0" });
      fixture.write("jup.lock", content);

      const result = await run(["pnpm", "--version"], { ...fixture, registry, env: env() });

      expect(result.exitCode, content).toBe(0);
      expect(result.stdout).toBe("11.1.2\n");
      // The memo is written in the canonical shape; the project's own file is
      // left exactly as broken as it was, for its owner to fix.
      expect(memoOf(fixture).resolutions["pnpm@^11.0.0"]?.resolved).toBe("11.1.2");
      expect(fixture.read("jup.lock")).toBe(content);
    }
  });

  it("degrades to a normal resolution when the memo is unreadable", async () => {
    for (const content of DAMAGED) {
      const fixture = withModules({ packageManager: "pnpm@^11.0.0" });
      fixture.write(MEMO, content);

      const result = await run(["pnpm", "--version"], { ...fixture, registry, env: env() });

      expect(result.exitCode, content).toBe(0);
      expect(result.stdout).toBe("11.1.2\n");
      expect(memoOf(fixture).resolutions["pnpm@^11.0.0"]?.resolved).toBe("11.1.2");
    }
  });

  it("does not record a CLI version override, even a range one", async () => {
    const fixture = createFixture({ packageManager: "pnpm@^11.0.0" });

    const result = await run(["pnpm@^10.0.0", "--version"], { ...fixture, registry, env: env() });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("10.5.0\n");
    // `pnpm@^10.0.0 …` is one invocation (§04.7), not a statement about the
    // project, and the project's own range is not what it resolved either.
    expect(fixture.exists("jup.lock")).toBe(false);
  });

  it("does not record a fallback version in the project that fell back", async () => {
    // A name mismatch under `COREPACK_ENABLE_STRICT=0` runs the *machine's*
    // yarn, not the project's pnpm. Nothing about that answer belongs in this
    // project's lockfile — the recorded default supplies it, and §04.5 tolerates
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
    expect(fixture.exists("jup.lock")).toBe(false);
  });

  it("leaves a recorded resolution exactly as the project wrote it", async () => {
    const fixture = createFixture({ packageManager: "pnpm@^11.0.0" });
    // Hand-written: compact, and carrying no digest. §04.4 refreshes a
    // resolution only on `corepack up`, so a run that merely *uses* one must not
    // rewrite the file — not to reformat it, and not to add what it now knows.
    const planted = `{"version":1,"resolutions":{"pnpm@^11.0.0":{"resolved":"11.1.2"}}}\n`;
    fixture.write("jup.lock", planted);

    const result = await run(["pnpm", "--version"], { ...fixture, registry, env: env() });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("11.1.2\n");
    expect(fixture.read("jup.lock")).toBe(planted);
  });

  it("memoes beside the manifest that declared the range, not beside the cwd", async () => {
    const fixture = withModules({ packageManager: "pnpm@^11.0.0" });
    fixture.write("packages/app/keep.txt", "");

    const result = await run(["pnpm", "--version"], {
      ...fixture,
      cwd: fixture.path("packages/app"),
      registry,
      env: env(),
    });

    expect(result.exitCode).toBe(0);
    expect(fixture.exists(`packages/app/${MEMO}`)).toBe(false);
    expect(memoOf(fixture).resolutions["pnpm@^11.0.0"]?.resolved).toBe("11.1.2");
  });

  it("accepts a range in both packageManager and devEngines — the pnpm 11.21 shape", async () => {
    const fixture = withModules({
      packageManager: "pnpm@^11.0.0",
      devEngines: { packageManager: { name: "pnpm", version: ">=11", onFail: "error" } },
    });

    const result = await run(["pnpm", "--version"], { ...fixture, registry, env: env() });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("11.1.2\n");
    expect(withoutDownloadNotices(result.stderr)).toBe("");
    // §03.3 — the member outranks the top-level range, so its own range is the
    // key the resolution is recorded under.
    expect(memoOf(fixture).resolutions["pnpm@>=11"]?.resolved).toBe("11.1.2");
  });

  it("install warms the cache with the recorded version, not the newest match", async () => {
    const fixture = createFixture({ packageManager: "pnpm@^11.0.0" });
    fixture.write(
      "jup.lock",
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

  it("install looks the resolution up under the devEngines range, which is the pin", async () => {
    const fixture = createFixture({
      packageManager: "pnpm@^11.0.0",
      devEngines: { packageManager: { name: "pnpm", version: ">=10", onFail: "error" } },
    });
    fixture.write(
      "jup.lock",
      `${JSON.stringify({ version: 1, resolutions: { "pnpm@>=10": { resolved: "11.0.0" } } })}\n`,
    );

    const result = await run(["install"], { ...fixture, registry, env: env() });

    // §03.3 — the member is the spec, so it is also the key the *proxy* path
    // will look up. Warming the cache under any other key warms the wrong
    // version; the stale `pnpm@^11.0.0` beside it is no longer read at all.
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("Adding pnpm@11.0.0 to the cache...\n");
  });

  it("up refreshes the recorded resolution and keeps the range in the manifest", async () => {
    const fixture = createFixture({ packageManager: "pnpm@^11.0.0" });
    fixture.write(
      "jup.lock",
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

  it("up keeps the range `use` wrote into devEngines, wherever it lives", async () => {
    // §03.7 — `use` writes the pin into every field that encodes it, and on a
    // devEngines-only project that is `devEngines.packageManager.version` alone.
    // `up` must then read the pin from the same place: gated on a *top-level*
    // string it saw no range at all, overwrote this one with an exact version,
    // and deleted the `jup.lock` entry `use` had just recorded on the way past —
    // which is the pnpm 11.21 shape, so it is not a corner.
    const fixture = withModules({
      name: "demo",
      devEngines: { packageManager: { name: "pnpm", version: ">=10", onFail: "error" } },
    });

    const used = await run(["use", "pnpm@^11.0.0"], { ...fixture, registry, env: env() });
    expect(used.exitCode).toBe(0);

    const afterUse = fixture.json("package.json") as {
      packageManager?: string;
      devEngines: { packageManager: { version: string } };
    };
    expect(afterUse.packageManager).toBeUndefined();
    expect(afterUse.devEngines.packageManager.version).toBe("^11.0.0");
    expect(lockOf(fixture).resolutions["pnpm@^11.0.0"]?.resolved).toBe("11.1.2");

    // Rewind the record to an older release, so the refresh has something to do.
    record(fixture, "pnpm@^11.0.0", "11.0.0");

    const upped = await run(["up"], { ...fixture, registry, env: env() });
    expect(upped.exitCode).toBe(0);

    const afterUp = fixture.json("package.json") as {
      packageManager?: string;
      devEngines: { packageManager: { version: string } };
    };
    expect(afterUp.packageManager).toBeUndefined();
    expect(afterUp.devEngines.packageManager.version).toBe("^11.0.0");
    expect(lockOf(fixture).resolutions["pnpm@^11.0.0"]).toEqual({
      resolved: "11.1.2",
      integrity: sriOf(registry.tarballOf("pnpm", "11.1.2")),
    });
    expect(upped.stdout).toContain(`to use pnpm@11.1.2`);
  });

  it("up retires the memo it has just superseded", async () => {
    const fixture = withModules({ packageManager: "pnpm@^11.0.0" });
    record(fixture, "pnpm@^11.0.0", "11.0.0");
    // What an ordinary run left behind, still well inside its window.
    fixture.write(
      MEMO,
      `${JSON.stringify({
        version: 1,
        resolutions: { "pnpm@^11.0.0": { resolved: "11.0.0", expires: Date.now() + 3_600_000 } },
      })}\n`,
    );

    const result = await run(["up"], { ...fixture, registry, env: env() });

    expect(result.exitCode).toBe(0);
    expect(lockOf(fixture).resolutions["pnpm@^11.0.0"]?.resolved).toBe("11.1.2");
    // Left in place, the memo outlives the decision that replaced it: it answers
    // alone in every state where the recorded file is not visible — an
    // uncommitted `up`, a `git stash`, a CI cache holding `node_modules` but not
    // the lockfile — and the project goes on running the superseded version.
    expect(fixture.exists(MEMO)).toBe(false);
  });

  it("install reads the memo when nothing is committed", async () => {
    // The now-ordinary state: a run has memoed, and no `jup.lock` exists at all.
    const fixture = withModules({ packageManager: "pnpm@^11.0.0" });
    fixture.write(
      MEMO,
      `${JSON.stringify({
        version: 1,
        resolutions: { "pnpm@^11.0.0": { resolved: "11.0.0", expires: Date.now() + 3_600_000 } },
      })}\n`,
    );

    const result = await run(["install"], { ...fixture, registry, env: env() });

    // Caching 11.1.2 and then running 11.0.0 offline is the failure `install`
    // exists to prevent, and in a `JUP_ENABLE_NETWORK=0` layer it is fatal.
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("Adding pnpm@11.0.0 to the cache...\n");
    expect(existsSync(join(fixture.home, "v1", "pnpm", "11.0.0"))).toBe(true);
    expect(existsSync(join(fixture.home, "v1", "pnpm", "11.1.2"))).toBe(false);
    expect(fixture.exists("jup.lock")).toBe(false);
  });

  it("use refuses to *delete* a recorded resolution under JUP_FROZEN_LOCKFILE=1", async () => {
    const fixture = createFixture({ packageManager: "pnpm@^11.0.0" });
    record(fixture, "pnpm@^11.0.0", "11.0.0");
    const before = fixture.read("jup.lock");

    const result = await run(["use", "pnpm@11.1.2"], {
      ...fixture,
      registry,
      env: env({ JUP_FROZEN_LOCKFILE: "1" }),
    });

    // An exact `use` retires the range's entry — and `rm`s `jup.lock` outright
    // when it was the only one. The flag governs whether that file may be
    // written, and a deletion is a write; the range form alone was guarded.
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain(
      `Usage Error: pnpm@^11.0.0 is not resolved in jup.lock and lockfile updates are disabled.`,
    );
    expect(registry.requests).toEqual([]);
    expect(fixture.read("jup.lock")).toBe(before);
    expect((fixture.json("package.json") as { packageManager: string }).packageManager).toBe(
      "pnpm@^11.0.0",
    );
  });

  it("up refuses to refresh under an explicit JUP_FROZEN_LOCKFILE=1", async () => {
    const fixture = createFixture({ packageManager: "pnpm@^11.0.0" });

    const frozen = await run(["up"], {
      ...fixture,
      registry,
      env: env({ JUP_FROZEN_LOCKFILE: "1" }),
    });

    expect(frozen.exitCode).toBe(1);
    expect(frozen.stdout).toContain(
      `Usage Error: pnpm@^11.0.0 is not resolved in jup.lock and lockfile updates are disabled.`,
    );

    // But CI on its own does not block a command the user ran *to* refresh it.
    const inCI = await run(["up"], { ...fixture, registry, env: env({ CI: "1" }) });
    expect(inCI.exitCode).toBe(0);
    expect(lockOf(fixture).resolutions["pnpm@^11.0.0"]?.resolved).toBe("11.1.2");
  });

  it("use replaces a range with an exact pin and retires its resolution", async () => {
    const fixture = withModules({ name: "demo" });

    const first = await run(["use", "pnpm@^10.0.0"], { ...fixture, registry, env: env() });
    expect(first.exitCode).toBe(0);
    expect(lockOf(fixture).resolutions["pnpm@^10.0.0"]?.resolved).toBe("10.5.0");

    // A run under the range, so there is a memo to retire as well as a record.
    expect((await run(["pnpm", "--version"], { ...fixture, registry, env: env() })).exitCode).toBe(
      0,
    );

    const used = await run(["use", "pnpm@11.1.2"], { ...fixture, registry, env: env() });

    expect(used.exitCode).toBe(0);
    expect(effectivePin(fixture.json("package.json"))).toMatch(/^pnpm@11\.1\.2\+sha512\./);
    // The last resolution went with the range it belonged to, and an empty
    // resolution map is no file at all — in either file, since a memo left
    // behind would come back to life the moment the range did.
    expect(fixture.exists("jup.lock")).toBe(false);
    expect(fixture.exists(MEMO)).toBe(false);
  });

  // §09 — the opt-out. The pin is unchanged; only the record is skipped.
  it("--no-lockfile keeps the range and records nothing", async () => {
    const fixture = withModules({ name: "demo" });

    const result = await run(["use", "--no-lockfile", "pnpm@^11.0.0"], {
      ...fixture,
      registry,
      env: env(),
    });

    expect(result.exitCode).toBe(0);
    expect(effectivePin(fixture.json("package.json"))).toBe("pnpm@^11.0.0");
    expect(result.stdout).toContain(`Updated ${fixture.path("package.json")} to use pnpm@^11.0.0`);
    // No file, so no line naming one (§12.11).
    expect(fixture.exists("jup.lock")).toBe(false);
    expect(result.stdout).not.toContain("jup.lock");

    // Still a working project: the range resolves, it just resolves afresh.
    const rerun = await run(["pnpm", "--version"], { ...fixture, registry, env: env() });
    expect(rerun.exitCode).toBe(0);
    expect(rerun.stdout).toBe("11.1.2\n");
  });

  // A flag that asked for no lockfile and left the old entry standing would not
  // have changed what the next run resolves, which is the whole point of it.
  it("--no-lockfile retires an entry a previous run recorded, and says so", async () => {
    const fixture = withModules({ packageManager: "pnpm@^11.0.0" });
    record(fixture, "pnpm@^11.0.0", "11.0.0");
    // A run under the range, so there is a memo to retire beside the record.
    expect((await run(["pnpm", "--version"], { ...fixture, registry, env: env() })).exitCode).toBe(
      0,
    );

    const result = await run(["use", "--no-lockfile", "pnpm@^11.0.0"], {
      ...fixture,
      registry,
      env: env(),
    });

    expect(result.exitCode).toBe(0);
    expect(effectivePin(fixture.json("package.json"))).toBe("pnpm@^11.0.0");
    // §12.11 — the removal changed the file, so the file is named.
    expect(result.stdout).toContain(`Removed pnpm@^11.0.0 from ${fixture.path("jup.lock")}`);
    // The memo goes with it, or it would answer alone for the same key.
    expect(fixture.exists("jup.lock")).toBe(false);
    expect(fixture.exists(MEMO)).toBe(false);
  });

  it("`up --no-lockfile` drops the record and still moves the project forward", async () => {
    const fixture = createFixture({ packageManager: "pnpm@^11.0.0" });
    record(fixture, "pnpm@^11.0.0", "11.0.0");

    const result = await run(["up", "--no-lockfile"], { ...fixture, registry, env: env() });

    expect(result.exitCode).toBe(0);
    // The newest release the range allows is still resolved and installed — the
    // flag governs what is committed, not what `up` means.
    expect(result.stdout).toContain("Installing pnpm@11.1.2 in the project...");
    expect(result.stdout).toContain(`Removed pnpm@^11.0.0 from ${fixture.path("jup.lock")}`);
    expect(fixture.exists("jup.lock")).toBe(false);
    // The range in the manifest is untouched, as it is for an ordinary `up`.
    expect(effectivePin(fixture.json("package.json"))).toBe("pnpm@^11.0.0");
  });

  it("`up --no-lockfile` on a project with no record changes nothing and names nothing", async () => {
    const fixture = createFixture({ packageManager: "pnpm@^11.0.0" });

    const result = await run(["up", "--no-lockfile"], { ...fixture, registry, env: env() });

    expect(result.exitCode).toBe(0);
    expect(fixture.exists("jup.lock")).toBe(false);
    // §12.11 names each path the command *changed*; this one changed none.
    expect(result.stdout).not.toContain("jup.lock");
  });

  // §04.4 — the flag writes nothing, so the freeze binds it only where it would
  // still change the committed file.
  it("--no-lockfile is refused under JUP_FROZEN_LOCKFILE=1 only when it would remove", async () => {
    const clean = createFixture({ name: "demo" });
    const allowed = await run(["use", "--no-lockfile", "pnpm@^11.0.0"], {
      ...clean,
      registry,
      env: env({ JUP_FROZEN_LOCKFILE: "1" }),
    });
    expect(allowed.exitCode).toBe(0);
    expect(effectivePin(clean.json("package.json"))).toBe("pnpm@^11.0.0");
    expect(clean.exists("jup.lock")).toBe(false);

    const recorded = createFixture({ packageManager: "pnpm@^11.0.0" });
    record(recorded, "pnpm@^11.0.0", "11.0.0");
    const before = recorded.read("jup.lock");

    const refused = await run(["use", "--no-lockfile", "pnpm@^11.0.0"], {
      ...recorded,
      registry,
      env: env({ JUP_FROZEN_LOCKFILE: "1" }),
    });

    expect(refused.exitCode).toBe(1);
    expect(refused.stdout).toContain(
      `Usage Error: pnpm@^11.0.0 is not resolved in jup.lock and lockfile updates are disabled.`,
    );
    expect(recorded.read("jup.lock")).toBe(before);
  });

  it("use refuses to record under an explicit JUP_FROZEN_LOCKFILE=1", async () => {
    const fixture = createFixture({ name: "demo" });

    const result = await run(["use", "pnpm@^11.0.0"], {
      ...fixture,
      registry,
      env: env({ JUP_FROZEN_LOCKFILE: "1" }),
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain(
      `Usage Error: pnpm@^11.0.0 is not resolved in jup.lock and lockfile updates are disabled.`,
    );
    // Refused before the resolve, so a frozen job fails on its own flag rather
    // than after a download it was never going to be allowed to record.
    expect(registry.requests).toEqual([]);
    expect(fixture.exists("package.json")).toBe(true);
    expect(fixture.json("package.json")).toEqual({ name: "demo" });
  });
});
