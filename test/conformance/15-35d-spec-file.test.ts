/**
 * §15.35d — `COREPACK_SPEC_FILE`, an external file supplying the project spec.
 *
 * #682 and #402: a vendored or generated tree whose `package.json` cannot be
 * edited — sometimes because it names the *wrong* package manager, sometimes
 * because a build step rewrites it — has no way to say which package manager it
 * wants. The variable names a file that supplies `packageManager` /
 * `devEngines.packageManager` instead, and **overrides the manifest**.
 *
 * §15.37 marks it env-file **ineligible**, and that is the half worth being
 * careful about: eligibility in `env.ts` is a *deny*-list, so a `COREPACK_*`
 * variable is project-settable until it is named. A `.corepack.env` able to set
 * this would let a cloned repository run a package manager its own manifest
 * never mentions. `test/unit/env.test.ts` pins the set membership; the row here
 * pins the observable consequence.
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

/** A project pinning yarn, with pnpm also available in the store. */
function project() {
  const fixture = createFixture({ packageManager: "yarn@1.0.0" });
  seedPackageManager(fixture.home, "yarn", "1.0.0");
  seedPackageManager(fixture.home, "pnpm", "11.1.2");
  return fixture;
}

describe("§15.35d — COREPACK_SPEC_FILE overrides the manifest", () => {
  it("supplies `packageManager` for a manifest that cannot be edited", async () => {
    const fixture = project();
    fixture.write("vendor/spec.json", `{"packageManager":"pnpm@11.1.2"}\n`);

    const result = await run(["pnpm", "--version"], {
      ...fixture,
      env: { COREPACK_SPEC_FILE: "vendor/spec.json" },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("11.1.2\n");
    expect(result.stderr).toBe("");
  });

  it("outranks the manifest rather than merging with it", async () => {
    // The discriminating half. The manifest pins yarn and the file pins pnpm, so
    // `yarn --version` — which the manifest alone would permit — must now be the
    // §12.5 mismatch, naming the *file* as the thing that configured it.
    const fixture = project();
    fixture.write("vendor/spec.json", `{"packageManager":"pnpm@11.1.2"}\n`);

    const result = await run(["yarn", "--version"], {
      ...fixture,
      env: { COREPACK_SPEC_FILE: "vendor/spec.json" },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      `This project is configured to use pnpm because ${fixture.path("vendor/spec.json")} ` +
        `has a "packageManager" field\n`,
    );
  });

  it("reads `devEngines.packageManager` from it too", async () => {
    const fixture = project();
    fixture.write(
      "vendor/spec.json",
      `${JSON.stringify({ devEngines: { packageManager: { name: "pnpm", version: "11.1.2" } } })}\n`,
    );

    const result = await run(["pnpm", "--version"], {
      ...fixture,
      env: { COREPACK_SPEC_FILE: "vendor/spec.json" },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("11.1.2\n");
  });

  it("does not read the manifest at all — a broken one no longer fails the run", async () => {
    // §15.35d's driving case: the file exists *because* the manifest is not
    // usable. A walk that still parsed it would go on failing on exactly the
    // file the variable was set to bypass.
    const fixture = createFixture("{ this is not JSON");
    seedPackageManager(fixture.home, "pnpm", "11.1.2");
    fixture.write("spec.json", `{"packageManager":"pnpm@11.1.2"}\n`);

    const result = await run(["pnpm", "--version"], {
      ...fixture,
      env: { COREPACK_SPEC_FILE: "spec.json" },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("11.1.2\n");
  });

  it("errors when the file is not there, rather than falling back", async () => {
    const fixture = project();

    const result = await run(["pnpm", "--version"], {
      ...fixture,
      env: { COREPACK_SPEC_FILE: "vendor/spec.json" },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      `JUP_SPEC_FILE points at ${fixture.path("vendor/spec.json")}, which does not exist\n`,
    );
    // Not the manifest's yarn pin, quietly: a typo must not silently restore the
    // behaviour the variable was set to override.
    expect(result.stdout).toBe("");
  });

  it("reports the file when its own contents are unparseable", async () => {
    const fixture = project();
    fixture.write("vendor/spec.json", "{ nope");

    const result = await run(["pnpm", "--version"], {
      ...fixture,
      env: { COREPACK_SPEC_FILE: "vendor/spec.json" },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`Invalid package.json`);
    expect(result.stderr).toContain(fixture.path("vendor/spec.json"));
  });

  it("§15.37: a project's .corepack.env cannot set it", async () => {
    const fixture = project();
    fixture.write("vendor/spec.json", `{"packageManager":"pnpm@11.1.2"}\n`);
    fixture.write(".corepack.env", "COREPACK_SPEC_FILE=vendor/spec.json\n");

    // The manifest's yarn pin still governs, so `pnpm` is the mismatch it always
    // was — the repository could not redirect its own spec.
    const result = await run(["pnpm", "--version"], fixture);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("This project is configured to use yarn");
    expect(result.stderr).toContain(fixture.path("package.json"));
    // §14.5 — refused loudly, because it is a security-relevant variable.
    expect(result.stderr).toContain("COREPACK_SPEC_FILE");
  });

  it("COREPACK_ENABLE_PROJECT_SPEC=0 ignores it, as it ignores the manifest", async () => {
    // §11.1's "never look at the project at all" covers a redirected spec: a
    // spec file is still the project speaking.
    const fixture = project();
    seedPackageManager(fixture.home, "yarn", YARN_DEFAULT);
    fixture.write("vendor/spec.json", `{"packageManager":"pnpm@11.1.2"}\n`);

    const result = await run(["yarn", "--version"], {
      ...fixture,
      env: {
        COREPACK_SPEC_FILE: "vendor/spec.json",
        COREPACK_ENABLE_PROJECT_SPEC: "0",
        // Proof by construction that neither declaration was consulted: the
        // fallback is the compiled-in default, already in the store, and any
        // request at all would be a hard failure.
        COREPACK_ENABLE_NETWORK: "0",
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${versionOf(YARN_DEFAULT)}\n`);
    expect(result.stderr).not.toContain("This project is configured");
  });
});
