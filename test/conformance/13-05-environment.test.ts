/**
 * §13.5 — environment variables (rows 38–51).
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFINITIONS } from "../../src/config/table.ts";
import {
  cleanupFixtures,
  createFixture,
  MockRegistry,
  packageManagerTarball,
  pmScript,
  REPO_ROOT,
  run,
  seedPackageManager,
  versionOf,
} from "./_harness/index.ts";

const YARN_DEFAULT = DEFINITIONS.yarn!.default;
const YARN_TRANSPARENT = DEFINITIONS.yarn!.transparent.default!;
const PNPM_DEFAULT = DEFINITIONS.pnpm!.default;

const registry = new MockRegistry();

beforeAll(async () => {
  await registry.start();
  registry.publish(
    "yarn",
    versionOf(YARN_DEFAULT),
    packageManagerTarball("yarn", versionOf(YARN_DEFAULT)),
  );
  registry.publish(
    "@yarnpkg/cli-dist",
    "3.0.0-rc.2",
    packageManagerTarball("yarn", "3.0.0-rc.2", {
      binPaths: ["bin/yarn.js"],
      packageName: "@yarnpkg/cli-dist",
    }),
  );
  registry.publishFile(
    "/3.0.0/packages/yarnpkg-cli/bin/yarn.js",
    pmScript("yarn", "3.0.0"),
    "application/javascript",
  );
});

afterAll(async () => {
  cleanupFixtures();
  await registry.stop();
});

beforeEach(() => registry.reset());

describe("§13.5 environment variables", () => {
  it("38: a yarn invocation in an npm project is refused when STRICT is unset", async () => {
    const fixture = createFixture({ packageManager: "npm@6.14.2" });

    const result = await run(["yarn", "--version"], fixture);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("This project is configured to use npm");
  });

  it("39: the refusal names the manifest by absolute path", async () => {
    const fixture = createFixture({ packageManager: "yarn@1.0.0" });

    const result = await run(["pnpm", "--version"], fixture);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      `This project is configured to use yarn because ${join(fixture.cwd, "package.json")} has a "packageManager" field\n`,
    );
    expect(result.stdout).toBe("");
  });

  it("40: COREPACK_ENABLE_STRICT=0 falls back instead of failing", async () => {
    const fixture = createFixture({ packageManager: "yarn@1.0.0" });
    seedPackageManager(fixture.home, "yarn", "1.0.0");
    seedPackageManager(fixture.home, "pnpm", PNPM_DEFAULT);

    const foreign = await run(["pnpm", "--version"], {
      ...fixture,
      env: { COREPACK_ENABLE_STRICT: "0" },
    });
    expect(foreign.exitCode).toBe(0);
    expect(foreign.stdout).toBe(`${versionOf(PNPM_DEFAULT)}\n`);

    const pinned = await run(["yarn", "--version"], {
      ...fixture,
      env: { COREPACK_ENABLE_STRICT: "0" },
    });
    expect(pinned.exitCode).toBe(0);
    expect(pinned.stdout).toBe("1.0.0\n");
  });

  it("41: COREPACK_ENABLE_PROJECT_SPEC=0 ignores the pin entirely", async () => {
    const fixture = createFixture({ packageManager: "yarn@1.0.0" });
    seedPackageManager(fixture.home, "yarn", "1.0.0");
    seedPackageManager(fixture.home, "yarn", YARN_DEFAULT);

    const result = await run(["yarn", "--version"], {
      ...fixture,
      env: { COREPACK_ENABLE_PROJECT_SPEC: "0" },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${versionOf(YARN_DEFAULT)}\n`);
  });

  it("42: a transparent command runs in a foreign project", async () => {
    const fixture = createFixture({ packageManager: "npm@6.14.2" });
    seedPackageManager(fixture.home, "yarn", YARN_TRANSPARENT);

    const result = await run(["yarn", "dlx", "--help"], fixture);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(`yarn@${versionOf(YARN_TRANSPARENT)} dlx --help\n`);
  });

  it("43: COREPACK_ENABLE_AUTO_PIN=1 writes the pin and prints both notices", async () => {
    const fixture = createFixture({});
    seedPackageManager(fixture.home, "yarn", YARN_DEFAULT);

    const result = await run(["yarn"], { ...fixture, env: { COREPACK_ENABLE_AUTO_PIN: "1" } });

    expect(result.exitCode).toBe(0);
    const written = fixture.json("package.json") as { packageManager?: string };
    expect(written.packageManager).toMatch(/^yarn@/);
    expect(result.stderr).toBe(
      `! The local project doesn't define a 'packageManager' field. Corepack will now add one referencing yarn@${written.packageManager!.slice("yarn@".length)}.\n` +
        `! For more details about this field, consult the documentation at https://nodejs.org/api/packages.html#packagemanager\n\n`,
    );
  });

  it("44: without the variable, no pin is written", async () => {
    const fixture = createFixture({});
    seedPackageManager(fixture.home, "yarn", YARN_DEFAULT);

    const result = await run(["yarn"], fixture);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(
      (fixture.json("package.json") as { packageManager?: string }).packageManager,
    ).toBeUndefined();
  });

  it("45: COREPACK_ENABLE_NETWORK=0 with nothing cached refuses to reach the network", async () => {
    const fixture = createFixture({ packageManager: "yarn@1.22.4" });

    const result = await run(["yarn", "--version"], {
      ...fixture,
      env: { COREPACK_ENABLE_NETWORK: "0" },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Network access disabled by the environment");
  });

  it("46: COREPACK_ENABLE_DOWNLOAD_PROMPT=1 prints exactly the download notice", async () => {
    const fixture = createFixture({ packageManager: "yarn@3.0.0" });

    const result = await run(["yarn", "--version"], {
      ...fixture,
      registry,
      env: { COREPACK_ENABLE_DOWNLOAD_PROMPT: "1" },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe(
      `! Corepack is about to download https://repo.yarnpkg.com/3.0.0/packages/yarnpkg-cli/bin/yarn.js\n`,
    );
    expect(result.stdout).toBe("3.0.0\n");
  });

  it("47: the second, cached run says nothing", async () => {
    const fixture = createFixture({ packageManager: "yarn@3.0.0" });
    const options = {
      ...fixture,
      registry,
      env: { COREPACK_ENABLE_DOWNLOAD_PROMPT: "1" },
    };

    expect((await run(["yarn", "--version"], options)).exitCode).toBe(0);
    const second = await run(["yarn", "--version"], options);

    expect(second.exitCode).toBe(0);
    expect(second.stderr).toBe("");
    expect(second.stdout).toBe("3.0.0\n");
  });

  it("48: .corepack.env cannot enable the download prompt", async () => {
    const fixture = createFixture({ packageManager: "yarn@3.0.0" });
    fixture.write(".corepack.env", "COREPACK_ENABLE_DOWNLOAD_PROMPT=1\n");

    const result = await run(["yarn", "--version"], { ...fixture, registry });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("3.0.0\n");
    // The file cannot turn the prompt on, and says nothing about having tried.
    // §14.5's notice is reserved for the five security-relevant variables it
    // adds; this one corepack already refused silently, so announcing it would
    // break this row while telling the user nothing actionable.
    expect(result.stderr).toBe("");
  });

  it("49: the notice names the mirror's tarball for a default-version download", async () => {
    const fixture = createFixture({});

    const result = await run(["yarn", "--version"], {
      ...fixture,
      env: {
        COREPACK_NPM_REGISTRY: registry.origin,
        COREPACK_INTEGRITY_KEYS: registry.trustStore(),
        COREPACK_ENABLE_DOWNLOAD_PROMPT: "1",
      },
    });

    // The notice — the whole of what this row is about — is printed before the
    // artifact stream opens. The run itself then fails on the hash: the
    // compiled-in default pins the digest of the *real* published yarn, which no
    // mock can reproduce, so only the first stderr line is asserted here.
    // (§14.11's weak-algorithm warning for the default's `sha1` pin shares the
    // stream, so this is a line match rather than a whole-stream one.)
    expect(result.stderr).toMatch(
      new RegExp(
        `^! Corepack is about to download ${registry.origin}/yarn/-/yarn-1\\.\\d+\\.\\d+\\.tgz$`,
        "m",
      ),
    );
  });

  it("50: a Yarn Berry pin over a mirror names the @yarnpkg/cli-dist tarball", async () => {
    const digest = createHash("sha224").update(pmScript("yarn", "3.0.0-rc.2")).digest("hex");
    const fixture = createFixture({ packageManager: `yarn@3.0.0-rc.2+sha224.${digest}` });

    const result = await run(["yarn", "--version"], {
      ...fixture,
      env: {
        COREPACK_NPM_REGISTRY: registry.origin,
        COREPACK_INTEGRITY_KEYS: registry.trustStore(),
        COREPACK_ENABLE_DOWNLOAD_PROMPT: "1",
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe(
      `! Corepack is about to download ${registry.origin}/@yarnpkg/cli-dist/-/cli-dist-3.0.0-rc.2.tgz\n`,
    );
    expect(result.stdout).toBe("3.0.0-rc.2\n");
  });

  it("51: COREPACK_ROOT is exported to the package manager", async () => {
    const fixture = createFixture({ packageManager: "npm@6.14.2" });
    seedPackageManager(fixture.home, "npm", "6.14.2");

    const result = await run(["npm", "run", "env"], fixture);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`COREPACK_ROOT=${REPO_ROOT.replace(/\/$/, "")}\n`);
  });
});
