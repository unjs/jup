/**
 * §13.7 — registry, auth and integrity (rows 63–85).
 *
 * The mock signs everything it serves with a real ECDSA P-256 key, so these rows
 * exercise the verification pipeline end to end rather than a stub of it. The
 * `invalid_integrity` mode is the load-bearing one: the metadata is *validly
 * signed* but describes bytes other than the ones served, which is the only way
 * to tell a signature failure from a digest failure apart.
 */

import { Buffer } from "node:buffer";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TRUST_KEYS } from "../../src/config/keys.ts";
import {
  cleanupFixtures,
  createFixture,
  makeTarball,
  MockRegistry,
  packageManagerTarball,
  run,
  type RunResult,
  withoutDownloadNotices,
} from "./_harness/index.ts";
import { startProxy, type ProxyFixture } from "./_harness/proxy.ts";

const registry = new MockRegistry();

const NPM_ACCEPT = "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8";

function trusted(extra?: Record<string, string | undefined>): Record<string, string | undefined> {
  return { COREPACK_INTEGRITY_KEYS: registry.trustStore(), ...extra };
}

/** Point everything at the mock as if it were the configured npm registry. */
function mirror(extra?: Record<string, string | undefined>): Record<string, string | undefined> {
  return { COREPACK_NPM_REGISTRY: registry.origin, ...trusted(extra) };
}

beforeAll(async () => {
  await registry.start();

  registry.publish("pnpm", "6.6.2", packageManagerTarball("pnpm", "6.6.2"), {
    distTags: { latest: "6.6.2" },
  });

  // §07.4's safety rules, served as real artifacts: a traversal, an absolute
  // path, and a gzip bomb. All three are correctly signed — the point is that a
  // valid signature buys an archive nothing at extraction time.
  registry.publish(
    "pnpm",
    "5.0.1",
    makeTarball([
      { path: "package/package.json", content: `{"name":"pnpm","version":"5.0.1"}` },
      { path: "package/../../evil.js", content: "throw new Error('pwned')" },
    ]),
  );
  registry.publish(
    "pnpm",
    "5.0.2",
    makeTarball([
      { path: "package/package.json", content: `{"name":"pnpm","version":"5.0.2"}` },
      { path: "/etc/evil.js", content: "throw new Error('pwned')" },
    ]),
  );
  registry.publish(
    "pnpm",
    "5.0.3",
    makeTarball([
      { path: "package/package.json", content: `{"name":"pnpm","version":"5.0.3"}` },
      { path: "package/bomb.bin", content: Buffer.alloc(24 * 1024 * 1024) },
    ]),
  );

  registry.publish("yarn", "1.22.4", packageManagerTarball("yarn", "1.22.4"));
});

afterAll(async () => {
  cleanupFixtures();
  await registry.stop();
});

beforeEach(() => registry.reset());

