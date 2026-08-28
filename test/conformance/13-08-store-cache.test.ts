/**
 * §13.8 — store, cache and offline operation (rows 86–96), plus §15.44's rows
 * 252 and 253.
 *
 * The store's whole concurrency story is "rename is atomic and losing the race is
 * a success" (§07.5), and its whole offline story is "a `.jup` marker is
 * enough" (§07.2). Both are asserted here against real processes.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupFixtures,
  copyTool,
  createFixture,
  hashOf,
  makeTarball,
  MockRegistry,
  packageManagerTarball,
  publishBerry,
  run,
  seedPackageManager,
} from "./_harness/index.ts";

const registry = new MockRegistry();

/**
 * Yarn Berry, hash-pinned. §15.41 moved it onto `@yarnpkg/cli-dist`, so it now
 * clears §15.11 on the mock's signature alone and the pin is no longer load
 * bearing — but these rows are about the *store* (banners, atomicity, offline
 * operation), and a pinned reference is the one they have always quoted.
 */
const BERRY = `2.2.2+sha512.${hashOf(packageManagerTarball("yarn", "2.2.2", { packageName: "@yarnpkg/cli-dist" }))}`;

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
  publishBerry(registry, "2.2.2");
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

/* ------------------------------------------------------------------ *
 * §15.44 — rows 252 and 253
 *
 * The backstop for §15.43. An install shimmed by an older build has
 * the store path §14.26 used to bake in still sitting in its stub's
 * shebang, and `cache clean` deleting the file underneath it leaves
 * every shim dying with `bad interpreter` (exit 126) and `jup` itself
 * unreachable behind the broken `node` shim (exit 127).
 *
 * The state is reproduced by rewriting the stub's first line in a
 * private copy of the tool, which is exactly what such an install
 * looks like on disk — and the only way to reach it now that §15.43
 * refuses to write it.
 * ------------------------------------------------------------------ */

describe.skipIf(process.platform === "win32")("§15.44 cache clean spares the interpreter", () => {
  /**
   * A copy of the tool per row: these rewrite the shared stub, and the
   * repository's own `src/shim-proxy.mjs` is a file every other suite reads.
   */
  function toolWithShebang(interpreter: string): string {
    const bin = copyTool();
    const stub = join(dirname(bin), "shim-proxy.mjs");
    const source = readFileSync(stub, "utf8");
    writeFileSync(stub, `#!${interpreter}\n${source.slice(source.indexOf("\n") + 1)}`);
    return bin;
  }

  /**
   * The runtime an older `enable` would have baked in: a real file, in the
   * layout §07.2 gives it, carrying a marker so `cache list` counts it.
   */
  function seedRuntime(home: string, version: string): string {
    const location = join(home, "v1", "node", version);
    mkdirSync(join(location, "bin"), { recursive: true });
    writeFileSync(join(location, "bin", "node"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(location, "bin", "node"), 0o755);
    writeFileSync(
      join(location, ".jup"),
      JSON.stringify({ locator: { name: "node", reference: version }, hash: "sha512.seeded" }),
    );
    return join(location, "bin", "node");
  }

  it("252: keeps the version the shebang names, removes the rest, and says why", async () => {
    const fixture = createFixture();
    const interpreter = seedRuntime(fixture.home, "22.14.0");
    seedPackageManager(fixture.home, "pnpm", "11.1.2");
    seedPackageManager(fixture.home, "yarn", "1.22.4");
    seedPackageManager(fixture.home, "npm", "9.8.1");

    const result = await run(["cache", "clean"], {
      ...fixture,
      registry,
      bin: toolWithShebang(interpreter),
    });

    expect(result.exitCode).toBe(0);
    // The count is what was actually removed — the spared version is not in it.
    expect(result.stdout).toBe(`Removed 3 cached version(s) from ${join(fixture.home, "v1")}\n`);
    // One line, on stderr, naming what survived, why, and the way out.
    expect(result.stderr.split("\n").filter(Boolean)).toHaveLength(1);
    expect(result.stderr).toContain("Kept node@22.14.0");
    expect(result.stderr).toContain(interpreter);
    expect(result.stderr).toContain("bad interpreter");
    expect(result.stderr).toContain("jup enable");

    // The property the whole section is for: the file the shims exec is still
    // there, and nothing else is.
    expect(existsSync(interpreter)).toBe(true);
    expect(existsSync(join(fixture.home, "v1", "pnpm"))).toBe(false);
    expect(existsSync(join(fixture.home, "v1", "yarn"))).toBe(false);
    expect(existsSync(join(fixture.home, "v1", "npm"))).toBe(false);
  });

  it("253: --all takes it after warning, and a pinned stub is untouched", async () => {
    const fixture = createFixture();
    const interpreter = seedRuntime(fixture.home, "22.14.0");
    seedPackageManager(fixture.home, "pnpm", "11.1.2");

    const all = await run(["cache", "clean", "--all"], {
      ...fixture,
      registry,
      bin: toolWithShebang(interpreter),
    });

    expect(all.exitCode).toBe(0);
    expect(all.stdout).toContain("Removed 2 cached version(s)");
    // Warned, and then done: `--all` is the explicit "yes, everything".
    expect(all.stderr).toContain("Removing node@22.14.0");
    expect(all.stderr).toContain("jup enable");
    expect(existsSync(join(fixture.home, "v1"))).toBe(false);

    // The other half of the row: a stub whose interpreter is outside `<home>` —
    // the only state §15.43 now produces — behaves exactly as §15.35l fixed it,
    // with nothing added to either stream.
    const pinned = createFixture();
    seedPackageManager(pinned.home, "pnpm", "11.1.2");
    seedPackageManager(pinned.home, "yarn", "1.22.4");

    const clean = await run(["cache", "clean"], {
      ...pinned,
      registry,
      bin: toolWithShebang(process.execPath),
    });

    expect(clean.exitCode).toBe(0);
    expect(clean.stdout).toBe(`Removed 2 cached version(s) from ${join(pinned.home, "v1")}\n`);
    expect(clean.stderr).toBe("");
    expect(existsSync(join(pinned.home, "v1"))).toBe(false);
  });
});
