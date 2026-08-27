import { Buffer } from "node:buffer";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { messages, UsageError } from "../../src/errors.ts";
import { resetNpmrcCache } from "../../src/net/npmrc.ts";
import {
  applyRegistryOverride,
  applySourceOverride,
  capToReleaseAge,
  fetchAvailableTags,
  fetchAvailableVersions,
  fetchLatestStableVersion,
  fetchResolvableVersions,
  fetchTarballURLAndSignature,
  getRegistryUrl,
  minimumReleaseAge,
  NPM_ACCEPT_HEADER,
  NPM_FULL_ACCEPT_HEADER,
  resolveRegistrySpec,
  verifyRegistryTrust,
} from "../../src/net/registry.ts";
import { DEFINITIONS } from "../../src/config/table.ts";
import type { NpmRegistrySpec, TrustedKey, UrlRegistrySpec } from "../../src/types.ts";

/* ------------------------------------------------------------------ *
 * A real local server per test: the wire is the contract. Routes are
 * keyed by request path, so a test asserts what was asked for as well as
 * what came back.
 * ------------------------------------------------------------------ */

interface TestServer {
  origin: string;
  requests: Array<{ url: string; headers: Record<string, string | string[] | undefined> }>;
  last: () => { url: string; headers: Record<string, string | string[] | undefined> };
  close: () => Promise<void>;
}

type Route = unknown | ((response: ServerResponse) => void);

const servers: TestServer[] = [];

async function startServer(routes: Record<string, Route>): Promise<TestServer> {
  const requests: TestServer["requests"] = [];

  const handle = (request: IncomingMessage, response: ServerResponse): void => {
    requests.push({ url: request.url ?? "", headers: { ...request.headers } });

    const route = Object.hasOwn(routes, request.url ?? "") ? routes[request.url ?? ""] : undefined;
    if (route === undefined) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(`{"error":"not found"}`);
      return;
    }
    if (typeof route === "function") {
      (route as (response: ServerResponse) => void)(response);
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(route));
  };

  const server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  const instance: TestServer = {
    origin: `http://127.0.0.1:${port}`,
    requests,
    last: () => {
      const request = requests.at(-1);
      if (request === undefined) {
        throw new Error("no request was received");
      }
      return request;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };

  servers.push(instance);
  return instance;
}

const ENV_KEYS = [
  "COREPACK_NPM_REGISTRY",
  "COREPACK_ENABLE_NETWORK",
  "COREPACK_INTEGRITY_KEYS",
  "COREPACK_REQUIRE_SIGNATURES",
  "COREPACK_ENABLE_UNSAFE_CUSTOM_URLS",
  "COREPACK_NPM_TOKEN",
  "COREPACK_NPM_USERNAME",
  "COREPACK_NPM_PASSWORD",
  "COREPACK_REGISTRY_YARN",
  "COREPACK_REGISTRY_PNPM",
  "COREPACK_REGISTRY_NPM",
  "COREPACK_MINIMUM_RELEASE_AGE",
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  // §15.1 is a filesystem input now; a stale parse would outlive the variables.
  resetNpmrcCache();
  saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

/** The rejection itself, so its `message` and `cause` can both be asserted. */
async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the promise to reject");
}

const npm = (packageName: string): NpmRegistrySpec => ({ type: "npm", package: packageName });

/* ------------------------------------------------------------------ *
 * §05.2 — base URL
 * ------------------------------------------------------------------ */

describe("getRegistryUrl (§05.2)", () => {
  it("defaults to the npm registry", () => {
    expect(getRegistryUrl()).toBe("https://registry.npmjs.org");
  });

  it("honours COREPACK_NPM_REGISTRY", () => {
    process.env.COREPACK_NPM_REGISTRY = "https://npm.example.com";
    expect(getRegistryUrl()).toBe("https://npm.example.com");
  });

  it("strips every trailing slash (test 64)", () => {
    process.env.COREPACK_NPM_REGISTRY = "https://npm.example.com/";
    expect(getRegistryUrl()).toBe("https://npm.example.com");

    process.env.COREPACK_NPM_REGISTRY = "https://npm.example.com///";
    expect(getRegistryUrl()).toBe("https://npm.example.com");

    process.env.COREPACK_NPM_REGISTRY = "https://npm.example.com/mirror//";
    expect(getRegistryUrl()).toBe("https://npm.example.com/mirror");
  });

  it("treats an empty override as unset", () => {
    process.env.COREPACK_NPM_REGISTRY = "";
    expect(getRegistryUrl()).toBe("https://registry.npmjs.org");
  });
});

/* ------------------------------------------------------------------ *
 * §05.2 — request construction
 * ------------------------------------------------------------------ */

describe("npm metadata requests (§05.2)", () => {
  it("sends the exact Accept header and an unencoded scoped path (test 63)", async () => {
    const server = await startServer({
      "/@yarnpkg/cli-dist": { versions: { "4.14.1": {} }, "dist-tags": { latest: "4.14.1" } },
    });
    process.env.COREPACK_NPM_REGISTRY = server.origin;

    await fetchAvailableVersions(npm("@yarnpkg/cli-dist"));

    // Scoped names appear literally — npm registry convention.
    expect(server.last().url).toBe("/@yarnpkg/cli-dist");
    expect(server.last().headers.accept).toBe(NPM_ACCEPT_HEADER);
    expect(server.last().headers.accept).toBe(
      "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8",
    );
  });

  it("never doubles the slash after a trailing-slash registry (test 64)", async () => {
    const server = await startServer({ "/pnpm": { versions: { "9.0.0": {} } } });
    process.env.COREPACK_NPM_REGISTRY = `${server.origin}//`;

    await fetchAvailableVersions(npm("pnpm"));

    expect(server.last().url).toBe("/pnpm");
    expect(server.requests.map((request) => request.url)).not.toContain("//pnpm");
  });

  it("passes the registry origin, so credentials are actually sent (§14.6)", async () => {
    const server = await startServer({ "/pnpm": { versions: {} } });
    process.env.COREPACK_NPM_REGISTRY = server.origin;
    process.env.COREPACK_NPM_TOKEN = "sekret";

    await fetchAvailableVersions(npm("pnpm"));

    expect(server.last().headers.authorization).toBe("Bearer sekret");
  });

  it("parses the abbreviated packument shape", async () => {
    const server = await startServer({
      "/pnpm": {
        name: "pnpm",
        "dist-tags": { latest: "9.1.0", next: "10.0.0-rc.1" },
        versions: {
          "9.0.0": { name: "pnpm", version: "9.0.0", dist: { tarball: "https://x/9.0.0.tgz" } },
          "9.1.0": { name: "pnpm", version: "9.1.0", dist: { tarball: "https://x/9.1.0.tgz" } },
        },
        modified: "2026-01-01T00:00:00.000Z",
      },
    });
    process.env.COREPACK_NPM_REGISTRY = server.origin;

    expect(await fetchAvailableVersions(npm("pnpm"))).toStrictEqual(["9.0.0", "9.1.0"]);
    expect(await fetchAvailableTags(npm("pnpm"))).toStrictEqual({
      latest: "9.1.0",
      next: "10.0.0-rc.1",
    });
  });

  it("parses the plain-JSON packument shape", async () => {
    // What a registry that ignores `application/vnd.npm.install-v1+json`
    // answers: the full document, with fields the abbreviated form omits.
    const server = await startServer({
      "/pnpm": {
        _id: "pnpm",
        _rev: "42-cafe",
        name: "pnpm",
        readme: "# pnpm",
        time: { "9.0.0": "2026-01-01T00:00:00.000Z" },
        "dist-tags": { latest: "9.0.0" },
        versions: {
          "9.0.0": {
            name: "pnpm",
            version: "9.0.0",
            maintainers: [{ name: "someone" }],
            dist: { tarball: "https://x/9.0.0.tgz", shasum: "abc" },
          },
        },
      },
    });
    process.env.COREPACK_NPM_REGISTRY = server.origin;

    expect(await fetchAvailableVersions(npm("pnpm"))).toStrictEqual(["9.0.0"]);
    expect(await fetchAvailableTags(npm("pnpm"))).toStrictEqual({ latest: "9.0.0" });
  });

  it("survives a document with neither versions nor dist-tags", async () => {
    const server = await startServer({ "/pnpm": { name: "pnpm" } });
    process.env.COREPACK_NPM_REGISTRY = server.origin;

    expect(await fetchAvailableVersions(npm("pnpm"))).toStrictEqual([]);
    expect(await fetchAvailableTags(npm("pnpm"))).toStrictEqual({});
  });
});

