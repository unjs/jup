/**
 * rows 156–157 — proxying, implemented rather than delegated (§05.1).
 *
 * Corepack carried an HTTP-client dependency *solely* for proxy support, dropped
 * it in 0.35.0, and now relies on a host feature gated behind
 * `NODE_USE_ENV_PROXY=1`. The result, reported as #447 and #458, is that setting
 * `HTTPS_PROXY` — the variable every other tool on the machine honours — does
 * nothing at all. These rows pin the opposite: the standard variables work on
 * their own, and `NO_PROXY` is honoured with them.
 *
 * §13.7's rows 71 and 72 cover the tunnel itself; these two cover the
 * environment contract around it.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupFixtures,
  createFixture,
  MockRegistry,
  packageManagerTarball,
  run,
} from "./_harness/index.ts";
import { startProxy } from "./_harness/proxy.ts";

const registry = new MockRegistry();

function trusted(extra?: Record<string, string | undefined>): Record<string, string | undefined> {
  return { COREPACK_INTEGRITY_KEYS: registry.trustStore(), ...extra };
}

beforeAll(async () => {
  await registry.start();
  registry.publish("pnpm", "6.6.2", packageManagerTarball("pnpm", "6.6.2"));
});

afterAll(async () => {
  cleanupFixtures();
  await registry.stop();
});

beforeEach(() => registry.reset());

describe("§05.1 proxying", () => {
  it("156: HTTPS_PROXY alone proxies the request — no second opt-in flag", async () => {
    const proxy = await startProxy(() => registry.origin);
    const fixture = createFixture({ packageManager: "pnpm@6.6.2" });

    try {
      // An https registry and nothing else: no NODE_USE_ENV_PROXY, no
      // HTTP_PROXY, no ALL_PROXY. `example.com` resolves nowhere the child can
      // reach, so a successful install *is* the proof that the tunnel was used.
      const result = await run(["pnpm", "--version"], {
        ...fixture,
        env: trusted({
          COREPACK_NPM_REGISTRY: "https://example.com",
          HTTPS_PROXY: proxy.origin,
          NODE_EXTRA_CA_CERTS: proxy.caFile,
        }),
      });

      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("6.6.2\n");

      // Every request went through a CONNECT tunnel: metadata and artifact alike.
      expect(proxy.connects).toEqual(["example.com:443", "example.com:443"]);
      expect(proxy.absoluteForm).toEqual([]);
      expect(registry.requests.map((request) => request.original)).toEqual([
        "https://example.com/pnpm/6.6.2",
        "https://example.com/pnpm/-/pnpm-6.6.2.tgz",
      ]);
    } finally {
      await proxy.stop();
    }
  });

  it("157: NO_PROXY with a matching host bypasses the proxy", async () => {
    const proxy = await startProxy(() => registry.origin);
    const bypassed = createFixture({ packageManager: "pnpm@6.6.2" });

    try {
      // `.internal` matches `registry.internal`, so the request must be made
      // directly — and directly, that name resolves nowhere.
      const direct = await run(["pnpm", "--version"], {
        ...bypassed,
        env: trusted({
          COREPACK_NPM_REGISTRY: "http://registry.internal",
          HTTP_PROXY: proxy.origin,
          HTTPS_PROXY: proxy.origin,
          NO_PROXY: ".internal",
        }),
      });

      expect(direct.exitCode).toBe(1);
      expect(direct.stderr).toContain(
        "Error when performing the request to http://registry.internal/pnpm/6.6.2",
      );
      // The point of the row: the proxy was never asked.
      expect(proxy.absoluteForm).toEqual([]);
      expect(proxy.connects).toEqual([]);

      // The control: the same host *without* the bypass does go through it, so
      // the assertion above is about `NO_PROXY` and not about a broken fixture.
      const proxied = createFixture({ packageManager: "pnpm@6.6.2" });
      const result = await run(["pnpm", "--version"], {
        ...proxied,
        env: trusted({
          COREPACK_NPM_REGISTRY: "http://registry.internal",
          HTTP_PROXY: proxy.origin,
          HTTPS_PROXY: proxy.origin,
          NO_PROXY: ".example,other.internal",
        }),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("6.6.2\n");
      expect(proxy.absoluteForm).toContain("http://registry.internal/pnpm/6.6.2");
    } finally {
      await proxy.stop();
    }
  });
});
