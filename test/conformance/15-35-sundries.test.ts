/**
 * Sundry required behaviours (rows 178, 202, 204, 206).
 *
 * Four small requirements that share one theme: the tool should say what it did
 * and what went wrong, in terms of what the user typed.
 *
 * | Row | § | Requirement |
 * |---|---|---|
 * | 178 | §12.6 | an airgapped failure names the seeding command |
 * | 202 | §09.5 | `use` is idempotent — no doubled build suffix |
 * | 204 | §04.1 | a nonexistent version is named as such, not as a bare 404 |
 * | 206 | §12.11 | `cache clean` reports what it removed |
 */

import { existsSync } from "node:fs";
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
} from "./_harness/index.ts";

const registry = new MockRegistry();

function env(extra?: Record<string, string | undefined>): Record<string, string | undefined> {
  return { COREPACK_INTEGRITY_KEYS: registry.trustStore(), CI: undefined, ...extra };
}

/** §03.3 — the pin the project actually declares, whichever field carries it. */
function pinOf(fixture: { json(relative: string): unknown }): string | undefined {
  return effectivePin(fixture.json("package.json"));
}

beforeAll(async () => {
  await registry.start();
  registry.publish("pnpm", "11.1.2", packageManagerTarball("pnpm", "11.1.2"), {
    distTags: { latest: "11.1.2" },
  });
});

afterAll(async () => {
  cleanupFixtures();
  await registry.stop();
});

beforeEach(() => registry.reset());

/* -------------------------------------------------------------------------- */
/* §12.6 — offline diagnostics                                                */
/* -------------------------------------------------------------------------- */

