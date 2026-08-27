import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_REGISTRY, getTrustedKeys, TRUST_KEYS } from "../../src/config/keys.ts";
import {
  DEFINITIONS,
  getBinariesFor,
  getDefinition,
  getPackageManagerFor,
  getSpecFor,
  getSpecUrl,
  hasRangeBand,
  hostTarget,
  isPerHost,
  isSupportedPackageManager,
  packageManagerForRegistry,
  resolveArtifactRegistry,
  resolveSpecBin,
  resolveSpecUrl,
  shimsByDefault,
  SUPPORTED_NAMES,
} from "../../src/config/table.ts";
import { messages, UsageError } from "../../src/errors.ts";
import { satisfiesWithPrereleases } from "../../src/version/semver.ts";
import type { BinSpec, PackageManagerSpec, TrustedKey, TrustStore } from "../../src/types.ts";

describe("registry table — shape (§02.5)", () => {
  it("supports exactly npm, pnpm, yarn, bun, deno and aube", () => {
    expect([...SUPPORTED_NAMES]).toEqual(["npm", "pnpm", "yarn", "bun", "deno", "aube"]);
    expect(isSupportedPackageManager("yarn")).toBe(true);
    expect(isSupportedPackageManager("bun")).toBe(true);
    // §01.7 / §15.21 — the table is closed and compiled in. `vlt` stands in for
    // "a real package manager this build does not ship", which is what every
    // negative assertion in this file needs and what `bun` used to be.
    expect(isSupportedPackageManager("vlt")).toBe(false);
    expect(getDefinition("vlt")).toBeUndefined();
  });

  it("pins hash-suffixed defaults", () => {
    expect(DEFINITIONS.npm!.default).toBe("11.14.1+sha1.4a6839650da0005f323fec6abd39d77ee24f842f");
    expect(DEFINITIONS.pnpm!.default).toBe("11.1.2+sha1.ed39d701687311ce9345771c62376f9fe7286694");
  });

  /**
   * §15.33 bullet 2 overrules §14.21's "deliberately not changed" and §02.5's
   * literal: an embedded `default` MUST track the current supported major, and
   * Yarn Classic 1.22.22 has been unsupported since 2020 (#812).
   *
   * The assertion is the *literal*, not `expect(yarn.default).toBe(
   * yarn.transparent.default)` — the tautology would pass just as well against
   * a table that had drifted back to Classic in both fields.
   */
  it("puts yarn's default on the supported major, hash-pinned (§15.33)", () => {
    const yarn = DEFINITIONS.yarn!;
    const supported = "4.14.1+sha224.88b7a7244bbd9040380c417f7eb556d85c67640b651f113cb4c72113";
    expect(yarn.default).toBe(supported);
    expect(yarn.transparent.default).toBe(supported);
    // §14.21's asymmetry is gone, and the classic line is what it is gone *from*.
    expect(yarn.default.startsWith("1.")).toBe(false);
  });

  /**
   * §02.5, §15.11 — every compiled-in default carries a digest, in the
   * `<version>+<algo>.<hex>` form §06.1 row 1 checks. A default that did not
   * would be refused by `assertVerificationTier` on any machine without a
   * `lastKnownGood.json`, i.e. every fresh install.
   */
  it("hash-pins every compiled-in default (§02.5)", () => {
    for (const [name, definition] of Object.entries(DEFINITIONS)) {
      // §15.28 — a per-host entry's artifact differs from machine to machine, so
      // there is no one digest to compile in. What clears §15.11's tier for it is
      // npm's signature over the host's own artifact, checked on every install;
      // the default is therefore a bare version, and asserting that it *is* bare
      // is what stops a well-meant edit from pinning one host's digest for all.
      const perHost = definition.ranges.some(([, spec]) => spec.artifactRegistry !== undefined);
      for (const reference of [definition.default, definition.transparent.default]) {
        if (reference === undefined) continue;
        expect(reference, name).toMatch(
          perHost ? /^\d+\.\d+\.\d+$/ : /^\d+\.\d+\.\d+\+sha\d+\.[\da-f]+$/,
        );
      }
    }
  });

  it("declares the transparent command prefixes", () => {
    expect(DEFINITIONS.npm!.transparent.commands).toEqual([["npm", "init"], ["npx"]]);
    expect(DEFINITIONS.pnpm!.transparent.commands).toEqual([
      ["pnpm", "init"],
      ["pnpx"],
      ["pnpm", "dlx"],
    ]);
    expect(DEFINITIONS.yarn!.transparent.commands).toEqual([
      ["yarn", "init"],
      ["yarn", "dlx"],
    ]);
    expect(DEFINITIONS.bun!.transparent.commands).toEqual([
      ["bun", "init"],
      ["bun", "create"],
      ["bun", "x"],
      ["bunx"],
    ]);
    expect(DEFINITIONS.deno!.transparent.commands).toEqual([["deno", "init"]]);
    expect(DEFINITIONS.npm!.transparent.default).toBeUndefined();
    expect(DEFINITIONS.pnpm!.transparent.default).toBeUndefined();
  });

  it("keeps ranges as an ordered list of [range, spec] pairs", () => {
    expect(DEFINITIONS.pnpm!.ranges.map(([range]) => range)).toEqual([
      "<6.0.0",
      "6.x || 7.x || 8.x || 9.x || 10.x",
      ">=11.0.0",
    ]);
    expect(DEFINITIONS.yarn!.ranges.map(([range]) => range)).toEqual(["<2.0.0", ">=2.0.0"]);
    expect(DEFINITIONS.npm!.ranges.map(([range]) => range)).toEqual(["*"]);
  });

  it("resolves dist-tags against the last range entry's registry (§02.3)", () => {
    const [, lastYarn] = DEFINITIONS.yarn!.ranges.at(-1)!;
    expect(lastYarn.registry).toEqual({
      type: "url",
      url: "https://repo.yarnpkg.com/tags",
      fields: { tags: "aliases", versions: "tags" },
    });
    expect(DEFINITIONS.yarn!.fetchLatestFrom).toEqual({ type: "npm", package: "yarn" });
  });
});

