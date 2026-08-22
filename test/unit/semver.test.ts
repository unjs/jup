import { describe, expect, it } from "vitest";
import {
  compare,
  isValidRange,
  isValidVersion,
  lt,
  major,
  parse,
  rcompare,
  satisfies,
  satisfiesWithPrereleases,
} from "../../src/semver.ts";

const SHA1 = "+sha1.ac34549e6aa8e7ead463a7407e1c7390f61a6610";
const SHA224 = "+sha224.88b7a7244bbd9040380c417f7eb556d85c67640b651f113cb4c72113";

describe("parse", () => {
  it("parses the §13.3 stable version forms", () => {
    expect(parse("1.22.4")).toMatchObject({
      major: 1,
      minor: 22,
      patch: 4,
      prerelease: [],
      build: [],
      version: "1.22.4",
    });
    expect(parse("4.11.6")).toMatchObject({ major: 4, minor: 11, patch: 6 });
    expect(parse("6.14.2")).toMatchObject({ major: 6, minor: 14, patch: 2 });
  });

  it("parses the §13.3 prerelease version forms", () => {
    expect(parse("2.0.0-rc.30")).toMatchObject({
      major: 2,
      minor: 0,
      patch: 0,
      prerelease: ["rc", 30],
      version: "2.0.0-rc.30",
    });
    expect(parse("3.0.0-rc.2")).toMatchObject({ prerelease: ["rc", 2] });
    expect(parse("11.0.0-dev.1005")).toMatchObject({
      major: 11,
      prerelease: ["dev", 1005],
      version: "11.0.0-dev.1005",
    });
  });

  it("keeps build metadata out of `version` but available in `build`", () => {
    const sha1 = parse(`1.22.22${SHA1}`);
    expect(sha1).toMatchObject({
      major: 1,
      minor: 22,
      patch: 22,
      version: "1.22.22",
      build: ["sha1", "ac34549e6aa8e7ead463a7407e1c7390f61a6610"],
    });

    const sha224 = parse(`4.14.1${SHA224}`);
    expect(sha224?.build[0]).toBe("sha224");
    expect(sha224?.build[1]).toHaveLength(56);
    expect(sha224?.version).toBe("4.14.1");

    // A prerelease reference can carry a hash suffix too (§13.3 #16 + #50).
    expect(parse(`3.0.0-rc.2${SHA224}`)).toMatchObject({
      prerelease: ["rc", 2],
      version: "3.0.0-rc.2",
      build: ["sha224", "88b7a7244bbd9040380c417f7eb556d85c67640b651f113cb4c72113"],
    });
  });

  it("accepts a leading `v` and surrounding whitespace", () => {
    expect(parse("v1.22.4")?.version).toBe("1.22.4");
    expect(parse("  1.22.4  ")?.version).toBe("1.22.4");
  });

  it("returns null on malformed input rather than throwing", () => {
    for (const bad of [
      "",
      "   ",
      "1",
      "1.2",
      "1.2.3.4",
      "01.2.3",
      "1.2.3-",
      "1.2.3+",
      "latest",
      "^1.2.3",
      "1.x",
      "not a version",
      "1.2.3+sha1.deadbeef extra",
    ]) {
      expect(() => parse(bad)).not.toThrow();
      expect(parse(bad), bad).toBeNull();
    }
    // Defensive: non-string input must not throw either.
    expect(parse(undefined as unknown as string)).toBeNull();
  });
});

describe("isValidVersion / isValidRange", () => {
  it("classifies exact versions", () => {
    expect(isValidVersion("11.0.0-dev.1005")).toBe(true);
    expect(isValidVersion(`6.6.2${SHA224}`)).toBe(true);
    expect(isValidVersion("6.x")).toBe(false);
    expect(isValidVersion("latest")).toBe(false);
  });

  it("accepts every range the embedded table uses", () => {
    for (const range of [
      "*",
      "<6.0.0",
      "6.x || 7.x || 8.x || 9.x || 10.x",
      ">=11.0.0",
      "<2.0.0",
      ">=2.0.0",
      "^4.0.0",
      "^10.0.0",
    ]) {
      expect(isValidRange(range), range).toBe(true);
    }
  });

  it("accepts the wider range grammar", () => {
    for (const range of [
      "1.2.3",
      "=1.2.3",
      ">1.2.3",
      "<=1.2.3",
      ">= 1.2.3",
      "~1.2.3",
      "^1.2.x",
      "1.2.x",
      "1.x",
      "x",
      "X",
      ">=1.2.3 <2.0.0",
      "1.2.3 - 2.3.4",
      "1.2 - 2.3",
      ">=1.0.0 <2.0.0 || >=3.0.0",
    ]) {
      expect(isValidRange(range), range).toBe(true);
    }
  });

  it("rejects tags and junk without throwing", () => {
    for (const range of ["latest", "canary", "yarn@1.x", "1.2.3<4", ">=<1", "1..2"]) {
      expect(() => isValidRange(range)).not.toThrow();
      expect(isValidRange(range), range).toBe(false);
    }
  });
});

