import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_REGISTRY, getTrustedKeys, TRUST_KEYS } from "../../src/config/keys.ts";
import {
  DEFINITIONS,
  getBinariesFor,
  getDefinition,
  getPackageManagerFor,
  getSpecFor,
  isSupportedPackageManager,
  resolveSpecUrl,
  SUPPORTED_NAMES,
} from "../../src/config/table.ts";
import { messages, UsageError } from "../../src/errors.ts";
import type { BinSpec, PackageManagerSpec } from "../../src/types.ts";

describe("registry table — shape (§02.5)", () => {
  it("supports exactly npm, pnpm and yarn", () => {
    expect([...SUPPORTED_NAMES]).toEqual(["npm", "pnpm", "yarn"]);
    expect(isSupportedPackageManager("yarn")).toBe(true);
    expect(isSupportedPackageManager("bun")).toBe(false);
    expect(getDefinition("bun")).toBeUndefined();
  });

  it("pins hash-suffixed defaults", () => {
    expect(DEFINITIONS.npm!.default).toBe("11.14.1+sha1.4a6839650da0005f323fec6abd39d77ee24f842f");
    expect(DEFINITIONS.pnpm!.default).toBe("11.1.2+sha1.ed39d701687311ce9345771c62376f9fe7286694");
  });

  it("keeps yarn's default at 1.x while transparent.default is 4.x (§14.21)", () => {
    const yarn = DEFINITIONS.yarn!;
    expect(yarn.default).toBe("1.22.22+sha1.ac34549e6aa8e7ead463a7407e1c7390f61a6610");
    expect(yarn.transparent.default).toBe(
      "4.14.1+sha224.88b7a7244bbd9040380c417f7eb556d85c67640b651f113cb4c72113",
    );
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
    expect(() => getSpecFor("bun", "1.0.0")).toThrow(/isn't supported by this corepack build/);
  });
});

describe("binary names (§02.4)", () => {
  it("unions and dedupes bin names across every range entry", () => {
    expect(getBinariesFor("yarn")).toEqual(["yarn", "yarnpkg"]);
    expect(getBinariesFor("pnpm")).toEqual(["pnpm", "pnpx"]);
    expect(getBinariesFor("npm")).toEqual(["npm", "npx"]);
    expect(getBinariesFor("bun")).toEqual([]);
  });

  it("reverse-maps a binary name to its package manager", () => {
    expect(getPackageManagerFor("yarnpkg")).toBe("yarn");
    expect(getPackageManagerFor("yarn")).toBe("yarn");
    expect(getPackageManagerFor("pnpx")).toBe("pnpm");
    expect(getPackageManagerFor("npx")).toBe("npm");
    expect(getPackageManagerFor("bunx")).toBeUndefined();
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
    // The store stays keyed by origin as the §15.10 seam — but §15.10 pairs
    // per-origin trust with a soft-fail for unknown origins, and the two arrive
    // together or not at all.
    const embedded = TRUST_KEYS[DEFAULT_REGISTRY]!;

    expect(getTrustedKeys()).toEqual(embedded);
    expect(getTrustedKeys("https://registry.npmjs.org/")).toEqual(embedded);
    expect(getTrustedKeys("https://npm.internal.example")).toEqual(embedded);
    expect(getTrustedKeys("https://artifactory.corp/api/npm/npm-remote/")).toEqual(embedded);
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
