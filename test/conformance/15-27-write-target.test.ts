/**
 * §03.7 — a predictable target for project-mutating commands (rows 191–192).
 *
 * #607: `corepack use` in a nested directory of a monorepo updates the **root**
 * `package.json`. Corepack's author confirmed the behaviour is intentional,
 * agreed it is surprising outside Yarn-style workspaces, and floated a `--here`
 * flag without committing to it.
 *
 * Two halves, and the second is the cheap one that retires the whole complaint:
 * the walk stops at a workspace boundary instead of climbing indefinitely, and
 * every mutating command prints the path it modified.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupFixtures,
  createFixture,
  effectivePin,
  MockRegistry,
  packageManagerTarball,
  run,
} from "./_harness/index.ts";

const registry = new MockRegistry();

function env(extra?: Record<string, string | undefined>): Record<string, string | undefined> {
  return { COREPACK_INTEGRITY_KEYS: registry.trustStore(), CI: undefined, ...extra };
}

/**
 * §03.3 — the pin one manifest declares, whichever field carries it. These rows
 * are about *which file* the write lands in, so the field it lands in is the
 * other section's business (§03.7).
 */
function pinAt(file: string, fixture: { json(relative: string): unknown }): string | undefined {
  return effectivePin(fixture.json(file));
}

/** A manifest in an *ancestor* of the fixture's project directory. */
function ancestorManifest(fixture: { root: string }, data: unknown): void {
  writeFileSync(join(fixture.root, "package.json"), `${JSON.stringify(data, undefined, 2)}\n`);
}

beforeAll(async () => {
  await registry.start();
  for (const version of ["11.0.0", "11.1.2"]) {
    registry.publish("pnpm", version, packageManagerTarball("pnpm", version), {
      distTags: { latest: "11.1.2" },
    });
  }
});

afterAll(async () => {
  cleanupFixtures();
  await registry.stop();
});

beforeEach(() => registry.reset());

