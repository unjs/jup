/**
 * §13.8 — store, cache and offline operation (rows 86–96).
 *
 * The store's whole concurrency story is "rename is atomic and losing the race is
 * a success" (§07.5), and its whole offline story is "a `.jup` marker is
 * enough" (§07.2). Both are asserted here against real processes.
 */

import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupFixtures,
  createFixture,
  hashOf,
  makeTarball,
  MockRegistry,
  packageManagerTarball,
  pmScript,
  run,
} from "./_harness/index.ts";

const registry = new MockRegistry();

/**
 * §15.11 — Yarn Berry comes from `repo.yarnpkg.com`, which publishes no
 * signatures and no digests, so every row here pins the hash of the bytes the
 * mock serves. These rows are about the *store* — banners, atomicity, offline
 * operation — and pinning changes only the reference they quote.
 */
const BERRY = `2.2.2+sha512.${hashOf(Buffer.from(pmScript("yarn", "2.2.2"), "utf8"))}`;

/** Root ignores the mode bits, so the read-only-home rows cannot be run as root. */
const IS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;

/** Nothing is listening here, so any request at all is a failure. */
const DEAD = {
  COREPACK_NPM_REGISTRY: "http://127.0.0.1:1",
  HTTP_PROXY: "http://0.0.0.0:1",
  HTTPS_PROXY: "http://0.0.0.0:1",
};

function trusted(extra?: Record<string, string | undefined>): Record<string, string | undefined> {
  return { COREPACK_INTEGRITY_KEYS: registry.trustStore(), ...extra };
}

beforeAll(async () => {
  await registry.start();
  registry.publishFile(
    "/2.2.2/packages/yarnpkg-cli/bin/yarn.js",
    pmScript("yarn", "2.2.2"),
    "application/javascript",
  );
  registry.publish("pnpm", "5.8.0", packageManagerTarball("pnpm", "5.8.0"));
});

afterAll(async () => {
  cleanupFixtures();
  await registry.stop();
});

beforeEach(() => registry.reset());