/* ------------------------------------------------------------------ *
 * §05.3 — url-typed registries
 * ------------------------------------------------------------------ */

describe("url registries (§05.3)", () => {
  /** Yarn's own document: tags -> "aliases", versions -> "tags". Inverted, deliberately. */
  const yarnFields = { tags: "aliases", versions: "tags" };

  it("reads an array of versions", async () => {
    const server = await startServer({
      "/tags": { aliases: { stable: "4.14.1" }, tags: ["4.14.0", "4.14.1"] },
    });
    const spec: UrlRegistrySpec = {
      type: "url",
      url: `${server.origin}/tags`,
      fields: yarnFields,
    };

    expect(await fetchAvailableVersions(spec)).toStrictEqual(["4.14.0", "4.14.1"]);
    expect(await fetchAvailableTags(spec)).toStrictEqual({ stable: "4.14.1" });
  });

  it("reads an object whose keys are versions", async () => {
    const server = await startServer({
      "/tags": {
        aliases: { stable: "4.14.1", canary: "5.0.0-rc.1" },
        tags: { "4.14.0": {}, "4.14.1": {} },
      },
    });
    const spec: UrlRegistrySpec = {
      type: "url",
      url: `${server.origin}/tags`,
      fields: yarnFields,
    };

    expect(await fetchAvailableVersions(spec)).toStrictEqual(["4.14.0", "4.14.1"]);
    expect(await fetchAvailableTags(spec)).toStrictEqual({
      stable: "4.14.1",
      canary: "5.0.0-rc.1",
    });
  });

  it("reads `stable`, not `latest`, for the latest stable version (§04.5)", async () => {
    const server = await startServer({
      "/tags": { aliases: { latest: "5.0.0-rc.1", stable: "4.14.1" }, tags: ["4.14.1"] },
    });
    const spec: UrlRegistrySpec = {
      type: "url",
      url: `${server.origin}/tags`,
      fields: yarnFields,
    };

    // No hash is attached on this path.
    expect(await fetchLatestStableVersion(spec)).toBe("4.14.1");
  });

  it("does not wrap url-path failures in the npm message", async () => {
    const server = await startServer({ "/tags": { aliases: {}, tags: [] } });
    const spec: UrlRegistrySpec = {
      type: "url",
      url: `${server.origin}/tags`,
      fields: yarnFields,
    };

    const error = await rejection(fetchLatestStableVersion(spec));
    expect(error.message).toBe(messages.tagNotFound("stable"));
  });
});

/* ------------------------------------------------------------------ *
 * §04.5 — latest stable, npm
 * ------------------------------------------------------------------ */

interface Keypair {
  keyid: string;
  spki: string;
  privateKey: KeyObject;
}

function keypair(keyid = "SHA256:test-key"): Keypair {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    keyid,
    spki: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    privateKey,
  };
}

function trustedKey(pair: Keypair): TrustedKey {
  return {
    expires: null,
    keyid: pair.keyid,
    keytype: "ecdsa-sha2-nistp256",
    scheme: "ecdsa-sha2-nistp256",
    key: pair.spki,
  };
}

function sriFor(payload: string, algo: "sha512" | "sha256"): { sri: string; hex: string } {
  const digest = createHash(algo).update(payload).digest();
  return { sri: `${algo}-${digest.toString("base64")}`, hex: digest.toString("hex") };
}

