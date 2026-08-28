/**
 * §15.28 — the libc half of the host name.
 *
 * Linux is the one platform where `<platform>-<arch>` does not name a binary
 * interface: a glibc build will not start on Alpine. Publishers that ship both
 * say so in the artifact name (`@endevco/aube-linux-x64-musl`,
 * `@oven/bun-linux-x64-musl`), so `hostTarget()` has to be able to ask for it —
 * otherwise the tool downloads a glibc artifact on a musl host, verifies its
 * signature, caches it, and hands the user a loader error about a `.so` they
 * never asked about.
 *
 * This lives in its own file because the probe is two `existsSync` calls, and
 * mocking `node:fs` for the rest of `config.test.ts` would also mock the trust
 * store's reads.
 *
 * The answer is memoised per architecture, so each architecture below is used
 * exactly once and the `LOADERS` set is arranged before the first call that
 * would consult it.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/** Absolute loader paths the fake filesystem contains. */
const LOADERS = new Set<string>();

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: (path: unknown) =>
      typeof path === "string" && path.startsWith("/lib")
        ? LOADERS.has(path)
        : actual.existsSync(path as string),
  };
});

const { getTableSpec, hostTarget, resolveSpecUrl } = await import("../../src/config/table.ts");
const { parse } = await import("../../src/version/semver.ts");

/** As in `config.test.ts`: the locator-level spelling of `resolveSpecUrl`. */
function getSpecUrl(locator: { name: string; reference: string }): string {
  const spec = getTableSpec(locator);
  if (spec === undefined) return locator.reference;
  return resolveSpecUrl(spec, locator, parse(locator.reference)!.version);
}

const REAL_PLATFORM = process.platform;
const REAL_ARCH = process.arch;

function pretendHost(platform: string, arch: string): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  Object.defineProperty(process, "arch", { value: arch, configurable: true });
}

beforeAll(() => {
  // x64 is the musl case and arm64 the glibc one; each is probed once and the
  // answer cached, so both sets are in place before any of it runs.
  LOADERS.add("/lib/ld-musl-x86_64.so.1");
  LOADERS.add("/lib/ld-musl-aarch64.so.1");
  // …and arm64 additionally has the glibc loader, which is what a distribution
  // with the `musl` package merely *installed* looks like.
  LOADERS.add("/lib/ld-linux-aarch64.so.1");
});

afterEach(() => pretendHost(REAL_PLATFORM, REAL_ARCH));

describe("hostTarget — §15.28's libc suffix", () => {
  it("names a musl host, so its own artifact can be asked for", () => {
    pretendHost("linux", "x64");
    expect(hostTarget()).toBe("linux-x64-musl");
  });

  it("reaches the musl artifact through the same `targets` map", () => {
    pretendHost("linux", "x64");
    expect(getSpecUrl({ name: "aube", reference: "2.2.0" })).toBe(
      "https://registry.npmjs.org/@endevco/aube-linux-x64-musl/-/aube-linux-x64-musl-2.2.0.tgz",
    );
    // bun renames the arch half and keeps the suffix; the map is what reconciles
    // the two spellings of one host.
    expect(getSpecUrl({ name: "bun", reference: "1.4.0" })).toBe(
      "https://registry.npmjs.org/@oven/bun-linux-x64-musl/-/bun-linux-x64-musl-1.4.0.tgz",
    );
  });

  it("tells a musl host that deno has no build for it, rather than shipping a glibc one", () => {
    pretendHost("linux", "x64");
    // Deno publishes `@deno/linux-x64-glibc` and nothing else for Linux. Before
    // the suffix existed this host was handed that package and failed at exec.
    expect(() => getSpecUrl({ name: "deno", reference: "2.9.5" })).toThrow(
      /publishes no artifact for linux-x64-musl/,
    );
  });

  it("treats a host that has both loaders as glibc", () => {
    // A glibc distribution with `musl` installed as a package has the musl
    // loader on disk and is still a glibc host; Alpine has no glibc loader at
    // all. Checking only for musl's presence would misread the first as the
    // second, so the absence of glibc's is what decides.
    pretendHost("linux", "arm64");
    expect(hostTarget()).toBe("linux-arm64");
  });

  it("does not probe at all off Linux", () => {
    // macOS and Windows have one C library each, and neither publisher spells a
    // suffix there. `/lib/ld-musl-*` on a Mac would be somebody else's file.
    pretendHost("darwin", "arm64");
    expect(hostTarget()).toBe("darwin-arm64");
    pretendHost("win32", "x64");
    expect(hostTarget()).toBe("win32-x64");
  });
});
