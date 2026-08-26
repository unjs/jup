/**
 * §17.9 rows 216–221 — the renames (§17.6 C2, C3, C9).
 *
 * One rule, applied five times: **write the `jup` spelling, accept the
 * `corepack` spelling on read, prefer `jup` in every message.** So every row
 * here has two halves, and the second half is the one that would rot silently —
 * a dual-read that quietly stopped reading the older name looks exactly like a
 * green suite until someone's warm store, committed lockfile or `.corepack.env`
 * stops working.
 *
 * Rows 216 and 217 use §13.1's exemption: they set the store-home variables
 * themselves rather than inherit the harness's fresh `COREPACK_HOME`, and
 * `cleanEnv()` keeps `XDG_CACHE_HOME`/`XDG_BIN_HOME` out of the way so that
 * §07.1's fallback chain lands inside the fixture rather than in the developer's
 * own cache.
 *
 * These are the jup surface, so they run `as: "jup"` wherever the entry point is
 * observable. The file *names* are not: C9 renames a file, and a file has one
 * name under both entry points — which is what row 219 asserts by packing under
 * the default (corepack) entry point and still getting `jup.tgz`.
 */

import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFINITIONS } from "../../src/config/table.ts";
import {
  cleanupFixtures,
  createFixture,
  makeTarball,
  MockRegistry,
  packageManagerTarball,
  run,
  seedPackageManager,
} from "./_harness/index.ts";

const YARN_DEFAULT = DEFINITIONS.yarn!.default;

const registry = new MockRegistry();

/** The mock mints its own keypair, so every downloading row has to trust it (§06.3). */
function trusted(extra?: Record<string, string | undefined>): Record<string, string | undefined> {
  return { COREPACK_INTEGRITY_KEYS: registry.trustStore(), CI: undefined, ...extra };
}

beforeAll(async () => {
  await registry.start();
  for (const version of ["11.0.0", "11.1.2"]) {
    registry.publish("pnpm", version, packageManagerTarball("pnpm", version));
  }
});

afterAll(async () => {
  cleanupFixtures();
  await registry.stop();
});

beforeEach(() => registry.reset());

/* -------------------------------------------------------------------------- */
/* C2 — the store home                                                        */
/* -------------------------------------------------------------------------- */

describe("§17.9 216–217 — the store home (§17.6 C2)", () => {
  it("216: with neither JUP_HOME nor COREPACK_HOME set, the store is <cache>/jup", async () => {
    const fixture = createFixture({});

    const result = await run(["info", "--json"], {
      ...fixture,
      as: "jup",
      // §13.1's exemption: drop the harness's fresh store home and land on
      // §07.1's fallback chain. `HOME` is already the fixture's, and `cleanEnv`
      // strips the developer's `XDG_CACHE_HOME`, so the chain stays inside it.
      env: { COREPACK_HOME: undefined, JUP_HOME: undefined },
    });

    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout) as { store: { home: string } };

    // C2: the last segment is `jup`. A directory named after another program is
    // the wrong place to keep artifacts it never created, and a real corepack's
    // `cache clean` is `rm -rf` on exactly that path (§07.9).
    expect(report.store.home).toBe(join(fixture.home, ".cache", "jup"));
    expect(report.store.home).not.toContain(join("node", "corepack"));
  });

  it("217: JUP_HOME wins over COREPACK_HOME when both are set (§11.6)", async () => {
    const fixture = createFixture({});
    const preferred = join(fixture.root, "preferred");
    const legacy = join(fixture.root, "legacy");

    const result = await run(["info", "--json"], {
      ...fixture,
      as: "jup",
      env: { JUP_HOME: preferred, COREPACK_HOME: legacy },
    });

    expect(result.exitCode).toBe(0);
    expect((JSON.parse(result.stdout) as { store: { home: string } }).store.home).toBe(preferred);

    // …and the legacy spelling alone is still honoured, which is the half that
    // keeps a user who already pointed their cache somewhere from re-downloading.
    const legacyOnly = await run(["info", "--json"], {
      ...fixture,
      as: "jup",
      env: { JUP_HOME: undefined, COREPACK_HOME: legacy },
    });
    expect((JSON.parse(legacyOnly.stdout) as { store: { home: string } }).store.home).toBe(legacy);
  });
});

/* -------------------------------------------------------------------------- */
/* C3 — the install marker                                                    */
/* -------------------------------------------------------------------------- */

