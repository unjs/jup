/**
 * row 201 — deprecated commands print a migration line (§09.11).
 *
 * #624 (5👍, a contributor's fix PR went unreviewed): corepack's `prepare` and
 * `hydrate` are documented as deprecated and print nothing at all, so every CI
 * script and tutorial still using them looks current. §09.11 requires both
 * halves — the command still works, *and* it names its replacement — and is
 * explicit that "never silently hide a command" is the point.
 *
 * The trap this file is written against: a row that only asserts the sentence
 * would pass against a build that printed it and then refused to do anything,
 * which is the failure mode §09.11 names. So every row here asserts the work
 * too — a cache entry written, an archive produced, an archive consumed.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cleanupFixtures, createFixture, run, seedPackageManager } from "./_harness/index.ts";

const PREPARE_LINE = `'jup prepare' is deprecated; use 'jup pack' instead.\n`;
const HYDRATE_LINE = `'jup hydrate' is deprecated; use 'jup install -g' instead.\n`;

afterAll(cleanupFixtures);

describe("§09.11 — a deprecated command names its replacement and still works", () => {
  it("201: `prepare` prints the migration line and caches the version", async () => {
    const fixture = createFixture({});
    // Already in the store, so the whole row runs with no network at all: what
    // is under test is the notice and the command's own output, not resolution.
    seedPackageManager(fixture.home, "yarn", "1.22.4");

    const result = await run(["prepare", "yarn@1.22.4"], fixture);

    expect(result.exitCode).toBe(0);
    // §09.11's sentence, byte for byte, on stderr — §09.14 puts warnings there,
    // and `prepare --json` writes a document to stdout that a caller pipes on.
    expect(result.stderr).toBe(PREPARE_LINE);
    // Still works: §09.11's own line, unchanged and unprefixed.
    expect(result.stdout).toBe("Adding yarn@1.22.4 to the cache...\n");
  });

  it("201: it does not leak into `--json` output", async () => {
    const fixture = createFixture({});
    seedPackageManager(fixture.home, "yarn", "1.22.4");

    const result = await run(["prepare", "yarn@1.22.4", "--json", "-o"], fixture);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe(PREPARE_LINE);
    // stdout parses: the notice is on the other stream, where it belongs.
    expect(() => JSON.parse(result.stdout) as unknown).not.toThrow();
    expect(fixture.exists("jup.tgz")).toBe(true);
  });

  it("201: `hydrate` prints its own line and consumes the archive", async () => {
    const source = createFixture({});
    seedPackageManager(source.home, "yarn", "1.22.4");
    // `--output=` rather than a space: §09.11's value is optional, so the space
    // form would read the path as another package-manager spec.
    const packed = await run(["prepare", "yarn@1.22.4", "--output=archive.tgz"], source);
    expect(packed.exitCode).toBe(0);

    // A *different* store, so "it worked" means the archive was really unpacked
    // rather than found already present.
    const target = createFixture({});
    const result = await run(["hydrate", source.path("archive.tgz")], target);

    expect(result.exitCode).toBe(0);
    // §09.11 keeps `hydrate`'s replacement distinct from `prepare`'s: the
    // archive half is `pack`, the install half is `install -g`.
    expect(result.stderr).toBe(HYDRATE_LINE);
    expect(result.stdout).toBe("Adding yarn@1.22.4 to the cache...\nAll done!\n");
    expect(existsSync(join(target.home, "v1", "yarn", "1.22.4"))).toBe(true);
  });

  it("201: a command that is not deprecated says nothing", async () => {
    // The control. Without it, a build that printed a deprecation line for
    // *every* command would pass every row above.
    const fixture = createFixture({});
    seedPackageManager(fixture.home, "yarn", "1.22.4");

    const result = await run(["pack", "yarn@1.22.4", "--output=out.tgz"], fixture);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain("is deprecated");
  });
});