describe("fetchLatestStableVersion, npm (§04.5)", () => {
  it("returns `<version>+sha512.<hex>` from dist.integrity", async () => {
    const { sri, hex } = sriFor("tarball bytes", "sha512");
    const server = await startServer({
      "/pnpm/latest": { name: "pnpm", version: "9.1.0", dist: { integrity: sri, shasum: "dead" } },
    });
    process.env.COREPACK_NPM_REGISTRY = server.origin;
    process.env.COREPACK_INTEGRITY_KEYS = "0";

    expect(await fetchLatestStableVersion(npm("pnpm"))).toBe(`9.1.0+sha512.${hex}`);
    expect(server.last().url).toBe("/pnpm/latest");
  });

  it("parses the SRI algorithm rather than slicing seven characters (§14.12)", async () => {
    const { sri, hex } = sriFor("tarball bytes", "sha256");
    const server = await startServer({
      "/pnpm/latest": { name: "pnpm", version: "9.1.0", dist: { integrity: sri } },
    });
    process.env.COREPACK_NPM_REGISTRY = server.origin;
    process.env.COREPACK_INTEGRITY_KEYS = "0";

    const reference = await fetchLatestStableVersion(npm("pnpm"));

    // `slice(7)` would have produced a sha512 label over a 32-byte digest, and
    // the hex would have been base64-decoded from one character too far in.
    expect(reference).toBe(`9.1.0+sha256.${hex}`);
    expect(hex).toHaveLength(64);
    expect(reference).not.toContain("sha512");
  });

  it("falls back to `<version>+sha1.<shasum>` on a legacy registry", async () => {
    const server = await startServer({
      "/yarn/latest": { name: "yarn", version: "1.22.22", dist: { shasum: "ac34549e6aa8e7ea" } },
    });
    process.env.COREPACK_NPM_REGISTRY = server.origin;

    // No integrity means nothing is signed, so this path never consults the
    // trust store — and must not fail for the lack of one.
    expect(await fetchLatestStableVersion(npm("yarn"))).toBe("1.22.22+sha1.ac34549e6aa8e7ea");
  });

  it("verifies the signature over `<pkg>@<version>:<integrity>` (§06.3)", async () => {
    const pair = keypair();
    const { sri, hex } = sriFor("tarball bytes", "sha512");
    const signature = sign("sha256", Buffer.from(`pnpm@9.1.0:${sri}`, "utf8"), pair.privateKey);

    const server = await startServer({
      "/pnpm/latest": {
        name: "pnpm",
        version: "9.1.0",
        dist: {
          integrity: sri,
          signatures: [{ keyid: pair.keyid, sig: signature.toString("base64") }],
        },
      },
    });
    process.env.COREPACK_NPM_REGISTRY = server.origin;
    process.env.COREPACK_INTEGRITY_KEYS = JSON.stringify({ npm: [trustedKey(pair)] });

    expect(await fetchLatestStableVersion(npm("pnpm"))).toBe(`9.1.0+sha512.${hex}`);
  });

  /*
   * §06.3 branches on the array, not on its usable entries. A signature with no
   * `keyid` is step 4 — `The package was not signed by any trusted keys`, a
   * `UsageError` that shows the user what the registry actually sent — not step
   * 1's `No compatible signature found in package metadata`, which is an
   * internal assertion printed with a stack.
   */
  it("takes the trusted-keys branch when no signature carries a keyid", async () => {
    const pair = keypair();
    const { sri } = sriFor("tarball bytes", "sha512");
    const server = await startServer({
      "/pnpm/latest": {
        name: "pnpm",
        version: "9.1.0",
        dist: { integrity: sri, signatures: [{ sig: "AAAA" }] },
      },
    });
    process.env.COREPACK_NPM_REGISTRY = server.origin;
    process.env.COREPACK_INTEGRITY_KEYS = JSON.stringify({ npm: [trustedKey(pair)] });

    const error = await rejection(fetchLatestStableVersion(npm("pnpm")));
    const cause = error.cause as Error;

    expect(cause).toBeInstanceOf(UsageError);
    expect(cause.message).not.toBe(messages.noCompatibleSignature());
    expect(cause.message.startsWith("The package was not signed by any trusted keys: ")).toBe(true);
    // The entry the registry sent reaches the diagnostic the user reads.
    expect(cause.message).toContain(`"sig": "AAAA"`);
  });

  it("wraps a verification failure in the §04.5 message, keeping the cause", async () => {
    const pair = keypair();
    const { sri } = sriFor("tarball bytes", "sha512");
    const server = await startServer({
      "/pnpm/latest": { name: "pnpm", version: "9.1.0", dist: { integrity: sri } },
    });
    process.env.COREPACK_NPM_REGISTRY = server.origin;
    process.env.COREPACK_INTEGRITY_KEYS = JSON.stringify({ npm: [trustedKey(pair)] });
    // §15.7 soft-fails an unsigned document onto its `integrity`, so mandating
    // signatures is what makes this one a failure to wrap at all.
    process.env.COREPACK_REQUIRE_SIGNATURES = "1";

    const error = await rejection(fetchLatestStableVersion(npm("pnpm")));

    expect(error.message).toBe(messages.cannotDownloadLatest("pnpm"));
    expect(error.message).toContain("JUP_INTEGRITY_KEYS");
    expect(error.message).toContain("JUP_DEFAULT_TO_LATEST");
    expect(error.message).not.toContain("INTEGRITY_CHECK");
    expect(error.message).not.toContain("USE_LATEST");
    // No signatures at all in that document.
    expect((error.cause as Error).message).toBe(messages.noCompatibleSignature());
    // §15.5 — and the reason has to survive to the *stack*, because `main.ts`
    // presents an unexpected error as its stack and a stack says nothing about
    // `cause`. Without this the sentence above names two remedies and no cause,
    // which reads like a network fault: that is exactly how npm signing
    // `yarn@latest` with a key its own /-/npm/v1/keys marks expired presents.
    expect(error.stack).toContain(`Caused by: ${messages.noCompatibleSignature()}`);
  });

  it("wraps a transport failure in the same message", async () => {
    const server = await startServer({});
    process.env.COREPACK_NPM_REGISTRY = server.origin;

    const error = await rejection(fetchLatestStableVersion(npm("pnpm")));

    expect(error.message).toBe(messages.cannotDownloadLatest("pnpm"));
    expect((error.cause as Error).message).toContain("HTTP 404");
  });
});

/* ------------------------------------------------------------------ *
 * §12.6 — the two network-disabled messages
 * ------------------------------------------------------------------ */

describe("COREPACK_ENABLE_NETWORK=0 (§05.2, §12.6)", () => {
  it("names the registry, not the URL, on the npm path", async () => {
    const server = await startServer({ "/pnpm": { versions: {} } });
    process.env.COREPACK_NPM_REGISTRY = server.origin;
    process.env.COREPACK_ENABLE_NETWORK = "0";

    const error = await rejection(fetchAvailableVersions(npm("pnpm")));

    expect(error).toBeInstanceOf(UsageError);
    expect(error.message).toBe(messages.networkDisabledRegistry(server.origin));
    expect(error.message).toContain("npm repository");
    // Distinct from the transport layer's message, which names the full URL.
    expect(error.message).not.toBe(messages.networkDisabledUrl(`${server.origin}/pnpm`));
    // The check happens before any socket is opened.
    expect(server.requests).toHaveLength(0);
  });

  it("uses the registry-naming message for tags and tarball metadata too", async () => {
    process.env.COREPACK_NPM_REGISTRY = "https://npm.example.com/";
    process.env.COREPACK_ENABLE_NETWORK = "0";

    // The registry named is the *stripped* one.
    const expected = messages.networkDisabledRegistry("https://npm.example.com");

    expect((await rejection(fetchAvailableTags(npm("pnpm")))).message).toBe(expected);
    expect((await rejection(fetchTarballURLAndSignature(npm("pnpm"), "9.1.0"))).message).toBe(
      expected,
    );
  });

  it("leaves the URL-naming message to the transport layer for url registries", async () => {
    const server = await startServer({ "/tags": { aliases: {}, tags: [] } });
    process.env.COREPACK_ENABLE_NETWORK = "0";
    const url = `${server.origin}/tags`;

    const error = await rejection(
      fetchAvailableVersions({ type: "url", url, fields: { tags: "aliases", versions: "tags" } }),
    );

    expect(error).toBeInstanceOf(UsageError);
    expect(error.message).toBe(messages.networkDisabledUrl(url));
    expect(error.message).not.toContain("npm repository");
  });
});

/* ------------------------------------------------------------------ *
 * §07.3 / §14.9 — tarball metadata
 * ------------------------------------------------------------------ */

