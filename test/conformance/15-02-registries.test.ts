/**
 * §15.38 rows 151–152 — per-source registries (§15.2) and origin rewriting (§15.3).
 *
 * #753 (15👍, no maintainer response) is "corepack ignores `COREPACK_NPM_REGISTRY`
 * for the Yarn registry", and #872 is a Renovate deployment whose IP gets banned
 * for fetching Yarn across hundreds of repositories with no way to point at a
 * self-hosted mirror. Corepack's override rewrites exactly one hardcoded prefix,
 * `https://registry.npmjs.org`, so Yarn Berry — which lives on `repo.yarnpkg.com`
 * — had no mirror path of its own at all, and the only workaround redirected npm
 * and pnpm as collateral.
 *
 * **Four rows are gone**, and Berry's fixtures with them. They asserted §15.2
 * against Yarn's *own* distribution origin — that `COREPACK_REGISTRY_YARN` could
 * move `repo.yarnpkg.com` where `COREPACK_NPM_REGISTRY` could not. §15.41 put
 * every band on the npm registry, so that origin is not in the table any more
 * and the distinction those rows drew cannot be set up. The variable itself is
 * unchanged and still asserted below, on Classic; what it lost is the case that
 * motivated it.
 *
 * Every row here runs **three** servers: the default registry, a Yarn-only
 * mirror, and a shared npm mirror. A harness that collapsed them into one could
 * not tell "Yarn was mirrored" from "everything was", which is precisely the
 * distinction §15.2 exists to make.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupFixtures,
  createFixture,
  MockRegistry,
  packageManagerTarball,
  run,
} from "./_harness/index.ts";

/** `registry.npmjs.org` and `repo.yarnpkg.com`, via `intercept.ts`. */
const fallback = new MockRegistry();
/** Yarn's own mirror: a copy of `repo.yarnpkg.com`, not an npm registry. */
const yarnMirror = new MockRegistry();
/** A shared npm mirror, for the precedence assertions. */
const npmMirror = new MockRegistry();

const PNPM = packageManagerTarball("pnpm", "6.6.2");
const YARN_CLASSIC = packageManagerTarball("yarn", "1.22.4");

function trustAll(): string {
  const keys = [fallback, yarnMirror, npmMirror].flatMap(
    (registry) => (JSON.parse(registry.trustStore()) as { npm: unknown[] }).npm,
  );
  return JSON.stringify({ npm: keys });
}

const paths = (registry: MockRegistry): string[] =>
  registry.requests.map((request) => request.path);

beforeAll(async () => {
  await Promise.all([fallback.start(), yarnMirror.start(), npmMirror.start()]);
  for (const registry of [fallback, yarnMirror, npmMirror]) {
    registry.publish("pnpm", "6.6.2", PNPM, { distTags: { latest: "6.6.2" } });
    registry.publish("yarn", "1.22.4", YARN_CLASSIC, { distTags: { latest: "1.22.4" } });
  }
});

afterAll(async () => {
  cleanupFixtures();
  await Promise.all([fallback.stop(), yarnMirror.stop(), npmMirror.stop()]);
});

beforeEach(() => {
  for (const registry of [fallback, yarnMirror, npmMirror]) registry.reset();
});