describe("§03.7 write targets", () => {
  it("191: `use` in a nested dir updates the workspaces root, and prints its path", async () => {
    const fixture = createFixture({ name: "root", workspaces: ["packages/*"] });
    mkdirSync(fixture.path("packages/app"), { recursive: true });
    fixture.write("packages/app/package.json", `{"name":"app"}\n`);

    const result = await run(["use", "pnpm@11.1.2"], {
      ...fixture,
      cwd: fixture.path("packages/app"),
      registry,
      env: env(),
    });

    expect(result.exitCode).toBe(0);
    expect(pinAt("package.json", fixture)).toMatch(/^pnpm@11\.1\.2\+sha512\./);
    expect(pinAt("packages/app/package.json", fixture)).toBeUndefined();

    // §12.11 — the line that makes the choice visible instead of surprising.
    expect(result.stdout).toContain(
      `Updated ${fixture.path("package.json")} to use ${pinAt("package.json", fixture)}`,
    );
  });

  it("191: a pnpm-workspace.yaml is a boundary too, even with no `workspaces` field", async () => {
    const fixture = createFixture({ name: "root" });
    fixture.write("pnpm-workspace.yaml", "packages:\n  - packages/*\n");
    mkdirSync(fixture.path("packages/app"), { recursive: true });
    fixture.write("packages/app/package.json", `{"name":"app"}\n`);
    // Without the boundary the walk climbs past the repository entirely and
    // lands here — the "corepack edited a file I did not expect" report.
    ancestorManifest(fixture, { name: "outside", packageManager: "pnpm@11.0.0" });

    const result = await run(["use", "pnpm@11.1.2"], {
      ...fixture,
      cwd: fixture.path("packages/app"),
      registry,
      env: env(),
    });

    expect(result.exitCode).toBe(0);
    expect(pinAt("package.json", fixture)).toMatch(/^pnpm@11\.1\.2\+sha512\./);
    // The manifest outside the repository is untouched.
    expect(JSON.parse(String(fixture.read("../package.json"))).packageManager).toBe("pnpm@11.0.0");
  });

  it("191: the boundary applies to `up` as well, which reads and writes one file", async () => {
    const fixture = createFixture({
      name: "root",
      workspaces: ["packages/*"],
      packageManager: "pnpm@11.0.0",
    });
    mkdirSync(fixture.path("packages/app"), { recursive: true });
    fixture.write("packages/app/package.json", `{"name":"app"}\n`);
    ancestorManifest(fixture, { name: "outside", packageManager: "pnpm@11.0.0" });

    const result = await run(["up"], {
      ...fixture,
      cwd: fixture.path("packages/app"),
      registry,
      env: env(),
    });

    expect(result.exitCode).toBe(0);
    expect(pinAt("package.json", fixture)).toMatch(/^pnpm@11\.1\.2\+sha512\./);
    expect(JSON.parse(String(fixture.read("../package.json"))).packageManager).toBe("pnpm@11.0.0");
  });

  it("192: `--here` forces the mutation into the current directory's manifest", async () => {
    const fixture = createFixture({ name: "root", workspaces: ["packages/*"] });
    mkdirSync(fixture.path("packages/app"), { recursive: true });
    fixture.write("packages/app/package.json", `{"name":"app"}\n`);

    const result = await run(["use", "--here", "pnpm@11.1.2"], {
      ...fixture,
      cwd: fixture.path("packages/app"),
      registry,
      env: env(),
    });

    expect(result.exitCode).toBe(0);
    expect(pinAt("packages/app/package.json", fixture)).toMatch(/^pnpm@11\.1\.2\+sha512\./);
    expect(pinAt("package.json", fixture)).toBeUndefined();
    expect(result.stdout).toContain(`Updated ${fixture.path("packages/app/package.json")} to use`);
  });

  it("192: `--here` creates the manifest when the current directory has none", async () => {
    const fixture = createFixture({ name: "root", workspaces: ["packages/*"] });
    mkdirSync(fixture.path("packages/fresh"), { recursive: true });

    const result = await run(["use", "--here", "pnpm@11.1.2"], {
      ...fixture,
      cwd: fixture.path("packages/fresh"),
      registry,
      env: env(),
    });

    expect(result.exitCode).toBe(0);
    expect(pinAt("packages/fresh/package.json", fixture)).toMatch(/^pnpm@11\.1\.2\+sha512\./);
    expect(pinAt("package.json", fixture)).toBeUndefined();
  });

  it("192: `up --here` refreshes only the current directory's pin", async () => {
    const fixture = createFixture({
      name: "root",
      workspaces: ["packages/*"],
      packageManager: "pnpm@11.0.0",
    });
    mkdirSync(fixture.path("packages/app"), { recursive: true });
    fixture.write("packages/app/package.json", `{"name":"app","packageManager":"pnpm@11.0.0"}\n`);

    const result = await run(["up", "--here"], {
      ...fixture,
      cwd: fixture.path("packages/app"),
      registry,
      env: env(),
    });

    expect(result.exitCode).toBe(0);
    expect(pinAt("packages/app/package.json", fixture)).toMatch(/^pnpm@11\.1\.2\+sha512\./);
    expect(pinAt("package.json", fixture)).toBe("pnpm@11.0.0");
  });

  it("191: reading is unchanged — a nested package still inherits the root's pin", async () => {
    // §03.7 is about *writing*. §03.1's documented monorepo read behaviour —
    // a package with no pin of its own uses its ancestor's — is what makes a
    // monorepo work at all, and must not move.
    const fixture = createFixture({
      name: "root",
      workspaces: ["packages/*"],
      packageManager: "pnpm@11.1.2",
    });
    mkdirSync(fixture.path("packages/app"), { recursive: true });
    fixture.write("packages/app/package.json", `{"name":"app"}\n`);

    expect((await run(["install"], { ...fixture, registry, env: env() })).exitCode).toBe(0);

    registry.reset();
    const result = await run(["pnpm", "--version"], {
      ...fixture,
      cwd: fixture.path("packages/app"),
      registry,
      env: env(),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("11.1.2\n");
  });
});
