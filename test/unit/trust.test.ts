/**
 * §15.9 — trust-key freshness (`src/trust.ts`).
 *
 * Every assertion here counts **requests**, not outcomes. The requirement is not
 * "a rotated key eventually works" — it is that exactly one branch of §06.3
 * spends a request, that the fast path spends none, and that the cache stops the
 * second one. A test that only asserted the exit condition would pass just as
 * well against a build that refreshed the trust store on every verification,
 * which is precisely the regression §01.3 cannot afford.
 */

import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_REGISTRY, TRUST_KEYS } from "../../src/config/keys.ts";
import { UntrustedKeyidError } from "../../src/verify/integrity.ts";
import {
  fetchNpmKeys,
  KEYS_CACHE_NAME,
  KEYS_CACHE_VERSION,
  KEYS_ENDPOINT,
  mergeKeys,
  readKeysCache,
  REFRESH_INTERVAL,
  sanitiseKeys,
  shouldRefresh,
  verifySignatureWithRefresh,
  writeKeysCache,
} from "../../src/verify/trust.ts";
import type { RegistrySignature, TrustedKey } from "../../src/types.ts";

/* -------------------------------------------------------------------------- */
/* Real keys, real signatures                                                  */
/* -------------------------------------------------------------------------- */

interface Keypair {
  keyid: string;
  spki: string;
  privateKey: KeyObject;
}

function makeKeypair(keyid: string): Keypair {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    keyid,
    spki: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    privateKey,
  };
}

function trustedKey(keypair: Keypair, expires: string | null = null): TrustedKey {
  return {
    expires,
    keyid: keypair.keyid,
    keytype: "ecdsa-sha2-nistp256",
    scheme: "ecdsa-sha2-nistp256",
    key: keypair.spki,
  };
}

const PACKAGE = "pnpm";
const VERSION = "6.6.2";
const INTEGRITY = `sha512-${Buffer.alloc(64, 3).toString("base64")}`;
const PAYLOAD = `${PACKAGE}@${VERSION}:${INTEGRITY}`;

function signature(keypair: Keypair, payload = PAYLOAD): RegistrySignature {
  return {
    keyid: keypair.keyid,
    sig: sign("sha256", Buffer.from(payload, "utf8"), keypair.privateKey).toString("base64"),
  };
}

function verify(signatures: RegistrySignature[] | undefined): Promise<void> {
  return verifySignatureWithRefresh({
    signatures,
    integrity: INTEGRITY,
    packageName: PACKAGE,
    version: VERSION,
    registryOrigin: DEFAULT_REGISTRY,
  });
}

/* -------------------------------------------------------------------------- */
/* Environment: a throwaway home, a counted transport, a controllable embedded  */
/* trust store                                                                 */
/* -------------------------------------------------------------------------- */

const roots: string[] = [];
let home = "";
let fetchMock: ReturnType<typeof vi.fn>;

const realFetch = globalThis.fetch;
const embedded = TRUST_KEYS[DEFAULT_REGISTRY]!;
const shipped = [...embedded];

const PROXY_VARIABLES = [
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
  "NODE_USE_ENV_PROXY",
];
const savedProxies: Record<string, string | undefined> = {};

/**
 * Replace the *embedded* table for one test.
 *
 * `COREPACK_INTEGRITY_KEYS` would do the same job for the trust store, but it
 * also disables the refresh (§15.9), so it cannot express "the shipped keys do
 * not explain this signature" — which is the entire subject of this file.
 */
function useEmbedded(keys: TrustedKey[]): void {
  embedded.length = 0;
  embedded.push(...keys);
}