describe("§15.2 — one mirror mechanism for every source", () => {
  it("151: npm and pnpm keep using the default registry", async () => {
    const fixture = createFixture({ packageManager: "pnpm@6.6.2" });

    const result = await run(["pnpm", "--version"], {
      ...fixture,
      registry: fallback,
      env: {
        COREPACK_REGISTRY_YARN: yarnMirror.origin,
        COREPACK_INTEGRITY_KEYS: trustAll(),
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("6.6.2\n");
    expect(paths(fallback)).toEqual(["/pnpm/6.6.2", "/pnpm/-/pnpm-6.6.2.tgz"]);
    // Mirroring Yarn must not drag pnpm along — which is the *only* thing
    // `COREPACK_NPM_REGISTRY` can do, and the whole of #753.
    expect(yarnMirror.requests).toEqual([]);
  });

  it("151: credentials follow the per-source registry, not the default one", async () => {
    // §14.6 scopes credentials to "the configured registry's origin". With
    // §15.2 there is one such origin *per package manager*, and the token has to
    // follow the one actually in force — otherwise mirroring Yarn onto an
    // authenticated internal host produces a 401 nobody can explain.
    const fixture = createFixture({ packageManager: "yarn@1.22.4" });
    yarnMirror.requiredAuthorization = "Bearer mirror-token";

    const result = await run(["yarn", "--version"], {
      ...fixture,
      registry: fallback,
      env: {
        COREPACK_REGISTRY_YARN: yarnMirror.origin,
        COREPACK_NPM_TOKEN: "mirror-token",
        COREPACK_INTEGRITY_KEYS: trustAll(),
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("1.22.4\n");
    // Yarn Classic's band is an npm registry, so §15.2 moves both the packument
    // and the tarball off `registry.yarnpkg.com`.
    expect(paths(yarnMirror)).toEqual(["/yarn/1.22.4", "/yarn/-/yarn-1.22.4.tgz"]);
    expect(yarnMirror.requests.map((request) => request.authorization)).toEqual([
      "Bearer mirror-token",
      "Bearer mirror-token",
    ]);
    expect(fallback.requests).toEqual([]);
  });

  it("names the effective registry and its source per package manager in `info`", async () => {
    const fixture = createFixture({ packageManager: "pnpm@6.6.2" });

    const result = await run(["info", "--json"], {
      ...fixture,
      env: {
        COREPACK_NPM_REGISTRY: npmMirror.origin,
        COREPACK_REGISTRY_YARN: yarnMirror.origin,
      },
    });

    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout) as {
      packageManagers: Array<{ name: string; registry: string; registrySource: string }>;
    };
    const byName = new Map(report.packageManagers.map((entry) => [entry.name, entry]));

    expect(byName.get("yarn")).toMatchObject({
      registry: yarnMirror.origin,
      registrySource: "COREPACK_REGISTRY_YARN",
    });
    expect(byName.get("pnpm")).toMatchObject({
      registry: npmMirror.origin,
      registrySource: "COREPACK_NPM_REGISTRY",
    });
  });
});

describe("§15.3 — rewrite origins, not substrings", () => {
  it("152: an override differing only by host case and trailing slash rewrites cleanly", async () => {
    const fixture = createFixture({ packageManager: "pnpm@6.6.2" });

    const result = await run(["pnpm", "--version"], {
      ...fixture,
      registry: fallback,
      env: {
        // The same origin as the built-in default, spelled differently. Both
        // differences are normalised by the URL parser; corepack's `String.replace`
        // sees neither.
        COREPACK_NPM_REGISTRY: "https://REGISTRY.NPMJS.ORG/",
        COREPACK_INTEGRITY_KEYS: trustAll(),
      },
    });

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("6.6.2\n");
    expect(fallback.requests.map((request) => request.original)).toEqual([
      "https://registry.npmjs.org/pnpm/6.6.2",
      "https://registry.npmjs.org/pnpm/-/pnpm-6.6.2.tgz",
    ]);
    // No doubled slash anywhere: a mirror like registry.npmmirror.com answers
    // `404` for one (§05.2).
    for (const path of paths(fallback)) expect(path).not.toContain("//");
  });

  it("152: an override with a path prefix prepends it exactly once", async () => {
    npmMirror.basePath = "/artifactory/api/npm/npm-remote";
    const fixture = createFixture({ packageManager: "pnpm@6.6.2" });

    const result = await run(["pnpm", "--version"], {
      ...fixture,
      registry: fallback,
      env: {
        COREPACK_NPM_REGISTRY: `${npmMirror.origin}${npmMirror.basePath}/`,
        COREPACK_INTEGRITY_KEYS: trustAll(),
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("6.6.2\n");
    expect(paths(npmMirror)).toEqual([
      "/artifactory/api/npm/npm-remote/pnpm/6.6.2",
      "/artifactory/api/npm/npm-remote/pnpm/-/pnpm-6.6.2.tgz",
    ]);
    expect(fallback.requests).toEqual([]);
  });

  it("152: a URL that merely contains the default registry is left alone", async () => {
    // Corepack's substring `replace` rewrites the middle of this one, turning a
    // refusal into a request to the mirror. §14.9 must refuse it instead.
    const fixture = createFixture({});
    writeFileSync(
      join(fixture.cwd, "package.json"),
      `${JSON.stringify({
        packageManager: "yarn@https://evil.example.com/https://registry.npmjs.org/yarn.js",
      })}\n`,
    );

    await run(["yarn", "--version"], {
      ...fixture,
      registry: fallback,
      env: {
        COREPACK_NPM_REGISTRY: npmMirror.origin,
        COREPACK_ENABLE_UNSAFE_CUSTOM_URLS: "1",
        COREPACK_INTEGRITY_KEYS: trustAll(),
      },
    });

    // Whatever the outcome, it must not have been fetched from the mirror as if
    // the URL had been rewritten onto it.
    expect(npmMirror.requests).toEqual([]);
    expect(fallback.requests).toEqual([]);
  });
});
