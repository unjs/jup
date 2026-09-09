/**
 * §04.6 — the default a package manager's own lockfile implies.
 *
 * `pnpm-lock.yaml` carries the format it was written in, and pnpm changed that
 * format on major boundaries: `5.4` is pnpm 7, `6.0` is pnpm 8, `9.0` is every
 * major from 9 on. Running a different major over such a file is not benign —
 * the newer one rewrites it in its own format and re-resolves the pins on the
 * way, and `--frozen-lockfile` refuses outright.
 *
 * So where the format names one major, that major is the default here. It stays
 * a guess: every statement a project actually makes outranks it, and a format
 * four current majors write says nothing at all.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupFixtures,
  createFixture,
  type Fixture,
  MockRegistry,
  packageManagerTarball,
  run,
} from "./_harness/index.ts";

const registry = new MockRegistry();

function env(extra?: Record<string, string | undefined>): Record<string, string | undefined> {
  return {
    COREPACK_INTEGRITY_KEYS: registry.trustStore(),
    CI: undefined,
    // §04.6 step 3 — the rows need a *global default* to distinguish the guess
    // from, and the compiled-in one names a version this registry does not
    // carry. With this set, "no opinion" is the mock's `latest`.
    COREPACK_DEFAULT_TO_LATEST: "1",
    ...extra,
  };
}

/** The newest release the registry offers, and so the default with no opinion. */
const LATEST = "11.1.2";

/** A project that declares nothing: the only state §04.6's guess is reached in. */
function project(manifest: unknown = { name: "demo" }): Fixture {
  return createFixture(manifest);
}

/**
 * A `pnpm-lock.yaml` header, as pnpm writes it.
 *
 * Only the first line is read, and only the first document of it: pnpm >= 12
 * puts its own resolution in a document ahead of the project's, and both carry
 * the same `lockfileVersion`.
 */
function lock(version: string): string {
  return `lockfileVersion: ${version}

settings:
  autoInstallPeers: true

importers:

  .:
    dependencies:
      semver:
        specifier: ^7.0.0
        version: 7.5.0
`;
}

beforeAll(async () => {
  await registry.start();

  // One release in each major the rows below reach for, plus a newer one in the
  // guessed major: the assertions have to distinguish "the range decided" from
  // "the only 8.x there was".
  for (const version of ["7.33.7", "8.0.0", "8.9.9", LATEST]) {
    registry.publish("pnpm", version, packageManagerTarball("pnpm", version));
  }
  registry.publish("pnpm", LATEST, packageManagerTarball("pnpm", LATEST), {
    distTags: { latest: LATEST },
  });
});

afterAll(async () => {
  cleanupFixtures();
  await registry.stop();
});

beforeEach(() => registry.reset());

