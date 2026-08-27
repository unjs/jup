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
 * **The band does not get a veto.** Every band in the shipped table is
 * open-ended at one end, so a restructured major lands *inside* a band rather
 * than outside every one — pnpm 12 satisfies `>=11.0.0` today. A rule that only
 * consulted the package for uncovered versions would therefore never fire on
 * the case #775 is about, which is why the rows below run against the shipped
 * table. `restructured()` still copies the tool with pnpm's top band closed at
 * `<12.0.0`, for the one row that needs a version no band covers at all.
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
let unbanded: string;

/**
 * pnpm 12 as a restructured package would ship it: the entry point has moved to
 * `dist/`, so the band's `./bin/pnpm.mjs` does not exist in the tarball at all.
 * An implementation that trusted the band cannot run this, which is what makes
 * the row discriminating rather than decorative.
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

/** A package that declares nothing: the band is the fallback (§15.17 point 2). */
const SILENT = npmTarball({
  "package.json": `${JSON.stringify({ name: "pnpm", version: "11.9.8" })}\n`,
  "bin/pnpm.mjs": pmScript("pnpm", "11.9.8"),
  "bin/pnpx.mjs": pmScript("pnpx", "11.9.8"),
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
  registry.publish("pnpm", "11.9.8", SILENT);
  registry.publish("pnpm", "12.0.0", MOVED);
  registry.publish("pnpm", "12.0.1", ESCAPING);

  unbanded = copyTool();
  const table = join(dirname(unbanded), "config", "table.ts");
  const source = readFileSync(table, "utf8");
  // One character of surgery: close pnpm's newest band. Asserted, so a table
  // edit that renamed the band fails this file loudly instead of quietly
  // turning the row below into a banded lookup that proves nothing.
  expect(source).toContain(`">=11.0.0"`);
  writeFileSync(table, source.replace(`">=11.0.0"`, `">=11.0.0 <12.0.0"`));
});

afterAll(async () => {
  cleanupFixtures();
  await registry.stop();
});

beforeEach(() => registry.reset());

describe("§15.17 — `bin` comes from the verified package", () => {
  it("176: pnpm@12 runs from the entry point its own package.json declares", async () => {
    // The shipped table: `>=11.0.0` covers this version and points at
    // `./bin/pnpm.mjs`, which this package does not contain. The band loses.
    const fixture = createFixture({ packageManager: `pnpm@12.0.0+sha512.${hashOf(MOVED)}` });

    const result = await run(["pnpm", "--version"], { ...fixture, registry });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("12.0.0\n");
    expect(result.stderr).toBe("");
    // The path really is the package's: the band's is absent from the install.
    const location = join(fixture.home, "v1", "pnpm", "12.0.0");
    expect(existsSync(join(location, "dist", "pnpm.mjs"))).toBe(true);
    expect(existsSync(join(location, "bin", "pnpm.mjs"))).toBe(false);
    // And it is the *marker* that says so, which is what every later cache hit
    // reads — the resolution is not repeated per run (§07.7).
    const marker = JSON.parse(readFileSync(join(location, ".jup"), "utf8")) as {
      bin: Record<string, string>;
    };
    expect(marker.bin).toEqual({ pnpm: "./dist/pnpm.mjs", pnpx: "./dist/pnpx.mjs" });
  });

  it("176: a package that declares no `bin` falls back to its range band", async () => {
    // §15.17 point 2. The table is still the safety net for anything published
    // without a `bin` map; it is just no longer the first answer.
    const fixture = createFixture({ packageManager: `pnpm@11.9.8+sha512.${hashOf(SILENT)}` });

    const result = await run(["pnpm", "--version"], { ...fixture, registry });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("11.9.8\n");
  });

  it("176: DEBUG=corepack reports the band the package disagreed with", async () => {
    // §15.17 point 3, second bullet. The run succeeds either way; without this
    // note nothing would ever say the band has rotted (§16.9).
    const fixture = createFixture({ packageManager: `pnpm@12.0.0+sha512.${hashOf(MOVED)}` });

    const result = await run(["pnpm", "--version"], {
      ...fixture,
      registry,
      env: { DEBUG: "corepack" },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain(
      `! pnpm@12.0.0 declares "bin" {"pnpm":"./dist/pnpm.mjs","pnpx":"./dist/pnpx.mjs"}, but its range band says {"pnpm":"./bin/pnpm.mjs","pnpx":"./bin/pnpx.mjs"}. The package won; update the range band.`,
    );
  });

  it("176: DEBUG=corepack notes a version no band covers, so it is not lost", async () => {
    // §15.17 point 3, first bullet — the tool whose table stops at pnpm 11.
    const fixture = createFixture({ packageManager: `pnpm@12.0.0+sha512.${hashOf(MOVED)}` });

    const result = await run(["pnpm", "--version"], {
      ...fixture,
      registry,
      bin: unbanded,
      env: { DEBUG: "corepack" },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("12.0.0\n");
    expect(result.stderr).toContain(
      `! pnpm@12.0.0 matches no declared range band; reading "bin" from the verified package.`,
    );
  });

  it("176: and says nothing without DEBUG", async () => {
    const fixture = createFixture({ packageManager: `pnpm@12.0.0+sha512.${hashOf(MOVED)}` });

    const result = await run(["pnpm", "--version"], { ...fixture, registry, bin: unbanded });

    expect(result.stderr).toBe("");
  });

  it("176: §14.13 — a `bin` that escapes the install directory is refused", async () => {
    // The security-critical half. The package is verified, so its metadata is
    // "trusted" in the only sense §15.17 claims; that is not a licence to write
    // the handover target wherever the package says.
    const fixture = createFixture({ packageManager: `pnpm@12.0.1+sha512.${hashOf(ESCAPING)}` });

    const result = await run(["pnpm", "--version"], { ...fixture, registry });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      `The bin path '../../../../evil.mjs' declared by pnpm@12.0.1 escapes its installation directory`,
    );
    // Refused before promotion: nothing escaping ever reached the store (§07.5).
    expect(existsSync(join(fixture.home, "v1", "pnpm", "12.0.1"))).toBe(false);
  });
});
