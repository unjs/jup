/**
 * row 197 — §01.4, global invocations bypass the project pin.
 *
 * #690: `npm install -g corepack@latest` inside a yarn- or pnpm-pinned project
 * dies on §03.5's name mismatch, which blocks the tool's own documented upgrade
 * path. A global command operates outside the project by definition, so §01.4
 * makes it transparent (§01.4).
 *
 * **This is worse here than in corepack, and that is our doing**: §10.7 shims
 * `npm` by default, which corepack never did, so the failure reaches users
 * corepack's version could not.
 *
 * Half of this file is the boundary from the *other* side. `-g` is three
 * characters long and appears in plenty of argument lists that are nothing to do
 * with installing globally, so the rows below pin where the scan stops — a scan
 * that simply searched `argv` would pass every positive row here and fail every
 * negative one.
 */

import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DEFINITIONS } from "../../src/config/table.ts";
import {
  cleanupFixtures,
  createFixture,
  run,
  seedPackageManager,
  versionOf,
} from "./_harness/index.ts";

const NPM_DEFAULT = DEFINITIONS.npm!.default;
const PNPM_DEFAULT = DEFINITIONS.pnpm!.default;

/** A project that pins yarn, with the *global* npm and pnpm defaults available. */
function yarnProject() {
  const fixture = createFixture({ name: "app", packageManager: "yarn@1.0.0" });
  seedPackageManager(fixture.home, "yarn", "1.0.0");
  seedPackageManager(fixture.home, "npm", NPM_DEFAULT);
  seedPackageManager(fixture.home, "pnpm", PNPM_DEFAULT);
  return { fixture, options: { cwd: fixture.cwd, home: fixture.home } };
}

const MISMATCH = "This project is configured to use yarn because";

afterAll(cleanupFixtures);

describe("§01.4 — a global invocation is transparent (row 197)", () => {
  it("197: `npm install -g <pkg>` is permitted in a yarn-pinned project", async () => {
    const { options } = yarnProject();

    // #690's own command.
    const result = await run(["npm", "install", "-g", "corepack@latest"], options);

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    // §01.4's second half: the version used is the **global default**, not the
    // project's pin — which is also proof the fallback path was taken.
    expect(result.stdout).toBe(`npm@${versionOf(NPM_DEFAULT)} install -g corepack@latest\n`);
  });

  it("197: the control — the same command without the flag still errors", async () => {
    const { fixture, options } = yarnProject();

    const result = await run(["npm", "install", "corepack@latest"], options);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      `This project is configured to use yarn because ${join(fixture.cwd, "package.json")} has a "packageManager" field\n`,
    );
  });

  it.for([
    [["npm", "install", "--global", "x"]],
    [["npm", "i", "-g", "x"]],
    [["npm", "-g", "install", "x"]],
    [["npm", "--location=global", "install", "x"]],
    [["npm", "install", "--location=global", "x"]],
    [["npm", "install", "--location", "global", "x"]],
    [["npm", "--silent", "install", "--no-audit", "-g", "x"]],
  ])("197: %s is global", async ([args]) => {
    const { options } = yarnProject();
    const result = await run(args!, options);
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("197: the equivalent pnpm invocation too", async () => {
    const { options } = yarnProject();

    const result = await run(["pnpm", "add", "-g", "x"], options);

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`pnpm@${versionOf(PNPM_DEFAULT)} add -g x\n`);
  });
});

describe("§01.4 — where the scan stops (row 197)", () => {
  /*
   * Each of these carries a `-g` that belongs to whatever the package manager is
   * about to run, not to the package manager. Recognising one would let a
   * project's pin be bypassed by an argument the user never wrote — so every one
   * of them must still hit §03.5's mismatch.
   */
  it.for([
    [["npm", "run", "build", "--", "-g"]],
    [["npm", "exec", "--", "something", "-g"]],
    [["npm", "exec", "something", "-g"]],
    [["npm", "run", "build", "-g"]],
    [["npm", "install", "--", "-g"]],
    [["npm", "test", "--", "--global"]],
  ])("197: %s is not global", async ([args]) => {
    const { options } = yarnProject();
    const result = await run(args!, options);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(MISMATCH);
    expect(result.stdout).toBe("");
  });

  it("197: a global invocation of the project's own package manager still honours the pin", async () => {
    const { options } = yarnProject();

    // Transparency is about the *name* mismatch (§03.5). `-g` is recognised
    // here, and must still not send a matching name to the global default
    // (`transparent.default`, 4.x) instead of the project's 1.0.0.
    const result = await run(["yarn", "-g", "add", "x"], options);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("yarn@1.0.0 -g add x\n");
  });
});
