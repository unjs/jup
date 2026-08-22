/**
 * §15.38 row 176 — `bin` paths come from the verified package (§15.17).
 *
 * #775: corepack hardcodes each package manager's entry point and breaks every
 * time one restructures. pnpm has forced a new range band twice already
 * (`.js` → `.cjs` → `.mjs`, §02.5) and a v12 alpha broke it again, and each
 * break needs a corepack release before anyone can install the new major. A
 * maintainer states the tradeoff honestly: reading `bin` from the download is
 * more correct but trusts attacker-controlled metadata.
 *
 * §15.17 takes both horns, because verification already happened — the
 * `package.json` being read has cleared §15.11's tier — and §14.13 confines the
 * paths it yields to the install directory.
 *
 * **How the fixture makes an unbanded version possible.** Every band in the
 * shipped table is open-ended at one end, so no real version escapes them all;
 * that is the whole reason this gap sat unexercised. `restructured()` runs a
 * *copy* of the tool (`copyTool`, already used by the shim rows) with pnpm's
 * top band closed at `<12.0.0`, which is exactly the state the table is in on
 * the day a new major ships and nobody has cut a release yet.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupFixtures,
  copyTool,
  createFixture,
  hashOf,
  MockRegistry,
  npmTarball,
  pmScript,
  run,
} from "./_harness/index.ts";

const registry = new MockRegistry();

/** A tool whose table stops at pnpm 11, so `pnpm@12` matches no declared band. */
let bin: string;

/**
 * pnpm 12 as a restructured package would ship it: the entry point has moved to
 * `dist/`, so the newest band's `./bin/pnpm.mjs` does not exist in the tarball
 * at all. An implementation that fell forward onto the band's `bin` cannot run
 * this, which is what makes the row discriminating rather than decorative.
 */
const MOVED = npmTarball({
  "package.json": `${JSON.stringify({
    name: "pnpm",
    version: "12.0.0",
    bin: { pnpm: "./dist/pnpm.mjs", pnpx: "./dist/pnpx.mjs" },
  })}\n`,
  "dist/pnpm.mjs": pmScript("pnpm", "12.0.0"),
  "dist/pnpx.mjs": pmScript("pnpx", "12.0.0"),
});

/** §14.13 — the same package, declaring a `bin` that climbs out of the install. */
const ESCAPING = npmTarball({
  "package.json": `${JSON.stringify({
    name: "pnpm",
    version: "12.0.1",
    bin: { pnpm: "../../../../evil.mjs" },
  })}\n`,
  "dist/pnpm.mjs": pmScript("pnpm", "12.0.1"),
});

beforeAll(async () => {
  await registry.start();
  registry.publish("pnpm", "12.0.0", MOVED);
  registry.publish("pnpm", "12.0.1", ESCAPING);

  bin = copyTool();
  const table = join(dirname(bin), "config", "table.ts");
  const source = readFileSync(table, "utf8");
  // One character of surgery: close pnpm's newest band. Asserted, so a table
  // edit that renamed the band fails this file loudly instead of quietly
  // turning every row below into a banded lookup that proves nothing.
  expect(source).toContain(`">=11.0.0"`);
  writeFileSync(table, source.replace(`">=11.0.0"`, `">=11.0.0 <12.0.0"`));
});

afterAll(async () => {
  cleanupFixtures();
  await registry.stop();
});

beforeEach(() => registry.reset());

describe("§15.17 — an unbanded version reads `bin` from the verified package", () => {
  it("176: pnpm@12 runs from the entry point its own package.json declares", async () => {
    const fixture = createFixture({ packageManager: `pnpm@12.0.0+sha512.${hashOf(MOVED)}` });

    const result = await run(["pnpm", "--version"], { ...fixture, registry, bin });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("12.0.0\n");
    expect(result.stderr).toBe("");
    // The path really is the package's, not the table's: the band's guess does
    // not exist in this install at all.
    const location = join(fixture.home, "v1", "pnpm", "12.0.0");
    expect(existsSync(join(location, "dist", "pnpm.mjs"))).toBe(true);
    expect(existsSync(join(location, "bin", "pnpm.mjs"))).toBe(false);
  });

  it("176: the same tool still prefers the table where a band does cover it", async () => {
    // The control for point 1. pnpm 11 is inside a declared band, so its `bin`
    // comes from the table with no parsing at all — and this fixture's tarball
    // declares a *different* `bin` to prove which one was used.
    const banded = npmTarball({
      "package.json": `${JSON.stringify({
        name: "pnpm",
        version: "11.9.9",
        bin: { pnpm: "./dist/wrong.mjs" },
      })}\n`,
      "bin/pnpm.mjs": pmScript("pnpm", "11.9.9"),
      "bin/pnpx.mjs": pmScript("pnpx", "11.9.9"),
      "dist/wrong.mjs": `process.stdout.write("the table's bin was ignored\\n");\n`,
    });
    registry.publish("pnpm", "11.9.9", banded);

    const fixture = createFixture({ packageManager: `pnpm@11.9.9+sha512.${hashOf(banded)}` });

    const result = await run(["pnpm", "--version"], { ...fixture, registry, bin });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("11.9.9\n");
  });

  it("176: DEBUG=corepack notes the version, so the missing band is not lost", async () => {
    // §15.17 point 3. The run succeeds either way; this is the maintenance
    // signal that a range band is owed (§16.9).
    const fixture = createFixture({ packageManager: `pnpm@12.0.0+sha512.${hashOf(MOVED)}` });

    const result = await run(["pnpm", "--version"], {
      ...fixture,
      registry,
      bin,
      env: { DEBUG: "corepack" },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain(
      `! pnpm@12.0.0 matches no declared range band; reading "bin" from the verified package.`,
    );
  });

  it("176: and says nothing without DEBUG", async () => {
    const fixture = createFixture({ packageManager: `pnpm@12.0.0+sha512.${hashOf(MOVED)}` });

    const result = await run(["pnpm", "--version"], { ...fixture, registry, bin });

    expect(result.stderr).toBe("");
  });

  it("176: §14.13 — a `bin` that escapes the install directory is refused", async () => {
    // The security-critical half. The package is verified, so its metadata is
    // "trusted" in the only sense §15.17 claims; that is not a licence to write
    // the handover target wherever the package says.
    const fixture = createFixture({ packageManager: `pnpm@12.0.1+sha512.${hashOf(ESCAPING)}` });

    const result = await run(["pnpm", "--version"], { ...fixture, registry, bin });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      `The bin path '../../../../evil.mjs' declared by pnpm@12.0.1 escapes its installation directory`,
    );
    // Refused before promotion: nothing escaping ever reached the store (§07.5).
    expect(existsSync(join(fixture.home, "v1", "pnpm", "12.0.1"))).toBe(false);
  });
});
