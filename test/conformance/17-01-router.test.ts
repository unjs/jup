/**
 * §17.9 rows 208–215 — the command router (§17.4 R7–R13, §17.6 C1′, C6, C10).
 *
 * Two things separate these rows from every other file here.
 *
 * The first is the **entry-point name**. `run()` spawns the tool as `corepack`
 * by default, because §13.1 requires rows 1–147 to assert corepack's verbatim
 * spellings through that entry point (§17.4 R12). The rows below that are about
 * jup's own surface pass `as: "jup"`, and the two rows that are about the
 * corepack entry point say `as: "corepack"` out loud rather than leaning on the
 * default — a row about which name was invoked should name it.
 *
 * The second is that row 215 is **not** a `(exitCode, stdout, stderr)` row.
 * §17.9 says so explicitly: R8's invariant is asserted at build time, because a
 * collision does not produce an error at all — it silently makes one of two
 * spellings unreachable. It is checked here as the pair §17.9 permits: the
 * function `pnpm build` runs, fed a poisoned table, plus the wiring that makes
 * the build run it.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertDisjoint, findCollisions, nameSets } from "../../scripts/check-name-sets.mjs";
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

/** The mock's signing key is not a compiled-in one, so every row has to trust it. */
function trusted(extra?: Record<string, string | undefined>): Record<string, string | undefined> {
  return { COREPACK_INTEGRITY_KEYS: registry.trustStore(), ...extra };
}

const PNPM = "10.0.0";
const YARN = "1.22.4";

beforeAll(async () => {
  await registry.start();
  registry.publish("pnpm", PNPM, packageManagerTarball("pnpm", PNPM), {
    distTags: { latest: PNPM },
  });
  registry.publish("yarn", YARN, packageManagerTarball("yarn", YARN), {
    distTags: { latest: YARN },
  });
});

afterAll(async () => {
  cleanupFixtures();
  await registry.stop();
});

beforeEach(() => registry.reset());

