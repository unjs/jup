/**
 * §15.38 row 205 — a stray `packageManager` in `$HOME` (§15.35k).
 *
 * #424 is the single most-repeated confusion in its thread: a `package.json` in
 * the home directory — or any ancestor of it — silently governs *every*
 * directory on the machine that has no manifest of its own, and §12.5's error
 * names a file the user has no memory of creating. §15.35k appends a clause
 * saying so.
 *
 * The discriminating half is the **control**: the same error, from a manifest
 * inside a real project, must not carry the clause. A build that appended it
 * unconditionally would satisfy row 205 and be worse than one that never did.
 */

import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  cleanupFixtures,
  createFixture,
  type Fixture,
  run,
  type RunOptions,
  seedPackageManager,
} from "./_harness/index.ts";

const SUFFIX =
  `(this manifest is outside any project — a stray "packageManager" field there ` +
  `affects every directory)`;

afterAll(cleanupFixtures);

/**
 * A home directory carrying a stray pin, and an unrelated directory inside it.
 *
 * `fixture.root` stands in for `$HOME`: the fixture's own `cwd` is `root/project`
 * and its store is `root/home`, so pointing `HOME` at the root gives a directory
 * that the walk climbs *through* — which is the shape #424 describes and the one
 * a home directory beside the project could never produce.
 */
function strayHome(): { fixture: Fixture; options: RunOptions } {
  const fixture = createFixture({});
  seedPackageManager(fixture.home, "pnpm", "11.1.2");
  seedPackageManager(fixture.home, "yarn", "1.0.0");
  fixture.remove("package.json");

  return {
    fixture,
    options: {
      cwd: fixture.cwd,
      home: fixture.home,
      env: { HOME: fixture.root, USERPROFILE: fixture.root },
    },
  };
}

describe("§15.35k — a manifest outside any project says so (row 205)", () => {
  it("205: a $HOME pin governing an unrelated directory is flagged", async () => {
    const { fixture, options } = strayHome();
    // The stray file itself, one directory above the project the user is in.
    fixture.write("../package.json", `{"packageManager":"yarn@1.0.0"}\n`);

    const result = await run(["pnpm", "--version"], options);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      `This project is configured to use yarn because ${join(fixture.root, "package.json")} ` +
        `has a "packageManager" field ${SUFFIX}\n`,
    );
  });

  it("205: a manifest *above* the home directory is flagged too", async () => {
    // §15.35k says "the home directory or above": a `packageManager` field in
    // `/` or in `$HOME`'s parent governs strictly more directories, not fewer.
    const { fixture, options } = strayHome();
    fixture.write("../package.json", `{"packageManager":"yarn@1.0.0"}\n`);

    const result = await run(["pnpm", "--version"], {
      ...options,
      env: { HOME: join(fixture.root, "home"), USERPROFILE: join(fixture.root, "home") },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(SUFFIX);
  });

  it("205: a manifest inside a real project is not flagged", async () => {
    // The control, and the reason this row can fail. `$HOME` is somewhere else
    // entirely, so the pinned manifest is one project's declaration and §12.5's
    // sentence stands exactly as rows 38 and 39 assert it.
    const fixture = createFixture({ packageManager: "yarn@1.0.0" });
    seedPackageManager(fixture.home, "pnpm", "11.1.2");

    const result = await run(["pnpm", "--version"], fixture);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      `This project is configured to use yarn because ${join(fixture.cwd, "package.json")} ` +
        `has a "packageManager" field\n`,
    );
    expect(result.stderr).not.toContain("outside any project");
  });

  it("205: a project *inside* the home directory is not flagged", async () => {
    // The sharper control: the manifest is below `$HOME`, not at it. A check
    // written as "is the manifest anywhere under the home directory" — the
    // obvious wrong implementation — flags this one and fails here.
    const fixture = createFixture({ packageManager: "yarn@1.0.0" });
    seedPackageManager(fixture.home, "pnpm", "11.1.2");

    const result = await run(["pnpm", "--version"], {
      cwd: fixture.cwd,
      home: fixture.home,
      env: { HOME: fixture.root, USERPROFILE: fixture.root },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).not.toContain("outside any project");
  });
});
