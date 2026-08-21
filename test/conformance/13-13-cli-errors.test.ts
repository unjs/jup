/**
 * §13.13 — CLI errors (rows 142–147).
 *
 * §12.1's stream split is part of these rows: a `UsageError` in *management*
 * mode goes to stdout with a usage line under it, while proxy mode prints the
 * bare message on stderr.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupFixtures,
  createFixture,
  MockRegistry,
  packageManagerTarball,
  REPO_ROOT,
  run,
  seedPackageManager,
} from "./_harness/index.ts";

const registry = new MockRegistry();

const OWN_VERSION = (
  JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { version: string }
).version;

beforeAll(async () => {
  await registry.start();
  registry.publish("yarn", "1.22.4", packageManagerTarball("yarn", "1.22.4"), {
    distTags: { latest: "1.22.4" },
  });
  registry.publishFile(
    "/tags",
    JSON.stringify({ aliases: { latest: "4.9.9", stable: "4.9.9" }, tags: ["2.4.3", "4.9.9"] }),
    "application/json",
  );
});

afterAll(async () => {
  cleanupFixtures();
  await registry.stop();
});

beforeEach(() => registry.reset());

describe("§13.13 CLI errors", () => {
  it("142: install with no project at all", async () => {
    const fixture = createFixture();

    const result = await run(["install"], fixture);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain(
      `Usage Error: Couldn't find a project in the local directory - please specify the package manager to pack, or run this command from a valid project`,
    );
    expect(result.stdout).toContain("$ corepack install");
    expect(result.stderr).toBe("");
  });

  it("143: install in a project with no spec", async () => {
    const fixture = createFixture({ name: "no-spec" });

    const result = await run(["install"], fixture);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain(
      `Usage Error: The local project doesn't feature a 'packageManager' field nor a 'devEngines.packageManager' field - please specify the package manager to pack, or update the manifest to reference it`,
    );
  });

  it("144: an impossible range reports what the user asked for", async () => {
    const fixture = createFixture();

    const result = await run(["install", "-g", "yarn@^99.0.0"], { ...fixture, registry });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain(
      `Usage Error: Failed to successfully resolve '^99.0.0' to a valid yarn release`,
    );
  });

  it("145: a tag that does not exist", async () => {
    const fixture = createFixture();

    const result = await run(["install", "-g", "yarn@nosuchtag"], { ...fixture, registry });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain(`Usage Error: Tag not found (nosuchtag)`);
  });

  it("146: --version prints the tool's own version", async () => {
    const fixture = createFixture();

    const result = await run(["--version"], fixture);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${OWN_VERSION}\n`);
    expect(result.stderr).toBe("");
  });

  it("147: yarn --version is yarn's version — the proxy shadows the builtin", async () => {
    const fixture = createFixture({ packageManager: "yarn@1.22.4" });
    seedPackageManager(fixture.home, "yarn", "1.22.4");

    const result = await run(["yarn", "--version"], fixture);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("1.22.4\n");
    expect(result.stdout).not.toContain(OWN_VERSION);
  });
});
