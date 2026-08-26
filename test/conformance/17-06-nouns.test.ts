/**
 * §17.9 rows 234–236 — **§17.6 C10a, the noun of the scope in effect.**
 *
 * C10's sibling row for row 234's sake: C10 substitutes the tool's own *name*
 * into a message body, C10a the *noun* naming the kind of tool the command is
 * acting on. The three rows are one argument in three parts — the substitution
 * happens (234), it carries the field names with it where one sentence has both
 * (235), and it stops at a `packageManager` **field name** (236).
 *
 * Row 236 is the negative one, and it is the reason the other two are safe: the
 * cheapest way to pass 234 and 235 is a blanket replacement over finished text,
 * which would also rewrite the messages that *validate* the `packageManager`
 * field — where the field is the subject of the sentence and there is no noun
 * about the command at all.
 *
 * `as: "jup"` wherever a row names a scope word: R12 makes the `corepack` entry
 * point mean `jup pm`, and it declines the words themselves.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupFixtures,
  createFixture,
  FIXTURE_TOOLS,
  FIXTURE_VERSION,
  MockRegistry,
  packageManagerTarball,
  run,
  RUNTIME_TOOL,
  useFixtureTable,
} from "./_harness/index.ts";

const registry = new MockRegistry();

/** The mock's key is not a compiled-in one, so every row has to trust it (§06.3). */
function trusted(extra?: Record<string, string | undefined>): Record<string, string | undefined> {
  return { COREPACK_INTEGRITY_KEYS: registry.trustStore(), ...extra };
}

/** The `Usage Error:` line alone — §12.1's usage line below it is R7's, not C10a's. */
function usageErrorLine(stdout: string): string {
  return stdout.split("\n")[0]!;
}

beforeAll(async () => {
  useFixtureTable();
  await registry.start();
  registry.publish(
    RUNTIME_TOOL,
    FIXTURE_VERSION,
    packageManagerTarball(RUNTIME_TOOL, FIXTURE_VERSION),
  );
});

afterAll(async () => {
  cleanupFixtures();
  await registry.stop();
});

beforeEach(() => registry.reset());

/* -------------------------------------------------------------------------- */
/* Row 234 — the noun follows the scope, and only the scope                     */
/* -------------------------------------------------------------------------- */

describe("§17.6 C10a the noun is the scope in effect", () => {
  /**
   * Row 234 — the terminal report that produced C10a, in all four invocations.
   *
   * `node` is §17.4 R8's `RESERVED` and in no table, so the spec never resolves
   * and the command has no role to report: this is exactly the message C10a says
   * takes the *scope's* noun rather than a resolved tool's role. Three of the
   * four are corepack's frozen sentence and are asserted byte for byte — a
   * substitution driven by the entry point instead of the scope, or by "is a
   * runtime in the table" instead of either, fails on one of them.
   */
  it("234: `install -g <unknown>@<v>` names the scope's noun, not always the package manager", async () => {
    const frozen = "Usage Error: Unsupported package manager specification (node@22)";

    for (const [as, args] of [
      ["corepack", ["install", "-g", "node@22"]],
      ["jup", ["install", "-g", "node@22"]],
      ["jup", ["pm", "install", "-g", "node@22"]],
    ] as const) {
      const fixture = createFixture({ name: "app" });
      const result = await run([...args], { ...fixture, as });

      expect(result.exitCode, `${as} ${args.join(" ")}`).toBe(1);
      expect(usageErrorLine(result.stdout), `${as} ${args.join(" ")}`).toBe(frozen);
    }

    const fixture = createFixture({ name: "app" });
    const scoped = await run(["runtime", "install", "-g", "node@22"], { ...fixture, as: "jup" });

    expect(scoped.exitCode).toBe(1);
    expect(usageErrorLine(scoped.stdout)).toBe(
      "Usage Error: Unsupported runtime specification (node@22)",
    );
    // A substitution, not a rewrite: one word differs and the sentence does not.
    expect(usageErrorLine(scoped.stdout)).toBe(frozen.replace("package manager", "runtime"));
  });
});

/* -------------------------------------------------------------------------- */
/* Row 235 — the both-halves sentence                                          */
/* -------------------------------------------------------------------------- */

