/**
 * §17.9 rows 225–233 — **roles in the data model**: R4's per-role project
 * enforcement, R9's narrowing, R10's inference for an unscoped command, R11's
 * dual-role specs.
 *
 * Every row but 233 is marked *(fixture)* in §17.9, and the reason is the whole
 * point of the fixture: §02.5 ships no runtime, so a package-manager-only table
 * satisfies R4, R9, R10 row 2 and R11 *vacuously*. Each row below was checked
 * against a role-blind implementation — the details are in each test's comment —
 * because a role-sensitive row that passes without the behaviour is worth
 * nothing.
 *
 * `as: "jup"` wherever a row names a scope word or an unscoped project command:
 * R12 makes the `corepack` entry point mean `jup pm`, so under it R9 declines a
 * runtime spec and R10 row 2 narrows to the package manager. Rows 225 and 226
 * are proxy mode, where no scope exists either way, and stay on the default
 * entry point.
 */

import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFINITIONS } from "../../src/config/table.ts";
import {
  cleanupFixtures,
  createFixture,
  DUAL_TOOL,
  FIXTURE_TOOLS,
  FIXTURE_VERSION,
  MockRegistry,
  packageManagerTarball,
  REPO_ROOT,
  run,
  RUNTIME_TOOL,
  seedPackageManager,
  useFixtureTable,
} from "./_harness/index.ts";

const registry = new MockRegistry();

/** A second release of each fixture, so `up` has somewhere to go. */
const NEXT_VERSION = "1.1.0";

const PNPM_DEFAULT = DEFINITIONS.pnpm!.default;

/** The mock's key is not a compiled-in one, so every row has to trust it (§06.3). */
function trusted(extra?: Record<string, string | undefined>): Record<string, string | undefined> {
  return { COREPACK_INTEGRITY_KEYS: registry.trustStore(), ...extra };
}

beforeAll(async () => {
  useFixtureTable();
  await registry.start();

  for (const name of [RUNTIME_TOOL, DUAL_TOOL]) {
    for (const version of [FIXTURE_VERSION, NEXT_VERSION]) {
      registry.publish(name, version, packageManagerTarball(name, version), {
        distTags: { latest: NEXT_VERSION },
      });
    }
  }
});

afterAll(async () => {
  cleanupFixtures();
  await registry.stop();
});

beforeEach(() => registry.reset());

/* -------------------------------------------------------------------------- */
/* R4 — per-role project enforcement (§17.3, §03.5)                            */
/* -------------------------------------------------------------------------- */

