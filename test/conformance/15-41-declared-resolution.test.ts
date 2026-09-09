/**
 * §04.4 — the package manager's own committed resolution.
 *
 * pnpm >= 12 reads `devEngines.packageManager` itself. Run on its own it
 * re-execs into the version its `pnpm-lock.yaml` records and leaves the file
 * alone; run under a version manager — which it detects by `COREPACK_ROOT`
 * (§08.7) — it defers the *choice* and writes whichever version it was handed
 * into that same committed file.
 *
 * So the file is a transcript of what jup resolved, and until jup read it back
 * the transcript was per-host: the memo is host-local and expires after a day,
 * and the store probe (§04.1 step 4) answers with whatever version is already
 * installed, forever. Two machines committed two versions of one line and
 * `pnpm install` was a diff on a fresh clone.
 *
 * The rows below are the whole rule: the committed record answers, it outranks
 * the memo and yields to `jup.lock`, and every gate that makes it answer *this*
 * project's range and nothing else.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupFixtures,
  createFixture,
  type Fixture,
  MockRegistry,
  packageManagerTarball,
  run,
  withoutDownloadNotices,
} from "./_harness/index.ts";

const registry = new MockRegistry();

function env(extra?: Record<string, string | undefined>): Record<string, string | undefined> {
  return { COREPACK_INTEGRITY_KEYS: registry.trustStore(), CI: undefined, ...extra };
}

/** The memo an ordinary run leaves behind, which these rows have to outrank. */
const MEMO = "node_modules/.jup/jup.lock";

/**
 * A project declaring the range, with a `node_modules` — the only condition
 * under which jup memoes anything at all (§04.4).
 */
function project(range = "^11.0.0"): Fixture {
  const fixture = createFixture({
    name: "demo",
    devEngines: { packageManager: { name: "pnpm", version: range } },
  });
  fixture.write("node_modules/.keep", "");
  return fixture;
}

/**
 * A `pnpm-lock.yaml` in the shape pnpm writes: its own resolution in the first
 * YAML document, the project's own importers in the second.
 *
 * The second document names `pnpm` too, and at the same indentation, because
 * that is the shape a reader which did not stop at the `---` would answer with.
 */
function managerLock(specifier: string, version: string, dependency = "9.9.9"): string {
  return `---
lockfileVersion: '9.0'

importers:

  .:
    configDependencies: {}
    packageManagerDependencies:
      pnpm:
        specifier: ${specifier}
        version: ${version}

packages:

  pnpm@${version}:
    resolution: {integrity: sha512-notjups}

---
lockfileVersion: '9.0'

importers:

  .:
    devDependencies:
      pnpm:
        specifier: ${specifier}
        version: ${dependency}
`;
}

/** A recorded resolution, hand-written the way `use` would have left it. */
function record(fixture: Fixture, key: string, resolved: string): void {
  fixture.write(
    "jup.lock",
    `${JSON.stringify({ version: 1, resolutions: { [key]: { resolved } } }, undefined, 2)}\n`,
  );
}

beforeAll(async () => {
  await registry.start();

  for (const version of ["11.0.0", "11.1.2"]) {
    registry.publish("pnpm", version, packageManagerTarball("pnpm", version));
  }
  registry.publish("pnpm", "11.1.2", packageManagerTarball("pnpm", "11.1.2"), {
    distTags: { latest: "11.1.2" },
  });
});

afterAll(async () => {
  cleanupFixtures();
  await registry.stop();
});

beforeEach(() => registry.reset());

