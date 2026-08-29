/**
 * row 176 — `bin` paths come from the verified package (§07.7).
 *
 * #775: corepack hardcodes each package manager's entry point and breaks every
 * time one restructures. pnpm has forced a new range band twice already
 * (`.js` → `.cjs` → `.mjs`, §02.5) and a v12 alpha broke it again, and each
 * break needs a corepack release before anyone can install the new major. A
 * maintainer states the tradeoff honestly: reading `bin` from the download is
 * more correct but trusts attacker-controlled metadata.
 *
 * §07.7 takes both horns, because verification already happened — the
 * `package.json` being read has cleared §06.1's tier — and §08.1 confines the
 * paths it yields to the install directory.
 *
 * **The band does not get a veto.** Every band in the shipped table is
 * open-ended at one end, so a restructured release lands *inside* a band rather
 * than outside every one — an 11.9.x that moved its entry point satisfies
 * `>=11.0.0` all the same. A rule that only consulted the package for uncovered
 * versions would therefore never fire on the case #775 is about, which is why
 * the rows below run against the shipped table.
 *
 * The version doing the restructuring here is a pnpm 11 and not the pnpm 12 the
 * issue named, because 12 restructured further than #775 imagined: it is a
 * native binary now, and §02.4's band fetches it from `@pnpm/exe.<host>`, a
 * package with no `bin` for §07.7 to read. Nothing about the rule changed —
 * what changed is which of pnpm's bands can demonstrate it. The uncovered-version
 * rows use `npm` for a related reason: pnpm's newest band is per-host, and it is
 * the band a version past the table falls forward onto.
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

/** A tool whose table stops below npm 12, so `npm@12` matches no declared band. */
let unbanded: string;

/**
 * A pnpm inside the `>=11.0.0` band that has moved its entry point to `dist/`,
 * so the band's `./bin/pnpm.mjs` does not exist in the tarball at all. An
 * implementation that trusted the band cannot run this, which is what makes the
 * row discriminating rather than decorative.
 */
const MOVED = npmTarball({
  "package.json": `${JSON.stringify({
    name: "pnpm",
    version: "11.9.9",
    bin: { pnpm: "./dist/pnpm.mjs", pnpx: "./dist/pnpx.mjs" },
  })}\n`,
  "dist/pnpm.mjs": pmScript("pnpm", "11.9.9"),
  "dist/pnpx.mjs": pmScript("pnpx", "11.9.9"),
});

/**
 * The same restructuring on the tool the uncovered-version rows use: an `npm`
 * past the closed band below, whose entry point is not where the band says.
 */
const UNCOVERED = npmTarball({
  "package.json": `${JSON.stringify({
    name: "npm",
    version: "12.0.0",
    bin: { npm: "./dist/npm-cli.js", npx: "./dist/npx-cli.js" },
  })}\n`,
  "dist/npm-cli.js": pmScript("npm", "12.0.0"),
  "dist/npx-cli.js": pmScript("npx", "12.0.0"),
});

/** A package that declares nothing: the band is the fallback (§07.7 point 2). */
const SILENT = npmTarball({
  "package.json": `${JSON.stringify({ name: "pnpm", version: "11.9.8" })}\n`,
  "bin/pnpm.mjs": pmScript("pnpm", "11.9.8"),
  "bin/pnpx.mjs": pmScript("pnpx", "11.9.8"),
});

/** §08.1 — the same package, declaring a `bin` that climbs out of the install. */
const ESCAPING = npmTarball({
  "package.json": `${JSON.stringify({
    name: "pnpm",
    version: "11.9.7",
    bin: { pnpm: "../../../../evil.mjs" },
  })}\n`,
  "dist/pnpm.mjs": pmScript("pnpm", "11.9.7"),
});