describe("fetchTarballURLAndSignature (§07.3)", () => {
  it("reads dist.tarball verbatim, with its integrity and signatures", async () => {
    // The routes object is read per request, so it can be filled in once the
    // server's own origin — the one the tarball must sit on — is known.
    const routes: Record<string, Route> = {};
    const server = await startServer(routes);
    process.env.COREPACK_NPM_REGISTRY = server.origin;

    const tarball = `${server.origin}/@yarnpkg/cli-dist/-/cli-dist-4.14.1.tgz?token=abc`;
    routes["/@yarnpkg/cli-dist/4.14.1"] = {
      version: "4.14.1",
      dist: {
        tarball,
        integrity: "sha512-AAAA",
        signatures: [{ keyid: "SHA256:x", sig: "sig" }],
      },
    };

    const result = await fetchTarballURLAndSignature(npm("@yarnpkg/cli-dist"), "4.14.1");

    expect(server.last().url).toBe("/@yarnpkg/cli-dist/4.14.1");
    // Verbatim: the query string and all, never synthesised from the version.
    expect(result.tarball).toBe(tarball);
    expect(result.integrity).toBe("sha512-AAAA");
    expect(result.signatures).toStrictEqual([{ keyid: "SHA256:x", sig: "sig" }]);
  });

  it("rejects a missing tarball with the §12.6 message", async () => {
    const server = await startServer({
      "/pnpm/9.1.0": { version: "9.1.0", dist: { integrity: "sha512-AAAA" } },
    });
    process.env.COREPACK_NPM_REGISTRY = server.origin;

    const error = await rejection(fetchTarballURLAndSignature(npm("pnpm"), "9.1.0"));
    expect(error.message).toBe(messages.noValidTarball("pnpm", "9.1.0"));
  });

  it("rejects a tarball that is not a URL at all", async () => {
    const server = await startServer({
      "/pnpm/9.1.0": { version: "9.1.0", dist: { tarball: "httpfoo-not-a-url" } },
    });
    process.env.COREPACK_NPM_REGISTRY = server.origin;

    const error = await rejection(fetchTarballURLAndSignature(npm("pnpm"), "9.1.0"));
    expect(error.message).toBe(messages.noValidTarball("pnpm", "9.1.0"));
  });

  it("refuses a tarball hosted somewhere other than the registry (test 83)", async () => {
    const server = await startServer({
      "/pnpm/9.1.0": { version: "9.1.0", dist: { tarball: "http://evil.example.com/pnpm.tgz" } },
    });
    process.env.COREPACK_NPM_REGISTRY = server.origin;

    const error = await rejection(fetchTarballURLAndSignature(npm("pnpm"), "9.1.0"));
    expect(error.message).toBe(messages.refusingToDownload("evil.example.com", server.origin));
  });

  it("passes signature entries through untouched, keyid or no keyid", async () => {
    const routes: Record<string, Route> = {};
    const server = await startServer(routes);
    process.env.COREPACK_NPM_REGISTRY = server.origin;

    routes["/pnpm/9.1.0"] = {
      version: "9.1.0",
      dist: {
        tarball: `${server.origin}/pnpm/-/pnpm-9.1.0.tgz`,
        // §06.3 needs every entry, including the unusable ones: they are what
        // its step-4 diagnostic prints.
        signatures: [{ sig: "no-keyid" }, { keyid: "SHA256:x", sig: "sig" }],
      },
    };

    const result = await fetchTarballURLAndSignature(npm("pnpm"), "9.1.0");
    expect(result.signatures).toStrictEqual([
      { sig: "no-keyid" },
      { keyid: "SHA256:x", sig: "sig" },
    ]);
  });

  it("returns undefined signatures instead of crashing when they are stripped (§15.7)", async () => {
    const routes: Record<string, Route> = {};
    const server = await startServer(routes);
    process.env.COREPACK_NPM_REGISTRY = server.origin;

    // What Artifactory and Nexus routinely return: a `dist` with the tarball
    // and nothing else. Corepack destructures `dist.signatures` and crashes.
    routes["/pnpm/9.1.0"] = {
      version: "9.1.0",
      dist: { tarball: `${server.origin}/pnpm/-/pnpm-9.1.0.tgz` },
    };

    const result = await fetchTarballURLAndSignature(npm("pnpm"), "9.1.0");
    expect(result.signatures).toBeUndefined();
    expect(result.integrity).toBeUndefined();
    expect(result.tarball).toBe(`${server.origin}/pnpm/-/pnpm-9.1.0.tgz`);
  });
});

/* ------------------------------------------------------------------ *
 * §15.7 — metadata without a `dist` section
 * ------------------------------------------------------------------ */

describe("metadata with no dist section (§15.7)", () => {
  it("reports it clearly from the tarball path, never as a TypeError", async () => {
    const server = await startServer({
      "/pnpm/9.1.0": { name: "pnpm", version: "9.1.0" },
    });
    process.env.COREPACK_NPM_REGISTRY = server.origin;

    const error = await rejection(fetchTarballURLAndSignature(npm("pnpm"), "9.1.0"));

    expect(error).not.toBeInstanceOf(TypeError);
    expect(error.message).not.toContain("Cannot read properties");
    expect(error.message).toBe(
      `pnpm@9.1.0 metadata from ${server.origin} has no "dist" section; this registry may not be npm-compatible`,
    );
  });

  it("reports it as the cause of the §04.5 wrapper on the latest path", async () => {
    const server = await startServer({ "/pnpm/latest": { name: "pnpm", version: "9.1.0" } });
    process.env.COREPACK_NPM_REGISTRY = server.origin;

    const error = await rejection(fetchLatestStableVersion(npm("pnpm")));
    const cause = error.cause as Error;

    expect(error.message).toBe(messages.cannotDownloadLatest("pnpm"));
    expect(cause).not.toBeInstanceOf(TypeError);
    expect(cause.message).toContain(`has no "dist" section`);
  });
});

/* ------------------------------------------------------------------ *
 * §05.2 rewrite 2 / §15.3 — origins, not substrings
 * ------------------------------------------------------------------ */

describe("applyRegistryOverride (§15.3)", () => {
  const tarball = "https://registry.npmjs.org/yarn/-/yarn-1.22.22.tgz";

  it("is a no-op when no override is configured", () => {
    expect(applyRegistryOverride(tarball)).toBe(tarball);
  });

  it("moves a default-registry URL onto the override", () => {
    process.env.COREPACK_NPM_REGISTRY = "https://npm.example.com";
    expect(applyRegistryOverride(tarball)).toBe("https://npm.example.com/yarn/-/yarn-1.22.22.tgz");
  });

  it("keeps the override's path prefix", () => {
    process.env.COREPACK_NPM_REGISTRY = "https://artifactory.example.com/api/npm/npm-remote";
    expect(applyRegistryOverride(tarball)).toBe(
      "https://artifactory.example.com/api/npm/npm-remote/yarn/-/yarn-1.22.22.tgz",
    );
  });

  it("handles an override differing only by a trailing slash (test 152)", () => {
    process.env.COREPACK_NPM_REGISTRY = "https://npm.example.com/";
    // No doubled slash in the path.
    expect(applyRegistryOverride(tarball)).toBe("https://npm.example.com/yarn/-/yarn-1.22.22.tgz");

    process.env.COREPACK_NPM_REGISTRY = "https://npm.example.com/mirror/";
    expect(applyRegistryOverride(tarball)).toBe(
      "https://npm.example.com/mirror/yarn/-/yarn-1.22.22.tgz",
    );
  });

  it("matches the default origin case-insensitively (test 152)", () => {
    process.env.COREPACK_NPM_REGISTRY = "https://npm.example.com";
    expect(applyRegistryOverride("https://REGISTRY.NPMJS.ORG/yarn/-/yarn-1.22.22.tgz")).toBe(
      "https://npm.example.com/yarn/-/yarn-1.22.22.tgz",
    );
  });

  it("compares origins rather than substrings", () => {
    process.env.COREPACK_NPM_REGISTRY = "https://npm.example.com";

    // The literal appears in the path, not the origin: not ours to rewrite.
    const decoy = "https://evil.example.com/https://registry.npmjs.org/yarn.tgz";
    expect(applyRegistryOverride(decoy)).toBe(decoy);

    // A different host that merely ends with the default one.
    const lookalike = "https://notregistry.npmjs.org.evil.example.com/yarn.tgz";
    expect(applyRegistryOverride(lookalike)).toBe(lookalike);

    // A different scheme is a different origin.
    const insecure = "http://registry.npmjs.org/yarn.tgz";
    expect(applyRegistryOverride(insecure)).toBe(insecure);
  });

  it("leaves other registries alone and is idempotent", () => {
    process.env.COREPACK_NPM_REGISTRY = "https://npm.example.com";

    const yarnRepo = "https://repo.yarnpkg.com/4.14.1/packages/yarnpkg-cli/bin/yarn.js";
    expect(applyRegistryOverride(yarnRepo)).toBe(yarnRepo);

    const once = applyRegistryOverride(tarball);
    expect(applyRegistryOverride(once)).toBe(once);
  });

  it("preserves the query string and returns unparseable input untouched", () => {
    process.env.COREPACK_NPM_REGISTRY = "https://npm.example.com";
    expect(applyRegistryOverride(`${tarball}?token=abc#frag`)).toBe(
      "https://npm.example.com/yarn/-/yarn-1.22.22.tgz?token=abc#frag",
    );
    expect(applyRegistryOverride("not a url")).toBe("not a url");
  });

  it("rewrites a proxied registry's npmjs.org tarball so §14.9 accepts it", async () => {
    const server = await startServer({
      "/pnpm/9.1.0": {
        version: "9.1.0",
        // What Artifactory and friends hand back even when proxying.
        dist: { tarball: "https://registry.npmjs.org/pnpm/-/pnpm-9.1.0.tgz" },
      },
    });
    process.env.COREPACK_NPM_REGISTRY = server.origin;

    const result = await fetchTarballURLAndSignature(npm("pnpm"), "9.1.0");
    expect(result.tarball).toBe(`${server.origin}/pnpm/-/pnpm-9.1.0.tgz`);
  });
});