describe("§17.9 the command router", () => {
  /**
   * R13 — nothing is deprecated by §17. The unscoped form keeps its meaning, and
   * `jup pm use` is the same command with its scope written down, so on the
   * success path the two runs must be indistinguishable.
   *
   * The manifest path is the one thing that legitimately differs — two fixtures,
   * two directories — so it is normalised out rather than excluded, which would
   * have let a difference hide behind it.
   */
  it("208: `use` and `pm use` agree on stdout, stderr, exit code and the manifest", async () => {
    const unscoped = createFixture({ name: "project" });
    const scoped = createFixture({ name: "project" });

    const a = await run(["use", `pnpm@${PNPM}`], {
      ...unscoped,
      as: "jup",
      registry,
      env: trusted(),
    });
    const b = await run(["pm", "use", `pnpm@${PNPM}`], {
      ...scoped,
      as: "jup",
      registry,
      env: trusted(),
    });

    expect(a.exitCode).toBe(0);
    expect(a.stdout.replaceAll(unscoped.cwd, "<project>")).toBe(
      b.stdout.replaceAll(scoped.cwd, "<project>"),
    );
    expect(a.stderr).toBe(b.stderr);
    expect(a.exitCode).toBe(b.exitCode);

    const pin = (fixture: typeof unscoped): unknown =>
      (fixture.json("package.json") as { packageManager?: unknown }).packageManager;
    expect(pin(unscoped)).toMatch(new RegExp(String.raw`^pnpm@${PNPM}\+sha512\.`));
    expect(pin(scoped)).toBe(pin(unscoped));
  });

  /**
   * R7 step 4 — a scope word takes a verb or a top-level flag, never a binary.
   * The next token is classified by steps 3, 5 and 6 only, so `yarn` never
   * reaches a proxy test and falls to step 7 (§12.9).
   */
  it("209: `pm yarn --version` is a usage error, not a proxy invocation", async () => {
    const fixture = createFixture({ name: "project", packageManager: `yarn@${YARN}` });
    seedPackageManager(fixture.home, "yarn", YARN);

    const result = await run(["pm", "yarn", "--version"], { ...fixture, as: "jup" });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain(`Usage Error: Unknown command "yarn"`);
    // §12.1 — the usage line names the binary invoked *and the scope in effect*.
    expect(result.stdout).toContain("$ jup pm <command>");
    expect(result.stderr).toBe("");
    // The proof it never proxied: Yarn's version is nowhere in the output.
    expect(result.stdout).not.toContain(YARN);
  });

  /**
   * R7 — steps 1 and 2 keep their precedence over the verb table, which is what
   * makes `corepack yarn --version` print Yarn's version (§13 row 147) and what
   * makes the shim path work. Row 209 and this row are the same rule read from
   * its two ends.
   */
  it("210: `yarn --version` is still proxy mode", async () => {
    const fixture = createFixture({ name: "project", packageManager: `yarn@${YARN}` });
    seedPackageManager(fixture.home, "yarn", YARN);

    const result = await run(["yarn", "--version"], { ...fixture, as: "jup" });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${YARN}\n`);
    expect(result.stderr).toBe("");
  });

  /**
   * R7 steps 3, 4 and 6, and §17.6 C6.
   *
   * Omitting the flag branch is R7's named easy mistake, and its symptom is
   * `jup --version` reported as an unknown command; `jup pm` and bare `jup`
   * print help rather than complaining that a scope word is not a command.
   */
  it("211: the top-level flags and the bare scope word all succeed", async () => {
    const fixture = createFixture();

    for (const args of [["--version"], ["--help"], ["pm", "--help"], ["pm"], []]) {
      const result = await run(args, { ...fixture, as: "jup" });
      expect(result.exitCode, `jup ${args.join(" ")}`).toBe(0);
      expect(result.stderr, `jup ${args.join(" ")}`).toBe("");
    }

    const own = (
      JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { version: string }
    ).version;
    expect((await run(["--version"], { ...fixture, as: "jup" })).stdout).toBe(`${own}\n`);

    // C6 — `jup --help` shows both scopes; the scoped form shows the
    // package-manager surface, spelled the way the reader would have to type it.
    const unscoped = await run(["--help"], { ...fixture, as: "jup" });
    expect(unscoped.stdout).toContain("jup pm <command>");
    expect(unscoped.stdout).toContain("jup runtime <command>");

    const scoped = await run(["pm", "--help"], { ...fixture, as: "jup" });
    expect(scoped.stdout).toContain("Usage: jup pm <command>");
    expect(scoped.stdout).toContain("jup pm use [--here]");
    expect(scoped.stdout).not.toContain("jup runtime <command>");

    // Step 4 → step 6: a scope word is never a command by itself.
    expect((await run(["pm"], { ...fixture, as: "jup" })).stdout).toBe(scoped.stdout);
  });

  /** R12 — scope words are not accepted through the corepack entry point. */
  it("212: `corepack pm use` is an unknown command", async () => {
    const fixture = createFixture({ name: "project" });

    const result = await run(["pm", "use", `pnpm@${PNPM}`], {
      ...fixture,
      as: "corepack",
      registry,
      env: trusted(),
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain(`Usage Error: Unknown command "pm"`);
    expect(result.stdout).toContain("$ corepack <command>");
    expect(result.stderr).toBe("");
    // It refused rather than ran: nothing was pinned.
    expect((fixture.json("package.json") as { packageManager?: unknown }).packageManager).toBe(
      undefined,
    );
  });

  /**
   * R12's second bullet — the corepack path recognises the scope words **in
   * order to refuse them**, and says where runtime management actually lives. A
   * bare `Unknown command "runtime"` would leave a user who typed the right verb
   * under the wrong name with nothing to go on.
   */
  it("213: `corepack runtime enable` names the jup spelling", async () => {
    const fixture = createFixture();

    const result = await run(["runtime", "enable"], { ...fixture, as: "corepack" });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain(
      `Usage Error: runtime management is not available through the 'corepack' command - use 'jup runtime <verb>'`,
    );
    expect(result.stderr).toBe("");
  });

  /**
   * R12 and C10 together — the same failure under the two names.
   *
   * §15.19's offline diagnostic is chosen because it names the tool in its
   * **body** as well as in the usage line, which is the half C10 is about: under
   * `corepack` both are corepack's, under `jup pm` both are jup's, and the
   * sentence, punctuation and interpolations are otherwise identical.
   */
  it("214: the usage line and the message body name the invoked entry point", async () => {
    const offline = { COREPACK_ENABLE_NETWORK: "0" };

    const asCorepack = await run(["use", `pnpm@${PNPM}`], {
      ...createFixture({ name: "project" }),
      as: "corepack",
      env: offline,
    });

    expect(asCorepack.exitCode).toBe(1);
    expect(asCorepack.stdout).toBe(
      `Installing pnpm@${PNPM} in the project...\n` +
        `Usage Error: pnpm@${PNPM} is not in the cache and network access is disabled. ` +
        `Seed it with 'corepack install -g --cache-only pnpm@${PNPM}', ` +
        `or run 'corepack pack pnpm@${PNPM}' on a networked machine.\n` +
        `\n$ corepack use [--here] [--pin-style=suffix|sidecar] <pattern>\n`,
    );

    const asJup = await run(["pm", "use", `pnpm@${PNPM}`], {
      ...createFixture({ name: "project" }),
      as: "jup",
      env: offline,
    });

    expect(asJup.exitCode).toBe(1);
    expect(asJup.stdout).toBe(
      `Installing pnpm@${PNPM} in the project...\n` +
        `Usage Error: pnpm@${PNPM} is not in the cache and network access is disabled. ` +
        `Seed it with 'jup install -g --cache-only pnpm@${PNPM}', ` +
        `or run 'jup pack pnpm@${PNPM}' on a networked machine.\n` +
        `\n$ jup pm use [--here] [--pin-style=suffix|sidecar] <pattern>\n`,
    );

    // A name substitution, not a rewrite: the two differ in the name and in
    // nothing else.
    expect(asCorepack.stdout.replaceAll("corepack", "jup")).toBe(
      asJup.stdout.replace("$ jup pm use", "$ jup use"),
    );
  });

  /**
   * Row 215 — R8's invariant, checked where §17.9 says it belongs.
   *
   * The check itself runs in `pnpm build`; what is asserted here is that it
   * *catches* a collision, because a build-time assertion nobody has ever seen
   * fail is indistinguishable from one that always passes.
   */
  describe("215: the disjointness invariant is a build-time check", () => {
    it("passes over the table this build actually ships", () => {
      expect(findCollisions(nameSets())).toEqual([]);
      expect(() => assertDisjoint(nameSets())).not.toThrow();
    });

    it.for([
      ["a scope word", "pm"],
      ["the full spelling of a scope", "runtime"],
      ["a verb", "use"],
      ["a reserved word", "node"],
    ])("fails when a table entry is named %s", ([, poison]) => {
      const poisoned = { ...nameSets(), NAMES: [...nameSets().NAMES, poison!] };

      expect(findCollisions(poisoned).map(({ word }) => word)).toContain(poison);
      expect(() => assertDisjoint(poisoned)).toThrow(/§17\.4 R8/);
    });

    it("reports both sets a colliding word is in", () => {
      const collisions = findCollisions({
        NAMES: ["pm"],
        SCOPE_WORDS: ["pm"],
        VERBS: [],
        RESERVED: [],
      });
      expect(collisions).toEqual([{ left: "NAMES", right: "SCOPE_WORDS", word: "pm" }]);
    });

    it("tolerates the yarn-is-both overlap inside NAMES", () => {
      // §17.4 R8: `NAMES` is a union precisely because `yarn` is both a tool name
      // and a binary name. A duplicate *within* a set is not a collision.
      expect(findCollisions({ NAMES: ["yarn", "yarn"], SCOPE_WORDS: ["pm"] })).toEqual([]);
    });

    it("is wired into `pnpm build`", () => {
      const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
        scripts: Record<string, string>;
      };
      expect(manifest.scripts.build).toContain("scripts/check-name-sets.mjs");
    });
  });
});
