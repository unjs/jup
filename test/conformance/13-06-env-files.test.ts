/**
 * §13.6 — `.corepack.env` (rows 52–62).
 *
 * Every row is asserted through a real run, because the interesting part of an
 * env file is which *behaviour* it does or does not change.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFINITIONS } from "../../src/config/table.ts";
import {
  cleanupFixtures,
  createFixture,
  MockRegistry,
  packageManagerTarball,
  run,
  seedPackageManager,
} from "./_harness/index.ts";

const YARN_DEFAULT = DEFINITIONS.yarn!.default;

const registry = new MockRegistry();

beforeAll(async () => {
  await registry.start();
  registry.publish("pnpm", "6.6.2", packageManagerTarball("pnpm", "6.6.2"));
});

afterAll(async () => {
  cleanupFixtures();
  await registry.stop();
});

beforeEach(() => registry.reset());

/** An empty project whose store already holds the default yarn. */
function autoPinProject() {
  const fixture = createFixture({});
  seedPackageManager(fixture.home, "yarn", YARN_DEFAULT);
  return fixture;
}

function pinned(fixture: { json(relative: string): unknown }): string | undefined {
  return (fixture.json("package.json") as { packageManager?: string }).packageManager;
}

describe("§13.6 env files", () => {
  it("52: .corepack.env can turn auto-pin on", async () => {
    const fixture = autoPinProject();
    fixture.write(".corepack.env", "COREPACK_ENABLE_AUTO_PIN=1\n");

    const result = await run(["yarn"], fixture);

    expect(result.exitCode).toBe(0);
    expect(pinned(fixture)).toMatch(/^yarn@/);
  });

  it("53: a real COREPACK_ENV_FILE=0 disables env files entirely", async () => {
    const fixture = autoPinProject();
    fixture.write(".corepack.env", "COREPACK_ENABLE_AUTO_PIN=1\n");

    const result = await run(["yarn"], { ...fixture, env: { COREPACK_ENV_FILE: "0" } });

    expect(result.exitCode).toBe(0);
    expect(pinned(fixture)).toBeUndefined();
  });

  it("54: the closest .corepack.env wins", async () => {
    const off = autoPinProject();
    off.write(".corepack.env", "COREPACK_ENABLE_AUTO_PIN=1\n");
    off.write("sub/.corepack.env", "COREPACK_ENABLE_AUTO_PIN=0\n");
    const suppressed = await run(["yarn"], { ...off, cwd: off.path("sub") });
    expect(suppressed.exitCode).toBe(0);
    expect(pinned(off)).toBeUndefined();

    const on = autoPinProject();
    on.write(".corepack.env", "COREPACK_ENABLE_AUTO_PIN=0\n");
    on.write("sub/.corepack.env", "COREPACK_ENABLE_AUTO_PIN=1\n");
    const applied = await run(["yarn"], { ...on, cwd: on.path("sub") });
    expect(applied.exitCode).toBe(0);
    expect(pinned(on)).toMatch(/^yarn@/);
  });

  it("55: an env file above the manifest that stopped the walk is never read", async () => {
    const fixture = createFixture({ packageManager: "yarn@1.0.0" });
    seedPackageManager(fixture.home, "yarn", "1.0.0");
    seedPackageManager(fixture.home, "yarn", YARN_DEFAULT);
    writeFileSync(join(fixture.root, ".corepack.env"), "COREPACK_ENABLE_PROJECT_SPEC=0\n");

    const result = await run(["yarn", "--version"], fixture);

    expect(result.exitCode).toBe(0);
    // Had the file been read, the pin would have been ignored and the default used.
    expect(result.stdout).toBe("1.0.0\n");
  });

  it("56: an env file inside node_modules is never read", async () => {
    const fixture = createFixture({ packageManager: "yarn@1.0.0" });
    seedPackageManager(fixture.home, "yarn", "1.0.0");
    seedPackageManager(fixture.home, "yarn", YARN_DEFAULT);
    fixture.write("node_modules/pkg/.corepack.env", "COREPACK_ENABLE_PROJECT_SPEC=0\n");
    fixture.write("node_modules/pkg/package.json", `{"name":"pkg"}\n`);

    const result = await run(["yarn", "--version"], {
      ...fixture,
      cwd: fixture.path("node_modules/pkg"),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("1.0.0\n");
  });

  it("57: a real environment variable beats the file", async () => {
    const fixture = autoPinProject();
    fixture.write(".corepack.env", "COREPACK_ENABLE_AUTO_PIN=1\n");

    const result = await run(["yarn"], { ...fixture, env: { COREPACK_ENABLE_AUTO_PIN: "0" } });

    expect(result.exitCode).toBe(0);
    expect(pinned(fixture)).toBeUndefined();
  });

  it("58: COREPACK_ENV_FILE names a different file, and .corepack.env is then ignored", async () => {
    const fixture = autoPinProject();
    fixture.write(".corepack.env", "COREPACK_ENABLE_AUTO_PIN=1\n");
    fixture.write(".other.env", "COREPACK_ENABLE_AUTO_PIN=0\n");

    const ignored = await run(["yarn"], { ...fixture, env: { COREPACK_ENV_FILE: ".other.env" } });
    expect(ignored.exitCode).toBe(0);
    expect(pinned(fixture)).toBeUndefined();

    const other = autoPinProject();
    other.write(".corepack.env", "COREPACK_ENABLE_AUTO_PIN=0\n");
    other.write(".other.env", "COREPACK_ENABLE_AUTO_PIN=1\n");
    const applied = await run(["yarn"], { ...other, env: { COREPACK_ENV_FILE: ".other.env" } });
    expect(applied.exitCode).toBe(0);
    expect(pinned(other)).toMatch(/^yarn@/);
  });

  it("59: keys without one of the tool's prefixes are dropped before anything is merged", async () => {
    const fixture = createFixture({ packageManager: "yarn@1.0.0" });
    seedPackageManager(fixture.home, "yarn", "1.0.0", {
      script: `process.stdout.write("LEAK=" + process.env.LEAK + " OPTIONS=" + process.env.NODE_OPTIONS + "\\n");\n`,
    });
    fixture.write(
      ".corepack.env",
      // `JUP_` and `COREPACK_` are the two prefixes §03.2 admits; anything else —
      // a bare name, or one belonging to the runtime — is dropped before the merge.
      "LEAK=leaked\nNODE_OPTIONS=--not-a-real-flag\nCOREPACK_ENABLE_STRICT=1\n",
    );

    const result = await run(["yarn"], fixture);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("LEAK=undefined OPTIONS=undefined\n");
  });

  it("60: .corepack.env cannot disable signature verification (§14.5)", async () => {
    const fixture = createFixture({ packageManager: "pnpm@6.6.2" });
    fixture.write(".corepack.env", "COREPACK_INTEGRITY_KEYS=0\n");

    const result = await run(["pnpm", "--version"], { ...fixture, registry });

    expect(result.exitCode).toBe(1);
    // The embedded trust store is still in force, so the mock's key is untrusted.
    expect(result.stderr).toContain("The package was not signed by any trusted keys");
    expect(result.stderr).toContain(
      `! Ignoring COREPACK_INTEGRITY_KEYS from ${join(fixture.cwd, ".corepack.env")}: this variable can only be set in the environment`,
    );
  });

  it("61: .corepack.env cannot allow a custom URL (§14.5)", async () => {
    const url = `${registry.origin}/yarn/-/yarn-1.22.21.tgz`;
    const fixture = createFixture({ packageManager: `yarn@${url}` });
    fixture.write(".corepack.env", "COREPACK_ENABLE_UNSAFE_CUSTOM_URLS=1\n");

    const result = await run(["yarn", "--version"], { ...fixture, registry });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Illegal use of URL for known package manager");
    expect(result.stderr).toContain(
      `! Ignoring COREPACK_ENABLE_UNSAFE_CUSTOM_URLS from ${join(fixture.cwd, ".corepack.env")}: this variable can only be set in the environment`,
    );
  });

  it("62: .corepack.env cannot supply COREPACK_NPM_TOKEN (§14.5)", async () => {
    registry.requiredAuthorization = "Bearer s3cret";

    const fromFile = createFixture({ packageManager: "pnpm@6.6.2" });
    fromFile.write(".corepack.env", "COREPACK_NPM_TOKEN=s3cret\n");
    const refused = await run(["pnpm", "--version"], {
      ...fromFile,
      registry,
      env: { COREPACK_INTEGRITY_KEYS: registry.trustStore() },
    });

    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("HTTP 401");
    expect(registry.requests.every((request) => request.authorization === undefined)).toBe(true);

    // The same token from the real environment is honoured, so the refusal above
    // is about *where* it came from and nothing else.
    const fromEnv = createFixture({ packageManager: "pnpm@6.6.2" });
    const accepted = await run(["pnpm", "--version"], {
      ...fromEnv,
      registry,
      env: {
        COREPACK_NPM_TOKEN: "s3cret",
        COREPACK_INTEGRITY_KEYS: registry.trustStore(),
      },
    });

    expect(accepted.exitCode).toBe(0);
    expect(accepted.stdout).toBe("6.6.2\n");
  });
});