describe("compare / rcompare / lt / major", () => {
  it("ignores build metadata, so a hash-pinned spec stays range-comparable", () => {
    expect(compare(`4.1.0${SHA224}`, "4.1.0")).toBe(0);
    expect(compare("4.1.0", `4.1.0${SHA1}`)).toBe(0);
    expect(lt(`4.1.0${SHA224}`, "4.1.0")).toBe(false);
    expect(lt(`4.1.0${SHA224}`, "4.1.1")).toBe(true);
  });

  it("orders by major, minor, patch", () => {
    expect(compare("1.22.4", "1.22.22")).toBe(-1);
    expect(compare("11.0.0", "9.15.0")).toBe(1);
    expect(compare("6.14.2", "6.14.2")).toBe(0);
    expect(rcompare("1.22.4", "1.22.22")).toBe(1);
  });

  it("sorts a prerelease below its own release", () => {
    expect(compare("2.0.0-rc.30", "2.0.0")).toBe(-1);
    expect(compare("11.0.0-dev.1005", "11.0.0")).toBe(-1);
    expect(compare("2.0.0", "2.0.0-rc.30")).toBe(1);
  });

  it("compares prerelease identifiers numerically when numeric", () => {
    expect(compare("2.0.0-rc.2", "2.0.0-rc.30")).toBe(-1);
    // Lexical comparison would put "30" before "2".
    expect(compare("2.0.0-rc.30", "2.0.0-rc.2")).toBe(1);
    expect(compare("11.0.0-dev.999", "11.0.0-dev.1005")).toBe(-1);
    // Numeric identifiers rank below alphanumeric ones.
    expect(compare("1.0.0-1", "1.0.0-alpha")).toBe(-1);
    expect(compare("1.0.0-alpha", "1.0.0-alpha.1")).toBe(-1);
    expect(compare("1.0.0-alpha.1", "1.0.0-beta")).toBe(-1);
  });

  it("sorts a mixed list descending, prereleases and hashes included", () => {
    const versions = [
      "1.22.4",
      `1.22.22${SHA1}`,
      "2.0.0-rc.30",
      "2.0.0",
      "3.0.0-rc.2",
      `4.14.1${SHA224}`,
      "4.14.1",
      "11.0.0-dev.1005",
      "11.0.0",
    ];
    const shuffled = [...versions].reverse();
    expect([...shuffled].sort(rcompare)).toEqual([
      "11.0.0",
      "11.0.0-dev.1005",
      // Equal under comparison (build metadata is ignored), so the stable sort
      // keeps their relative input order.
      "4.14.1",
      `4.14.1${SHA224}`,
      "3.0.0-rc.2",
      "2.0.0",
      "2.0.0-rc.30",
      `1.22.22${SHA1}`,
      "1.22.4",
    ]);
  });

  it("does not throw on malformed input", () => {
    expect(() => compare("nonsense", "1.2.3")).not.toThrow();
    expect(compare("nonsense", "1.2.3")).toBe(-1);
    expect(compare("1.2.3", "nonsense")).toBe(1);
    expect(compare("nonsense", "junk")).toBe(0);
    expect(lt("nonsense", "junk")).toBe(false);
  });

  it("extracts the major for `corepack up`, NaN when unparseable", () => {
    expect(major("4.9.0")).toBe(4);
    expect(major(`11.1.2${SHA1}`)).toBe(11);
    expect(major("11.0.0-dev.1005")).toBe(11);
    expect(major("latest")).toBeNaN();
  });
});