beforeAll(async () => {
  await registry.start();
  registry.publish("pnpm", "11.9.8", SILENT);
  registry.publish("pnpm", "11.9.9", MOVED);
  registry.publish("pnpm", "11.9.7", ESCAPING);
  registry.publish("npm", "12.0.0", UNCOVERED);

  unbanded = copyTool();
  const table = join(dirname(unbanded), "config", "table.ts");
  const source = readFileSync(table, "utf8");
  // One line of surgery: close npm's only band, which is `*`. Anchored on the
  // URL beneath it, because `"*"` on its own is a range three other entries also
  // declare — and asserted, so a table edit that moves it fails this file loudly
  // instead of quietly turning the rows below into banded lookups that prove
  // nothing.
  const band = `"*",\n        {\n          url: "https://registry.npmjs.org/npm/-/npm-{}.tgz",`;
  expect(source).toContain(band);
  writeFileSync(table, source.replace(band, band.replace(`"*"`, `"<12.0.0"`)));
});

afterAll(async () => {
  cleanupFixtures();
  await registry.stop();
});

beforeEach(() => registry.reset());

describe("§07.7 — `bin` comes from the verified package", () => {
  it("176: a restructured pnpm runs from the entry point its own package.json declares", async () => {
    // The shipped table: `>=11.0.0` covers this version and points at
    // `./bin/pnpm.mjs`, which this package does not contain. The band loses.
    const fixture = createFixture({ packageManager: `pnpm@11.9.9+sha512.${hashOf(MOVED)}` });

    const result = await run(["pnpm", "--version"], { ...fixture, registry });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("11.9.9\n");
    expect(result.stderr).toBe("");
    // The path really is the package's: the band's is absent from the install.
    const location = join(fixture.home, "v1", "pnpm", "11.9.9");
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
    // §07.7 point 2. The table is still the safety net for anything published
    // without a `bin` map; it is just no longer the first answer.
    const fixture = createFixture({ packageManager: `pnpm@11.9.8+sha512.${hashOf(SILENT)}` });

    const result = await run(["pnpm", "--version"], { ...fixture, registry });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("11.9.8\n");
  });

  it("176: DEBUG=corepack reports the band the package disagreed with", async () => {
    // §07.7 point 3, second bullet. The run succeeds either way; without this
    // note nothing would ever say the band has rotted (§16).
    const fixture = createFixture({ packageManager: `pnpm@11.9.9+sha512.${hashOf(MOVED)}` });

    const result = await run(["pnpm", "--version"], {
      ...fixture,
      registry,
      env: { DEBUG: "corepack" },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain(
      `! pnpm@11.9.9 declares "bin" {"pnpm":"./dist/pnpm.mjs","pnpx":"./dist/pnpx.mjs"}, but its range band says {"pnpm":"./bin/pnpm.mjs","pnpx":"./bin/pnpx.mjs"}. The package won; update the range band.`,
    );
  });

  it("176: DEBUG=corepack notes a version no band covers, so it is not lost", async () => {
    // §07.7 point 3, first bullet — the tool whose table stops below npm 12.
    const fixture = createFixture({ packageManager: `npm@12.0.0+sha512.${hashOf(UNCOVERED)}` });

    const result = await run(["npm", "--version"], {
      ...fixture,
      registry,
      bin: unbanded,
      env: { DEBUG: "corepack" },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("12.0.0\n");
    expect(result.stderr).toContain(
      `! npm@12.0.0 matches no declared range band; reading "bin" from the verified package.`,
    );
  });

  it("176: and says nothing without DEBUG", async () => {
    const fixture = createFixture({ packageManager: `npm@12.0.0+sha512.${hashOf(UNCOVERED)}` });

    const result = await run(["npm", "--version"], { ...fixture, registry, bin: unbanded });

    expect(result.stderr).toBe("");
  });

  it("176: §08.1 — a `bin` that escapes the install directory is refused", async () => {
    // The security-critical half. The package is verified, so its metadata is
    // "trusted" in the only sense §07.7 claims; that is not a licence to write
    // the handover target wherever the package says.
    const fixture = createFixture({ packageManager: `pnpm@11.9.7+sha512.${hashOf(ESCAPING)}` });

    const result = await run(["pnpm", "--version"], { ...fixture, registry });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      `The bin path '../../../../evil.mjs' declared by pnpm@11.9.7 escapes its installation directory`,
    );
    // Refused before promotion: nothing escaping ever reached the store (§07.5).
    expect(existsSync(join(fixture.home, "v1", "pnpm", "11.9.7"))).toBe(false);
  });
});