describe("§12.6 airgapped installs", () => {
  it("178: an uncached version with the network off names the seeding command", async () => {
    const fixture = createFixture({ packageManager: "pnpm@11.1.2" });

    const result = await run(["pnpm", "--version"], {
      ...fixture,
      env: { COREPACK_ENABLE_NETWORK: "0" },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      `pnpm@11.1.2 is not in the cache and network access is disabled. ` +
        `Seed it with 'jup cache install -g --cache-only pnpm@11.1.2', ` +
        `or run 'jup pack pnpm@11.1.2' on a networked machine.\n`,
    );
  });

  it("178: a range that cannot be resolved offline says the same", async () => {
    // The failure moves from the download to the *resolution* here, and the
    // diagnostic has to cover both or half the airgapped cases keep the bare
    // "can't reach <url>".
    const fixture = createFixture({ packageManager: "pnpm@^11.0.0" });

    const result = await run(["pnpm", "--version"], {
      ...fixture,
      env: { COREPACK_ENABLE_NETWORK: "0" },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("pnpm@^11.0.0 is not in the cache and network access is");
    expect(result.stderr).toContain("jup cache install -g --cache-only pnpm@^11.0.0");
  });

  it("178: `corepack up` says the same, from its second resolve", async () => {
    // The one this file caught only against the *built* binary: an exactly-pinned
    // project resolves step one from the pin itself, so the request that fails is
    // the major-confining resolve, and that call site had no diagnostic on it.
    const fixture = createFixture({ packageManager: "pnpm@11.1.2" });
    seedPackageManager(fixture.home, "pnpm", "11.1.2");

    const result = await run(["up"], { ...fixture, env: { COREPACK_ENABLE_NETWORK: "0" } });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("pnpm@^11.0.0 is not in the cache and network access is");
    expect(result.stdout).toContain("jup cache install -g --cache-only pnpm@^11.0.0");
  });

  it("178: a seeded store needs no network at all, which is the point", async () => {
    const fixture = createFixture({ packageManager: "pnpm@11.1.2" });
    seedPackageManager(fixture.home, "pnpm", "11.1.2");

    const result = await run(["pnpm", "--version"], {
      ...fixture,
      env: { COREPACK_ENABLE_NETWORK: "0" },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("11.1.2\n");
  });
});

/* -------------------------------------------------------------------------- */
/* §09.5 — idempotent use                                                    */
/* -------------------------------------------------------------------------- */

describe("§09.5 idempotent use", () => {
  it("202: running `use` twice on the same version leaves the pin identical", async () => {
    const fixture = createFixture({ name: "project" });

    expect((await run(["use", "pnpm@11.1.2"], { ...fixture, registry, env: env() })).exitCode).toBe(
      0,
    );
    const first = fixture.read("package.json");

    expect((await run(["use", "pnpm@11.1.2"], { ...fixture, registry, env: env() })).exitCode).toBe(
      0,
    );

    // Byte for byte: not merely "still valid", but "the same file", so a repeated
    // `use` in a script cannot churn a repository's diff.
    expect(fixture.read("package.json")).toBe(first);
  });

  it("202: re-pinning the value already written never doubles the build suffix", async () => {
    const fixture = createFixture({ name: "project" });

    expect((await run(["use", "pnpm@11.1.2"], { ...fixture, registry, env: env() })).exitCode).toBe(
      0,
    );
    const pinned = pinOf(fixture)!;

    // #316's historically-reported shape: feed the hash-bearing reference back
    // in and watch `+sha512.…+sha512.…` appear.
    expect((await run(["use", pinned], { ...fixture, registry, env: env() })).exitCode).toBe(0);

    expect(pinOf(fixture)).toBe(pinned);
    expect(pinOf(fixture)!.match(/\+sha/g)).toHaveLength(1);
  });

  it("202: `up` on an already-current pin is idempotent too", async () => {
    const fixture = createFixture({ name: "project", packageManager: "pnpm@11.1.2" });

    expect((await run(["up"], { ...fixture, registry, env: env() })).exitCode).toBe(0);
    const first = fixture.read("package.json");

    expect((await run(["up"], { ...fixture, registry, env: env() })).exitCode).toBe(0);
    expect(fixture.read("package.json")).toBe(first);
  });
});

/* -------------------------------------------------------------------------- */
/* §04.1 — nonexistent versions                                              */
/* -------------------------------------------------------------------------- */

describe("§04.1 nonexistent versions", () => {
  it("204: an exact pin that was never published is named as nonexistent", async () => {
    // §04.1 step 5 hands back an exact version without asking whether it exists,
    // so before this the first sign of trouble was `Server answered with HTTP
    // 404` naming a tarball URL the user never typed (#204).
    const fixture = createFixture({ packageManager: "pnpm@11.9.9" });

    const result = await run(["pnpm", "--version"], { ...fixture, registry, env: env() });

    expect(result.exitCode).toBe(1);
    // The origin *the tool asked for*, which is what answers "where did it look?".
    // The harness rewrites the host onto the mock at the transport layer
    // (`_harness/intercept.ts`), and the message deliberately reports the URL the
    // download layer was given rather than where the socket ended up.
    expect(result.stderr).toBe(
      `pnpm@11.9.9 does not exist in https://registry.npmjs.org. ` +
        `Run 'jup info' to see the resolved spec and where it came from.\n`,
    );
    expect(result.stderr).not.toContain("Server answered with HTTP 404");
  });

  it("204: the same for `corepack install -g`, in management-mode presentation", async () => {
    const fixture = createFixture();

    const result = await run(["cache", "install", "-g", "pnpm@11.9.9"], {
      ...fixture,
      registry,
      env: env(),
    });

    expect(result.exitCode).toBe(1);
    // A `UsageError`, so §12.1 puts it on stdout with the usage line.
    expect(result.stdout).toContain(`Usage Error: pnpm@11.9.9 does not exist in`);
    expect(result.stderr).toBe("");
  });

  it("204: a version that does exist is unaffected", async () => {
    const fixture = createFixture({ packageManager: "pnpm@11.1.2" });

    const result = await run(["pnpm", "--version"], { ...fixture, registry, env: env() });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("11.1.2\n");
  });

  /**
   * §04.1's `publishedFrom` — the narrower half of the same row.
   *
   * "Does not exist" is the wrong sentence when the version plainly does exist
   * and jup simply stopped reading the host that carries it. §02.5 put every
   * band on npm, and Yarn Berry landed on `@yarnpkg/cli-dist`, whose 2.x line
   * starts at 2.4.1 — so `yarn@2.2.2`, which `repo.yarnpkg.com` still serves,
   * 404s. The band declares `publishedFrom` and the 404 says which release to
   * pin instead.
   */
  it("204: a version below the band's `publishedFrom` names the release to pin", async () => {
    const fixture = createFixture({ packageManager: "yarn@2.2.2" });

    const result = await run(["yarn", "--version"], { ...fixture, registry, env: env() });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      `yarn@2.2.2 does not exist in https://registry.npmjs.org. ` +
        `jup installs yarn from @yarnpkg/cli-dist, whose earliest published version ` +
        `is 2.4.1; releases before it were only ever distributed elsewhere. ` +
        `Pin 2.4.1 or newer.\n`,
    );
    // The first sentence is `versionDoesNotExist`'s, unchanged — the two messages
    // differ only where they have something different to say.
    expect(result.stderr).toContain("does not exist in");
    expect(result.stderr).not.toContain("Server answered with HTTP 404");
  });

  it("204: a missing version *above* it keeps the bare sentence", async () => {
    // The branch is gated on the version, not on the tool: Berry above 2.4.1 is
    // published, so a 404 there means what it says.
    const fixture = createFixture({ packageManager: "yarn@3.9999.0" });

    const result = await run(["yarn", "--version"], { ...fixture, registry, env: env() });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      `yarn@3.9999.0 does not exist in https://registry.npmjs.org. ` +
        `Run 'jup info' to see the resolved spec and where it came from.\n`,
    );
  });

  it("204: `publishedFrom` gates no request — a published Berry release still installs", async () => {
    // The invariant that keeps a stale `publishedFrom` cheap: it selects a
    // sentence *after* a 404, and never decides whether to ask.
    const tarball = packageManagerTarball("yarn", "2.4.1", { packageName: "@yarnpkg/cli-dist" });
    registry.publish("@yarnpkg/cli-dist", "2.4.1", tarball, { distTags: { latest: "2.4.1" } });

    const fixture = createFixture({ packageManager: "yarn@2.4.1" });

    const result = await run(["yarn", "--version"], { ...fixture, registry, env: env() });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("2.4.1\n");
  });
});

/* -------------------------------------------------------------------------- */
/* §12.11 — mutating commands report                                          */
/* -------------------------------------------------------------------------- */

describe("§12.11 cache clean reports what it removed", () => {
  it("206: reports the count removed, then `Nothing to remove`", async () => {
    const fixture = createFixture();
    seedPackageManager(fixture.home, "pnpm", "11.1.2");
    seedPackageManager(fixture.home, "yarn", "1.22.4");

    const first = await run(["cache", "clean"], { ...fixture, registry });

    expect(first.exitCode).toBe(0);
    expect(first.stdout).toBe(`Removed 2 cached version(s) from ${join(fixture.home, "v1")}\n`);
    expect(first.stderr).toBe("");

    // §12.11 is "report what you did", and a report is only worth having if it
    // is true: a `cache clean` that printed the right count and removed nothing
    // would satisfy every assertion above.
    expect(existsSync(join(fixture.home, "v1"))).toBe(false);

    const second = await run(["cache", "clean"], { ...fixture, registry });

    expect(second.exitCode).toBe(0);
    expect(second.stdout).toBe("Nothing to remove\n");
  });

  it("206: `clear` is the same command and reports the same way", async () => {
    const fixture = createFixture();
    seedPackageManager(fixture.home, "pnpm", "11.1.2");

    const result = await run(["cache", "clear"], { ...fixture, registry });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Removed 1 cached version(s) from ");
  });
});