describe("satisfies (strict — standard prerelease-excluding semver)", () => {
  it("matches stable versions against the table's ranges", () => {
    expect(satisfies("11.14.1", "*")).toBe(true);
    expect(satisfies("5.18.10", "<6.0.0")).toBe(true);
    expect(satisfies("6.0.0", "<6.0.0")).toBe(false);
    expect(satisfies("10.5.0", "6.x || 7.x || 8.x || 9.x || 10.x")).toBe(true);
    expect(satisfies("11.0.0", "6.x || 7.x || 8.x || 9.x || 10.x")).toBe(false);
    expect(satisfies("11.1.2", ">=11.0.0")).toBe(true);
    expect(satisfies("1.22.22", "<2.0.0")).toBe(true);
    expect(satisfies("4.14.1", ">=2.0.0")).toBe(true);
  });

  it("EXCLUDES a prerelease from a range that does not name one", () => {
    expect(satisfies("4.0.0-rc.1", ">=2.0.0")).toBe(false);
    expect(satisfies("10.5.0-rc.1", "6.x || 7.x || 8.x || 9.x || 10.x")).toBe(false);
    expect(satisfies("11.0.0-dev.1005", "*")).toBe(false);
    expect(satisfies("2.0.0-rc.30", "<2.0.0")).toBe(false);
  });

  it("admits a prerelease only when the range names one at the same tuple", () => {
    expect(satisfies("2.0.0-rc.30", ">=2.0.0-rc.0")).toBe(true);
    expect(satisfies("2.0.0-rc.30", ">=2.0.0-rc.0 <3.0.0")).toBe(true);
    // The named prerelease is at a different [major,minor,patch] tuple.
    expect(satisfies("3.0.0-rc.2", ">=2.0.0-rc.0")).toBe(false);
    expect(satisfies("2.0.0-rc.30", "2.0.0-rc.30")).toBe(true);
  });

  it("handles the whole range grammar", () => {
    expect(satisfies("1.2.3", "1.2.3")).toBe(true);
    expect(satisfies("1.2.3", "=1.2.3")).toBe(true);
    expect(satisfies("1.2.4", "~1.2.3")).toBe(true);
    expect(satisfies("1.3.0", "~1.2.3")).toBe(false);
    expect(satisfies("1.9.0", "^1.2.3")).toBe(true);
    expect(satisfies("2.0.0", "^1.2.3")).toBe(false);
    expect(satisfies("0.2.9", "^0.2.3")).toBe(true);
    expect(satisfies("0.3.0", "^0.2.3")).toBe(false);
    expect(satisfies("0.0.3", "^0.0.3")).toBe(true);
    expect(satisfies("0.0.4", "^0.0.3")).toBe(false);
    expect(satisfies("4.9.0", "^4.0.0")).toBe(true);
    expect(satisfies("5.0.0", "^4.0.0")).toBe(false);
    expect(satisfies("2.0.0", "1.2.3 - 2.3.4")).toBe(true);
    expect(satisfies("2.3.5", "1.2.3 - 2.3.4")).toBe(false);
    expect(satisfies("2.3.9", "1.2.3 - 2.3")).toBe(true);
    expect(satisfies("2.4.0", "1.2.3 - 2.3")).toBe(false);
    expect(satisfies("1.2.9", "1.2.x")).toBe(true);
    expect(satisfies("1.3.0", "1.2.x")).toBe(false);
    expect(satisfies("6.9.9", "6.X")).toBe(true);
    expect(satisfies("1.2.3", ">1")).toBe(false);
    expect(satisfies("2.0.0", ">1")).toBe(true);
    expect(satisfies("1.2.3", ">=1.2.3 <2.0.0")).toBe(true);
    expect(satisfies("2.0.0", ">=1.2.3 <2.0.0")).toBe(false);
  });

  it("ignores build metadata on the version under test", () => {
    expect(satisfies(`6.6.2${SHA224}`, "6.x")).toBe(true);
    expect(satisfies(`1.22.22${SHA1}`, "<2.0.0")).toBe(true);
  });

  it("returns false on malformed input rather than throwing", () => {
    expect(() => satisfies("1.2.3", "not a range")).not.toThrow();
    expect(satisfies("1.2.3", "not a range")).toBe(false);
    expect(satisfies("not a version", "*")).toBe(false);
    expect(satisfies("", "*")).toBe(false);
    expect(satisfies("1.2.3", ">=<1")).toBe(false);
  });
});