describe("getSpecFor — reverse-order band lookup (§02.3)", () => {
  it("picks pnpm's .js band for 5.9.0", () => {
    const spec = getSpecFor("pnpm", "5.9.0");
    expect(spec.bin).toEqual({ pnpm: "./bin/pnpm.js", pnpx: "./bin/pnpx.js" });
    expect(spec.url).toBe("https://registry.npmjs.org/pnpm/-/pnpm-{}.tgz");
    expect(spec.registry).toEqual({ type: "npm", package: "pnpm" });
    expect(spec.commands).toEqual({ use: ["pnpm", "install"] });
  });

  it("picks pnpm's .cjs band for 9.1.0", () => {
    expect(getSpecFor("pnpm", "9.1.0").bin).toEqual({
      pnpm: "./bin/pnpm.cjs",
      pnpx: "./bin/pnpx.cjs",
    });
  });

  it("picks pnpm's .cjs band for the 10.5.0-rc.1 prerelease (§04.2)", () => {
    expect(getSpecFor("pnpm", "10.5.0-rc.1").bin).toEqual({
      pnpm: "./bin/pnpm.cjs",
      pnpx: "./bin/pnpx.cjs",
    });
  });

  it("picks pnpm's .mjs band for 11.1.2 — last declared wins", () => {
    expect(getSpecFor("pnpm", "11.1.2").bin).toEqual({
      pnpm: "./bin/pnpm.mjs",
      pnpx: "./bin/pnpx.mjs",
    });
  });

  it("gives yarn 1.22.22 the npm tarball with a BinSpec", () => {
    const spec = getSpecFor("yarn", "1.22.22");
    expect(spec.url).toBe("https://registry.yarnpkg.com/yarn/-/yarn-{}.tgz");
    expect(spec.bin).toEqual({ yarn: "./bin/yarn.js", yarnpkg: "./bin/yarn.js" });
    expect(spec.registry).toEqual({ type: "npm", package: "yarn" });
    expect(spec.npmRegistry).toBeUndefined();
  });

  it("gives yarn 4.14.1 the repo.yarnpkg.com single file with a BinList", () => {
    const spec = getSpecFor("yarn", "4.14.1");
    expect(spec.url).toBe("https://repo.yarnpkg.com/{}/packages/yarnpkg-cli/bin/yarn.js");
    expect(spec.bin).toEqual(["yarn", "yarnpkg"]);
    expect(Array.isArray(spec.bin)).toBe(true);
    expect(spec.npmRegistry).toEqual({
      type: "npm",
      package: "@yarnpkg/cli-dist",
      bin: "bin/yarn.js",
    });
  });

  it("matches npm's single `*` band for any version", () => {
    const spec = getSpecFor("npm", "11.14.1");
    expect(spec.url).toBe("https://registry.npmjs.org/npm/-/npm-{}.tgz");
    expect(spec.bin).toEqual({ npm: "./bin/npm-cli.js", npx: "./bin/npx-cli.js" });
  });

  it("rejects an unknown package manager with a usage error", () => {
    expect(() => getSpecFor("vlt", "1.0.0")).toThrow(/isn't supported by this jup build/);
  });
});

/**
 * §15.17 — a version outside every declared band.
 *
 * Every band the table ships today is open-ended at one end, so no real version
 * can escape them all; that is exactly why this path went unexercised, and why
 * these tests close a band on a *copy* of pnpm's range list rather than waiting
 * for the day a real one breaks.
 */
describe("getSpecFor / hasRangeBand — no matching band (§15.17)", () => {
  const original = DEFINITIONS.pnpm!.ranges;

  afterEach(() => {
    DEFINITIONS.pnpm!.ranges = original;
  });

  /** pnpm's table with its newest band closed, i.e. the table on the day 12 ships. */
  function closeTopBand(): void {
    DEFINITIONS.pnpm!.ranges = original.map(([range, spec]) =>
      range === ">=11.0.0" ? ([">=11.0.0 <12.0.0", spec] as const) : ([range, spec] as const),
    ) as typeof original;
  }

  it("reports honestly whether a declared band covers the version", () => {
    expect(hasRangeBand("pnpm", "11.1.2")).toBe(true);
    expect(hasRangeBand("pnpm", "5.9.0")).toBe(true);
    expect(hasRangeBand("vlt", "1.0.0")).toBe(false);

    closeTopBand();
    expect(hasRangeBand("pnpm", "12.0.0")).toBe(false);
    // …and the versions that *are* declared still are, so the answer is about
    // this version rather than about the edit.
    expect(hasRangeBand("pnpm", "11.1.2")).toBe(true);
  });

  it("falls forward to the newest band rather than throwing", () => {
    closeTopBand();

    // §04.1 already resolves dist-tags against the newest band, so its registry
    // and URL template are the right guess for a version beyond the table.
    const spec = getSpecFor("pnpm", "12.0.0");
    expect(spec.url).toBe("https://registry.npmjs.org/pnpm/-/pnpm-{}.tgz");
    expect(spec.registry).toEqual({ type: "npm", package: "pnpm" });
    // The `bin` is inherited too — and it is exactly the value `resolveBin`
    // must *not* use, which is what `hasRangeBand` is for.
    expect(spec.bin).toEqual({ pnpm: "./bin/pnpm.mjs", pnpx: "./bin/pnpx.mjs" });
  });
});

describe("binary names (§02.4)", () => {
  it("unions and dedupes bin names across every range entry", () => {
    expect(getBinariesFor("yarn")).toEqual(["yarn", "yarnpkg"]);
    expect(getBinariesFor("pnpm")).toEqual(["pnpm", "pnpx"]);
    expect(getBinariesFor("npm")).toEqual(["npm", "npx"]);
    expect(getBinariesFor("bun")).toEqual(["bun", "bunx"]);
    expect(getBinariesFor("deno")).toEqual(["deno"]);
    expect(getBinariesFor("vlt")).toEqual([]);
  });

  it("reverse-maps a binary name to its package manager", () => {
    expect(getPackageManagerFor("yarnpkg")).toBe("yarn");
    expect(getPackageManagerFor("yarn")).toBe("yarn");
    expect(getPackageManagerFor("pnpx")).toBe("pnpm");
    expect(getPackageManagerFor("npx")).toBe("npm");
    expect(getPackageManagerFor("bunx")).toBe("bun");
    expect(getPackageManagerFor("deno")).toBe("deno");
    expect(getPackageManagerFor("vlt")).toBeUndefined();
  });

  it("keeps every BinSpec path relative and inside the package", () => {
    for (const name of SUPPORTED_NAMES) {
      for (const [, spec] of getDefinition(name)!.ranges) {
        if (Array.isArray(spec.bin)) continue;
        for (const path of Object.values(spec.bin as BinSpec)) {
          expect(path.startsWith("./")).toBe(true);
          expect(path).not.toContain("..");
        }
      }
    }
  });
});

describe("trust store (§02.6, §14.4)", () => {
  it("is keyed by registry origin", () => {
    expect(Object.keys(TRUST_KEYS)).toEqual([DEFAULT_REGISTRY]);
    expect(DEFAULT_REGISTRY).toBe("https://registry.npmjs.org");
  });

  it("ships only unexpired keys", () => {
    const now = Date.now();
    const keys = Object.values(TRUST_KEYS).flat();
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key).toHaveProperty("expires");
      if (key.expires !== null) {
        expect(Date.parse(key.expires)).toBeGreaterThan(now);
      }
    }
  });

  it("drops the key that expired on 2025-01-29 (§14.4)", () => {
    const keyids = Object.values(TRUST_KEYS)
      .flat()
      .map((key) => key.keyid);
    expect(keyids).not.toContain("SHA256:jl3bwswu80PjjokCgh0o2w5c2U4LhQAE57gj9cz1kzA");
    expect(keyids).toContain("SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U");
  });

  it("carries base64 DER SubjectPublicKeyInfo P-256 keys", () => {
    for (const key of Object.values(TRUST_KEYS).flat()) {
      expect(key.keytype).toBe("ecdsa-sha2-nistp256");
      expect(key.scheme).toBe("ecdsa-sha2-nistp256");
      expect(key.key).not.toContain("BEGIN PUBLIC KEY");
      expect(key.key.startsWith("MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE")).toBe(true);
    }
  });

  it("returns the embedded keys for every registry, not just the default (§06.3)", () => {
    // §06.3 step 2 reads the embedded list unconditionally, and §06.6's threat
    // model depends on it: npm's signature travels with the package, so a
    // compromised *mirror* cannot forge it. Selecting keys by origin instead
    // returns nothing for a custom registry, which turns that defence into a
    // hard failure on exactly the deployments it exists for.
    //
    // Note that this assertion alone cannot establish §15.10 — the embedded
    // store holds one origin, so "keyed by origin" and "flattened" agree on
    // every line of it. The two-origin test below is the one that separates
    // them.
    const embedded = TRUST_KEYS[DEFAULT_REGISTRY]!;

    expect(getTrustedKeys()).toEqual(embedded);
    expect(getTrustedKeys("https://registry.npmjs.org/")).toEqual(embedded);
    expect(getTrustedKeys("https://npm.internal.example")).toEqual(embedded);
    expect(getTrustedKeys("https://artifactory.corp/api/npm/npm-remote/")).toEqual(embedded);
  });
});