describe("§04.4 the package manager's own lockfile", () => {
  it("runs the version the committed file records, not the newest the range admits", async () => {
    const fixture = project();
    fixture.write("pnpm-lock.yaml", managerLock("^11.0.0", "11.0.0"));

    const result = await run(["pnpm", "--version"], { ...fixture, registry, env: env() });

    expect(result.exitCode).toBe(0);
    // 11.1.2 is what the range resolves to; 11.0.0 is what the project committed.
    expect(result.stdout).toBe("11.0.0\n");
  });

  it("answers with no metadata request, and memoes nothing", async () => {
    const fixture = project();
    fixture.write("pnpm-lock.yaml", managerLock("^11.0.0", "11.0.0"));

    // Once to fill the store, then again with a clean request log: the second
    // run is the one under test.
    expect((await run(["pnpm", "--version"], { ...fixture, registry, env: env() })).exitCode).toBe(
      0,
    );
    registry.reset();

    const result = await run(["pnpm", "--version"], { ...fixture, registry, env: env() });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("11.0.0\n");
    expect(result.stderr).toBe("");
    // §01.3's budget: a committed answer costs no request, exactly as `jup.lock`
    // does. And nothing is memoed for an answer that did not come from the
    // registry, so `node_modules` gains no file either.
    expect(registry.requests).toEqual([]);
    expect(fixture.exists(MEMO)).toBe(false);
  });

  it("outranks a live memo, which is the host-local note that drifts", async () => {
    const fixture = project();

    // A first run with no manager lockfile resolves the range and memoes 11.1.2
    // — the state every machine reaches on its own, at its own time.
    const first = await run(["pnpm", "--version"], { ...fixture, registry, env: env() });
    expect(first.stdout).toBe("11.1.2\n");
    expect(fixture.exists(MEMO)).toBe(true);

    fixture.write("pnpm-lock.yaml", managerLock("^11.0.0", "11.0.0"));

    const second = await run(["pnpm", "--version"], { ...fixture, registry, env: env() });

    expect(second.exitCode).toBe(0);
    expect(second.stdout).toBe("11.0.0\n");
  });

  it("yields to jup.lock, which is the project's own recorded decision", async () => {
    const fixture = project();
    fixture.write("pnpm-lock.yaml", managerLock("^11.0.0", "11.0.0"));
    record(fixture, "pnpm@^11.0.0", "11.1.2");

    const result = await run(["pnpm", "--version"], { ...fixture, registry, env: env() });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("11.1.2\n");
  });

  it("stands only for the range it was recorded against", async () => {
    const fixture = project("^11.0.0");
    // The manifest has moved on; the file still speaks about the old range.
    fixture.write("pnpm-lock.yaml", managerLock("^11", "11.0.0"));

    const result = await run(["pnpm", "--version"], { ...fixture, registry, env: env() });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("11.1.2\n");
  });

  it("is skipped when the recorded version no longer satisfies the range", async () => {
    const fixture = project("^11.1.0");
    fixture.write("pnpm-lock.yaml", managerLock("^11.1.0", "11.0.0"));

    const result = await run(["pnpm", "--version"], { ...fixture, registry, env: env() });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("11.1.2\n");
  });

  it("is not consulted for an exact pin, which is its own record", async () => {
    const fixture = createFixture({ name: "demo", packageManager: "pnpm@11.1.2" });
    fixture.write("pnpm-lock.yaml", managerLock("^11.0.0", "11.0.0"));

    const result = await run(["pnpm", "--version"], { ...fixture, registry, env: env() });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("11.1.2\n");
  });

  it("is switched off by JUP_ENABLE_PM_LOCKFILE=0", async () => {
    const fixture = project();
    fixture.write("pnpm-lock.yaml", managerLock("^11.0.0", "11.0.0"));

    const result = await run(["pnpm", "--version"], {
      ...fixture,
      registry,
      env: env({ JUP_ENABLE_PM_LOCKFILE: "0" }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("11.1.2\n");
  });

  // §09.4 — `up` resolves with `useCache: false`, so nothing here can pin it.
  // A record that could not be moved forward would be a trap, not a lockfile.
  it("does not hold `up` back", async () => {
    const fixture = project();
    fixture.write("pnpm-lock.yaml", managerLock("^11.0.0", "11.0.0"));

    const result = await run(["up"], { ...fixture, registry, env: env() });

    expect(result.exitCode).toBe(0);
    // No `jup.lock` in the project, so `up` memoes its answer (§04.4) — and the
    // answer is the newest the range admits, not the recorded 11.0.0.
    expect(withoutDownloadNotices(result.stderr)).toBe("");
    expect(fixture.exists(MEMO)).toBe(true);
    expect(JSON.stringify(fixture.json(MEMO))).toContain("11.1.2");
  });

  it("reports itself in `info`, naming the file it read", async () => {
    const fixture = project();
    fixture.write("pnpm-lock.yaml", managerLock("^11.0.0", "11.0.0"));

    const result = await run(["info"], { ...fixture, registry, env: env() });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("status          declared");
    expect(result.stdout).toContain(`source          ${fixture.path("pnpm-lock.yaml")}`);
    expect(result.stdout).toContain(`declared        11.0.0  (${fixture.path("pnpm-lock.yaml")})`);
  });
});