describe("§17.9 218 — the install marker (§17.6 C3)", () => {
  it("218: a store holding only .corepack is warm, and a fresh install writes .jup", async () => {
    const fixture = createFixture({ packageManager: "yarn@1.0.0" });

    // An inherited corepack store: seed as jup does, then rename the marker to
    // what corepack would have written. Same contents, older name (§07.2).
    const inherited = join(fixture.home, "v1", "yarn", "1.0.0");
    seedPackageManager(fixture.home, "yarn", "1.0.0");
    writeFileSync(join(inherited, ".corepack"), readFileSync(join(inherited, ".jup")));
    rmSync(join(inherited, ".jup"));

    // Warm: no network at all, and the pinned version runs.
    const warm = await run(["yarn", "--version"], {
      ...fixture,
      env: { COREPACK_ENABLE_NETWORK: "0" },
    });
    expect(warm.exitCode).toBe(0);
    expect(warm.stdout).toBe("1.0.0\n");
    expect(existsSync(join(inherited, ".jup"))).toBe(false);

    // C8 — nothing was migrated: the inherited entry is left exactly as found.
    expect(readdirSync(inherited)).toContain(".corepack");

    // A *fresh* install beside it writes the new name.
    const installed = await run(["install", "-g", "pnpm@11.1.2"], {
      ...fixture,
      registry,
      env: trusted(),
    });
    expect(installed.exitCode).toBe(0);
    expect(existsSync(join(fixture.home, "v1", "pnpm", "11.1.2", ".jup"))).toBe(true);
    expect(existsSync(join(fixture.home, "v1", "pnpm", "11.1.2", ".corepack"))).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* C9 — the user-visible names                                                */
/* -------------------------------------------------------------------------- */

describe("§17.9 219 — pack output (§17.6 C9, §07.10)", () => {
  it("219: pack writes jup.tgz, and install -g round-trips it offline", async () => {
    const source = createFixture();

    // Deliberately the *default* entry point. A file name is not a message: C10
    // varies what the tool calls itself, C9 renamed the file, and the file has
    // one name however the tool was invoked.
    const packed = await run(["pack", "pnpm@11.1.2"], { ...source, registry, env: trusted() });
    expect(packed.exitCode).toBe(0);
    expect(source.exists("jup.tgz")).toBe(true);
    expect(source.exists("corepack.tgz")).toBe(false);
    expect(packed.stdout).toContain("jup.tgz");

    const target = createFixture({ packageManager: "pnpm@11.1.2" });
    const hydrated = await run(["install", "-g", source.path("jup.tgz")], {
      ...target,
      env: { COREPACK_ENABLE_NETWORK: "0" },
    });
    expect(hydrated.exitCode).toBe(0);

    const ran = await run(["pnpm", "--version"], {
      ...target,
      env: { COREPACK_ENABLE_NETWORK: "0" },
    });
    expect(ran.stdout).toBe("11.1.2\n");
  });

  it("219: an archive whose markers are all .corepack installs, not Invalid archive format", async () => {
    // What corepack's own `pack` produces, and what jup's produces from a store
    // it inherited. §07.10 spells both names out because the validator compares
    // literal path segments.
    const staging = createFixture();
    seedPackageManager(staging.home, "yarn", "1.0.0");
    const archive = staging.path("legacy.tgz");
    writeFileSync(archive, archiveOf(join(staging.home, "v1"), ".corepack"));

    const target = createFixture({ packageManager: "yarn@1.0.0" });
    const hydrated = await run(["install", "-g", archive], {
      ...target,
      env: { COREPACK_ENABLE_NETWORK: "0" },
    });

    expect(hydrated.stdout).not.toContain("Invalid archive format");
    expect(hydrated.exitCode).toBe(0);

    const ran = await run(["yarn", "--version"], {
      ...target,
      env: { COREPACK_ENABLE_NETWORK: "0" },
    });
    expect(ran.exitCode).toBe(0);
    expect(ran.stdout).toBe("1.0.0\n");
  });
});

describe("§17.9 220 — the env file (§17.6 C9, §03.2)", () => {
  /** An empty project whose store already holds the default yarn (auto-pin's target). */
  function autoPinProject() {
    const fixture = createFixture({});
    seedPackageManager(fixture.home, "yarn", YARN_DEFAULT);
    return fixture;
  }

  function pinned(fixture: { json(relative: string): unknown }): string | undefined {
    return (fixture.json("package.json") as { packageManager?: string }).packageManager;
  }

  it("220: .corepack.env is read when .jup.env is absent", async () => {
    const fixture = autoPinProject();
    fixture.write(".corepack.env", "COREPACK_ENABLE_AUTO_PIN=1\n");

    const result = await run(["yarn"], { ...fixture, as: "jup" });

    expect(result.exitCode).toBe(0);
    expect(pinned(fixture)).toMatch(/^yarn@/);
  });

  it("220: the same §14.5 deny-list applies to the legacy name (row 60's shape)", async () => {
    const fixture = createFixture({ packageManager: "pnpm@11.1.2" });
    fixture.write(".corepack.env", "COREPACK_INTEGRITY_KEYS=0\n");

    const result = await run(["pnpm", "--version"], { ...fixture, as: "jup", registry });

    // The embedded trust store is still in force, so the mock's key is untrusted:
    // reading the older name must not be a way past the deny-list.
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("The package was not signed by any trusted keys");
    expect(result.stderr).toContain(
      `! Ignoring COREPACK_INTEGRITY_KEYS from ${join(fixture.cwd, ".corepack.env")}: this variable can only be set in the environment`,
    );
  });

  it("220: .jup.env wins where both exist, and they are never merged", async () => {
    const fixture = autoPinProject();
    fixture.write(".jup.env", "COREPACK_ENABLE_AUTO_PIN=0\n");
    fixture.write(".corepack.env", "COREPACK_ENABLE_AUTO_PIN=1\n");

    const suppressed = await run(["yarn"], { ...fixture, as: "jup" });
    expect(suppressed.exitCode).toBe(0);
    expect(pinned(fixture)).toBeUndefined();

    // And the other way round, so the row cannot pass by ignoring both files.
    const other = autoPinProject();
    other.write(".jup.env", "COREPACK_ENABLE_AUTO_PIN=1\n");
    other.write(".corepack.env", "COREPACK_ENABLE_AUTO_PIN=0\n");
    expect((await run(["yarn"], { ...other, as: "jup" })).exitCode).toBe(0);
    expect(pinned(other)).toMatch(/^yarn@/);
  });
});

describe("§17.9 221 — the lockfile (§17.6 C9, §15.23)", () => {
  it("221: a range with no lockfile writes .jup.lock, and the next run honours it", async () => {
    const fixture = createFixture({ packageManager: "pnpm@^11.0.0" });

    const first = await run(["pnpm", "--version"], {
      ...fixture,
      as: "jup",
      registry,
      env: trusted(),
    });
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toBe("11.1.2\n");
    expect(fixture.exists(".jup.lock")).toBe(true);
    expect(fixture.exists(".corepack.lock")).toBe(false);

    // Honoured, and §15.23's "without any network access" holds for it.
    registry.reset();
    const second = await run(["pnpm", "--version"], {
      ...fixture,
      as: "jup",
      registry,
      env: trusted({ COREPACK_ENABLE_NETWORK: "0" }),
    });
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toBe("11.1.2\n");
    expect(registry.requests).toEqual([]);
  });

  it("221: a pre-existing .corepack.lock is honoured, with no network", async () => {
    const fixture = createFixture({ packageManager: "pnpm@^11.0.0" });
    // Both satisfy the range, so §04.1 step 4's cache probe would answer 11.1.2
    // on its own: only the recorded resolution can produce 11.0.0.
    seedPackageManager(fixture.home, "pnpm", "11.0.0");
    seedPackageManager(fixture.home, "pnpm", "11.1.2");
    fixture.write(
      ".corepack.lock",
      `${JSON.stringify({ version: 1, resolutions: { "pnpm@^11.0.0": { resolved: "11.0.0" } } }, undefined, 2)}\n`,
    );

    const result = await run(["pnpm", "--version"], {
      ...fixture,
      as: "jup",
      env: { COREPACK_ENABLE_NETWORK: "0" },
    });

    // 11.0.0, not the 11.1.2 the range's maximum would have picked: the recorded
    // resolution decided it, and it came from the older file name.
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("11.0.0\n");
  });

  it("221: the frozen-lockfile error names the file it actually looked at", async () => {
    const missing = createFixture({ packageManager: "pnpm@^11.0.0" });
    const refused = await run(["pnpm", "--version"], {
      ...missing,
      as: "jup",
      env: { COREPACK_FROZEN_LOCKFILE: "1", COREPACK_ENABLE_NETWORK: "0" },
    });
    expect(refused.exitCode).toBe(1);
    // §12.1 — a proxy-mode `UsageError` goes straight to stderr.
    expect(refused.stderr).toContain(
      "pnpm@^11.0.0 is not resolved in .jup.lock and lockfile updates are disabled.",
    );

    // The same refusal in a project still carrying the older name has to name
    // *that* file, or the message sends the user to a file they do not have.
    const legacy = createFixture({ packageManager: "pnpm@^11.0.0" });
    legacy.write(".corepack.lock", `${JSON.stringify({ version: 1, resolutions: {} })}\n`);
    const legacyRefused = await run(["pnpm", "--version"], {
      ...legacy,
      as: "jup",
      env: { COREPACK_FROZEN_LOCKFILE: "1", COREPACK_ENABLE_NETWORK: "0" },
    });
    expect(legacyRefused.exitCode).toBe(1);
    expect(legacyRefused.stderr).toContain(
      "pnpm@^11.0.0 is not resolved in .corepack.lock and lockfile updates are disabled.",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A `pack`-shaped archive of `root` (`<home>/v1`), with every install marker
 * renamed to `markerName`.
 *
 * `pack` is a copy of cache subtrees rather than a repackaging (§07.10), so this
 * is what corepack's own output looks like — and what jup's looks like when the
 * store it packed was inherited.
 */
function archiveOf(root: string, markerName: string): Uint8Array {
  const entries: Array<{ path: string; content: Buffer }> = [];
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const absolute = join(entry.parentPath, entry.name);
    const path = relative(root, absolute).split("\\").join("/");
    entries.push({
      path: entry.name === ".jup" ? `${path.slice(0, -".jup".length)}${markerName}` : path,
      content: readFileSync(absolute),
    });
  }
  return makeTarball(entries);
}