describe("§13.7 registry, auth and integrity", () => {
  it("63: metadata is fetched from <default registry>/<pkg> with the abbreviated Accept header", async () => {
    const fixture = createFixture();

    const result = await run(["install", "-g", "pnpm@6.x"], {
      ...fixture,
      registry,
      env: trusted(),
    });

    expect(result.exitCode).toBe(0);
    const metadata = registry.requests.find((request) => request.path === "/pnpm");
    expect(metadata?.original).toBe("https://registry.npmjs.org/pnpm");
    expect(metadata?.accept).toBe(NPM_ACCEPT);
  });

  it("64: a trailing slash on COREPACK_NPM_REGISTRY never doubles in the URL", async () => {
    const fixture = createFixture();

    const result = await run(["install", "-g", "pnpm@6.6.2"], {
      ...fixture,
      env: mirror({ COREPACK_NPM_REGISTRY: `${registry.origin}///` }),
    });

    expect(result.exitCode).toBe(0);
    expect(registry.requests.length).toBeGreaterThan(0);
    for (const request of registry.requests) expect(request.path.startsWith("//")).toBe(false);
    expect(registry.requests.map((request) => request.path)).toContain("/pnpm/6.6.2");
  });

  it("65: COREPACK_NPM_TOKEN becomes a Bearer header", async () => {
    const fixture = createFixture();

    const result = await run(["install", "-g", "pnpm@6.6.2"], {
      ...fixture,
      env: mirror({ COREPACK_NPM_TOKEN: "foo" }),
    });

    expect(result.exitCode).toBe(0);
    expect(registry.requests.map((request) => request.authorization)).toContain("Bearer foo");
    expect(registry.requests.every((request) => request.authorization === "Bearer foo")).toBe(true);
  });

  it("66: a token wins over username/password, and nothing else is sent", async () => {
    const fixture = createFixture();

    const result = await run(["install", "-g", "pnpm@6.6.2"], {
      ...fixture,
      env: mirror({
        COREPACK_NPM_TOKEN: "foo",
        COREPACK_NPM_USERNAME: "user",
        COREPACK_NPM_PASSWORD: "pass",
      }),
    });

    expect(result.exitCode).toBe(0);
    expect(registry.requests.length).toBeGreaterThan(0);
    for (const request of registry.requests) expect(request.authorization).toBe("Bearer foo");
  });

  it("67: username and password become a Basic header", async () => {
    const fixture = createFixture();
    const expected = `Basic ${Buffer.from("user:pass").toString("base64")}`;

    const result = await run(["install", "-g", "pnpm@6.6.2"], {
      ...fixture,
      env: mirror({ COREPACK_NPM_USERNAME: "user", COREPACK_NPM_PASSWORD: "pass" }),
    });

    expect(result.exitCode).toBe(0);
    expect(registry.requests.length).toBeGreaterThan(0);
    for (const request of registry.requests) expect(request.authorization).toBe(expected);
  });

  it("68: a username with no password sends no authorization at all", async () => {
    const fixture = createFixture();

    const result = await run(["install", "-g", "pnpm@6.6.2"], {
      ...fixture,
      env: mirror({ COREPACK_NPM_USERNAME: "user" }),
    });

    expect(result.exitCode).toBe(0);
    expect(registry.requests.length).toBeGreaterThan(0);
    for (const request of registry.requests) expect(request.authorization).toBeUndefined();
  });

  it("69: userinfo in the registry URL becomes Basic and never reaches the request line", async () => {
    const fixture = createFixture();
    const origin = registry.origin.replace("http://", "http://user:pass@");
    const expected = `Basic ${Buffer.from("user:pass").toString("base64")}`;

    const result = await run(["install", "-g", "pnpm@6.6.2"], {
      ...fixture,
      env: mirror({ COREPACK_NPM_REGISTRY: origin }),
    });

    expect(result.exitCode).toBe(0);
    const metadata = registry.requests.filter((request) => request.path === "/pnpm/6.6.2");
    expect(metadata.length).toBeGreaterThan(0);
    for (const request of metadata) {
      expect(request.authorization).toBe(expected);
      // Userinfo is stripped from the URL before the request is made, so it can
      // reach neither the request line nor a redirect target.
      //
      // NOTE: the *artifact* request that follows carries no credentials at all,
      // because `dist.tarball` has no userinfo of its own — see the report on
      // this suite; the row itself only covers the metadata request.
      expect(request.path).not.toContain("@");
      expect(request.path).not.toContain("pass");
    }
  });

  /**
   * Rows 71 and 72 — the environment a user behind a corporate proxy actually
   * has: one proxy for both schemes, a registry that only resolves on its far
   * side, and a `dist.tarball` served over TLS. The run has to come out the
   * other end with the package manager installed, which means the metadata went
   * absolute-form through `HTTP_PROXY` and the artifact went through a `CONNECT`
   * tunnel whose certificate was verified.
   *
   * Neither row is allowed to reach `example.com`: nothing but the proxy knows
   * where the registry lives.
   */
  async function proxiedInstall(
    extra?: Record<string, string | undefined>,
  ): Promise<{ result: RunResult; proxy: ProxyFixture }> {
    const proxy = await startProxy(() => registry.origin);
    // The artifact is advertised over TLS on the same host, so one run exercises
    // both proxy request shapes (§05.1).
    registry.tarballOrigin = "https://example.com";
    const fixture = createFixture({ packageManager: "pnpm@6.6.2" });

    try {
      const result = await run(["pnpm", "--version"], {
        ...fixture,
        env: trusted({
          COREPACK_NPM_REGISTRY: "http://example.com",
          HTTP_PROXY: proxy.origin,
          HTTPS_PROXY: proxy.origin,
          NODE_EXTRA_CA_CERTS: proxy.caFile,
          ...extra,
        }),
      });
      return { result, proxy };
    } finally {
      await proxy.stop();
    }
  }

  it("71: HTTP_PROXY plus a CONNECT proxy tunnels the request", async () => {
    const { result, proxy } = await proxiedInstall({ NODE_USE_ENV_PROXY: "1" });

    expect(withoutDownloadNotices(result.stderr)).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("6.6.2\n");

    // The metadata request line named the whole URL — that is the forward-proxy
    // protocol, and it is the only reason a registry on `example.com` resolved.
    expect(proxy.absoluteForm).toContain("http://example.com/pnpm/6.6.2");
    // The artifact went through a tunnel, opened to the target's own authority.
    expect(proxy.connects).toEqual(["example.com:443"]);

    // The mock saw both, and saw them as the URLs the tool asked for.
    const originals = registry.requests.map((request) => request.original);
    expect(originals).toContain("http://example.com/pnpm/6.6.2");
    expect(originals).toContain("https://example.com/pnpm/-/pnpm-6.6.2.tgz");
  });

  it("72: the same without NODE_USE_ENV_PROXY still tunnels (§05.1)", async () => {
    // Corepack needs this second flag before `HTTP_PROXY` does anything at all,
    // which is the whole of #447 and #458. Here its absence changes nothing.
    expect(process.env.NODE_USE_ENV_PROXY).toBeUndefined();

    const { result, proxy } = await proxiedInstall({ NODE_USE_ENV_PROXY: undefined });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("6.6.2\n");
    expect(proxy.absoluteForm).toContain("http://example.com/pnpm/6.6.2");
    expect(proxy.connects).toEqual(["example.com:443"]);
  });

  it("73: a signature from an untrusted key is refused", async () => {
    registry.mode = "untrusted_key";
    const untrusted = createFixture({ packageManager: "pnpm@6.6.2" });

    const result = await run(["pnpm", "--version"], { ...untrusted, registry, env: trusted() });

    expect(result.exitCode).toBe(1);
    // §06.3 step 4: an unmatched keyid is "not signed by any trusted keys". The
    // row's `No compatible signature found in package metadata` is step 1's
    // message, which an *absent* signature list used to produce here too —
    // §06.1 makes that case a soft-fail instead, so row 160 asserts the step-1
    // message on the path that still refuses (JUP_REQUIRE_SIGNATURES).
    expect(result.stderr).toContain("The package was not signed by any trusted keys");

    registry.mode = "no_signatures";
    const unsigned = createFixture({ packageManager: "pnpm@6.6.2" });
    const missing = await run(["pnpm", "--version"], { ...unsigned, registry, env: trusted() });

    // §06.1 tier 2: no signature, but a matching `integrity` — proceed, warned.
    // A missing signature is a registry-shape problem (Artifactory, Nexus), and
    // refusing every such registry is what drove users to
    // `COREPACK_INTEGRITY_KEYS=0`, a permanent global downgrade.
    expect(missing.exitCode).toBe(0);
    expect(missing.stderr).toContain("does not publish signatures for pnpm@6.6.2");
  });

  it("74: COREPACK_INTEGRITY_KEYS naming the mock's key makes the same install succeed", async () => {
    const embedded = createFixture({ packageManager: "pnpm@6.6.2" });
    const rejected = await run(["pnpm", "--version"], { ...embedded, registry });
    expect(rejected.exitCode).toBe(1);
    expect(rejected.stderr).toContain("The package was not signed by any trusted keys");

    const configured = createFixture({ packageManager: "pnpm@6.6.2" });
    const accepted = await run(["pnpm", "--version"], { ...configured, registry, env: trusted() });
    expect(accepted.exitCode).toBe(0);
    expect(accepted.stdout).toBe("6.6.2\n");
  });

  it("75: a mismatched keypair fails for exact versions, ranges, tags and default resolution", async () => {
    registry.mode = "invalid_signature";

    const exact = createFixture({ packageManager: "pnpm@6.6.2" });
    const byVersion = await run(["pnpm", "--version"], { ...exact, registry, env: trusted() });
    expect(byVersion.exitCode).toBe(1);
    expect(byVersion.stderr).toContain("Signature does not match");

    const range = createFixture();
    const byRange = await run(["install", "-g", "pnpm@6.x"], {
      ...range,
      registry,
      env: trusted(),
    });
    expect(byRange.exitCode).toBe(1);
    expect(byRange.stderr).toContain("Signature does not match");

    const tag = createFixture();
    const byTag = await run(["install", "-g", "pnpm@latest"], { ...tag, registry, env: trusted() });
    expect(byTag.exitCode).toBe(1);
    expect(byTag.stderr).toContain("Signature does not match");

    // No-arg default resolution verifies the signature over `<pkg>/latest`, and
    // §04.6 wraps whatever went wrong in its own message.
    const fallback = createFixture();
    const byDefault = await run(["pnpm", "--version"], {
      ...fallback,
      registry,
      env: trusted({ COREPACK_DEFAULT_TO_LATEST: "1" }),
    });
    expect(byDefault.exitCode).toBe(1);
    expect(byDefault.stderr).toContain("jup cannot download the latest stable version of pnpm");
  });

  it("76: a tarball inconsistent with its signed integrity is refused", async () => {
    registry.mode = "invalid_integrity";
    const fixture = createFixture({ packageManager: "pnpm@6.6.2" });

    const result = await run(["pnpm", "--version"], { ...fixture, registry, env: trusted() });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/Mismatch hashes\. Expected [\da-f]{128}, got [\da-f]{128}/);
    expect(existsSync(join(fixture.home, "v1", "pnpm", "6.6.2"))).toBe(false);
  });

  it("77: an explicit +sha1 pin fails as a hash, not as a signature", async () => {
    registry.mode = "invalid_signature";
    const fixture = createFixture({ packageManager: "pnpm@6.6.2+sha1.deadbeef" });

    const result = await run(["pnpm", "--version"], { ...fixture, registry, env: trusted() });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Mismatch hashes. Expected deadbeef, got ");
    expect(result.stderr).not.toContain("Signature");
  });

  it("78: the correct pinned hash installs despite the bad signature", async () => {
    registry.mode = "invalid_signature";
    const { createHash } = await import("node:crypto");
    const digest = createHash("sha1").update(registry.tarballOf("pnpm", "6.6.2")).digest("hex");
    const fixture = createFixture({ packageManager: `pnpm@6.6.2+sha1.${digest}` });

    const result = await run(["pnpm", "--version"], { ...fixture, registry, env: trusted() });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("6.6.2\n");
  });

  it("79: an integrity failure caches nothing, so a re-run fails identically", async () => {
    registry.mode = "invalid_integrity";
    const fixture = createFixture({ packageManager: "pnpm@6.6.2" });
    const options = { ...fixture, registry, env: trusted() };

    const first = await run(["pnpm", "--version"], options);
    const second = await run(["pnpm", "--version"], options);

    expect(first.exitCode).toBe(1);
    expect(second.exitCode).toBe(1);
    expect(second.stderr).toBe(first.stderr);
    expect(existsSync(join(fixture.home, "v1", "pnpm"))).toBe(false);
  });

  it("80: COREPACK_INTEGRITY_KEYS unset / 0 / empty / arbitrary JSON", async () => {
    // The mock's key is never in the embedded store, so "verification ran" and
    // "the install failed" are the same observation.
    const cases: Array<[string | undefined, boolean]> = [
      [undefined, false],
      ["0", true],
      ["", true],
      [`{"npm":[]}`, false],
    ];

    for (const [value, skipped] of cases) {
      const fixture = createFixture({ packageManager: "pnpm@6.6.2" });
      const result = await run(["pnpm", "--version"], {
        ...fixture,
        registry,
        env: { COREPACK_INTEGRITY_KEYS: value },
      });

      expect(result.exitCode, `COREPACK_INTEGRITY_KEYS=${JSON.stringify(value)}`).toBe(
        skipped ? 0 : 1,
      );
    }
  });

  it("81: the embedded trust store matches registry.npmjs.org/-/npm/v1/keys", async (context) => {
    // A *live* staleness check, so it is the one row that needs the network.
    // `JUP_OFFLINE=1` opts out, and an unreachable registry skips rather than
    // fails — CI without egress must not go red over a freshness check.
    if (process.env.JUP_OFFLINE === "1") {
      context.skip();
      return;
    }

    let live: { keys: Array<{ keyid: string; key: string; expires: string | null }> };
    try {
      const response = await fetch("https://registry.npmjs.org/-/npm/v1/keys", {
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        context.skip();
        return;
      }
      live = (await response.json()) as typeof live;
    } catch {
      context.skip();
      return;
    }

    const usable = live.keys.filter(
      (key) => key.expires === null || Date.parse(key.expires) > Date.now(),
    );
    const embedded = TRUST_KEYS["https://registry.npmjs.org"] ?? [];

    expect(embedded.map((key) => `${key.keyid}:${key.key}`).sort()).toEqual(
      usable.map((key) => `${key.keyid}:${key.key}`).sort(),
    );
  });

  it("82: a trust store whose only matching key has expired accepts, loudly (§06.5)", async () => {
    const expires = "2020-01-01T00:00:00.000Z";
    const fixture = createFixture({ packageManager: "pnpm@6.6.2" });

    const result = await run(["pnpm", "--version"], {
      ...fixture,
      registry,
      env: { COREPACK_INTEGRITY_KEYS: registry.trustStore({ expires }) },
    });

    // §06.5's SHOULD, taken. npm rotated its signing key on 2025-01-29 and
    // `dist.signatures` is never rewritten, so hard-failing here would refuse
    // every package manager published before that date — all of Yarn 1.x
    // included, which can never be re-signed.
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("6.6.2\n");
    // "MUST NOT do so silently."
    expect(result.stderr).toContain(
      `carries a valid signature from ${registry.keyid}, a key that expired ${expires}; accepting it`,
    );
  });

  it("208: an expired key whose signature does not verify still fails (§06.5)", async () => {
    const expires = "2020-01-01T00:00:00.000Z";
    const fixture = createFixture({ packageManager: "pnpm@6.6.2" });

    // Expiry buys leniency, not a bypass: the ECDSA check runs first, so a
    // tampered artifact is refused whether or not the key is current. The mode
    // signs with a rogue keypair under the *advertised* keyid, which is exactly
    // the shape that reaches the expired branch.
    registry.mode = "invalid_signature";

    const result = await run(["pnpm", "--version"], {
      ...fixture,
      registry,
      env: { COREPACK_INTEGRITY_KEYS: registry.trustStore({ expires }) },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      `The package was signed with an expired key (${registry.keyid}, expired ${expires})`,
    );
    expect(result.stderr).not.toContain("accepting it");
  });

  it("83: a dist.tarball on another host is refused (§05.2)", async () => {
    registry.tarballOrigin = "https://evil.example.com";
    const fixture = createFixture({ packageManager: "pnpm@6.6.2" });

    const result = await run(["pnpm", "--version"], {
      ...fixture,
      env: mirror(),
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      `Refusing to download from evil.example.com: it does not match the configured registry ${registry.origin}`,
    );
  });

  it("84: a tarball entry escaping the extraction directory is refused (§07.4)", async () => {
    const traversal = createFixture({ packageManager: "pnpm@5.0.1" });
    const climbed = await run(["pnpm", "--version"], { ...traversal, registry, env: trusted() });
    expect(climbed.exitCode).toBe(1);
    expect(climbed.stderr).toContain(
      `Refusing to extract 'package/../../evil.js': path escapes the extraction directory`,
    );

    const absolute = createFixture({ packageManager: "pnpm@5.0.2" });
    const rooted = await run(["pnpm", "--version"], { ...absolute, registry, env: trusted() });
    expect(rooted.exitCode).toBe(1);
    expect(rooted.stderr).toContain(`Refusing to extract '/etc/evil.js'`);

    // Nothing escaped, and nothing was cached.
    expect(existsSync(join(traversal.root, "evil.js"))).toBe(false);
    expect(existsSync(join(traversal.home, "v1", "pnpm", "5.0.1"))).toBe(false);
  });

  it("85: an implausible expansion ratio is refused before the disk fills (§07.4)", async () => {
    const fixture = createFixture({ packageManager: "pnpm@5.0.3" });

    const result = await run(["pnpm", "--version"], { ...fixture, registry, env: trusted() });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Refusing to extract: implausible compression ratio");
    expect(existsSync(join(fixture.home, "v1", "pnpm", "5.0.3"))).toBe(false);
  });
});