describe("satisfiesWithPrereleases (lenient — strips prereleases from both sides)", () => {
  it("INCLUDES a prerelease in a range that names none", () => {
    expect(satisfiesWithPrereleases("4.0.0-rc.1", ">=2.0.0")).toBe(true);
    expect(satisfiesWithPrereleases("2.0.0-rc.30", ">=2.0.0")).toBe(true);
    expect(satisfiesWithPrereleases("3.0.0-rc.2", ">=2.0.0")).toBe(true);
    expect(satisfiesWithPrereleases("11.0.0-dev.1005", "*")).toBe(true);
    expect(satisfiesWithPrereleases("11.0.0-dev.1005", ">=11.0.0")).toBe(true);
  });

  it("lands `10.5.0-rc.1` in the pnpm `.cjs` band, per §02.5", () => {
    // Reversed band order: `>=11.0.0` first, then the 6–10 band, then `<6.0.0`.
    expect(satisfiesWithPrereleases("10.5.0-rc.1", ">=11.0.0")).toBe(false);
    expect(satisfiesWithPrereleases("10.5.0-rc.1", "6.x || 7.x || 8.x || 9.x || 10.x")).toBe(true);
    expect(satisfiesWithPrereleases("10.5.0-rc.1", "10.x")).toBe(true);
    expect(satisfiesWithPrereleases("10.5.0-rc.1", "<6.0.0")).toBe(false);
  });

  it("differs from strict exactly where §04.2 says it should", () => {
    // Lenient: yes. Strict: no. The two modes MUST stay distinct.
    expect(satisfiesWithPrereleases("4.0.0-rc.1", ">=2.0.0")).toBe(true);
    expect(satisfies("4.0.0-rc.1", ">=2.0.0")).toBe(false);

    expect(satisfiesWithPrereleases("10.5.0-rc.1", "10.x")).toBe(true);
    expect(satisfies("10.5.0-rc.1", "10.x")).toBe(false);
  });

  it("strips the prerelease from the comparator too, not just the version", () => {
    // `2.0.0` (stripped from `2.0.0-rc.30`) is not `>= 2.0.0-rc.40` under plain
    // semver — it is only excluded once the comparator is stripped as well.
    expect(satisfiesWithPrereleases("2.0.0-rc.30", "<2.0.0-rc.40")).toBe(false);
    expect(satisfiesWithPrereleases("1.9.9", "<2.0.0-rc.40")).toBe(true);
    expect(satisfiesWithPrereleases("2.0.0-rc.30", ">=2.0.0-rc.40")).toBe(true);
    // Contrast: `includePrerelease` semantics would answer the opposite way here.
    expect(satisfies("2.0.0-rc.30", ">=2.0.0-rc.40")).toBe(false);
  });

  it("is unchanged for stable versions", () => {
    expect(satisfiesWithPrereleases("11.14.1", "*")).toBe(true);
    expect(satisfiesWithPrereleases("5.18.10", "<6.0.0")).toBe(true);
    expect(satisfiesWithPrereleases("6.0.0", "<6.0.0")).toBe(false);
    expect(satisfiesWithPrereleases("1.22.22", "<2.0.0")).toBe(true);
    expect(satisfiesWithPrereleases("1.22.22", ">=2.0.0")).toBe(false);
    expect(satisfiesWithPrereleases("4.9.0", "^4.0.0")).toBe(true);
  });

  it("ignores build metadata, so hash-pinned references stay range-comparable", () => {
    expect(satisfiesWithPrereleases(`3.0.0-rc.2${SHA224}`, ">=2.0.0")).toBe(true);
    expect(satisfiesWithPrereleases(`1.22.22${SHA1}`, "<2.0.0")).toBe(true);
    expect(satisfiesWithPrereleases(`11.1.2${SHA1}`, ">=11.0.0")).toBe(true);
  });

  it("returns false on malformed input rather than throwing", () => {
    expect(() => satisfiesWithPrereleases("1.2.3", "not a range")).not.toThrow();
    expect(satisfiesWithPrereleases("1.2.3", "not a range")).toBe(false);
    expect(satisfiesWithPrereleases("not a version", "*")).toBe(false);
    expect(satisfiesWithPrereleases("", "*")).toBe(false);
    expect(satisfiesWithPrereleases(undefined as unknown as string, "*")).toBe(false);
    expect(satisfiesWithPrereleases("1.2.3", "latest")).toBe(false);
  });
});
