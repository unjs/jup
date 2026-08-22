/**
 * §15.33 — no stale or shadowed defaults (rows 199–200).
 *
 * `Engine.executePackageManagerRequest` reads
 * `definition.transparent.default ?? defaultVersion`, so a compile-time constant
 * unconditionally outranks the user's own last-known-good. After
 * `corepack install -g yarn@4.9.0`, `yarn dlx` still runs the table's pin, with
 * no way to override it (#202, acknowledged by two maintainers, no fix landed).
 *
 * **On "at least as new".** §15.33's prose says to prefer the recorded default
 * when it is at least as new as the floor, but row 199 pairs a recorded `4.9.0`
 * with a table floor of `4.14.1` and requires `4.9.0` to win — a version-wise
 * floor answers `4.14.1` and fails the row. The reading that satisfies both is a
 * **major-line** floor, and it is also what the driving issue asks for: #812 is
 * `yarn create` reaching for Yarn Classic 1.22.22, unsupported since 2020,
 * because the recorded default is from an older major line.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DEFINITIONS } from "../../src/config/table.ts";
import {
  cleanupFixtures,
  createFixture,
  run,
  seedPackageManager,
  versionOf,
} from "./_harness/index.ts";

const YARN_TRANSPARENT = DEFINITIONS.yarn!.transparent.default!;

afterAll(cleanupFixtures);

function recordDefault(home: string, entries: Record<string, string>): void {
  writeFileSync(join(home, "lastKnownGood.json"), `${JSON.stringify(entries, undefined, 2)}\n`);
}

describe("§15.33 transparent.default is a floor, not an override", () => {
  it("199: a recorded default in the same major line wins over the table's pin", async () => {
    const fixture = createFixture();
    recordDefault(fixture.home, { yarn: "4.9.0" });
    seedPackageManager(fixture.home, "yarn", "4.9.0");
    seedPackageManager(fixture.home, "yarn", YARN_TRANSPARENT);

    // Both versions are in the store, so whichever the tool picks runs — the
    // assertion cannot pass by accident through a resolution failure.
    const result = await run(["yarn", "dlx", "--help"], fixture);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("yarn@4.9.0 dlx --help\n");
    expect(result.stderr).toBe("");
  });

  it("199: and `install -g` is how that default gets recorded", async () => {
    const fixture = createFixture();
    seedPackageManager(fixture.home, "yarn", "4.9.0");
    seedPackageManager(fixture.home, "yarn", YARN_TRANSPARENT);

    // No registry: `install -g` on an already-cached exact version resolves from
    // the store (§04.1 step 4) and records it (§09.3), all without the network.
    const installed = await run(["install", "-g", "yarn@4.9.0"], fixture);
    expect(installed.exitCode).toBe(0);

    const result = await run(["yarn", "dlx", "--help"], fixture);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("yarn@4.9.0 dlx --help\n");
  });

  it("200: with nothing recorded, the table's transparent.default stands", async () => {
    const fixture = createFixture();
    seedPackageManager(fixture.home, "yarn", YARN_TRANSPARENT);

    const result = await run(["yarn", "dlx", "--help"], fixture);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`yarn@${versionOf(YARN_TRANSPARENT)} dlx --help\n`);
  });

  it("200: a recorded default from an older major line does not shadow the floor", async () => {
    // #812 exactly. Yarn's compiled-in `default` is Classic 1.22.22 while its
    // `transparent.default` is modern, and `install -g yarn@1.22.22` records the
    // classic line — which has no `dlx` at all.
    const fixture = createFixture();
    recordDefault(fixture.home, { yarn: "1.22.22" });
    seedPackageManager(fixture.home, "yarn", "1.22.22");
    seedPackageManager(fixture.home, "yarn", YARN_TRANSPARENT);

    const result = await run(["yarn", "dlx", "--help"], fixture);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`yarn@${versionOf(YARN_TRANSPARENT)} dlx --help\n`);
  });

  it("199: a non-transparent command still uses the recorded default outright", async () => {
    // The floor applies to transparent commands only; `yarn --version` has
    // always taken the last-known-good and still does (§04.5 step 1).
    const fixture = createFixture();
    recordDefault(fixture.home, { yarn: "1.22.22" });
    seedPackageManager(fixture.home, "yarn", "1.22.22");

    const result = await run(["yarn", "--version"], fixture);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("1.22.22\n");
  });

  it("200: the floor is read from disk, never from the network", async () => {
    const fixture = createFixture();
    seedPackageManager(fixture.home, "yarn", YARN_TRANSPARENT);

    // `COREPACK_ENABLE_NETWORK=0` turns any request into a hard failure, so exit
    // 0 is the assertion that this path makes none — which is what §04.5 has
    // always promised for transparent commands and what §15.33 must not cost.
    const result = await run(["yarn", "dlx", "--help"], {
      ...fixture,
      env: { COREPACK_ENABLE_NETWORK: "0" },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`yarn@${versionOf(YARN_TRANSPARENT)} dlx --help\n`);
  });
});