/** The `/-/npm/v1/keys` document, and nothing else: any other URL is a failure. */
function serveKeys(keys: TrustedKey[]): void {
  fetchMock.mockImplementation((url: string) => {
    if (url !== KEYS_ENDPOINT) throw new Error(`unexpected request: ${url}`);
    return Promise.resolve(
      new Response(JSON.stringify({ keys }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  });
}

function seedCache(keys: TrustedKey[], fetchedAt: string | number = Date.now()): void {
  writeFileSync(
    join(home, KEYS_CACHE_NAME),
    JSON.stringify({
      version: KEYS_CACHE_VERSION,
      registries: {
        [DEFAULT_REGISTRY]: {
          fetchedAt: typeof fetchedAt === "number" ? new Date(fetchedAt).toISOString() : fetchedAt,
          keys,
        },
      },
    }),
  );
}

function cacheFile(): string {
  return readFileSync(join(home, KEYS_CACHE_NAME), "utf8");
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pipack-trust-"));
  roots.push(home);
  process.env.COREPACK_HOME = home;
  delete process.env.COREPACK_INTEGRITY_KEYS;
  delete process.env.COREPACK_ENABLE_NETWORK;
  for (const name of PROXY_VARIABLES) {
    savedProxies[name] = process.env[name];
    delete process.env[name];
  }

  fetchMock = vi.fn(() => {
    throw new Error("no request expected");
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  useEmbedded(shipped);
  delete process.env.COREPACK_HOME;
  delete process.env.COREPACK_INTEGRITY_KEYS;
  delete process.env.COREPACK_ENABLE_NETWORK;
  for (const name of PROXY_VARIABLES) {
    const value = savedProxies[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

/* -------------------------------------------------------------------------- */

describe("verifySignatureWithRefresh — §15.9", () => {
  it("makes no request when the shipped keys already verify", async () => {
    const npm = makeKeypair("SHA256:shipped");
    useEmbedded([trustedKey(npm)]);
    serveKeys([trustedKey(makeKeypair("SHA256:rotated"))]);

    await expect(verify([signature(npm)])).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("refreshes once on an unknown keyid, then verifies and caches", async () => {
    const rotated = makeKeypair("SHA256:rotated");
    useEmbedded([trustedKey(makeKeypair("SHA256:shipped"))]);
    serveKeys([trustedKey(rotated)]);

    await expect(verify([signature(rotated)])).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe(KEYS_ENDPOINT);

    const cached = readKeysCache();
    expect(cached.keys.map((key) => key.keyid)).toEqual(["SHA256:rotated"]);
    expect(cached.fetchedAt).toBeGreaterThan(Date.now() - 60_000);
  });

  it("merges rather than substitutes: a shipped key still verifies afterwards", async () => {
    const shippedKey = makeKeypair("SHA256:shipped");
    const rotated = makeKeypair("SHA256:rotated");
    useEmbedded([trustedKey(shippedKey)]);
    serveKeys([trustedKey(rotated)]);

    // The refresh happens for the rotated signature…
    await expect(verify([signature(rotated)])).resolves.toBeUndefined();
    // …and the shipped key is still trusted, with no further request.
    await expect(verify([signature(shippedKey)])).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not refresh for an expired key, a bad signature, or no signature", async () => {
    const npm = makeKeypair("SHA256:shipped");
    serveKeys([trustedKey(makeKeypair("SHA256:rotated"))]);

    // The keyid matched — a refresh would return the same key with the same
    // expiry, so §15.9 does not spend a request on it (§06.5 decides).
    useEmbedded([trustedKey(npm, "2020-01-01T00:00:00.000Z")]);
    await expect(verify([signature(npm)])).rejects.toThrow(
      "The package was signed with an expired key (SHA256:shipped, expired 2020-01-01T00:00:00.000Z)",
    );

    useEmbedded([trustedKey(npm)]);
    await expect(
      verify([{ keyid: npm.keyid, sig: signature(npm, "other payload").sig }]),
    ).rejects.toThrow("Signature does not match");

    await expect(verify([])).rejects.toThrow("No compatible signature found in package metadata");
    await expect(verify(undefined)).rejects.toThrow(
      "No compatible signature found in package metadata",
    );

    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("makes no request when COREPACK_INTEGRITY_KEYS pins the store — cache included", async () => {
    const rotated = makeKeypair("SHA256:rotated");
    useEmbedded([]);
    serveKeys([trustedKey(rotated)]);
    // Already on disk, and still not consulted: a pinned store is final.
    seedCache([trustedKey(rotated)]);
    process.env.COREPACK_INTEGRITY_KEYS = JSON.stringify({
      [DEFAULT_REGISTRY]: [trustedKey(makeKeypair("SHA256:pinned"))],
    });

    await expect(verify([signature(rotated)])).rejects.toBeInstanceOf(UntrustedKeyidError);

    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("skips the fetch under COREPACK_ENABLE_NETWORK=0 but still reads the cache", async () => {
    const rotated = makeKeypair("SHA256:rotated");
    useEmbedded([trustedKey(makeKeypair("SHA256:shipped"))]);
    serveKeys([trustedKey(rotated)]);
    // Refreshed while the machine had a network; the machine no longer has one.
    seedCache([trustedKey(rotated)], Date.now() - 10 * REFRESH_INTERVAL);
    process.env.COREPACK_ENABLE_NETWORK = "0";

    await expect(verify([signature(rotated)])).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("decides against a refresh under COREPACK_ENABLE_NETWORK=0, cache or no cache", () => {
    // Asserted on the decision rather than on the socket, deliberately: `httpGet`
    // refuses under this flag by itself, so a request count cannot distinguish
    // §15.9's rule from its absence. The mutation that deletes the check is only
    // visible here.
    const rotated = makeKeypair("SHA256:rotated");
    const stale = { keys: [], fetchedAt: undefined };
    const signatures = [signature(rotated)];

    expect(shouldRefresh(stale, signatures)).toBe(true);

    process.env.COREPACK_ENABLE_NETWORK = "0";
    expect(shouldRefresh(stale, signatures)).toBe(false);
    // …and every other input, so the flag is not merely one term of an `&&`.
    expect(
      shouldRefresh({ keys: [], fetchedAt: Date.now() - 10 * REFRESH_INTERVAL }, signatures),
    ).toBe(false);
    expect(shouldRefresh(stale, undefined)).toBe(false);
  });

  it("uses a cached key that matches the keyid at any age", async () => {
    const rotated = makeKeypair("SHA256:rotated");
    useEmbedded([]);
    serveKeys([trustedKey(rotated)]);
    seedCache([trustedKey(rotated)], Date.now() - 365 * 24 * 60 * 60 * 1000);

    await expect(verify([signature(rotated)])).resolves.toBeUndefined();

    // The steady state after a rotation: the answer is on disk, so no request is
    // made however old the file is.
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("suppresses a fruitless refresh for the interval, then tries again", async () => {
    const rotated = makeKeypair("SHA256:rotated");
    useEmbedded([]);
    serveKeys([trustedKey(rotated)]);
    // A cache that cannot explain this signature, written a moment ago.
    seedCache([trustedKey(makeKeypair("SHA256:unrelated"))], Date.now() - 1000);

    await expect(verify([signature(rotated)])).rejects.toBeInstanceOf(UntrustedKeyidError);
    expect(fetchMock).toHaveBeenCalledTimes(0);

    // Past the interval, the same run refreshes and succeeds.
    seedCache([trustedKey(makeKeypair("SHA256:unrelated"))], Date.now() - REFRESH_INTERVAL - 1000);
    await expect(verify([signature(rotated)])).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports the trust error, not the transport one, when the refresh fails", async () => {
    const rotated = makeKeypair("SHA256:rotated");
    useEmbedded([trustedKey(makeKeypair("SHA256:shipped"))]);
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(verify([signature(rotated)])).rejects.toBeInstanceOf(UntrustedKeyidError);

    // One attempt, not §15.5's three: this is a repair on an already-failing path.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Nothing was cached, so the next run is free to try again immediately.
    expect(readKeysCache().fetchedAt).toBeUndefined();
  });

  it("reports the refreshed store in the diagnostic", async () => {
    useEmbedded([trustedKey(makeKeypair("SHA256:shipped"))]);
    serveKeys([trustedKey(makeKeypair("SHA256:rotated"))]);

    await expect(verify([signature(makeKeypair("SHA256:unknown"))])).rejects.toThrow(
      /SHA256:rotated/,
    );
  });
});

/* -------------------------------------------------------------------------- */

describe("the keys cache — §15.9, §07.8", () => {
  it("round-trips through the cache file with a timestamp", () => {
    const key = trustedKey(makeKeypair("SHA256:written"));
    writeKeysCache([key]);

    const parsed = JSON.parse(cacheFile()) as {
      version: number;
      registries: Record<string, { fetchedAt: string; keys: TrustedKey[] }>;
    };
    expect(parsed.version).toBe(KEYS_CACHE_VERSION);
    expect(Object.keys(parsed.registries)).toEqual([DEFAULT_REGISTRY]);
    expect(parsed.registries[DEFAULT_REGISTRY]!.keys).toEqual([key]);
    expect(readKeysCache().keys).toEqual([key]);
  });

  it("treats every damaged shape as 'nothing cached'", () => {
    const target = join(home, KEYS_CACHE_NAME);
    const key = trustedKey(makeKeypair("SHA256:k"));

    expect(readKeysCache()).toEqual({ keys: [], fetchedAt: undefined });

    for (const content of [
      "",
      "{",
      "null",
      "[]",
      `"a string"`,
      JSON.stringify({ version: 2, registries: { [DEFAULT_REGISTRY]: { keys: [key] } } }),
      JSON.stringify({ version: KEYS_CACHE_VERSION, registries: null }),
      JSON.stringify({ version: KEYS_CACHE_VERSION, registries: [] }),
      // An entry for an origin §15.10 forbids auto-fetching keys from is ignored
      // rather than adopted.
      JSON.stringify({
        version: KEYS_CACHE_VERSION,
        registries: { "https://npm.internal.example": { fetchedAt: "2026-01-01", keys: [key] } },
      }),
    ]) {
      writeFileSync(target, content);
      expect(readKeysCache(), content).toEqual({ keys: [], fetchedAt: undefined });
    }
  });

  it("keeps usable keys when only the timestamp is damaged", () => {
    const key = trustedKey(makeKeypair("SHA256:k"));
    writeFileSync(
      join(home, KEYS_CACHE_NAME),
      JSON.stringify({
        version: KEYS_CACHE_VERSION,
        registries: { [DEFAULT_REGISTRY]: { fetchedAt: "not a date", keys: [key] } },
      }),
    );

    // Usable, and due for a refresh — the two are independent.
    expect(readKeysCache()).toEqual({ keys: [key], fetchedAt: undefined });
  });

  it("never fails a run over an unwritable home (§07.8)", () => {
    // A *file* where the home directory should be: `mkdirSync` throws ENOTDIR,
    // and the run carries on.
    const blocked = join(mkdtempSync(join(tmpdir(), "pipack-trust-ro-")), "home");
    roots.push(blocked);
    writeFileSync(blocked, "not a directory");
    process.env.COREPACK_HOME = blocked;

    expect(() => writeKeysCache([trustedKey(makeKeypair("SHA256:k"))])).not.toThrow();
    expect(readKeysCache()).toEqual({ keys: [], fetchedAt: undefined });
  });
});

/* -------------------------------------------------------------------------- */

describe("sanitiseKeys / mergeKeys / fetchNpmKeys", () => {
  it("drops entries that could never be selected, and defaults the unused fields", () => {
    expect(sanitiseKeys("not an array")).toEqual([]);
    expect(
      sanitiseKeys([
        null,
        "string",
        [],
        { keyid: "SHA256:no-key" },
        { key: "MFk", expires: null },
        { keyid: 7, key: "MFk" },
        { keyid: "SHA256:a", key: "MFk", expires: 12 },
        { keyid: "SHA256:b", key: "MFk", expires: "2030-01-01T00:00:00.000Z" },
        { keyid: "SHA256:c", key: "MFk" },
      ]),
    ).toEqual([
      {
        expires: "2030-01-01T00:00:00.000Z",
        keyid: "SHA256:b",
        keytype: "",
        scheme: "",
        key: "MFk",
      },
      { expires: null, keyid: "SHA256:c", keytype: "", scheme: "", key: "MFk" },
    ]);
  });

  it("keeps the embedded walk order and drops a keyid seen twice", () => {
    const a = trustedKey(makeKeypair("SHA256:a"));
    const b = trustedKey(makeKeypair("SHA256:b"));
    const shadow = { ...trustedKey(makeKeypair("SHA256:a")), expires: "1999-01-01" };

    expect(mergeKeys([a], [shadow, b]).map((key) => key.keyid)).toEqual(["SHA256:a", "SHA256:b"]);
    // The embedded entry wins outright: a refresh may add keyids, never redefine
    // or expire the ones this build shipped.
    expect(mergeKeys([a], [shadow, b])[0]).toBe(a);
  });

  it("answers undefined for a document that carries no usable key", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ keys: [{ nope: true }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(fetchNpmKeys()).resolves.toBeUndefined();

    fetchMock.mockResolvedValue(new Response("<html>", { status: 404 }));
    await expect(fetchNpmKeys()).resolves.toBeUndefined();
  });

  it("asks npm's registry, whatever registry is configured", async () => {
    process.env.COREPACK_NPM_REGISTRY = "https://npm.internal.example";
    try {
      serveKeys([trustedKey(makeKeypair("SHA256:k"))]);
      await expect(fetchNpmKeys()).resolves.toHaveLength(1);
      expect(fetchMock.mock.calls[0]![0]).toBe("https://registry.npmjs.org/-/npm/v1/keys");
    } finally {
      delete process.env.COREPACK_NPM_REGISTRY;
    }
  });

  it("sends no credentials, so a token scoped elsewhere cannot leak to npm", async () => {
    process.env.COREPACK_NPM_TOKEN = "secret-token";
    try {
      serveKeys([trustedKey(makeKeypair("SHA256:k"))]);
      await fetchNpmKeys();
      const headers = new Headers(
        (fetchMock.mock.calls[0]![1] as RequestInit | undefined)?.headers as HeadersInit,
      );
      expect(headers.get("authorization")).toBeNull();
    } finally {
      delete process.env.COREPACK_NPM_TOKEN;
    }
  });
});
