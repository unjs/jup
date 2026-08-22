/**
 * §15.38 rows 158–161 — registry metadata robustness (§15.7, §15.8).
 *
 * The driving reports are corepack #570, #725 and #808: a private registry that
 * omits `dist`, or strips `dist.signatures`, produced a raw
 * `TypeError: Cannot read properties of undefined`, and the only documented
 * remedy — `COREPACK_INTEGRITY_KEYS=0` — traded a metadata-shape problem for a
 * permanent, global security downgrade. These rows pin the three outcomes
 * §15.7 requires instead, and §15.8's package-root retry.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupFixtures,
  createFixture,
  hashOf,
  MockRegistry,
  packageManagerTarball,
  run,
} from "./_harness/index.ts";

const registry = new MockRegistry();

/** The exact bytes the mock serves for `pnpm@6.6.2`, so a test can pin them. */
const TARBALL = packageManagerTarball("pnpm", "6.6.2");

/** Everything points at the mock as if it were the configured npm registry. */
function mirror(extra?: Record<string, string | undefined>): Record<string, string | undefined> {
  return {
    COREPACK_NPM_REGISTRY: registry.origin,
    COREPACK_INTEGRITY_KEYS: registry.trustStore(),
    ...extra,
  };
}

/** How many times `needle` occurs in `haystack`. */
function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

beforeAll(async () => {
  await registry.start();
  registry.publish("pnpm", "6.6.2", TARBALL, { distTags: { latest: "6.6.2" } });
});

afterAll(async () => {
  cleanupFixtures();
  await registry.stop();
});

beforeEach(() => registry.reset());

describe("§15.7 / §15.8 registry metadata robustness", () => {
  it("158: metadata with no `dist` key reports the registry, rather than crashing", async () => {
    registry.mode = "no_dist";
    const fixture = createFixture({ packageManager: "pnpm@6.6.2" });

    const result = await run(["pnpm", "--version"], { ...fixture, env: mirror() });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      `pnpm@6.6.2 metadata from ${registry.origin} has no "dist" section; this registry may not be npm-compatible`,
    );
    // The symptom every one of #570, #725 and #808 actually reported.
    expect(result.stderr).not.toContain("Cannot read properties");
    expect(existsSync(join(fixture.home, "v1", "pnpm"))).toBe(false);
  });

  it("159: `dist` without `signatures` and a pinned hash succeeds with one warning", async () => {
    registry.mode = "no_signatures";
    const fixture = createFixture({ packageManager: `pnpm@6.6.2+sha512.${hashOf(TARBALL)}` });

    const result = await run(["pnpm", "--version"], { ...fixture, env: mirror() });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("6.6.2\n");
    // §15.7's soft-fail, worded verbatim and emitted exactly once.
    const warning = `! ${registry.origin} does not publish signatures for pnpm@6.6.2; falling back to integrity-only verification`;
    expect(occurrences(result.stderr, warning)).toBe(1);
  });

  it("160: the same with no pinned hash is refused under COREPACK_REQUIRE_SIGNATURES", async () => {
    registry.mode = "no_signatures";
    const unset = createFixture({ packageManager: "pnpm@6.6.2" });

    // Without the variable, the registry's own `integrity` carries the install.
    const permitted = await run(["pnpm", "--version"], { ...unset, env: mirror() });
    expect(permitted.exitCode).toBe(0);
    expect(permitted.stderr).toContain("does not publish signatures");

    const fixture = createFixture({ packageManager: "pnpm@6.6.2" });
    const result = await run(["pnpm", "--version"], {
      ...fixture,
      env: mirror({ COREPACK_REQUIRE_SIGNATURES: "1" }),
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("No compatible signature found in package metadata");
    // Refused before anything reached the store (§06.2).
    expect(existsSync(join(fixture.home, "v1", "pnpm"))).toBe(false);
  });

  it("161: signatures absent from the version endpoint are read from the package root", async () => {
    registry.mode = "root_only_signatures";
    const fixture = createFixture({ packageManager: "pnpm@6.6.2" });

    const result = await run(["pnpm", "--version"], {
      // Mandating signatures proves the fallback verified one, rather than the
      // soft-fail quietly carrying the install.
      ...fixture,
      env: mirror({ COREPACK_REQUIRE_SIGNATURES: "1" }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("6.6.2\n");
    expect(result.stderr).not.toContain("does not publish signatures");

    // §15.8's one extra request, and it comes *after* the version endpoint that
    // failed to carry the signatures.
    const paths = registry.requests.map((request) => request.path);
    expect(paths.indexOf("/pnpm")).toBeGreaterThan(paths.indexOf("/pnpm/6.6.2"));
    expect(paths.filter((path) => path === "/pnpm")).toHaveLength(1);
  });

  it("161: a signed version endpoint never asks the package root", async () => {
    const fixture = createFixture({ packageManager: "pnpm@6.6.2" });

    const result = await run(["pnpm", "--version"], {
      ...fixture,
      env: mirror({ COREPACK_REQUIRE_SIGNATURES: "1" }),
    });

    expect(result.exitCode).toBe(0);
    // The happy path pays for none of §15.8: metadata, then tarball.
    expect(registry.requests.map((request) => request.path)).toStrictEqual([
      "/pnpm/6.6.2",
      "/pnpm/-/pnpm-6.6.2.tgz",
    ]);
  });
});