describe("§17.3 R4 the invoked binary's role selects the pin", () => {
  // Row 225. Against a role-blind `reconcile` this fails loudly: the project's
  // only pin is `devEngines.runtime`, §03.3 reads it as *the* spec, the name is
  // not `pnpm`, and §12.5 answers `This project is configured to use
  // fixture-runtime` — for running the package manager. Verified by reverting
  // `reconcile` to compare against a single spec: exit 1 with that message.
  it("225: a runtime-only pin does not reject a package manager", async () => {
    const fixture = createFixture({
      name: "app",
      devEngines: { runtime: { name: RUNTIME_TOOL, version: FIXTURE_VERSION } },
    });
    seedPackageManager(fixture.home, "pnpm", PNPM_DEFAULT);

    const result = await run(["pnpm", "--version"], {
      ...fixture,
      table: FIXTURE_TOOLS,
      // §04.5's fallback, answered entirely from the seeded store: the row is
      // about enforcement, and a network fetch would be a second variable.
      env: { COREPACK_ENABLE_NETWORK: "0" },
    });

    expect(result.stderr).not.toContain("This project is configured to use");
    expect(result.exitCode).toBe(0);
    // The ordinary fallback path (§03.5, §04.5): the compiled-in default, not
    // anything the project said.
    expect(result.stdout).toBe(`${PNPM_DEFAULT.split("+")[0]!}\n`);
  });

  // Row 226 — the same rule read from the other end, which is the half a
  // "runtime falls back to the package-manager pin when it has none" reading
  // would still get wrong.
  it("226: a package-manager pin does not reject a runtime; the runtime falls back", async () => {
    const fixture = createFixture({
      name: "app",
      packageManager: `pnpm@${PNPM_DEFAULT}`,
    });
    seedPackageManager(fixture.home, RUNTIME_TOOL, FIXTURE_VERSION);

    const result = await run([RUNTIME_TOOL, "--version"], {
      ...fixture,
      table: FIXTURE_TOOLS,
      env: { COREPACK_ENABLE_NETWORK: "0" },
    });

    expect(result.stderr).not.toContain("This project is configured to use");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${FIXTURE_VERSION}\n`);
  });
});

/* -------------------------------------------------------------------------- */
/* R10 row 2 — every role the project pins                                     */
/* -------------------------------------------------------------------------- */

describe("§17.4 R10 an unscoped project command acts on every pinned role", () => {
  /** A project pinning a package manager *and* a runtime. */
  function bothPinned(runtimeVersion = FIXTURE_VERSION): ReturnType<typeof createFixture> {
    return createFixture({
      name: "app",
      packageManager: `${DUAL_TOOL}@${FIXTURE_VERSION}`,
      devEngines: { runtime: { name: RUNTIME_TOOL, version: runtimeVersion } },
    });
  }

  // Row 227. A role-blind §09.1 returns one descriptor and this fails on the
  // missing second line; verified by making `resolveProjectPlans` return only
  // the package-manager plan.
  it("227: `jup install` installs both, package manager first, one line each", async () => {
    const fixture = bothPinned();

    const result = await run(["install"], {
      ...fixture,
      as: "jup",
      registry,
      table: FIXTURE_TOOLS,
      env: trusted(),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      `Adding ${DUAL_TOOL}@${FIXTURE_VERSION} to the cache...\n` +
        `Adding ${RUNTIME_TOOL}@${FIXTURE_VERSION} to the cache...\n`,
    );
    for (const name of [DUAL_TOOL, RUNTIME_TOOL]) {
      expect(existsSync(join(fixture.home, "v1", name, FIXTURE_VERSION, ".jup"))).toBe(true);
    }
  });

  // Row 228 — "aborting on the first failure would make `jup install` in CI
  // report a runtime problem as a package manager problem, or hide it entirely".
  // Here the *second* role fails, so an implementation that short-circuits would
  // still install the first; what it would get wrong is the exit code and the
  // report. Verified against a `forEachRole` that rethrows: the runtime line is
  // replaced by §12.1's usage block and the package manager's line survives, so
  // the assertion on both lines together is what carries the row.
  it("228: one role's failure neither skips nor hides the other; exit is non-zero", async () => {
    const fixture = bothPinned("9.9.9");

    const result = await run(["install"], {
      ...fixture,
      as: "jup",
      registry,
      table: FIXTURE_TOOLS,
      env: trusted(),
    });

    expect(result.exitCode).toBe(1);
    // The package manager still installed, and said so.
    expect(result.stdout).toContain(`Adding ${DUAL_TOOL}@${FIXTURE_VERSION} to the cache...`);
    expect(existsSync(join(fixture.home, "v1", DUAL_TOOL, FIXTURE_VERSION, ".jup"))).toBe(true);
    // The runtime got its own `Adding …` line, in order, and its own failure
    // underneath it — §15.19's diagnostic, naming the runtime rather than the
    // package manager whose install succeeded.
    expect(result.stdout).toContain(`Adding ${RUNTIME_TOOL}@9.9.9 to the cache...`);
    expect(result.stdout).toContain(`Usage Error: ${RUNTIME_TOOL}@9.9.9 does not exist in`);
    expect(result.stdout.indexOf(DUAL_TOOL)).toBeLessThan(result.stdout.indexOf(RUNTIME_TOOL));
    // Not §12.1's block: that names *the command* and appends its usage line,
    // and this command did not fail — one of its roles did.
    expect(result.stdout).not.toContain("$ jup install");
  });

  // Row 228, read from the other end — and the half that actually catches a
  // short-circuit. With the failing role **first**, an implementation that
  // rethrows never reaches the second role at all, so the runtime is neither
  // installed nor mentioned: "a failure resolving or installing one role MUST
  // NOT skip the others". Verified by making `forEachRole` rethrow, which leaves
  // the runtime uninstalled and its line absent.
  it("228: a failing package manager does not skip the runtime behind it", async () => {
    const fixture = createFixture({
      name: "app",
      packageManager: `${DUAL_TOOL}@9.9.9`,
      devEngines: { runtime: { name: RUNTIME_TOOL, version: FIXTURE_VERSION } },
    });

    const result = await run(["install"], {
      ...fixture,
      as: "jup",
      registry,
      table: FIXTURE_TOOLS,
      env: trusted(),
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain(`Usage Error: ${DUAL_TOOL}@9.9.9 does not exist in`);
    // The runtime ran anyway, in its own right.
    expect(result.stdout).toContain(`Adding ${RUNTIME_TOOL}@${FIXTURE_VERSION} to the cache...`);
    expect(existsSync(join(fixture.home, "v1", RUNTIME_TOOL, FIXTURE_VERSION, ".jup"))).toBe(true);
  });

  // Row 229, first half.
  it("229: `jup up` updates both pins in one manifest", async () => {
    const fixture = bothPinned();

    const result = await run(["up"], {
      ...fixture,
      as: "jup",
      registry,
      table: FIXTURE_TOOLS,
      env: trusted(),
    });

    expect(result.exitCode).toBe(0);
    const manifest = fixture.json("package.json") as {
      packageManager: string;
      devEngines: { runtime: { version: string } };
    };
    expect(manifest.packageManager).toMatch(
      new RegExp(`^${DUAL_TOOL}@${NEXT_VERSION}\\+sha512\\.`),
    );
    expect(manifest.devEngines.runtime.version).toBe(NEXT_VERSION);
  });

  // Row 229, second half — the part that makes "**one** manifest write" an
  // assertion rather than a description. The runtime's declared range refuses
  // the version `up` lands on, so §03.7's `warnOrThrow` throws *while the pins
  // are being written*. With one write, nothing reaches the file: the package
  // manager's pin, composed into the same string a statement earlier, is
  // discarded with it. With one write per role it would already be on disk —
  // which is precisely §15.26's half-updated manifest. Verified by writing the
  // pins in two `writePin` calls: `packageManager` came out at 1.1.0.
  it("229: a pin refused mid-write leaves the whole manifest untouched (§15.26)", async () => {
    const fixture = createFixture({
      name: "app",
      packageManager: `${DUAL_TOOL}@${FIXTURE_VERSION}`,
      devEngines: {
        runtime: { name: RUNTIME_TOOL, version: `>=${FIXTURE_VERSION} <${NEXT_VERSION}` },
      },
    });
    const before = fixture.read("package.json");

    const result = await run(["up"], {
      ...fixture,
      as: "jup",
      registry,
      table: FIXTURE_TOOLS,
      env: trusted(),
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("does not match the devEngines specification");
    expect(fixture.read("package.json")).toBe(before);
  });
});

/* -------------------------------------------------------------------------- */
/* R9 — scope narrows, never widens                                            */
/* -------------------------------------------------------------------------- */

describe("§17.4 R9 a scope narrows and never widens", () => {
  // Row 230. Against an implementation that ignores `Route.scope` this passes
  // straight through to the resolve and installs the runtime under `jup pm`;
  // verified by removing the `narrowToScope` call, which turns the exit code
  // into 0 and writes the pin.
  it("230: `jup pm use <runtime-only tool>` names the other spelling", async () => {
    const fixture = createFixture({ name: "app" });

    const result = await run(["pm", "use", `${RUNTIME_TOOL}@${FIXTURE_VERSION}`], {
      ...fixture,
      as: "jup",
      registry,
      table: FIXTURE_TOOLS,
      env: trusted(),
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain(
      `Usage Error: '${RUNTIME_TOOL}' is not a package manager - run 'jup runtime use ${RUNTIME_TOOL}@${FIXTURE_VERSION}' instead`,
    );
    // It refused *before* resolving: a scoped command that downloads the thing
    // it is about to decline has already spent the user's network.
    expect(registry.requests).toEqual([]);
    expect(fixture.exists("package.json")).toBe(true);
    expect((fixture.json("package.json") as { packageManager?: string }).packageManager).toBe(
      undefined,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* R11 — dual-role specs                                                       */
/* -------------------------------------------------------------------------- */

describe("§17.4 R11 a dual-role spec is resolved, never guessed", () => {
  // Row 231, first half — R11 step 4. "Writing the wrong field here silently
  // changes which program runs the user's code", so the answer is an error and
  // not a default. An implementation that defaulted to `packageManager` would
  // exit 0 and write a pin; that is what this row exists to fail.
  it("231: an undeclared dual-role tool is a usage error naming both spellings", async () => {
    const fixture = createFixture({ name: "app" });

    const result = await run(["use", `${DUAL_TOOL}@${FIXTURE_VERSION}`], {
      ...fixture,
      as: "jup",
      registry,
      table: FIXTURE_TOOLS,
      env: trusted(),
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain(
      `Usage Error: ${DUAL_TOOL} can be both a package manager and a runtime - ` +
        `run 'jup pm use ${DUAL_TOOL}@${FIXTURE_VERSION}' or 'jup runtime use ${DUAL_TOOL}@${FIXTURE_VERSION}'`,
    );
    expect((fixture.json("package.json") as { packageManager?: string }).packageManager).toBe(
      undefined,
    );
  });

  // Row 231, second half — R11 step 3. The manifest already says which role this
  // tool fills, so there is nothing to ask about: that field is updated and no
  // second one is created (§15.26's bullet 2, now for a role with no top-level
  // field at all).
  it("231: a dual-role tool the project already declares updates that field", async () => {
    const fixture = createFixture({
      name: "app",
      devEngines: { runtime: { name: DUAL_TOOL, version: FIXTURE_VERSION } },
    });

    const result = await run(["use", `${DUAL_TOOL}@${NEXT_VERSION}`], {
      ...fixture,
      as: "jup",
      registry,
      table: FIXTURE_TOOLS,
      env: trusted(),
    });

    expect(result.stdout).not.toContain("Usage Error");
    expect(result.exitCode).toBe(0);

    const manifest = fixture.json("package.json") as {
      packageManager?: string;
      devEngines: { runtime: { version: string; integrity?: string } };
    };
    expect(manifest.devEngines.runtime.version).toBe(NEXT_VERSION);
    expect(manifest.devEngines.runtime.integrity).toMatch(/^sha512-/);
    // §17.5 R14 — "There is no top-level `runtime` field and this specification
    // MUST NOT invent one." Nor may a runtime pin land in `packageManager`.
    expect(manifest.packageManager).toBeUndefined();
  });

  // Row 232 — R11 step 2, and the reason `autoRoleFor` exists. In proxy mode
  // step 1 has no scope word and step 3 has no declaration (`NoSpec` is the only
  // case auto-pin fires in), and nothing distinguishes a package-manager use of
  // this binary from a runtime use — R2 keeps the surface one flat namespace and
  // R3 keeps roles data. R11's last paragraph decides it: the `package-manager`
  // role wins, "because auto-pin's own verbatim notice is about the
  // `packageManager` field". So this row must NOT be the step-4 error.
  it("232: auto-pin writes a pin for a dual-role tool rather than refusing", async () => {
    const fixture = createFixture({ name: "app" });

    const result = await run([DUAL_TOOL, "--version"], {
      ...fixture,
      registry,
      table: FIXTURE_TOOLS,
      env: trusted({ COREPACK_ENABLE_AUTO_PIN: "1" }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain("can be both a package manager and a runtime");
    // The notice §03.6 freezes, and the field it names.
    expect(result.stderr).toContain(`will now add one referencing ${DUAL_TOOL}@`);

    const manifest = fixture.json("package.json") as {
      packageManager?: string;
      devEngines?: unknown;
    };
    // §04.5's fallback, so the table's compiled-in default rather than `latest`.
    expect(manifest.packageManager).toMatch(
      new RegExp(`^${DUAL_TOOL}@${FIXTURE_VERSION}\\+sha512\\.`),
    );
    expect(manifest.devEngines).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* R10 row 5 — a destructive command refuses a scope                           */
/* -------------------------------------------------------------------------- */

describe("§17.4 R10 row 5 `cache clean` refuses a scope", () => {
  // Row 233 — no fixture table needed: the rule is about the *command*, and its
  // whole point is that a scope must not be read as a filter. `cache clean` is
  // `rm -rf <home>/v1` (§07.9), so a filtered reading of `jup runtime cache
  // clean` would destroy every cached package manager — which is exactly what
  // an implementation that ignored the scope would do here, and what the
  // surviving store below catches.
  it("233: `jup runtime cache clean` is a usage error and the store survives", async () => {
    const fixture = createFixture({ name: "app" });
    seedPackageManager(fixture.home, "pnpm", PNPM_DEFAULT);
    const seeded = join(fixture.home, "v1", "pnpm", PNPM_DEFAULT.split("+")[0]!);

    const refused = await run(["runtime", "cache", "clean"], { ...fixture, as: "jup" });

    expect(refused.exitCode).toBe(1);
    expect(refused.stdout).toContain(
      `Usage Error: 'cache clean' is not scoped - it removes the whole store; run 'jup cache clean'`,
    );
    expect(existsSync(seeded)).toBe(true);

    // Unscoped, it does what it always did.
    const cleaned = await run(["cache", "clean"], { ...fixture, as: "jup" });

    expect(cleaned.exitCode).toBe(0);
    expect(existsSync(seeded)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* R3 — roles are data, not code                                               */
/* -------------------------------------------------------------------------- */

/**
 * §17.3 R3, as a test rather than as an intention — **not** a numbered row.
 *
 * "The tool's own structure MUST NOT branch on a literal role anywhere outside
 * the table and the four role-sensitive behaviours in the table below. Adding a
 * runtime MUST be a data-only change."
 *
 * The invariant is checkable because a role is only ever *spelled* in a handful
 * of places: everything else is parameterised by a `Role` the caller supplies,
 * or asks {@link hasRole}. This scans `src/` with comments stripped — a comment
 * naming a role is prose, and prose is what R3 asks for more of — and fails if
 * a sixth file learns to say one out loud. That failure is the signal the
 * instruction describes: "if you find yourself writing `=== 'runtime'` in a
 * fifth place, the abstraction is wrong."
 */
describe("§17.3 R3 roles are data", () => {
  /** The files allowed to spell a role, and what each of them is. */
  const ALLOWED: Record<string, string> = {
    "types.ts": "the `Role` union itself",
    "config/table.ts": "§02.5's entries and R10 row 2's `ROLE_ORDER`",
    "project/manifest.ts": "R4 row 1's `PIN_FIELDS` and R4 row 2's enforcement",
    "project/pin.ts": "R11's tie-break for auto-pin",
    "commands/cli.ts": "R9's narrowing and R11's resolution",
    "commands/router.ts": "R8's scope words and R9/R11's role nouns",
  };

  it("spells a role only where the table and R4's behaviours live", async () => {
    const offenders: string[] = [];

    for (const file of await walk(join(REPO_ROOT, "src"))) {
      const source = await readFile(file, "utf8");
      // Comments are where the *reasons* live; R3 is about branches.
      const code = source.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/\/\/[^\n]*/g, "");
      if (!/"(?:package-manager|runtime)"/.test(code)) continue;

      const name = relative(join(REPO_ROOT, "src"), file).replaceAll("\\", "/");
      if (!Object.hasOwn(ALLOWED, name)) offenders.push(name);
    }

    expect(offenders).toEqual([]);
  });
});

/** Every file under `directory`, recursively. */
async function walk(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await walk(path)));
    else found.push(path);
  }
  return found;
}