/* -------------------------------------------------------------------------- */
/* §15.10 — per-origin trust                                                   */
/* -------------------------------------------------------------------------- */

describe("getTrustedKeys — §15.10 origin scoping", () => {
  const key = (keyid: string): TrustedKey => ({
    expires: null,
    keyid,
    keytype: "ecdsa-sha2-nistp256",
    scheme: "ecdsa-sha2-nistp256",
    key: "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE",
  });

  /**
   * Two custom origins and npm's, which is the smallest store that can tell
   * per-origin selection from a flattened one. That is the whole lesson: the
   * trust-store test that came before used the one shape — a single origin —
   * under which every implementation agrees.
   */
  const store: TrustStore = {
    [DEFAULT_REGISTRY]: [key("SHA256:npm")],
    "https://a.example": [key("SHA256:a")],
    "https://b.example": [key("SHA256:b")],
  };

  const keyids = (registry: string): string[] =>
    getTrustedKeys(registry, store).map((entry) => entry.keyid);

  it("offers an origin its own keys, and npm's, and nobody else's", () => {
    expect(keyids("https://a.example")).toEqual(["SHA256:a", "SHA256:npm"]);
    expect(keyids("https://b.example")).toEqual(["SHA256:b", "SHA256:npm"]);
    // §06.6 — npm's own registry is not vouched for by anyone's private keys.
    expect(keyids(DEFAULT_REGISTRY)).toEqual(["SHA256:npm"]);
    // An origin nobody configured falls back to npm's keys alone, which is what
    // keeps an unconfigured mirror verifying.
    expect(keyids("https://unknown.example")).toEqual(["SHA256:npm"]);
  });

  it("compares parsed origins, so a path or a trailing slash still selects", () => {
    expect(keyids("https://a.example/")).toEqual(["SHA256:a", "SHA256:npm"]);
    expect(keyids("https://a.example/api/npm/npm-remote")).toEqual(["SHA256:a", "SHA256:npm"]);
    expect(keyids("https://A.EXAMPLE")).toEqual(["SHA256:a", "SHA256:npm"]);
    // A different port is a different origin.
    expect(keyids("https://a.example:8443")).toEqual(["SHA256:npm"]);
  });

  it("keeps a keyid configured for both at its most specific position", () => {
    const shared: TrustStore = {
      [DEFAULT_REGISTRY]: [key("SHA256:shared"), key("SHA256:npm")],
      "https://a.example": [key("SHA256:shared")],
    };
    expect(getTrustedKeys("https://a.example", shared).map((entry) => entry.keyid)).toEqual([
      "SHA256:shared",
      "SHA256:npm",
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* §15.28 — `{platform}` / `{arch}` URL templates                              */
/* -------------------------------------------------------------------------- */

/**
 * `process.platform` and `process.arch` are read-only properties on a real
 * process, so the only way to reach the unsupported branches is to redefine them
 * — and reaching them is the point: on every machine the suite actually runs on,
 * both are supported and the error is dead code no row can touch.
 */
function pretendHost(platform: string, arch: string): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  Object.defineProperty(process, "arch", { value: arch, configurable: true });
}

const REAL_PLATFORM = process.platform;
const REAL_ARCH = process.arch;

describe("resolveSpecUrl — §15.28 per-platform URL templates", () => {
  afterEach(() => pretendHost(REAL_PLATFORM, REAL_ARCH));

  const locator = { name: "bunny", reference: "1.0.0" };
  const specFor = (url: string): PackageManagerSpec =>
    ({ url, bin: { bunny: "./bin/bunny" }, registry: { type: "npm", package: "bunny" } }) as const;

  it("substitutes every placeholder, including repeats", () => {
    pretendHost("darwin", "arm64");
    expect(
      resolveSpecUrl(
        specFor("https://example.com/{platform}/{arch}/bunny-{}-{platform}-{arch}.tgz"),
        locator,
        "1.0.0",
      ),
    ).toBe("https://example.com/darwin/arm64/bunny-1.0.0-darwin-arm64.tgz");
  });

  it("normalises the names a non-Node host would report", () => {
    pretendHost("linux", "aarch64");
    expect(resolveSpecUrl(specFor("https://e.com/{}-{arch}.tgz"), locator, "1.0.0")).toBe(
      "https://e.com/1.0.0-arm64.tgz",
    );
    pretendHost("linux", "amd64");
    expect(resolveSpecUrl(specFor("https://e.com/{}-{arch}.tgz"), locator, "1.0.0")).toBe(
      "https://e.com/1.0.0-x64.tgz",
    );
  });

  it("leaves a template without placeholders exactly as the table wrote it", () => {
    pretendHost("sunos", "s390x");
    // The unsupported host must not matter to a band that never asked: every
    // entry in the shipped table is in this case, and none of them may start
    // failing on an exotic platform because §15.28 exists.
    expect(
      resolveSpecUrl(specFor("https://registry.npmjs.org/pnpm/-/pnpm-{}.tgz"), locator, "9.0.0"),
    ).toBe("https://registry.npmjs.org/pnpm/-/pnpm-9.0.0.tgz");
  });

  it("names the unsupported platform rather than emitting a literal placeholder", () => {
    pretendHost("freebsd", "x64");
    const url = specFor("https://e.com/bunny-{}-{platform}-{arch}.tgz");

    expect(() => resolveSpecUrl(url, locator, "1.0.0")).toThrow(UsageError);
    expect(() => resolveSpecUrl(url, locator, "1.0.0")).toThrow(
      messages.unsupportedPlatform("bunny", "1.0.0", "freebsd"),
    );
  });

  it("names the unsupported architecture separately from the platform", () => {
    pretendHost("linux", "ppc64");
    const url = specFor("https://e.com/bunny-{}-{platform}-{arch}.tgz");

    // The platform half resolved fine; saying "unsupported platform linux" would
    // send the reader hunting for the wrong thing.
    expect(() => resolveSpecUrl(url, locator, "1.0.0")).toThrow(
      messages.unsupportedArch("bunny", "1.0.0", "ppc64"),
    );
  });
});

/* -------------------------------------------------------------------------- *
 * §15.28 / §15.21 — the native entries
 * -------------------------------------------------------------------------- */

describe("bun and deno — §15.28's per-host entries (§15.21, §02.5)", () => {
  afterEach(() => pretendHost(REAL_PLATFORM, REAL_ARCH));

  /**
   * §15.21's central claim, checked rather than asserted in prose: adding a
   * package manager is a **data-only** change. If it were not, some field below
   * would have needed a name-shaped special case somewhere in the tool, and the
   * generic accessors would not be able to answer for `bun` and `deno` the way
   * they answer for `pnpm`.
   */
  it("answers every generic table question, with no name-shaped special case", () => {
    for (const name of ["bun", "deno"]) {
      const definition = getDefinition(name)!;
      expect(isSupportedPackageManager(name)).toBe(true);
      expect(definition.ranges.length).toBeGreaterThan(0);
      for (const binName of getBinariesFor(name)) {
        expect(getPackageManagerFor(binName)).toBe(name);
      }
      // §04.1's dist-tag rule reads the last band's registry; for a native entry
      // that is the *launcher* package, which is where the tags live.
      expect(definition.ranges.at(-1)![1].registry).toEqual({ type: "npm", package: name });
      expect(definition.fetchLatestFrom).toEqual({ type: "npm", package: name });
    }
  });

  it("splits the version source from the artifact source (§15.28)", () => {
    const bun = getSpecFor("bun", "1.4.0");
    // Versions and dist-tags: the small launcher package.
    expect(bun.registry).toEqual({ type: "npm", package: "bun" });
    // Bytes and the signature over them: the per-host binary package. Pointing
    // both at `bun` is the mistake this field exists to prevent — the launcher
    // is a 15 kB `postinstall` stub, and jup runs no lifecycle scripts.
    expect(bun.artifactRegistry).toEqual({ type: "npm", package: "@oven/bun-{target}" });
    expect(getSpecFor("deno", "2.9.5").artifactRegistry).toEqual({
      type: "npm",
      package: "@deno/{target}",
    });
  });

  it("bands bun by the host set each version actually shipped", () => {
    expect(DEFINITIONS.bun!.ranges.map(([range]) => range)).toEqual([
      "*",
      ">=1.1.0",
      ">=1.1.39",
      ">=1.3.10",
    ]);

    // Reversed, first match wins (§02.3): Windows arrived in 1.1.0, Alpine in
    // 1.1.39 and Windows on arm64 in 1.3.10, so an older version must not claim
    // any of them.
    expect(Object.keys(getSpecFor("bun", "1.0.0").targets!)).not.toContain("win32-x64");
    expect(Object.keys(getSpecFor("bun", "1.2.0").targets!)).toContain("win32-x64");
    expect(Object.keys(getSpecFor("bun", "1.2.0").targets!)).not.toContain("win32-arm64");
    expect(Object.keys(getSpecFor("bun", "1.4.0").targets!)).toContain("win32-arm64");
    expect(Object.keys(getSpecFor("bun", "1.1.38").targets!)).not.toContain("linux-x64-musl");
    expect(Object.keys(getSpecFor("bun", "1.1.39").targets!)).toContain("linux-x64-musl");
    expect(Object.keys(getSpecFor("bun", "1.4.0").targets!)).toContain("linux-arm64-musl");
  });

  it("resolves `{target}` to the published artifact name for each host", () => {
    const cases: Array<[string, string, string, string]> = [
      ["linux", "x64", "@oven/bun-linux-x64", "@deno/linux-x64-glibc"],
      ["linux", "arm64", "@oven/bun-linux-aarch64", "@deno/linux-arm64-glibc"],
      ["darwin", "arm64", "@oven/bun-darwin-aarch64", "@deno/darwin-arm64"],
      ["win32", "x64", "@oven/bun-windows-x64", "@deno/win32-x64"],
    ];

    for (const [platform, arch, bunPackage, denoPackage] of cases) {
      pretendHost(platform, arch);
      // The two vendors spell the same host three different ways — bun renames
      // both halves, deno suffixes only Linux — which is why this is a table and
      // not a pair of alias maps.
      expect(getSpecUrl({ name: "bun", reference: "1.4.0" })).toBe(
        `https://registry.npmjs.org/${bunPackage}/-/${bunPackage.slice("@oven/".length)}-1.4.0.tgz`,
      );
      expect(getSpecUrl({ name: "deno", reference: "2.9.5" })).toBe(
        `https://registry.npmjs.org/${denoPackage}/-/${denoPackage.slice("@deno/".length)}-2.9.5.tgz`,
      );
    }
  });

  it("names the host when the version ships no artifact for it", () => {
    pretendHost("win32", "arm64");
    const locator = { name: "bun", reference: "1.2.0" };

    // Not a 404, and not a URL still carrying `{target}`: bun 1.2.0 genuinely
    // has no Windows arm64 build, and bumping the version is the fix.
    expect(() => getSpecUrl(locator)).toThrow(UsageError);
    expect(() => getSpecUrl(locator)).toThrow(
      messages.unsupportedTarget("bun", "1.2.0", "win32-arm64", [
        "darwin-arm64",
        "darwin-x64",
        "linux-arm64",
        "linux-arm64-musl",
        "linux-x64",
        "linux-x64-musl",
        "win32-x64",
      ]),
    );
  });

  it("substitutes `{exe}` in bin paths, and only on Windows", () => {
    // The platform packages declare no `bin` of their own, so §07.7 has nothing
    // to read and the table is the authority — which makes this the one place
    // the `.exe` can come from.
    pretendHost("linux", "x64");
    expect(resolveSpecBin(getSpecFor("bun", "1.4.0"))).toEqual({
      bun: "./bin/bun",
      bunx: "./bin/bun",
    });
    expect(resolveSpecBin(getSpecFor("deno", "2.9.5"))).toEqual({ deno: "./deno" });
  });

  it("makes `bun` and `bunx` one file, which is what argv[0] dispatch needs", () => {
    const bin = resolveSpecBin(getSpecFor("bun", "1.4.0")) as BinSpec;
    expect(bin.bun).toBe(bin.bunx);
    expect(getBinariesFor("bun")).toEqual(["bun", "bunx"]);
  });

  it("keeps the resolved artifact registry's identity, so §15.2 still finds it", () => {
    pretendHost("linux", "x64");
    const spec = getSpecFor("bun", "1.4.0");
    const locator = { name: "bun", reference: "1.4.0" };

    const first = resolveArtifactRegistry(spec, locator)!;
    expect(first).toEqual({ type: "npm", package: "@oven/bun-linux-x64" });
    // Identity, not equality: `packageManagerForRegistry` is a `Map` lookup on
    // the object, so a freshly minted one per call would silently drop
    // `JUP_REGISTRY_BUN` on exactly the entries that need it.
    expect(resolveArtifactRegistry(spec, locator)).toBe(first);
    expect(packageManagerForRegistry(first)).toBe("bun");
  });

  it("classifies which entries have a per-host artifact", () => {
    expect(isPerHost({ name: "bun", reference: "1.4.0" })).toBe(true);
    expect(isPerHost({ name: "deno", reference: "2.9.5" })).toBe(true);
    expect(isPerHost({ name: "pnpm", reference: "11.1.2" })).toBe(false);
    expect(isPerHost({ name: "yarn", reference: "4.14.1" })).toBe(false);
    // A URL reference belongs to no band, so there is nothing host-dependent
    // about it whatever it points at.
    expect(isPerHost({ name: "yarn", reference: "https://example.com/yarn.js" })).toBe(false);
  });

  it("normalises the host pair the same way `{platform}` and `{arch}` do", () => {
    pretendHost("linux", "aarch64");
    expect(hostTarget()).toBe("linux-arm64");
    pretendHost("win32", "amd64");
    expect(hostTarget()).toBe("win32-x64");
  });

  it("keeps the native entries out of a bare `enable` (§10.5)", () => {
    expect(shimsByDefault("npm")).toBe(true);
    expect(shimsByDefault("pnpm")).toBe(true);
    expect(shimsByDefault("yarn")).toBe(true);
    expect(shimsByDefault("bun")).toBe(false);
    expect(shimsByDefault("deno")).toBe(false);
  });

  it("runs the artifact directly, with no JavaScript runtime lookup (§08.3.1)", () => {
    expect(getSpecFor("bun", "1.4.0").exec).toBe("native");
    expect(getSpecFor("deno", "2.9.5").exec).toBe("native");
    expect(getSpecFor("pnpm", "11.1.2").exec).toBeUndefined();
  });

  it("declares what `use` runs afterwards", () => {
    expect(getSpecFor("bun", "1.4.0").commands).toEqual({ use: ["bun", "install"] });
    expect(getSpecFor("deno", "2.9.5").commands).toEqual({ use: ["deno", "install"] });
  });
});

/* -------------------------------------------------------------------------- */
/* §15.21 — aube                                                              */
/* -------------------------------------------------------------------------- */

/**
 * aube is the third per-host entry, and it is here to hold two things the first
 * two could not say.
 *
 * The first is that `targets` is a **declaration**, not a spelling table: aube's
 * published names are `hostTarget()` verbatim, so the map is an identity and
 * still load-bearing, because aube publishes no `darwin-x64` at all. An Intel
 * Mac must be told that before any request rather than after a 404.
 *
 * The second is that `shimByDefault` is about runtimes, not about newness. bun
 * and deno opt out because their names belong to a runtime a user installed on
 * purpose; `aube`, `aubr` and `aubx` mean nothing outside a project, so they
 * join npm, pnpm and yarn in the set a bare `jup enable` claims.
 */
describe("aube — §15.21's third per-host entry", () => {
  afterEach(() => pretendHost(REAL_PLATFORM, REAL_ARCH));

  it("splits the launcher from the artifact, like bun and deno", () => {
    const spec = getSpecFor("aube", "2.2.0");
    // `@endevco/aube` is a ~12 kB `preinstall` stub; the binaries are elsewhere.
    expect(spec.registry).toEqual({ type: "npm", package: "@endevco/aube" });
    expect(spec.artifactRegistry).toEqual({ type: "npm", package: "@endevco/aube-{target}" });
    expect(DEFINITIONS.aube!.fetchLatestFrom).toEqual({ type: "npm", package: "@endevco/aube" });
    expect(spec.exec).toBe("native");
    expect(spec.commands).toEqual({ use: ["aube", "install"] });
    expect(isPerHost({ name: "aube", reference: "2.2.0" })).toBe(true);
  });

  it("carries a bare default, because one version is many artifacts", () => {
    expect(DEFINITIONS.aube!.default).toBe("2.2.0");
  });

  it("gives all three names one file, for argv[0] dispatch", () => {
    pretendHost("linux", "x64");
    const bin = resolveSpecBin(getSpecFor("aube", "2.2.0")) as BinSpec;
    // Unlike bun's two, these are three *different* paths in the tarball — the
    // publisher hardlinks one executable to three names — so the dispatch is
    // aube's own, and the table only has to name them.
    expect(bin).toEqual({ aube: "./bin/aube", aubr: "./bin/aubr", aubx: "./bin/aubx" });
    expect(getBinariesFor("aube")).toEqual(["aube", "aubr", "aubx"]);
    for (const name of ["aube", "aubr", "aubx"]) {
      expect(getPackageManagerFor(name)).toBe("aube");
    }

    pretendHost("win32", "x64");
    expect(resolveSpecBin(getSpecFor("aube", "2.2.0"))).toEqual({
      aube: "./bin/aube",
      aubr: "./bin/aubr",
      aubx: "./bin/aubx",
    });
  });

  it("resolves `{target}` straight through, because the names already match", () => {
    pretendHost("linux", "x64");
    expect(getSpecUrl({ name: "aube", reference: "2.2.0" })).toBe(
      "https://registry.npmjs.org/@endevco/aube-linux-x64/-/aube-linux-x64-2.2.0.tgz",
    );
    expect(
      resolveArtifactRegistry(getSpecFor("aube", "2.2.0"), {
        name: "aube",
        reference: "2.2.0",
      }),
    ).toEqual({ type: "npm", package: "@endevco/aube-linux-x64" });
  });

  it("says so when a perfectly ordinary host has no build at all", () => {
    pretendHost("darwin", "x64");
    // The whole reason an identity map is still written out: `@endevco/aube-darwin-x64`
    // has never been published, and a 404 would read as a registry problem.
    expect(() => getSpecUrl({ name: "aube", reference: "2.2.0" })).toThrow(
      messages.unsupportedTarget("aube", "2.2.0", "darwin-x64", [
        "darwin-arm64",
        "linux-arm64",
        "linux-arm64-musl",
        "linux-x64",
        "linux-x64-musl",
        "win32-arm64",
        "win32-x64",
      ]),
    );
  });

  it("declares one band, because its one host change is unexpressible", () => {
    // aube gained its musl artifacts in `1.0.0-beta.12`, and §02.3's band lookup
    // strips prereleases from both sides — so `>=1.0.0-beta.12` would also admit
    // `1.0.0-beta.2` and promise an artifact that does not exist. bun's bands
    // work because its boundaries (1.1.0, 1.1.39, 1.3.10) are releases.
    expect(DEFINITIONS.aube!.ranges.map(([range]) => range)).toEqual(["*"]);
    expect(Object.keys(getSpecFor("aube", "2.2.0").targets!)).toContain("linux-arm64-musl");
    expect(satisfiesWithPrereleases("1.0.0-beta.2", ">=1.0.0-beta.12")).toBe(true);
  });

  it("joins the default shim set, unlike the two runtimes", () => {
    expect(shimsByDefault("aube")).toBe(true);
    expect(shimsByDefault("bun")).toBe(false);
    expect(shimsByDefault("deno")).toBe(false);
  });

  it("exempts only the commands that do not act on a project (§03.5)", () => {
    expect(DEFINITIONS.aube!.transparent.commands).toEqual([
      ["aube", "init"],
      ["aube", "create"],
      ["aube", "dlx"],
      ["aubx"],
    ]);
    // `aubr` is `aube run` and `aube exec` runs a locally installed binary: both
    // need the project, so neither is exempt.
    expect(DEFINITIONS.aube!.transparent.commands).not.toContainEqual(["aubr"]);
    expect(DEFINITIONS.aube!.transparent.default).toBeUndefined();
  });
});