describe("§17.6 C10a where one sentence names the noun and the fields", () => {
  /**
   * Row 235, first half. "A message that names the package-manager fields while
   * asking for a runtime is the incoherence this clause exists to remove."
   *
   * The project pins a package manager and nothing else, so a `runtime`-scoped
   * `pack` has no pin to work from (§17.3 R4) — and the sentence it prints has
   * to name the field it actually looked at. A noun substitution that stopped at
   * the noun would say `runtime` while pointing at `'packageManager'`, which is
   * the half-right C10a calls worse than none.
   */
  it("235: `jup runtime pack` names the runtime and `devEngines.runtime`", async () => {
    const fixture = createFixture({ name: "app", packageManager: "pnpm@11.22.0" });

    const result = await run(["runtime", "pack"], { ...fixture, as: "jup", table: FIXTURE_TOOLS });

    expect(result.exitCode).toBe(1);
    expect(usageErrorLine(result.stdout)).toBe(
      `Usage Error: The local project doesn't feature a 'devEngines.runtime' field - ` +
        `please specify the runtime to pack, or update the manifest to reference it`,
    );
    // The package manager's own fields are not mentioned at all: the scope never
    // read them, so naming them would send the reader to the wrong line.
    expect(result.stdout).not.toContain("packageManager");
  });

  /**
   * Row 235, second half — the same command under `jup pm`, byte-identical to
   * today's. Both fields, both spelled as §12.9 froze them, and the sentence
   * that reaches the `corepack` entry point is the same one.
   */
  it("235: under `jup pm` the sentence is byte-identical to corepack's", async () => {
    const frozen =
      `Usage Error: The local project doesn't feature a 'packageManager' field nor a ` +
      `'devEngines.packageManager' field - please specify the package manager to pack, ` +
      `or update the manifest to reference it`;

    const scoped = await run(["pm", "pack"], {
      ...createFixture({ name: "app" }),
      as: "jup",
      table: FIXTURE_TOOLS,
    });
    const frozenEntry = await run(["pack"], { ...createFixture({ name: "app" }), as: "corepack" });

    expect(usageErrorLine(scoped.stdout)).toBe(frozen);
    expect(usageErrorLine(frozenEntry.stdout)).toBe(frozen);
  });

  /**
   * The control the *(fixture)* marker is for: `devEngines.runtime` is the field
   * the first half's message names, so pinning it has to be what makes the
   * message go away. Without this, the row is satisfied by a message that names
   * any string at all, and "the fields that scope's role actually reads" is an
   * intention rather than an assertion.
   */
  it("235: pinning the field the message names is what satisfies the command", async () => {
    const fixture = createFixture({
      name: "app",
      packageManager: "pnpm@11.22.0",
      devEngines: { runtime: { name: RUNTIME_TOOL, version: FIXTURE_VERSION } },
    });

    const result = await run(["runtime", "pack"], {
      ...fixture,
      as: "jup",
      registry,
      table: FIXTURE_TOOLS,
      env: trusted(),
    });

    expect(result.stdout).not.toContain("Usage Error");
    expect(result.exitCode).toBe(0);
    expect(fixture.exists("jup.tgz")).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Row 236 — the negative row                                                  */
/* -------------------------------------------------------------------------- */

describe("§17.6 C10a the substitution stops at a field name", () => {
  /**
   * Row 236, **the negative row**. `Invalid package manager specification in
   * <source>; expected a string` is a statement about a malformed
   * `packageManager` field, "under every scope" — the field is the subject of
   * the sentence and the noun is not a noun about the command at all.
   *
   * `info` is the reachable reading of that field under a `runtime` scope
   * (§15.30's report parses every role's pin rather than only the scoped one),
   * and it prints the message twice — as the project's `problem` and as the
   * resolution's `reason`. Verified load-bearing by routing
   * `messages.invalidSpecNotString` through the same noun as its neighbours:
   * both lines came back as `Invalid runtime specification in package.json;
   * expected a string` and this test failed, while rows 234 and 235 stayed
   * green — which is exactly the overreach it exists to catch.
   */
  it("236: a non-string `packageManager` reads the same under `jup runtime`", async () => {
    const fixture = createFixture({ name: "app", packageManager: 42 });
    const frozen = "Invalid package manager specification in package.json; expected a string";

    const scoped = await run(["runtime", "info"], {
      ...fixture,
      as: "jup",
      env: { COREPACK_ENABLE_NETWORK: "0" },
    });
    const frozenEntry = await run(["info"], {
      ...fixture,
      as: "corepack",
      env: { COREPACK_ENABLE_NETWORK: "0" },
    });

    expect(scoped.exitCode).toBe(0);
    expect(scoped.stdout).toContain(`  problem         ${frozen}`);
    expect(scoped.stdout).toContain(`  reason          ${frozen}`);
    expect(scoped.stdout).not.toContain("Invalid runtime specification");
    // The same field, read under the frozen entry point, says the same thing.
    expect(frozenEntry.stdout).toContain(`  problem         ${frozen}`);
  });

  /**
   * The same exclusion on the error path, where the sentence is the whole
   * output rather than a line of a report — `prepare` reads the project spec
   * without a role (§09.10 keeps it the command it was), so the malformed field
   * is parsed under a `runtime` scope and its complaint must still be about the
   * field. Part of row 236: the exclusion is about the *sentence*, not about
   * which command happened to print it.
   */
  it("236: and on the error path, under the same scope", async () => {
    const fixture = createFixture({ name: "app", packageManager: 42 });

    const result = await run(["runtime", "prepare"], { ...fixture, as: "jup" });

    expect(result.exitCode).toBe(1);
    expect(usageErrorLine(result.stdout)).toBe(
      "Usage Error: Invalid package manager specification in package.json; expected a string",
    );
  });
});