describe("§04.6 the format the package manager's own lockfile is written in", () => {
  it("runs the major that wrote the lockfile, not the newest release there is", async () => {
    const fixture = project();
    fixture.write("pnpm-lock.yaml", lock("'6.0'"));

    const result = await run(["pnpm", "--version"], { ...fixture, registry, env: env() });

    expect(result.exitCode).toBe(0);
    // 8.9.9 is the newest the format admits; 11.1.2 is what the machine would
    // otherwise have run, and what would have rewritten this file.
    expect(result.stdout).toBe("8.9.9\n");
  });

  it("reads the older formats too, each to the majors that wrote it", async () => {
    const fixture = project();
    fixture.write("pnpm-lock.yaml", lock("5.4"));

    const result = await run(["pnpm", "--version"], { ...fixture, registry, env: env() });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("7.33.7\n");
  });

  // pnpm 9, 10, 11 and 12 all write `9.0`, and for one project their output is
  // byte-identical. There is nothing here to prefer to the recorded default.
  it("has no opinion about 9.0, which four current majors write", async () => {
    const fixture = project();
    fixture.write("pnpm-lock.yaml", lock("'9.0'"));

    const result = await run(["pnpm", "--version"], { ...fixture, registry, env: env() });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${LATEST}\n`);
  });

  it("yields to every spec the project actually declares", async () => {
    const fixture = project({
      name: "demo",
      devEngines: { packageManager: { name: "pnpm", version: `^11.0.0` } },
    });
    fixture.write("pnpm-lock.yaml", lock("'6.0'"));

    const result = await run(["pnpm", "--version"], { ...fixture, registry, env: env() });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${LATEST}\n`);
  });

  // §01.4 — a transparent command is not asking the project for anything, so it
  // is not asking this either.
  it("is not consulted for a transparent command", async () => {
    const fixture = project();
    fixture.write("pnpm-lock.yaml", lock("'6.0'"));

    const result = await run(["pnpm", "dlx", "--help"], { ...fixture, registry, env: env() });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`pnpm@${LATEST} dlx --help\n`);
  });

  // §03.1 — the guess belongs to a project, and a directory with no manifest is
  // not one. A `pnpm-lock.yaml` beside the user says nothing about a global run.
  it("needs a project: a lockfile with no package.json is nobody's statement", async () => {
    const fixture = createFixture();
    fixture.write("pnpm-lock.yaml", lock("'6.0'"));

    const result = await run(["pnpm", "--version"], { ...fixture, registry, env: env() });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${LATEST}\n`);
  });

  it("is switched off by JUP_ENABLE_PM_LOCKFILE=0", async () => {
    const fixture = project();
    fixture.write("pnpm-lock.yaml", lock("'6.0'"));

    const result = await run(["pnpm", "--version"], {
      ...fixture,
      registry,
      env: env({ JUP_ENABLE_PM_LOCKFILE: "0" }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${LATEST}\n`);
  });

  it("is switched off by COREPACK_ENABLE_PROJECT_SPEC=0, which reads no project at all", async () => {
    const fixture = project();
    fixture.write("pnpm-lock.yaml", lock("'6.0'"));

    const result = await run(["pnpm", "--version"], {
      ...fixture,
      registry,
      env: env({ COREPACK_ENABLE_PROJECT_SPEC: "0" }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${LATEST}\n`);
  });

  // What one project's lockfile implies is that project's business. Recording it
  // would make the next `pnpm` in an unrelated directory run 8.9.9 too.
  it("is not written to the machine's recorded default", async () => {
    const fixture = project();
    fixture.write("pnpm-lock.yaml", lock("'6.0'"));

    const result = await run(["pnpm", "--version"], { ...fixture, registry, env: env() });
    expect(result.stdout).toBe("8.9.9\n");

    const elsewhere = createFixture({ name: "other" });
    const after = await run(["pnpm", "--version"], {
      ...elsewhere,
      home: fixture.home,
      registry,
      env: env(),
    });

    expect(after.exitCode).toBe(0);
    expect(after.stdout).toBe(`${LATEST}\n`);
  });

  // §03.6 — auto-pin writes down the version the run would use, so it has to
  // write down this one; a pin naming a different major than the run just used
  // would be the drift this guess exists to stop.
  it("is what auto-pin commits", async () => {
    const fixture = project();
    fixture.write("pnpm-lock.yaml", lock("'6.0'"));

    const result = await run(["pnpm", "--version"], {
      ...fixture,
      registry,
      env: env({ COREPACK_ENABLE_AUTO_PIN: "1" }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("8.9.9\n");
    expect(JSON.stringify(fixture.json("package.json"))).toContain(
      '"name":"pnpm","version":"8.9.9"',
    );
  });

  it("reports itself in `info`, naming the file it read and the range it implies", async () => {
    const fixture = project();
    fixture.write("pnpm-lock.yaml", lock("'6.0'"));

    const result = await run(["info"], { ...fixture, registry, env: env() });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("status          inferred");
    expect(result.stdout).toContain(`source          ${fixture.path("pnpm-lock.yaml")}`);
    expect(result.stdout).toContain("lockfileVersion 6");
    expect(result.stdout).toContain(">=8.0.0 <9.0.0");
  });
});