describe("§13.8 store, cache and offline", () => {
  it("86: corepack install prints exactly the cache banner", async () => {
    const fixture = createFixture({ packageManager: `yarn@${BERRY}` });

    const result = await run(["install"], { ...fixture, registry, env: trusted() });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`Adding yarn@${BERRY} to the cache...\n`);
    expect(result.stderr).toBe("");
    expect(existsSync(join(fixture.home, "v1", "yarn", "2.2.2", ".jup"))).toBe(true);
  });

  it("86: corepack install leaves lastKnownGood.json untouched", async () => {
    const fixture = createFixture({ packageManager: `yarn@${BERRY}` });
    // Same major and strictly below 2.2.2, so §04.7's guarded bump would fire —
    // §09.2 says this command does not touch the file, and being specific it
    // wins over §04.7's general rule.
    const lastKnownGood = join(fixture.home, "lastKnownGood.json");
    writeFileSync(lastKnownGood, `${JSON.stringify({ yarn: "2.0.0" }, undefined, 2)}\n`);

    const result = await run(["install"], {
      ...fixture,
      registry,
      // The harness pins this to `0`, which would disable §04.7's bump on its
      // own; the point here is that `install` leaves the file alone even when
      // the bump is enabled.
      env: trusted({ COREPACK_DEFAULT_TO_LATEST: undefined }),
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(lastKnownGood, "utf8"))).toEqual({ yarn: "2.0.0" });
  });

  it("87: the cached version then runs with COREPACK_ENABLE_NETWORK=0", async () => {
    const fixture = createFixture({ packageManager: `yarn@${BERRY}` });
    expect((await run(["install"], { ...fixture, registry, env: trusted() })).exitCode).toBe(0);

    const result = await run(["yarn", "--version"], {
      ...fixture,
      env: { COREPACK_ENABLE_NETWORK: "0" },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("2.2.2\n");
    expect(result.stderr).toBe("");
  });

  it.skipIf(IS_ROOT)(
    "88: a corrupt lastKnownGood.json, a read-only home and no network still run",
    async () => {
      const fixture = createFixture({ packageManager: `yarn@${BERRY}` });
      expect((await run(["install"], { ...fixture, registry, env: trusted() })).exitCode).toBe(0);

      writeFileSync(join(fixture.home, "lastKnownGood.json"), "{");
      chmodSync(fixture.home, 0o555);
      try {
        const result = await run(["yarn", "--version"], { ...fixture, env: DEAD });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("2.2.2\n");
        expect(result.stderr).toBe("");
      } finally {
        chmodSync(fixture.home, 0o755);
      }
    },
  );

  it.skipIf(IS_ROOT)(
    "89: install --global prints the install banner and survives the same treatment",
    async () => {
      const fixture = createFixture();

      const installed = await run(["install", "--global", `yarn@${BERRY}`], {
        ...fixture,
        registry,
        env: trusted(),
      });
      expect(installed.exitCode).toBe(0);
      expect(installed.stdout).toBe(`Installing yarn@${BERRY}...\n`);
      expect(installed.stderr).toBe("");

      // The recorded default is what makes this work with no project spec at all,
      // and a read-only home must not stop it being read.
      chmodSync(fixture.home, 0o555);
      try {
        const result = await run(["yarn", "--version"], { ...fixture, env: DEAD });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("2.2.2\n");
        expect(result.stderr).toBe("");
      } finally {
        chmodSync(fixture.home, 0o755);
      }
    },
  );

  it("90: pack, then install -g the archive into a fresh offline COREPACK_HOME", async () => {
    const source = createFixture();
    const packed = await run(["pack", `yarn@${BERRY}`], { ...source, registry, env: trusted() });
    expect(packed.exitCode).toBe(0);
    expect(source.exists("jup.tgz")).toBe(true);

    const target = createFixture({ packageManager: `yarn@${BERRY}` });
    const hydrated = await run(["install", "-g", source.path("jup.tgz")], {
      ...target,
      env: { COREPACK_ENABLE_NETWORK: "0" },
    });
    expect(hydrated.exitCode).toBe(0);

    const result = await run(["yarn", "--version"], {
      ...target,
      env: { COREPACK_ENABLE_NETWORK: "0" },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("2.2.2\n");
  });

  it("91: the same works when the new COREPACK_HOME does not exist yet", async () => {
    const source = createFixture();
    expect(
      (await run(["pack", `yarn@${BERRY}`], { ...source, registry, env: trusted() })).exitCode,
    ).toBe(0);

    const target = createFixture({ packageManager: `yarn@${BERRY}` });
    rmSync(target.home, { recursive: true, force: true });

    const hydrated = await run(["install", "-g", source.path("jup.tgz")], {
      ...target,
      env: { COREPACK_ENABLE_NETWORK: "0" },
    });
    expect(hydrated.exitCode).toBe(0);
    expect(
      (await run(["yarn", "--version"], { ...target, env: { COREPACK_ENABLE_NETWORK: "0" } }))
        .stdout,
    ).toBe("2.2.2\n");
  });

  it("92: an archive holding two package managers hydrates both, offline", async () => {
    const source = createFixture();
    const packed = await run(["pack", `yarn@${BERRY}`, "pnpm@5.8.0"], {
      ...source,
      registry,
      env: trusted(),
    });
    expect(packed.exitCode).toBe(0);

    const target = createFixture();
    const hydrated = await run(["install", "-g", source.path("jup.tgz")], {
      ...target,
      env: { COREPACK_ENABLE_NETWORK: "0" },
    });
    expect(hydrated.exitCode).toBe(0);

    const offline = { COREPACK_ENABLE_NETWORK: "0" };
    const yarn = await run(["yarn@2.2.2", "--version"], { ...target, env: offline });
    const pnpm = await run(["pnpm@5.8.0", "--version"], { ...target, env: offline });
    expect(yarn.stdout).toBe("2.2.2\n");
    expect(pnpm.stdout).toBe("5.8.0\n");
  });

  it("93: install -g refuses an archive that did not come from pack", async () => {
    const fixture = createFixture();
    writeFileSync(
      fixture.path("stray.tgz"),
      makeTarball([{ path: "not-a-store/readme.txt", content: "hello" }]),
    );

    const result = await run(["install", "-g", fixture.path("stray.tgz")], fixture);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain(
      `Usage Error: Invalid archive format; did it get generated by 'jup pack'?`,
    );
  });

  it("94: three concurrent runs needing the same fresh download all succeed", async () => {
    const fixture = createFixture({ packageManager: `yarn@${BERRY}` });
    const options = { ...fixture, registry, env: trusted() };

    const results = await Promise.all([
      run(["yarn", "--version"], options),
      run(["yarn", "--version"], options),
      run(["yarn", "--version"], options),
    ]);

    for (const result of results) {
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("2.2.2\n");
    }
    // Exactly one install survives, and no temp folder is left behind (§07.5).
    expect(existsSync(join(fixture.home, "v1", "yarn", "2.2.2", ".jup"))).toBe(true);
    const { readdirSync } = await import("node:fs");
    expect(
      readdirSync(join(fixture.home, "v1")).filter((entry) => entry.startsWith("corepack-")),
    ).toEqual([]);
  });

  it("95: cache clean and cache clear both empty v1 and spare lastKnownGood.json", async () => {
    for (const subcommand of ["clean", "clear"] as const) {
      const fixture = createFixture();
      expect(
        (await run(["install", "-g", `yarn@${BERRY}`], { ...fixture, registry, env: trusted() }))
          .exitCode,
      ).toBe(0);
      expect(existsSync(join(fixture.home, "v1", "yarn", "2.2.2"))).toBe(true);
      expect(existsSync(join(fixture.home, "lastKnownGood.json"))).toBe(true);

      const first = await run(["cache", subcommand], fixture);
      expect(first.exitCode).toBe(0);
      expect(existsSync(join(fixture.home, "v1"))).toBe(false);
      expect(existsSync(join(fixture.home, "lastKnownGood.json"))).toBe(true);

      // A second run is a no-op rather than an error.
      const second = await run(["cache", subcommand], fixture);
      expect(second.exitCode).toBe(0);
      expect(second.stderr).toBe("");
    }
  });

  it("96: a warm run with an exact pin makes zero network requests (§01.3)", async () => {
    const fixture = createFixture({ packageManager: `yarn@${BERRY}` });
    expect((await run(["install"], { ...fixture, registry, env: trusted() })).exitCode).toBe(0);
    registry.reset();

    const result = await run(["yarn", "--version"], { ...fixture, registry, env: trusted() });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("2.2.2\n");
    expect(registry.requests).toEqual([]);
    // The other half of the budget — no `lastKnownGood.json` read and no store
    // `opendir` — is proved with an fs spy inside the child process by
    // test/unit/main.test.ts, "the warm fast path — §01.3 (test 96)"; it is not
    // duplicated here.
  });
});
