import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_REGISTRY, TRUST_KEYS } from "../../src/config/keys.ts";
import { DEFINITIONS } from "../../src/config/table.ts";

/**
 * §16 — `docs/public/install.{sh,ps1}` carry copies of table values, and
 * `scripts/refresh-table.mjs` stamps them. These are the assertions that make
 * the stamping load-bearing rather than well-intentioned: a hand-edited
 * `node.default`, or a key rotation landed without re-running the script, fails
 * here instead of on a user's machine.
 *
 * Neither drift is cosmetic. A stale `NODE_VERSION` is the duplicate download —
 * the installer bootstraps one Node and jup resolves a different one, leaving
 * ~200 MB of each on a fresh machine. A stale `NPM_TRUST_KEYS` stops
 * `install.sh` verifying the artifact's npm signature, and it then declines to
 * write the store entry at all (§06.1), which is the same duplicate by another
 * route.
 */
const PUBLIC = join(import.meta.dirname, "..", "..", "docs", "public");

function read(name: string): string {
  return readFileSync(join(PUBLIC, name), "utf8");
}

/** The one `<name>=<value>` or `$<name> = '<value>'` assignment, unquoted. */
function literal(source: string, pattern: RegExp): string {
  const found = pattern.exec(source);
  expect(found, `no match for ${pattern.source}`).not.toBeNull();
  return found![1]!;
}

describe("bootstrap installers", () => {
  const sh = read("install.sh");
  const ps1 = read("install.ps1");

  it("bootstrap the version the table calls node's default", () => {
    const expected = DEFINITIONS.node!.default;

    expect(literal(sh, /^NODE_VERSION=(.*)$/m)).toBe(expected);
    expect(literal(ps1, /^\$nodeVersion = '([^']*)'$/m)).toBe(expected);
  });

  it("carry §02.6's trust store for the default registry", () => {
    // Order included: the stamper writes them as `refreshKeys` left them, so a
    // reordering is a diff someone should have to look at.
    const expected = TRUST_KEYS[DEFAULT_REGISTRY]!.map((key) => key.key).join(" ");

    expect(literal(sh, /^NPM_TRUST_KEYS="([^"]*)"$/m)).toBe(expected);
  });

  it("treat an older Node than `engines.node` as no Node at all", () => {
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dirname, "..", "..", "package.json"), "utf8"),
    ) as { engines: { node: string } };
    const [, major, minor] = /^>=(\d+)\.(\d+)\./.exec(manifest.engines.node) ?? [];

    for (const [source, majorPattern, minorPattern] of [
      [sh, /^NODE_MIN_MAJOR=(\d+)$/m, /^NODE_MIN_MINOR=(\d+)$/m],
      [ps1, /^\$nodeMinMajor = (\d+)$/m, /^\$nodeMinMinor = (\d+)$/m],
    ] as const) {
      expect(literal(source, majorPattern)).toBe(major);
      expect(literal(source, minorPattern)).toBe(minor);
    }
  });
});
