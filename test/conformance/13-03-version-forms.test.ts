/**
 * §13.3 — version forms (rows 14–21).
 *
 * These rows are about what a *reference* may look like, so nothing here is
 * pre-seeded: every install is a real download from the mock registry, verified
 * exactly as a production one would be.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupFixtures,
  createFixture,
  MockRegistry,
  packageManagerTarball,
  pmScript,
  run,
} from "./_harness/index.ts";

const registry = new MockRegistry();

/** Every download row needs the mock's key, since it is not in the embedded store. */
function env(extra?: Record<string, string | undefined>): Record<string, string | undefined> {
  return { COREPACK_INTEGRITY_KEYS: registry.trustStore(), ...extra };
}

beforeAll(async () => {
  await registry.start();

  for (const version of ["1.22.4", "1.22.21"]) {
    registry.publish("yarn", version, packageManagerTarball("yarn", version));
  }
  registry.publish("pnpm", "4.11.6", packageManagerTarball("pnpm", "4.11.6"));
  registry.publish("pnpm", "11.0.0-dev.1005", packageManagerTarball("pnpm", "11.0.0-dev.1005"));
  registry.publish("npm", "6.14.2", packageManagerTarball("npm", "6.14.2"));

  // A package manager nobody has heard of, for the custom-URL rows.
  registry.publish(
    "mypm",
    "1.0.0",
    packageManagerTarball("mypm", "1.0.0", { binPaths: ["bin/mypm.js"] }),
  );

  // Yarn Berry's single-file artifacts live on repo.yarnpkg.com, not on npm.
  for (const version of ["2.0.0-rc.30", "3.0.0-rc.2"]) {
    registry.publishFile(
      `/${version}/packages/yarnpkg-cli/bin/yarn.js`,
      pmScript("yarn", version),
      "application/javascript",
    );
  }
});

afterAll(async () => {
  cleanupFixtures();
  await registry.stop();
});

beforeEach(() => registry.reset());

describe("§13.3 version forms", () => {
  it.for([
    ["yarn", "1.22.4"],
    ["pnpm", "4.11.6"],
    ["npm", "6.14.2"],
  ])("14: %s@%s resolves exactly", async ([name, version]) => {
    const fixture = createFixture({ packageManager: `${name}@${version}` });

    const result = await run([name!, "--version"], { ...fixture, registry, env: env() });

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${version}\n`);
  });

  it.for([
    ["yarn", "2.0.0-rc.30", "yarn.js"],
    ["yarn", "3.0.0-rc.2", "yarn.js"],
    ["pnpm", "11.0.0-dev.1005", "bin/pnpm.mjs"],
  ])(
    "15: the prerelease %s@%s resolves and lands in its range band",
    async ([name, version, entry]) => {
      const fixture = createFixture({ packageManager: `${name}@${version}` });

      const result = await run([name!, "--version"], { ...fixture, registry, env: env() });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(`${version}\n`);
      // The band decides the entry-point layout: a single `yarn.js` for Berry, and
      // pnpm's `.mjs` (not `.js`/`.cjs`) for the >=11 band.
      expect(existsSync(join(fixture.home, "v1", name!, version!, entry!))).toBe(true);
    },
  );

  it("16: +sha1.<40 hex> and +sha224.<56 hex> suffixes are accepted and verified", async () => {
    const cases = [
      { name: "pnpm", version: "4.11.6", algo: "sha1" },
      { name: "npm", version: "6.14.2", algo: "sha224" },
    ] as const;

    for (const { name, version, algo } of cases) {
      const digest = createHash(algo).update(registry.tarballOf(name, version)).digest("hex");
      expect(digest).toHaveLength(algo === "sha1" ? 40 : 56);

      const good = createFixture({ packageManager: `${name}@${version}+${algo}.${digest}` });
      const accepted = await run([name, "--version"], { ...good, registry, env: env() });
      expect(accepted.exitCode).toBe(0);
      expect(accepted.stdout).toBe(`${version}\n`);

      // "and verified": the same pin with one byte changed must fail.
      const wrong = `${digest.slice(0, -1)}${digest.endsWith("0") ? "1" : "0"}`;
      const bad = createFixture({ packageManager: `${name}@${version}+${algo}.${wrong}` });
      const rejected = await run([name, "--version"], { ...bad, registry, env: env() });
      expect(rejected.exitCode).toBe(1);
      expect(rejected.stderr).toContain(`Mismatch hashes. Expected ${wrong}, got ${digest}`);
    }
  });

  it("17: a URL for a known package manager on the CLI is refused without the opt-in", async () => {
    const fixture = createFixture({});
    const url = `${registry.origin}/yarn/-/yarn-1.22.21.tgz`;

    const result = await run([`yarn@${url}`, "--version"], { ...fixture, registry, env: env() });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Illegal use of URL for known package manager");
    expect(result.stderr).toContain("COREPACK_ENABLE_UNSAFE_CUSTOM_URLS=1");
  });

  it("18: the same URL resolves to 1.22.21 with COREPACK_ENABLE_UNSAFE_CUSTOM_URLS=1", async () => {
    const fixture = createFixture({});
    const url = `${registry.origin}/yarn/-/yarn-1.22.21.tgz`;

    const result = await run([`yarn@${url}`, "--version"], {
      ...fixture,
      registry,
      env: env({ COREPACK_ENABLE_UNSAFE_CUSTOM_URLS: "1" }),
    });

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("1.22.21\n");
  });

  it("19: an unknown package manager referenced by URL runs the downloaded package", async () => {
    const fixture = createFixture({});
    const url = `${registry.origin}/mypm/-/mypm-1.0.0.tgz`;

    const result = await run([`mypm@${url}`, "--version"], {
      ...fixture,
      registry,
      env: env({ COREPACK_ENABLE_UNSAFE_CUSTOM_URLS: "1" }),
    });

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("1.0.0\n");
  });

  it("20: a #sha1.<hex> fragment on a URL reference is verified", async () => {
    const digest = createHash("sha1").update(registry.tarballOf("mypm", "1.0.0")).digest("hex");
    const url = `${registry.origin}/mypm/-/mypm-1.0.0.tgz`;

    const good = createFixture({});
    const accepted = await run([`mypm@${url}#sha1.${digest}`, "--version"], {
      ...good,
      registry,
      env: env({ COREPACK_ENABLE_UNSAFE_CUSTOM_URLS: "1" }),
    });
    expect(accepted.exitCode).toBe(0);
    expect(accepted.stdout).toBe("1.0.0\n");

    const bad = createFixture({});
    const rejected = await run([`mypm@${url}#sha1.${"0".repeat(40)}`, "--version"], {
      ...bad,
      registry,
      env: env({ COREPACK_ENABLE_UNSAFE_CUSTOM_URLS: "1" }),
    });
    expect(rejected.exitCode).toBe(1);
    expect(rejected.stderr).toContain(`Mismatch hashes. Expected ${"0".repeat(40)}, got ${digest}`);
  });

  it("21: a URL inside devEngines.packageManager.version is not a semver range", async () => {
    const url = "https://registry.yarnpkg.com/yarn/-/yarn-1.22.21.tgz";
    const fixture = createFixture({
      devEngines: { packageManager: { name: "yarn", version: url } },
    });

    const result = await run(["yarn", "--version"], { ...fixture, registry, env: env() });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      `The value of devEngines.packageManager.version "${url}" is not a valid semver range\n`,
    );
  });
});
