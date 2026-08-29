/**
 * §13.2 — spec parsing and discovery (rows 1–13).
 *
 * Every row runs the real entry point against a throwaway project and a
 * throwaway store; the pinned package managers are hand-planted fakes, because
 * what is under test here is discovery, not downloading.
 */

import { afterAll, describe, expect, it } from "vitest";
import { DEFINITIONS } from "../../src/config/table.ts";
import {
  cleanupFixtures,
  createFixture,
  run,
  seedPackageManager,
  versionOf,
} from "./_harness/index.ts";

const YARN_DEFAULT = DEFINITIONS.yarn!.default;

afterAll(cleanupFixtures);

describe("§13.2 spec parsing and discovery", () => {
  it("1: packageManager yarn@1.22.4 -> yarn --version prints 1.22.4", async () => {
    const fixture = createFixture({ packageManager: "yarn@1.22.4" });
    seedPackageManager(fixture.home, "yarn", "1.22.4");

    const result = await run(["yarn", "--version"], fixture);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("1.22.4\n");
    expect(result.stderr).toBe("");
  });

  it("2: packageManager yarn -> No version specified", async () => {
    const fixture = createFixture({ packageManager: "yarn" });

    const result = await run(["yarn", "--version"], fixture);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      `No version specified for yarn in "packageManager" of package.json\n`,
    );
    expect(result.stdout).toBe("");
  });

  // Rows 3 and 4 are superseded by §04.4: a dist-tag and a semver range are both
  // valid pins now, and what used to be their rejection is asserted here as
  // acceptance. Their §13 wording ("expected a semver version") survives only in
  // rows 2 and 5, where the pin names no version at all.
  it("3: packageManager yarn@stable resolves from its recorded resolution", async () => {
    const fixture = createFixture({ packageManager: "yarn@stable" });
    seedPackageManager(fixture.home, "yarn", "1.22.4");
    // No mock registry is wired into this file, so a tag lookup would have to
    // reach the real repo.yarnpkg.com — exit 0 is therefore also the assertion
    // that the recorded resolution answered without any network at all.
    fixture.write(
      "jup.lock",
      `${JSON.stringify({ version: 1, resolutions: { "yarn@stable": { resolved: "1.22.4" } } })}\n`,
    );

    const result = await run(["yarn", "--version"], fixture);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("1.22.4\n");
    expect(result.stderr).toBe("");
  });

  it("4: packageManager yarn@^1.0.0 resolves, and memoes what it resolved to", async () => {
    const fixture = createFixture({ packageManager: "yarn@^1.0.0" });
    seedPackageManager(fixture.home, "yarn", "1.22.4");
    fixture.write("node_modules/.keep", "");

    const result = await run(["yarn", "--version"], fixture);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("1.22.4\n");
    expect(result.stderr).toBe("");
    // §04.4 — the project's own file is a decision, and running yarn is not
    // one: what a proxy run may write is the memo in `node_modules/.jup`.
    expect(fixture.exists("jup.lock")).toBe(false);
    // No `integrity`: this store entry was hand-planted with a placeholder hash
    // rather than downloaded, and an unusable digest is recorded as none at all.
    // Row 181 covers the real thing, against bytes that were actually fetched.
    const memo = fixture.json("node_modules/.jup/jup.lock") as {
      version: number;
      resolutions: Record<string, { resolved: string; expires: number }>;
    };
    expect(memo.version).toBe(1);
    expect(memo.resolutions["yarn@^1.0.0"]?.resolved).toBe("1.22.4");
    expect(memo.resolutions["yarn@^1.0.0"]?.expires).toBeGreaterThan(Date.now());
  });

  it("5: packageManager yarn@ -> No version specified", async () => {
    const fixture = createFixture({ packageManager: "yarn@" });

    const result = await run(["yarn", "--version"], fixture);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("No version specified");
  });

  it("6: a vendored manifest in node_modules/foo is ignored; the ancestor pin wins", async () => {
    const fixture = createFixture({ packageManager: "yarn@1.22.4" });
    fixture.write("node_modules/foo/package.json", `{"packageManager":"pnpm@4.11.6"}\n`);
    seedPackageManager(fixture.home, "yarn", "1.22.4");

    const result = await run(["yarn", "--version"], {
      ...fixture,
      cwd: fixture.path("node_modules/foo"),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("1.22.4\n");
  });

  it("7: a vendored manifest in node_modules/@scope/foo is ignored; the ancestor pin wins", async () => {
    const fixture = createFixture({ packageManager: "yarn@1.22.4" });
    fixture.write("node_modules/@scope/foo/package.json", `{"packageManager":"pnpm@4.11.6"}\n`);
    seedPackageManager(fixture.home, "yarn", "1.22.4");

    const result = await run(["yarn", "--version"], {
      ...fixture,
      cwd: fixture.path("node_modules/@scope/foo"),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("1.22.4\n");
  });

  it("8: the closest manifest wins — npm@6.14.2 in foo/ over yarn@1.22.4 at the root", async () => {
    const fixture = createFixture({ packageManager: "yarn@1.22.4" });
    fixture.write("foo/package.json", `{"packageManager":"npm@6.14.2"}\n`);
    seedPackageManager(fixture.home, "npm", "6.14.2");

    const result = await run(["npm", "--version"], { ...fixture, cwd: fixture.path("foo") });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("6.14.2\n");
  });

  it("9: no package.json anywhere -> exit 0 with the default version", async () => {
    const fixture = createFixture();
    seedPackageManager(fixture.home, "yarn", YARN_DEFAULT);

    const result = await run(["yarn", "--version"], fixture);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${versionOf(YARN_DEFAULT)}\n`);
    expect(result.stderr).toBe("");
  });

  it("10: an empty package.json -> exit 0 with the built-in default version", async () => {
    const fixture = createFixture({});
    seedPackageManager(fixture.home, "yarn", YARN_DEFAULT);

    const result = await run(["yarn", "--version"], fixture);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${versionOf(YARN_DEFAULT)}\n`);
    expect(result.stderr).toBe("");
  });

  it("11: invalid JSON -> Invalid package.json in <path>", async () => {
    const fixture = createFixture(`{"packageManager": "yarn@1.22.4"`);

    const result = await run(["yarn", "--version"], fixture);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(`Invalid package.json in package.json\n`);
  });

  it("12: a UTF-8 BOM does not stop the spec being parsed", async () => {
    const fixture = createFixture(`﻿{"packageManager":"yarn@1.22.4"}\n`);
    seedPackageManager(fixture.home, "yarn", "1.22.4");

    const result = await run(["yarn", "--version"], fixture);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("1.22.4\n");
  });

  it("13: corepack use preserves the BOM in the rewritten manifest (§03.7)", async () => {
    const fixture = createFixture(`﻿{\n  "name": "bom",\n  "packageManager": "yarn@1.0.0"\n}\n`);
    seedPackageManager(fixture.home, "yarn", "1.22.4");

    const result = await run(["use", "yarn@1.22.4"], fixture);

    expect(result.exitCode).toBe(0);
    const written = fixture.read("package.json");
    expect(written.startsWith("﻿")).toBe(true);
    expect(written).toContain(`"packageManager": "yarn@1.22.4+sha512.seeded"`);
    // The rewrite is surgical: key order and the rest of the file are untouched.
    expect(written).toContain(`"name": "bom"`);
  });
});
