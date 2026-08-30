/**
 * §13.6 — `.jup.env` (rows 52–62f).
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
  effectivePin,
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

/** §03.3 — the pin the project declares, whichever field carries it (§03.7). */
function pinned(fixture: { json(relative: string): unknown }): string | undefined {
  return effectivePin(fixture.json("package.json"));
}

describe("§13.6 env files", () => {
  it("52: .jup.env can turn auto-pin on", async () => {
    const fixture = autoPinProject();
    fixture.write(".jup.env", "COREPACK_ENABLE_AUTO_PIN=1\n");

    const result = await run(["yarn"], fixture);

    expect(result.exitCode).toBe(0);
    expect(pinned(fixture)).toMatch(/^yarn@/);
  });

  it("53: a real COREPACK_ENV_FILE=0 disables env files entirely", async () => {
    const fixture = autoPinProject();
    fixture.write(".jup.env", "COREPACK_ENABLE_AUTO_PIN=1\n");

    const result = await run(["yarn"], { ...fixture, env: { COREPACK_ENV_FILE: "0" } });

    expect(result.exitCode).toBe(0);
    expect(pinned(fixture)).toBeUndefined();
  });

  it("54: the closest .jup.env wins", async () => {
    const off = autoPinProject();
    off.write(".jup.env", "COREPACK_ENABLE_AUTO_PIN=1\n");
    off.write("sub/.jup.env", "COREPACK_ENABLE_AUTO_PIN=0\n");
    const suppressed = await run(["yarn"], { ...off, cwd: off.path("sub") });
    expect(suppressed.exitCode).toBe(0);
    expect(pinned(off)).toBeUndefined();

    const on = autoPinProject();
    on.write(".jup.env", "COREPACK_ENABLE_AUTO_PIN=0\n");
    on.write("sub/.jup.env", "COREPACK_ENABLE_AUTO_PIN=1\n");
    const applied = await run(["yarn"], { ...on, cwd: on.path("sub") });
    expect(applied.exitCode).toBe(0);
    expect(pinned(on)).toMatch(/^yarn@/);
  });

  it("55: an env file above the manifest that stopped the walk is never read", async () => {
    const fixture = createFixture({ packageManager: "yarn@1.0.0" });
    seedPackageManager(fixture.home, "yarn", "1.0.0");
    seedPackageManager(fixture.home, "yarn", YARN_DEFAULT);
    writeFileSync(join(fixture.root, ".jup.env"), "COREPACK_ENABLE_PROJECT_SPEC=0\n");

    const result = await run(["yarn", "--version"], fixture);

    expect(result.exitCode).toBe(0);
    // Had the file been read, the pin would have been ignored and the default used.
    expect(result.stdout).toBe("1.0.0\n");
  });

  it("56: an env file inside node_modules is never read", async () => {
    const fixture = createFixture({ packageManager: "yarn@1.0.0" });
    seedPackageManager(fixture.home, "yarn", "1.0.0");
    seedPackageManager(fixture.home, "yarn", YARN_DEFAULT);
    fixture.write("node_modules/pkg/.jup.env", "COREPACK_ENABLE_PROJECT_SPEC=0\n");
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
    fixture.write(".jup.env", "COREPACK_ENABLE_AUTO_PIN=1\n");

    const result = await run(["yarn"], { ...fixture, env: { COREPACK_ENABLE_AUTO_PIN: "0" } });

    expect(result.exitCode).toBe(0);
    expect(pinned(fixture)).toBeUndefined();
  });

  it("58: COREPACK_ENV_FILE names a different file, and .jup.env is then ignored", async () => {
    const fixture = autoPinProject();
    fixture.write(".jup.env", "COREPACK_ENABLE_AUTO_PIN=1\n");
    fixture.write(".other.env", "COREPACK_ENABLE_AUTO_PIN=0\n");

    const ignored = await run(["yarn"], { ...fixture, env: { COREPACK_ENV_FILE: ".other.env" } });
    expect(ignored.exitCode).toBe(0);
    expect(pinned(fixture)).toBeUndefined();

    const other = autoPinProject();
    other.write(".jup.env", "COREPACK_ENABLE_AUTO_PIN=0\n");
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
      ".jup.env",
      // `JUP_` and `COREPACK_` are the two prefixes §03.2 admits; anything else —
      // a bare name, or one belonging to the runtime — is dropped before the merge.
      "LEAK=leaked\nNODE_OPTIONS=--not-a-real-flag\nCOREPACK_ENABLE_STRICT=1\n",
    );

    const result = await run(["yarn"], fixture);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("LEAK=undefined OPTIONS=undefined\n");
  });

  it("60: .jup.env cannot disable signature verification (§03.2)", async () => {
    const fixture = createFixture({ packageManager: "pnpm@6.6.2" });
    fixture.write(".jup.env", "COREPACK_INTEGRITY_KEYS=0\n");

    const result = await run(["pnpm", "--version"], { ...fixture, registry });

    expect(result.exitCode).toBe(1);
    // The embedded trust store is still in force, so the mock's key is untrusted.
    expect(result.stderr).toContain("The package was not signed by any trusted keys");
    expect(result.stderr).toContain(
      `⚠ Ignoring COREPACK_INTEGRITY_KEYS from ${join(fixture.cwd, ".jup.env")}: this variable can only be set in the environment`,
    );
  });

  it("61: .jup.env cannot allow a custom URL (§03.2)", async () => {
    const url = `${registry.origin}/yarn/-/yarn-1.22.21.tgz`;
    const fixture = createFixture({ packageManager: `yarn@${url}` });
    fixture.write(".jup.env", "COREPACK_ENABLE_UNSAFE_CUSTOM_URLS=1\n");

    const result = await run(["yarn", "--version"], { ...fixture, registry });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Illegal use of URL for known package manager");
    expect(result.stderr).toContain(
      `⚠ Ignoring COREPACK_ENABLE_UNSAFE_CUSTOM_URLS from ${join(fixture.cwd, ".jup.env")}: this variable can only be set in the environment`,
    );
  });

  it("62: .jup.env cannot supply COREPACK_NPM_TOKEN (§03.2)", async () => {
    registry.requiredAuthorization = "Bearer s3cret";

    const fromFile = createFixture({ packageManager: "pnpm@6.6.2" });
    fromFile.write(".jup.env", "COREPACK_NPM_TOKEN=s3cret\n");
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
  /* ---------------------------------------------------------------- *
   * Rows 62b–62f — the legacy name.
   *
   * §03.2 renamed the file, and `.corepack.env` is the one name in that
   * rename with copies on real disks, so §03.2 keeps reading it. These rows
   * pin the four things that make the fallback safe rather than surprising.
   * ---------------------------------------------------------------- */

  it("62b: .corepack.env alone is still read", async () => {
    const fixture = autoPinProject();
    fixture.write(".corepack.env", "COREPACK_ENABLE_AUTO_PIN=1\n");

    const result = await run(["yarn"], fixture);

    expect(result.exitCode).toBe(0);
    expect(pinned(fixture)).toMatch(/^yarn@/);
  });

  it("62c: .jup.env wins over a .corepack.env beside it", async () => {
    const off = autoPinProject();
    off.write(".jup.env", "COREPACK_ENABLE_AUTO_PIN=0\n");
    off.write(".corepack.env", "COREPACK_ENABLE_AUTO_PIN=1\n");
    const suppressed = await run(["yarn"], off);
    expect(suppressed.exitCode).toBe(0);
    expect(pinned(off)).toBeUndefined();

    const on = autoPinProject();
    on.write(".jup.env", "COREPACK_ENABLE_AUTO_PIN=1\n");
    on.write(".corepack.env", "COREPACK_ENABLE_AUTO_PIN=0\n");
    const applied = await run(["yarn"], on);
    expect(applied.exitCode).toBe(0);
    expect(pinned(on)).toMatch(/^yarn@/);
  });

  // The one the fallback could plausibly get wrong: resolving both names per
  // *directory* is what keeps "closest wins" true across the two spellings. A
  // walk that looked for every `.jup.env` first would let a repository root
  // silently override the package you are standing in.
  it("62d: a child's .corepack.env beats a parent's .jup.env", async () => {
    const off = autoPinProject();
    off.write(".jup.env", "COREPACK_ENABLE_AUTO_PIN=1\n");
    off.write("sub/.corepack.env", "COREPACK_ENABLE_AUTO_PIN=0\n");
    const suppressed = await run(["yarn"], { ...off, cwd: off.path("sub") });
    expect(suppressed.exitCode).toBe(0);
    expect(pinned(off)).toBeUndefined();

    const on = autoPinProject();
    on.write(".jup.env", "COREPACK_ENABLE_AUTO_PIN=0\n");
    on.write("sub/.corepack.env", "COREPACK_ENABLE_AUTO_PIN=1\n");
    const applied = await run(["yarn"], { ...on, cwd: on.path("sub") });
    expect(applied.exitCode).toBe(0);
    expect(pinned(on)).toMatch(/^yarn@/);
  });

  it("62e: a configured COREPACK_ENV_FILE has no fallback", async () => {
    const fixture = autoPinProject();
    fixture.write(".corepack.env", "COREPACK_ENABLE_AUTO_PIN=1\n");

    const result = await run(["yarn"], {
      ...fixture,
      env: { COREPACK_ENV_FILE: ".other.env" },
    });

    expect(result.exitCode).toBe(0);
    expect(pinned(fixture)).toBeUndefined();
  });

  // Not a deprecation. The walk is on the cold path of every run in a project
  // with no pin yet, so a line printed here would be printed constantly — and
  // the two spellings have to be indistinguishable in output, not merely both
  // read. Asserted as a byte-for-byte comparison rather than a `not.toContain`,
  // which would only rule out the wording this test happened to guess.
  it("62f: the legacy name prints exactly what the new name prints", async () => {
    const modern = autoPinProject();
    modern.write(".jup.env", "COREPACK_ENABLE_AUTO_PIN=1\n");
    const expected = await run(["yarn"], modern);

    const legacy = autoPinProject();
    legacy.write(".corepack.env", "COREPACK_ENABLE_AUTO_PIN=1\n");
    const actual = await run(["yarn"], legacy);

    // The auto-pin notice names the manifest it rewrote, and the two fixtures
    // live in different temp directories; that path is the only licensed
    // difference between the two runs.
    const scrub = (text: string, fixture: { cwd: string }) => text.replaceAll(fixture.cwd, "<p>");

    expect(actual.exitCode).toBe(expected.exitCode);
    expect(scrub(actual.stderr, legacy)).toBe(scrub(expected.stderr, modern));
    expect(pinned(legacy)).toBe(pinned(modern));
  });
});
