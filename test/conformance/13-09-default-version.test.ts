/**
 * §13.9 — the default version and `lastKnownGood.json` (rows 97–104).
 *
 * Rows 97–100 are a *sequence* against one store: they describe how the recorded
 * default moves (and does not move) as projects come and go, so they share a
 * fixture and run in order.
 */

import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupFixtures,
  createFixture,
  hashOf,
  MockRegistry,
  packageManagerTarball,
  publishBerry,
  run,
  type Fixture,
} from "./_harness/index.ts";

const registry = new MockRegistry();

/**
 * §15.11 — Berry from `repo.yarnpkg.com` clears a verification tier only
 * through a pinned hash, so the rows that install one pin the digest of the
 * bytes the mock serves.
 */
const BERRY = `2.2.2+sha512.${hashOf(packageManagerTarball("yarn", "2.2.2", { packageName: "@yarnpkg/cli-dist" }))}`;

/** Nothing listens here; used to prove a step needed no network. */
const DEAD = { COREPACK_NPM_REGISTRY: "http://127.0.0.1:1" };

function trusted(extra?: Record<string, string | undefined>): Record<string, string | undefined> {
  return { COREPACK_INTEGRITY_KEYS: registry.trustStore(), ...extra };
}

function lastKnownGood(fixture: Fixture): Record<string, string> {
  const file = join(fixture.home, "lastKnownGood.json");
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, string>) : {};
}

/** The store shared by rows 97–100. */
let sequence: Fixture;

beforeAll(async () => {
  await registry.start();

  for (const version of ["1.0.0", "1.22.4"]) {
    registry.publish("yarn", version, packageManagerTarball("yarn", version), {
      distTags: { latest: "1.22.4" },
    });
  }
  registry.publish("npm", "7.24.2", packageManagerTarball("npm", "7.24.2"), {
    distTags: { latest: "7.24.2", "latest-7": "7.24.2" },
  });

  // §15.41 — Berry is an npm package, so its versions and its dist-tags come
  // from one packument. It used to be single `.js` files on `repo.yarnpkg.com`
  // plus a url-type `/tags` document (tags under `aliases`, versions under
  // `tags`, §05.3).
  publishBerry(registry, "2.2.2");
  publishBerry(registry, "4.9.9");
  registry.publish(
    "@yarnpkg/cli-dist",
    "4.9.9",
    packageManagerTarball("yarn", "4.9.9", { packageName: "@yarnpkg/cli-dist" }),
    { distTags: { latest: "4.9.9", stable: "4.9.9" } },
  );

  sequence = createFixture({ packageManager: "yarn@1.22.4" });
});

afterAll(async () => {
  cleanupFixtures();
  await registry.stop();
});

beforeEach(() => registry.reset());

describe("§13.9 default version and last-known-good", () => {
  it("97: installing 1.22.4 over a recorded 1.0.0 advances the default (same major)", async () => {
    // Seed the recorded default the way `install -g` would have.
    const seed = await run(["install", "-g", "yarn@1.0.0"], {
      ...sequence,
      registry,
      env: trusted(),
    });
    expect(seed.exitCode).toBe(0);
    expect(lastKnownGood(sequence).yarn).toMatch(/^1\.0\.0/);

    const result = await run(["yarn", "--version"], {
      ...sequence,
      registry,
      env: trusted({ COREPACK_DEFAULT_TO_LATEST: "1" }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("1.22.4\n");
    expect(lastKnownGood(sequence).yarn).toMatch(/^1\.22\.4/);
  });

  it("98: with the manifest removed, the recorded default answers — offline", async () => {
    sequence.remove("package.json");

    const result = await run(["yarn", "--version"], {
      ...sequence,
      env: { ...DEAD, COREPACK_DEFAULT_TO_LATEST: "1" },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("1.22.4\n");
  });

  it("99: installing 2.2.2 does not move a default in another major", async () => {
    sequence.write("package.json", `{"packageManager":"yarn@${BERRY}"}\n`);

    const result = await run(["yarn", "--version"], {
      ...sequence,
      registry,
      env: trusted({ COREPACK_DEFAULT_TO_LATEST: "1" }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("2.2.2\n");
    expect(lastKnownGood(sequence).yarn).toMatch(/^1\.22\.4/);
  });

  it("100: with the manifest removed again, the default is still 1.22.4", async () => {
    sequence.remove("package.json");

    const result = await run(["yarn", "--version"], {
      ...sequence,
      env: { ...DEAD, COREPACK_DEFAULT_TO_LATEST: "1" },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("1.22.4\n");
  });

  it("101: install -g sets the default unconditionally, even downgrading a major", async () => {
    const fixture = createFixture({});

    expect(
      (await run(["install", "-g", `yarn@${BERRY}`], { ...fixture, registry, env: trusted() }))
        .exitCode,
    ).toBe(0);
    expect(lastKnownGood(fixture).yarn).toMatch(/^2\.2\.2/);

    expect(
      (await run(["install", "-g", "yarn@1.0.0"], { ...fixture, registry, env: trusted() }))
        .exitCode,
    ).toBe(0);
    expect(lastKnownGood(fixture).yarn).toMatch(/^1\.0\.0/);

    const result = await run(["yarn", "--version"], { ...fixture, env: DEAD });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("1.0.0\n");
  });

  it("102: install -g npm@latest-7 resolves the dist-tag and pins the 7.x line", async () => {
    const fixture = createFixture({});

    const installed = await run(["install", "-g", "npm@latest-7"], {
      ...fixture,
      registry,
      env: trusted(),
    });
    expect(installed.exitCode).toBe(0);

    const result = await run(["npm", "--version"], { ...fixture, env: DEAD });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^7\./);
  });

  it("103: install -g yarn (bare) resolves the true latest, not the 1.x line", async () => {
    const fixture = createFixture({});

    // §15.41 — no opt-out. This row needed `COREPACK_ALLOW_UNVERIFIED=1` for as
    // long as a bare name resolved through Berry's `/tags` document on
    // `repo.yarnpkg.com`, which published neither signatures nor digests: the
    // most ordinary first command anyone types was also the one that could not
    // clear §15.11. Resolving through `@yarnpkg/cli-dist` gives it npm's
    // signature, so the plain form now works on a clean machine — and the empty
    // stderr below is the assertion that says so.
    const result = await run(["install", "-g", "yarn"], {
      ...fixture,
      registry,
      env: trusted(),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("Installing yarn@4.9.9...\n");
    expect(result.stderr).toBe("");
    expect(lastKnownGood(fixture).yarn).toMatch(/^4\.9\.9/);
  });

  it("104: a COREPACK_HOME that has been deleted is re-created", async () => {
    const fixture = createFixture({});
    rmSync(fixture.home, { recursive: true, force: true });

    const result = await run(["yarn", "--version"], {
      ...fixture,
      registry,
      env: trusted({ COREPACK_DEFAULT_TO_LATEST: "1" }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("1.22.4\n");
    expect(existsSync(join(fixture.home, "lastKnownGood.json"))).toBe(true);
  });
});
