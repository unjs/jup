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
  hashOf,
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

/**
 * §15.11 — Berry from `repo.yarnpkg.com` has no signature and no published
 * digest, so these rows pin the hash of the bytes the mock serves. The rows are
 * about the download *notice*, and the URL in it is unchanged.
 */
const BERRY = `3.0.0+sha512.${hashOf(Buffer.from(pmScript("yarn", "3.0.0"), "utf8"))}`;

beforeAll(async () => {
  await registry.start();
  registry.publish(
    "yarn",
    versionOf(YARN_DEFAULT),
    packageManagerTarball("yarn", versionOf(YARN_DEFAULT)),
  );
  // §15.33 bullet 2 moved yarn's compiled-in `default` onto the Berry line, and
  // §05.3 routes Berry through `@yarnpkg/cli-dist` whenever an npm registry is
  // configured — which is what row 49 is downloading over.
  registry.publish(
    "@yarnpkg/cli-dist",
    versionOf(YARN_DEFAULT),
    packageManagerTarball("yarn", versionOf(YARN_DEFAULT), {
      binPaths: ["bin/yarn.js"],
      packageName: "@yarnpkg/cli-dist",
    }),
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

  it("40/41: the JUP_ spelling drives the same behaviour, and wins over COREPACK_", async () => {
    // Every variable in §11 answers to both `JUP_X` and `COREPACK_X` — the tool
    // is `jup`, the table is written in corepack's spelling because that is what
    // projects and CI already set. This row runs the whole pipeline on the new
    // spelling, rather than trusting the unit tests' view of `readEnv`.
    const fixture = createFixture({ packageManager: "yarn@1.0.0" });
    seedPackageManager(fixture.home, "yarn", "1.0.0");
    seedPackageManager(fixture.home, "yarn", YARN_DEFAULT);

    const jup = await run(["yarn", "--version"], {
      ...fixture,
      env: { JUP_ENABLE_PROJECT_SPEC: "0" },
    });
    expect(jup.exitCode).toBe(0);
    expect(jup.stdout).toBe(`${versionOf(YARN_DEFAULT)}\n`);

    // Set against each other, the tool's own name is the more specific statement
    // and wins: the pin is honoured because JUP_ turns the ignore back off.
    const both = await run(["yarn", "--version"], {
      ...fixture,
      env: { COREPACK_ENABLE_PROJECT_SPEC: "0", JUP_ENABLE_PROJECT_SPEC: "1" },
    });
    expect(both.exitCode).toBe(0);
    expect(both.stdout).toBe("1.0.0\n");
  });

  it("41: COREPACK_ENABLE_PROJECT_SPEC=0 survives a manifest that cannot be parsed", async () => {
    // §03.5 / §11.1: "never look at the project at all", "entirely". The escape
    // hatch users reach for *because* their manifest is broken must not be
    // defeated by the broken manifest.
    const fixture = createFixture("{ this is not json");
    seedPackageManager(fixture.home, "yarn", YARN_DEFAULT);

    const result = await run(["yarn", "--version"], {
      ...fixture,
      env: { COREPACK_ENABLE_PROJECT_SPEC: "0" },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${versionOf(YARN_DEFAULT)}\n`);
    expect(result.stderr).toBe("");
  });

  it("41: COREPACK_ENABLE_PROJECT_SPEC=0 skips devEngines validation too", async () => {
    const fixture = createFixture({
      packageManager: "yarn@1.0.0",
      // `onFail` defaults to error, so this mismatch fails the run outright
      // while the project is being looked at.
      devEngines: { packageManager: { name: "pnpm", version: "10.x" } },
    });
    seedPackageManager(fixture.home, "yarn", YARN_DEFAULT);

    const strict = await run(["yarn", "--version"], fixture);
    expect(strict.exitCode).toBe(1);

    const result = await run(["yarn", "--version"], {
      ...fixture,
      env: { COREPACK_ENABLE_PROJECT_SPEC: "0" },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${versionOf(YARN_DEFAULT)}\n`);
    expect(result.stderr).toBe("");
  });

  it("41: a .jup.env may still be what sets the variable", async () => {
    const fixture = createFixture("{ this is not json");
    fixture.write(".jup.env", "COREPACK_ENABLE_PROJECT_SPEC=0\n");
    seedPackageManager(fixture.home, "yarn", YARN_DEFAULT);

    const result = await run(["yarn", "--version"], fixture);

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
    // §15.27/§15.35l added the last line: "it also covers the auto-pin case in
    // §03.6". It stays on stderr because this is proxy mode and stdout belongs
    // entirely to the package manager (§09.11).
    expect(result.stderr).toBe(
      `! The local project doesn't define a 'packageManager' field. jup will now add one referencing yarn@${written.packageManager!.slice("yarn@".length)}.\n` +
        `! For more details about this field, consult the documentation at https://nodejs.org/api/packages.html#packagemanager\n\n` +
        `Updated ${fixture.path("package.json")} to use ${written.packageManager}\n`,
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
    // §15.19 redirected this row. §12.6's bare "can't reach <url>" named a
    // tarball URL the user never typed and said nothing about how to fix it;
    // row 178 requires the airgapped failure to name the package manager and
    // the seeding command. "network access is disabled" survives inside it.
    expect(result.stderr).toContain("network access is disabled");
    expect(result.stderr).toContain("jup install -g --cache-only yarn@1.22.4");
  });

  it("46: COREPACK_ENABLE_DOWNLOAD_PROMPT=1 prints exactly the download notice", async () => {
    const fixture = createFixture({ packageManager: `yarn@${BERRY}` });

    const result = await run(["yarn", "--version"], {
      ...fixture,
      registry,
      env: { COREPACK_ENABLE_DOWNLOAD_PROMPT: "1" },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe(
      `! jup is about to download https://repo.yarnpkg.com/3.0.0/packages/yarnpkg-cli/bin/yarn.js\n`,
    );
    expect(result.stdout).toBe("3.0.0\n");
  });

  it("47: the second, cached run says nothing", async () => {
    const fixture = createFixture({ packageManager: `yarn@${BERRY}` });
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

  it("48: .jup.env cannot enable the download prompt", async () => {
    const fixture = createFixture({ packageManager: `yarn@${BERRY}` });
    fixture.write(".jup.env", "COREPACK_ENABLE_DOWNLOAD_PROMPT=1\n");

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
    // mock can reproduce, so only this stderr line is asserted here. The tarball
    // named is `@yarnpkg/cli-dist`'s because §05.3 switches Berry onto it over a
    // configured npm registry, and §15.33 put the default on the Berry line.
    expect(result.stderr).toMatch(
      new RegExp(
        `^! jup is about to download ${registry.origin}/@yarnpkg/cli-dist/-/cli-dist-${versionOf(
          YARN_DEFAULT,
        ).replaceAll(".", String.raw`\.`)}\\.tgz$`,
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
      `! jup is about to download ${registry.origin}/@yarnpkg/cli-dist/-/cli-dist-3.0.0-rc.2.tgz\n`,
    );
    expect(result.stdout).toBe("3.0.0-rc.2\n");
  });

  it("51: COREPACK_ROOT is exported to the package manager, under both spellings", async () => {
    const fixture = createFixture({ packageManager: "npm@6.14.2" });
    seedPackageManager(fixture.home, "npm", "6.14.2");

    const result = await run(["npm", "run", "env"], fixture);

    expect(result.exitCode).toBe(0);
    const root = REPO_ROOT.replace(/\/$/, "");
    expect(result.stdout).toContain(`COREPACK_ROOT=${root}\n`);
    // §11.3 / §14.22 — a corepack-aware package manager looks for the first; one
    // that has learnt this tool's name finds the second.
    expect(result.stdout).toContain(`JUP_ROOT=${root}\n`);
  });
});