/* ------------------------------------------------------------------ *
 * §15.7 / §15.8 — the metadata tiering, in isolation
 * ------------------------------------------------------------------ */

describe("verifyRegistryTrust (§15.7, §15.8)", () => {
  /**
   * A fresh package name per call: §15.7's warning is emitted once per package
   * and version for the life of the process, so reusing one across tests would
   * silence all but the first.
   */
  let counter = 0;
  const freshPackage = (): string => `pkg-${++counter}`;

  function signed(packageName: string, version: string, integrity: string, pair: Keypair): unknown {
    return {
      keyid: pair.keyid,
      sig: sign(
        "sha256",
        Buffer.from(`${packageName}@${version}:${integrity}`, "utf8"),
        pair.privateKey,
      ).toString("base64"),
    };
  }

  it("tier 1: an absent `dist` is reported, not destructured (§15.7)", async () => {
    const packageName = freshPackage();
    const server = await startServer({
      [`/${packageName}/latest`]: { name: packageName, version: "9.1.0" },
    });
    process.env.COREPACK_NPM_REGISTRY = server.origin;

    const error = await rejection(fetchLatestStableVersion(npm(packageName)));

    expect(error.message).toBe(messages.cannotDownloadLatest(packageName));
    expect((error.cause as Error).message).toBe(
      messages.noDistSection(packageName, "9.1.0", server.origin),
    );
    // #570's actual symptom, which must never resurface.
    expect((error.cause as Error).message).not.toContain("Cannot read properties");
  });

  it("tier 2: warns once per package and version, then proceeds", async () => {
    const packageName = freshPackage();
    const server = await startServer({ [`/${packageName}`]: { name: packageName } });
    process.env.COREPACK_NPM_REGISTRY = server.origin;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const call = (): Promise<void> =>
      verifyRegistryTrust({
        spec: npm(packageName),
        version: "9.1.0",
        registryUrl: server.origin,
        signatures: undefined,
        integrity: "sha512-abc",
        hasDigest: true,
      });

    await call();
    await call();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      `! ${server.origin} does not publish signatures for ${packageName}@9.1.0; falling back to integrity-only verification`,
    );
    warn.mockRestore();
  });

  it("tier 2: refuses when the registry publishes no digest at all", async () => {
    const packageName = freshPackage();
    const server = await startServer({ [`/${packageName}`]: { name: packageName } });
    process.env.COREPACK_NPM_REGISTRY = server.origin;

    const error = await rejection(
      verifyRegistryTrust({
        spec: npm(packageName),
        version: "9.1.0",
        registryUrl: server.origin,
        signatures: undefined,
        integrity: undefined,
        hasDigest: false,
      }),
    );

    expect(error.message).toBe(messages.noRegistryDigest(packageName, "9.1.0", server.origin));
  });

  it("COREPACK_REQUIRE_SIGNATURES makes the soft-fail a UsageError", async () => {
    const packageName = freshPackage();
    const server = await startServer({ [`/${packageName}`]: { name: packageName } });
    process.env.COREPACK_NPM_REGISTRY = server.origin;
    process.env.COREPACK_REQUIRE_SIGNATURES = "1";

    const error = await rejection(
      verifyRegistryTrust({
        spec: npm(packageName),
        version: "9.1.0",
        registryUrl: server.origin,
        signatures: undefined,
        integrity: "sha512-abc",
        hasDigest: true,
      }),
    );

    expect(error).toBeInstanceOf(UsageError);
    expect(error.message).toBe(messages.noCompatibleSignature());
  });

  it("COREPACK_INTEGRITY_KEYS=0 skips the tiering entirely (§06.1 row 5)", async () => {
    const packageName = freshPackage();
    const server = await startServer({ [`/${packageName}`]: { name: packageName } });
    process.env.COREPACK_NPM_REGISTRY = server.origin;
    process.env.COREPACK_INTEGRITY_KEYS = "0";
    process.env.COREPACK_REQUIRE_SIGNATURES = "1";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await verifyRegistryTrust({
      spec: npm(packageName),
      version: "9.1.0",
      registryUrl: server.origin,
      signatures: undefined,
      integrity: undefined,
      hasDigest: false,
    });

    expect(warn).not.toHaveBeenCalled();
    expect(server.requests).toHaveLength(0);
    warn.mockRestore();
  });

  it("§15.8: reads `versions[<version>].dist.signatures` from the package root", async () => {
    const packageName = freshPackage();
    const pair = keypair();
    const { sri } = sriFor("tarball bytes", "sha512");
    const server = await startServer({
      // The version endpoint Artifactory strips, and the root it does not.
      [`/${packageName}`]: {
        name: packageName,
        versions: {
          "9.1.0": {
            dist: { integrity: sri, signatures: [signed(packageName, "9.1.0", sri, pair)] },
          },
        },
      },
    });
    process.env.COREPACK_NPM_REGISTRY = server.origin;
    process.env.COREPACK_INTEGRITY_KEYS = JSON.stringify({ npm: [trustedKey(pair)] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await verifyRegistryTrust({
      spec: npm(packageName),
      version: "9.1.0",
      registryUrl: server.origin,
      signatures: undefined,
      integrity: sri,
      hasDigest: true,
    });

    expect(server.requests.map((request) => request.url)).toStrictEqual([`/${packageName}`]);
    // Verified, so nothing was downgraded and nothing is warned about.
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("§15.8: a signature recovered from the root still hard-fails when invalid", async () => {
    const packageName = freshPackage();
    const pair = keypair();
    const rogue = keypair("SHA256:rogue");
    const { sri } = sriFor("tarball bytes", "sha512");
    const server = await startServer({
      [`/${packageName}`]: {
        name: packageName,
        versions: {
          "9.1.0": {
            dist: {
              integrity: sri,
              // The trusted keyid over someone else's signature: §15.7 tier 3.
              signatures: [
                { ...(signed(packageName, "9.1.0", sri, rogue) as object), keyid: pair.keyid },
              ],
            },
          },
        },
      },
    });
    process.env.COREPACK_NPM_REGISTRY = server.origin;
    process.env.COREPACK_INTEGRITY_KEYS = JSON.stringify({ npm: [trustedKey(pair)] });

    const error = await rejection(
      verifyRegistryTrust({
        spec: npm(packageName),
        version: "9.1.0",
        registryUrl: server.origin,
        signatures: undefined,
        integrity: sri,
        hasDigest: true,
      }),
    );

    expect(error.message).toBe(messages.signatureMismatch());
  });

  it("§15.8: makes no request at all when COREPACK_ENABLE_NETWORK=0", async () => {
    const packageName = freshPackage();
    const pair = keypair();
    const { sri } = sriFor("tarball bytes", "sha512");
    const server = await startServer({
      [`/${packageName}`]: {
        name: packageName,
        versions: {
          "9.1.0": {
            dist: { integrity: sri, signatures: [signed(packageName, "9.1.0", sri, pair)] },
          },
        },
      },
    });
    process.env.COREPACK_NPM_REGISTRY = server.origin;
    process.env.COREPACK_INTEGRITY_KEYS = JSON.stringify({ npm: [trustedKey(pair)] });
    process.env.COREPACK_ENABLE_NETWORK = "0";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await verifyRegistryTrust({
      spec: npm(packageName),
      version: "9.1.0",
      registryUrl: server.origin,
      signatures: undefined,
      integrity: sri,
      hasDigest: true,
    });

    expect(server.requests).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("§15.8: never fires when the version endpoint is already signed", async () => {
    const packageName = freshPackage();
    const pair = keypair();
    const { sri } = sriFor("tarball bytes", "sha512");
    const server = await startServer({ [`/${packageName}`]: { name: packageName } });
    process.env.COREPACK_NPM_REGISTRY = server.origin;
    process.env.COREPACK_INTEGRITY_KEYS = JSON.stringify({ npm: [trustedKey(pair)] });

    await verifyRegistryTrust({
      spec: npm(packageName),
      version: "9.1.0",
      registryUrl: server.origin,
      signatures: [signed(packageName, "9.1.0", sri, pair)] as never,
      integrity: sri,
      hasDigest: true,
    });

    expect(server.requests).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * §15.2 / §15.3 — per-source registries and origin rewriting
 * ------------------------------------------------------------------ */

describe("per-source registries (§15.2)", () => {
  it("gives each package manager its own base URL", () => {
    process.env.COREPACK_NPM_REGISTRY = "https://shared.example.org";
    process.env.COREPACK_REGISTRY_YARN = "https://yarn.example.org";

    expect(getRegistryUrl({ name: "yarn" })).toBe("https://yarn.example.org");
    expect(getRegistryUrl({ name: "pnpm" })).toBe("https://shared.example.org");
    expect(getRegistryUrl({ name: "npm" })).toBe("https://shared.example.org");
  });

  it("moves a table URL off its own distribution origin — the thing #872 could not do", () => {
    process.env.COREPACK_REGISTRY_YARN = "https://yarn.example.org";

    // repo.yarnpkg.com is neither an npm registry nor the default registry, so
    // §05.2 rewrite 2 has never been able to touch it.
    expect(
      applySourceOverride(
        "https://repo.yarnpkg.com/4.9.0/packages/yarnpkg-cli/bin/yarn.js",
        "yarn",
      ),
    ).toBe("https://yarn.example.org/4.9.0/packages/yarnpkg-cli/bin/yarn.js");
    expect(applySourceOverride("https://repo.yarnpkg.com/tags", "yarn")).toBe(
      "https://yarn.example.org/tags",
    );
  });

  it("leaves every other package manager's URL alone", () => {
    process.env.COREPACK_REGISTRY_YARN = "https://yarn.example.org";
    expect(applySourceOverride("https://registry.npmjs.org/pnpm/-/pnpm-1.0.0.tgz", "pnpm")).toBe(
      "https://registry.npmjs.org/pnpm/-/pnpm-1.0.0.tgz",
    );
  });

  it("prepends the override's own path prefix, once", () => {
    process.env.COREPACK_REGISTRY_YARN = "https://mirror.example.org/artifactory/yarn/";

    const once = applySourceOverride("https://repo.yarnpkg.com/tags", "yarn");
    expect(once).toBe("https://mirror.example.org/artifactory/yarn/tags");
    // §15.38 row 152 — idempotent, so a second pass cannot double the prefix.
    expect(applySourceOverride(once, "yarn")).toBe(once);
  });

  it("is a no-op with nothing configured", () => {
    expect(applySourceOverride("https://repo.yarnpkg.com/tags", "yarn")).toBe(
      "https://repo.yarnpkg.com/tags",
    );
  });
});

describe("applyRegistryOverride — origins, not substrings (§15.3)", () => {
  it("normalises a differing host case and trailing slash (§15.38 row 152)", () => {
    // `new URL` lower-cases the host and normalises the path, so both spellings
    // of the same origin rewrite identically and neither doubles a slash.
    expect(
      applyRegistryOverride(
        "https://registry.npmjs.org/pnpm/-/pnpm-6.6.2.tgz",
        "https://REGISTRY.NPMJS.ORG/",
      ),
    ).toBe("https://registry.npmjs.org/pnpm/-/pnpm-6.6.2.tgz");

    expect(
      applyRegistryOverride(
        "https://registry.npmjs.org/pnpm/-/pnpm-6.6.2.tgz",
        "https://Mirror.Example.ORG/",
      ),
    ).toBe("https://mirror.example.org/pnpm/-/pnpm-6.6.2.tgz");
  });

  it("refuses to rewrite a URL that merely contains the default registry", () => {
    // Corepack's `String.replace` rewrites the middle of this one.
    const url = "https://evil.example.org/proxy/https://registry.npmjs.org/pnpm";
    expect(applyRegistryOverride(url, "https://mirror.example.org")).toBe(url);
  });

  it("does not double a path prefix when applied twice", () => {
    const once = applyRegistryOverride(
      "https://registry.npmjs.org/pnpm/-/pnpm-6.6.2.tgz",
      "https://mirror.example.org/npm-mirror",
    );
    expect(once).toBe("https://mirror.example.org/npm-mirror/pnpm/-/pnpm-6.6.2.tgz");
    expect(applyRegistryOverride(once, "https://mirror.example.org/npm-mirror")).toBe(once);
  });
});

describe("resolveRegistrySpec — §05.2 rewrite 1", () => {
  const berry: UrlRegistrySpec = {
    type: "url",
    url: "https://repo.yarnpkg.com/tags",
    fields: { tags: "aliases", versions: "tags" },
  };

  it("leaves Berry on its own document with nothing configured", () => {
    // Identity matters: the table's object is what carries the npm alternative.
    const table = DEFINITIONS.yarn!.ranges.at(-1)![1].registry;
    expect(resolveRegistrySpec(table)).toBe(table);
  });

  it("switches Berry to @yarnpkg/cli-dist once an npm registry is configured", () => {
    process.env.COREPACK_NPM_REGISTRY = "https://mirror.example.org";
    const table = DEFINITIONS.yarn!.ranges.at(-1)![1].registry;
    expect(resolveRegistrySpec(table)).toEqual({
      type: "npm",
      package: "@yarnpkg/cli-dist",
      bin: "bin/yarn.js",
    });
  });

  it("keeps Berry on its own document for COREPACK_REGISTRY_YARN — that is a mirror", () => {
    process.env.COREPACK_REGISTRY_YARN = "https://yarn.example.org";
    const table = DEFINITIONS.yarn!.ranges.at(-1)![1].registry;
    expect(resolveRegistrySpec(table)).toBe(table);
  });

  it("passes through a spec the table does not declare", () => {
    expect(resolveRegistrySpec(berry)).toBe(berry);
  });

  it("is applied by the fetchers, so a tag lookup follows the same switch", async () => {
    // `resolve.ts` performs this substitution for `COREPACK_NPM_REGISTRY` before
    // it calls in here, but nothing there knows about `.npmrc`. Doing it inside
    // the fetchers as well is what makes §15.38 row 150's configuration —
    // `@yarnpkg:registry` and nothing else — move the *tag document* too, not
    // only the download.
    const root = mkdtempSync(join(tmpdir(), "jup-registry-npmrc-"));
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    const savedHome = process.env.HOME;
    const savedPrefix = process.env.PREFIX;

    try {
      const server = await startServer({
        "/@yarnpkg/cli-dist": { "dist-tags": { stable: "4.9.0" }, versions: { "4.9.0": {} } },
      });
      writeFileSync(join(home, ".npmrc"), `@yarnpkg:registry=${server.origin}\n`);
      process.env.HOME = home;
      process.env.PREFIX = join(root, "prefix");
      resetNpmrcCache();

      const table = DEFINITIONS.yarn!.ranges.at(-1)![1].registry;
      await expect(fetchAvailableTags(table)).resolves.toEqual({ stable: "4.9.0" });
      // Not `https://repo.yarnpkg.com/tags`, which is what corepack asks for.
      expect(server.requests.map((request) => request.url)).toEqual(["/@yarnpkg/cli-dist"]);
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      if (savedPrefix === undefined) delete process.env.PREFIX;
      else process.env.PREFIX = savedPrefix;
      resetNpmrcCache();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------------ *
 * §15.35e — COREPACK_MINIMUM_RELEASE_AGE
 * ------------------------------------------------------------------ */

const HOUR = 60 * 60 * 1000;

/** A packument with a `time` map, as the **full** document carries it. */
function datedPackument(entries: Record<string, number>, options?: { time?: boolean }): unknown {
  const versions: Record<string, unknown> = {};
  const time: Record<string, string> = {};
  for (const [version, agoHours] of Object.entries(entries)) {
    versions[version] = { name: "pnpm", version, dist: { tarball: `https://x/${version}.tgz` } };
    time[version] = new Date(Date.now() - agoHours * HOUR).toISOString();
  }
  const document: Record<string, unknown> = { name: "pnpm", versions };
  if (options?.time !== false) document.time = time;
  return document;
}

describe("minimumReleaseAge (§15.35e)", () => {
  it("is off when unset, empty, blank or explicitly zero", () => {
    expect(minimumReleaseAge()).toBeUndefined();
    for (const value of ["", "   ", "0", "0.0"]) {
      process.env.COREPACK_MINIMUM_RELEASE_AGE = value;
      expect(minimumReleaseAge(), JSON.stringify(value)).toBeUndefined();
    }
  });

  it("reads hours, and answers milliseconds", () => {
    process.env.COREPACK_MINIMUM_RELEASE_AGE = "24";
    expect(minimumReleaseAge()).toBe(24 * HOUR);

    process.env.COREPACK_MINIMUM_RELEASE_AGE = " 0.5 ";
    expect(minimumReleaseAge()).toBe(HOUR / 2);
  });

  it("refuses an unparseable or negative value rather than falling back to off", () => {
    // The whole point: `COREPACK_NETWORK_TIMEOUT=abc` costing a user the default
    // timeout is a preference gone wrong, while this silently turning a
    // supply-chain control off on the machine of someone who believes they
    // turned it on is the fail-open shape §15.35e exists to close.
    for (const value of ["24h", "-1", "abc", "NaN", "Infinity"]) {
      process.env.COREPACK_MINIMUM_RELEASE_AGE = value;
      expect(() => minimumReleaseAge(), value).toThrow(UsageError);
      expect(() => minimumReleaseAge(), value).toThrow(
        `JUP_MINIMUM_RELEASE_AGE must be a non-negative number of hours, got ${JSON.stringify(value)}`,
      );
    }
  });
});

describe("fetchResolvableVersions (§15.35e, §04.1 step 6)", () => {
  it("is fetchAvailableVersions, header and all, while the gate is off", async () => {
    const server = await startServer({ "/pnpm": datedPackument({ "9.0.0": 1, "9.1.0": 1 }) });
    process.env.COREPACK_NPM_REGISTRY = server.origin;

    const candidates = await fetchResolvableVersions(npm("pnpm"));

    expect(candidates.versions).toStrictEqual(["9.0.0", "9.1.0"]);
    expect(candidates.undatedSource).toBeUndefined();
    // Both halves of "costs nothing when unset": one request, abbreviated.
    expect(server.requests.map((request) => request.url)).toStrictEqual(["/pnpm"]);
    expect(server.last().headers.accept).toBe(NPM_ACCEPT_HEADER);
  });

  it("asks for the full document, and only then, when the gate is on", async () => {
    const server = await startServer({ "/pnpm": datedPackument({ "9.0.0": 100, "9.1.0": 1 }) });
    process.env.COREPACK_NPM_REGISTRY = server.origin;
    process.env.COREPACK_MINIMUM_RELEASE_AGE = "24";

    const candidates = await fetchResolvableVersions(npm("pnpm"));

    expect(candidates.versions).toStrictEqual(["9.0.0"]);
    expect(candidates.undatedSource).toBeUndefined();
    // Still exactly one request — the gate changes which document, never how
    // many are sent.
    expect(server.requests.map((request) => request.url)).toStrictEqual(["/pnpm"]);
    expect(server.last().headers.accept).toBe(NPM_FULL_ACCEPT_HEADER);
    expect(server.last().headers.accept).toBe("application/json");
  });

  it("drops a version the `time` map does not mention", async () => {
    const document = datedPackument({ "9.0.0": 100, "9.1.0": 100 }) as {
      time: Record<string, string>;
    };
    delete document.time["9.1.0"];
    const server = await startServer({ "/pnpm": document });
    process.env.COREPACK_NPM_REGISTRY = server.origin;
    process.env.COREPACK_MINIMUM_RELEASE_AGE = "24";

    // Undatable, so unvouchable, so not a candidate — even though it is older
    // than everything the map does date.
    expect((await fetchResolvableVersions(npm("pnpm"))).versions).toStrictEqual(["9.0.0"]);
  });

  it("reports a packument with no `time` map at all as an undated source", async () => {
    const server = await startServer({
      "/pnpm": datedPackument({ "9.0.0": 100 }, { time: false }),
    });
    process.env.COREPACK_NPM_REGISTRY = server.origin;
    process.env.COREPACK_MINIMUM_RELEASE_AGE = "24";

    const candidates = await fetchResolvableVersions(npm("pnpm"));

    expect(candidates.versions).toStrictEqual(["9.0.0"]);
    expect(candidates.undatedSource).toBe(`${server.origin}/pnpm`);
  });

  it("reports a url-typed registry as an undated source (blocker 3)", async () => {
    const server = await startServer({
      "/tags": { aliases: { stable: "4.14.1" }, tags: ["4.14.0", "4.14.1"] },
    });
    const spec: UrlRegistrySpec = {
      type: "url",
      url: `${server.origin}/tags`,
      fields: { tags: "aliases", versions: "tags" },
    };
    process.env.COREPACK_MINIMUM_RELEASE_AGE = "24";

    const candidates = await fetchResolvableVersions(spec);

    // Nothing is filtered — there is nothing to filter *by*. The caller decides,
    // once it knows whether this source contributes a candidate at all.
    expect(candidates.versions).toStrictEqual(["4.14.0", "4.14.1"]);
    expect(candidates.undatedSource).toBe(`${server.origin}/tags`);
  });
});

describe("capToReleaseAge (§15.35e, §04.1 step 3)", () => {
  it("returns its argument and makes no request while the gate is off", async () => {
    const server = await startServer({ "/pnpm": datedPackument({ "9.0.0": 100 }) });
    process.env.COREPACK_NPM_REGISTRY = server.origin;

    expect(await capToReleaseAge(npm("pnpm"), "9.9.9")).toBe("9.9.9");
    expect(server.requests).toStrictEqual([]);
  });

  it("caps a dist-tag at the newest release old enough to be chosen", async () => {
    const server = await startServer({
      "/pnpm": datedPackument({ "9.0.0": 500, "9.1.0": 100, "9.2.0": 1 }),
    });
    process.env.COREPACK_NPM_REGISTRY = server.origin;
    process.env.COREPACK_MINIMUM_RELEASE_AGE = "24";

    expect(await capToReleaseAge(npm("pnpm"), "9.2.0")).toBe("9.1.0");
  });

  it("never caps *upwards* — a tag pointing backwards stays there", async () => {
    const server = await startServer({
      "/pnpm": datedPackument({ "9.0.0": 500, "9.1.0": 100, "9.2.0": 100 }),
    });
    process.env.COREPACK_NPM_REGISTRY = server.origin;
    process.env.COREPACK_MINIMUM_RELEASE_AGE = "24";

    // 9.2.0 is eligible too, but the tag named the 9.0.0 line and the gate is
    // not licence to move a user forward.
    expect(await capToReleaseAge(npm("pnpm"), "9.0.0")).toBe("9.0.0");
  });

  it("§15.24 — skips a prerelease unless the tag itself names one", async () => {
    const server = await startServer({
      "/pnpm": datedPackument({ "9.0.0": 500, "9.1.0-rc.1": 100, "9.2.0": 1 }),
    });
    process.env.COREPACK_NPM_REGISTRY = server.origin;
    process.env.COREPACK_MINIMUM_RELEASE_AGE = "24";

    expect(await capToReleaseAge(npm("pnpm"), "9.2.0")).toBe("9.0.0");
    expect(await capToReleaseAge(npm("pnpm"), "9.2.0-rc.9")).toBe("9.1.0-rc.1");
  });

  it("refuses when the source publishes no release dates", async () => {
    const server = await startServer({
      "/tags": { aliases: { stable: "4.14.1" }, tags: ["4.14.0", "4.14.1"] },
    });
    const spec: UrlRegistrySpec = {
      type: "url",
      url: `${server.origin}/tags`,
      fields: { tags: "aliases", versions: "tags" },
    };
    process.env.COREPACK_MINIMUM_RELEASE_AGE = "24";

    const error = await rejection(capToReleaseAge(spec, "4.14.1"));
    expect(error).toBeInstanceOf(UsageError);
    expect(error.message).toBe(
      `JUP_MINIMUM_RELEASE_AGE is set, but ${server.origin}/tags publishes no release dates, so the minimum age cannot be enforced there; pin an exact version, or set JUP_NPM_REGISTRY to an npm registry that serves this package manager`,
    );
  });

  it("refuses when nothing published is old enough", async () => {
    const server = await startServer({ "/pnpm": datedPackument({ "9.0.0": 1, "9.1.0": 2 }) });
    process.env.COREPACK_NPM_REGISTRY = server.origin;
    process.env.COREPACK_MINIMUM_RELEASE_AGE = "24";

    const error = await rejection(capToReleaseAge(npm("pnpm"), "9.1.0"));
    expect(error).toBeInstanceOf(UsageError);
    expect(error.message).toBe(
      "No release of pnpm is old enough for COREPACK_MINIMUM_RELEASE_AGE=24",
    );
  });
});

describe("fetchLatestStableVersion under the gate (§15.35e, §04.5)", () => {
  it("selects the newest eligible stable release instead of asking for `latest`", async () => {
    const { sri, hex } = sriFor("tarball bytes", "sha512");
    const server = await startServer({
      "/pnpm": datedPackument({ "9.0.0": 500, "9.1.0": 100, "9.2.0": 1 }),
      "/pnpm/9.1.0": { name: "pnpm", version: "9.1.0", dist: { integrity: sri } },
      "/pnpm/latest": { name: "pnpm", version: "9.2.0", dist: { integrity: sri } },
    });
    process.env.COREPACK_NPM_REGISTRY = server.origin;
    process.env.COREPACK_INTEGRITY_KEYS = "0";
    process.env.COREPACK_MINIMUM_RELEASE_AGE = "24";

    expect(await fetchLatestStableVersion(npm("pnpm"))).toBe(`9.1.0+sha512.${hex}`);
    // The packument (full) to learn the ages, then the version document. Never
    // `/pnpm/latest`, which would answer 9.2.0.
    expect(server.requests.map((request) => request.url)).toStrictEqual(["/pnpm", "/pnpm/9.1.0"]);
    expect(server.requests[0]!.headers.accept).toBe(NPM_FULL_ACCEPT_HEADER);
    expect(server.requests[1]!.headers.accept).toBe(NPM_ACCEPT_HEADER);
  });

  it("still asks for `latest` in one request while the gate is off", async () => {
    const { sri, hex } = sriFor("tarball bytes", "sha512");
    const server = await startServer({
      "/pnpm/latest": { name: "pnpm", version: "9.2.0", dist: { integrity: sri } },
    });
    process.env.COREPACK_NPM_REGISTRY = server.origin;
    process.env.COREPACK_INTEGRITY_KEYS = "0";

    expect(await fetchLatestStableVersion(npm("pnpm"))).toBe(`9.2.0+sha512.${hex}`);
    expect(server.requests.map((request) => request.url)).toStrictEqual(["/pnpm/latest"]);
  });

  it("refuses an undated url document rather than reading `stable` from it", async () => {
    const server = await startServer({
      "/tags": { aliases: { stable: "4.14.1" }, tags: ["4.14.1"] },
    });
    const spec: UrlRegistrySpec = {
      type: "url",
      url: `${server.origin}/tags`,
      fields: { tags: "aliases", versions: "tags" },
    };
    process.env.COREPACK_MINIMUM_RELEASE_AGE = "24";

    const error = await rejection(fetchLatestStableVersion(spec));
    expect(error).toBeInstanceOf(UsageError);
    expect(error.message).toContain("publishes no release dates");
    // And it did not fetch the document it could not have gated anyway.
    expect(server.requests).toStrictEqual([]);
  });
});
