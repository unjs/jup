import { createHash, generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UsageError } from "../../src/errors.ts";
import {
  assertSupportedAlgo,
  compareDigest,
  hashStream,
  parseSri,
  shouldSkipIntegrityCheck,
  verifySignature,
} from "../../src/verify/integrity.ts";
import type { RegistrySignature, TrustedKey } from "../../src/types.ts";

/* -------------------------------------------------------------------------- */
/* Helpers — real keys, real signatures, no fixtures                           */
/* -------------------------------------------------------------------------- */

const REGISTRY = "https://registry.npmjs.org";

interface Keypair {
  keyid: string;
  spki: string;
  privateKey: KeyObject;
}

function makeKeypair(keyid: string, namedCurve = "prime256v1"): Keypair {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve });
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

/** The signed statement of §06.3: `<packageName>@<version>:<integrity>`, DER `(r, s)`. */
function signPayload(keypair: Keypair, payload: string): string {
  return sign("sha256", Buffer.from(payload, "utf8"), keypair.privateKey).toString("base64");
}

/**
 * The tests inject their trust store through `COREPACK_INTEGRITY_KEYS` rather
 * than leaning on the embedded one, so they are independent of which npm keys
 * happen to be shipped today.
 */
function useTrustStore(keys: TrustedKey[], shape: "origin" | "legacy" = "origin"): void {
  process.env.COREPACK_INTEGRITY_KEYS = JSON.stringify(
    shape === "legacy" ? { npm: keys } : { [REGISTRY]: keys },
  );
}

const PACKAGE = "@yarnpkg/cli-dist";
const VERSION = "4.14.1";
const INTEGRITY = `sha512-${Buffer.alloc(64, 7).toString("base64")}`;
const PAYLOAD = `${PACKAGE}@${VERSION}:${INTEGRITY}`;

function verify(signatures: RegistrySignature[] | undefined): void {
  verifySignature({
    signatures,
    integrity: INTEGRITY,
    packageName: PACKAGE,
    version: VERSION,
    registryOrigin: REGISTRY,
  });
}

afterEach(() => {
  delete process.env.COREPACK_INTEGRITY_KEYS;
});

/* -------------------------------------------------------------------------- */

describe("verifySignature — §06.3", () => {
  it("accepts a valid signature from a trusted key (test 74)", () => {
    const npm = makeKeypair("SHA256:npm-primary");
    useTrustStore([trustedKey(npm)]);

    expect(() => verify([{ keyid: npm.keyid, sig: signPayload(npm, PAYLOAD) }])).not.toThrow();
  });

  it('accepts the legacy {"npm": [...]} store shape (§06.4)', () => {
    const npm = makeKeypair("SHA256:npm-legacy");
    useTrustStore([trustedKey(npm)], "legacy");

    expect(() => verify([{ keyid: npm.keyid, sig: signPayload(npm, PAYLOAD) }])).not.toThrow();
  });

  it("walks trusted keys in order and stops at the first match", () => {
    const first = makeKeypair("SHA256:first");
    const second = makeKeypair("SHA256:second");
    useTrustStore([trustedKey(first), trustedKey(second)]);

    // Both keyids are present; only the *first* trusted key is consulted, so a
    // bogus signature under the second one must not rescue a bad first one.
    expect(() =>
      verify([
        { keyid: first.keyid, sig: signPayload(second, PAYLOAD) },
        { keyid: second.keyid, sig: signPayload(second, PAYLOAD) },
      ]),
    ).toThrow("Signature does not match");
  });

  it("rejects a missing or empty signature list (test 73)", () => {
    useTrustStore([trustedKey(makeKeypair("SHA256:npm-primary"))]);

    expect(() => verify(undefined)).toThrow("No compatible signature found in package metadata");
    expect(() => verify([])).toThrow("No compatible signature found in package metadata");
  });

  it("rejects a signature from an untrusted key (test 73)", () => {
    const trusted = makeKeypair("SHA256:npm-primary");
    const rogue = makeKeypair("SHA256:rogue");
    useTrustStore([trustedKey(trusted)]);

    let thrown: unknown;
    try {
      verify([{ keyid: rogue.keyid, sig: signPayload(rogue, PAYLOAD) }]);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(UsageError);
    expect((thrown as Error).message).toContain("The package was not signed by any trusted keys:");
    // The details are pretty-printed so a user can see what was offered.
    expect((thrown as Error).message).toContain(rogue.keyid);
    expect((thrown as Error).message).toContain("\n  ");
  });

  it("rejects a matched signature that carries no sig", () => {
    const npm = makeKeypair("SHA256:npm-primary");
    useTrustStore([trustedKey(npm)]);

    expect(() => verify([{ keyid: npm.keyid, sig: "" }])).toThrow(
      "The package was not signed by any trusted keys:",
    );
  });

  /*
   * Entries reach §06.3 exactly as the registry sent them, so a malformed one
   * must take step 4's branch (and appear in its diagnostic) rather than being
   * dropped — dropping them all reported step 1 instead — or crashing.
   */
  it("rejects an entry with no keyid, reporting it in the diagnostic", () => {
    const npm = makeKeypair("SHA256:npm-primary");
    useTrustStore([trustedKey(npm)]);

    let thrown: unknown;
    try {
      verify([{ sig: signPayload(npm, PAYLOAD) }]);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(UsageError);
    expect((thrown as Error).message).toContain("The package was not signed by any trusted keys:");
    expect((thrown as Error).message).not.toContain("No compatible signature found");
  });

  it("survives a null entry in the signatures array", () => {
    const npm = makeKeypair("SHA256:npm-primary");
    useTrustStore([trustedKey(npm)]);

    // A packument is untrusted input: `null` in the array is malformed data,
    // not a reason to throw a `TypeError` with a stack.
    const signatures = [null, { keyid: npm.keyid, sig: signPayload(npm, PAYLOAD) }];
    expect(() => verify(signatures as unknown as RegistrySignature[])).not.toThrow();
  });

  it("rejects a mismatched keypair (test 75)", () => {
    const trusted = makeKeypair("SHA256:npm-primary");
    const other = makeKeypair("SHA256:other");
    useTrustStore([trustedKey(trusted)]);

    // Right keyid, signature made with a different private key.
    expect(() => verify([{ keyid: trusted.keyid, sig: signPayload(other, PAYLOAD) }])).toThrow(
      "Signature does not match",
    );
  });

  it("rejects a signature over a different payload", () => {
    const npm = makeKeypair("SHA256:npm-primary");
    useTrustStore([trustedKey(npm)]);

    expect(() =>
      verify([{ keyid: npm.keyid, sig: signPayload(npm, `${PACKAGE}@4.14.2:${INTEGRITY}`) }]),
    ).toThrow("Signature does not match");
  });

  it("treats a malformed signature as a mismatch, not a crash", () => {
    const npm = makeKeypair("SHA256:npm-primary");
    useTrustStore([trustedKey(npm)]);

    expect(() => verify([{ keyid: npm.keyid, sig: "bm90LWEtc2lnbmF0dXJl" }])).toThrow(
      "Signature does not match",
    );
  });
});

describe("verifySignature — key expiry (§14.4, test 82)", () => {
  it("fails naming the key when the only match is expired", () => {
    const npm = makeKeypair("SHA256:npm-expired");
    const expires = "2025-01-29T00:00:00.000Z";
    useTrustStore([trustedKey(npm, expires)]);

    // The signature itself is perfectly valid: expiry alone must fail the run.
    expect(() => verify([{ keyid: npm.keyid, sig: signPayload(npm, PAYLOAD) }])).toThrow(
      `The package was signed with an expired key (${npm.keyid}, expired ${expires})`,
    );
  });

  it("skips an expired key in favour of a live one later in the list", () => {
    const dead = makeKeypair("SHA256:npm-expired");
    const live = makeKeypair("SHA256:npm-primary");
    useTrustStore([trustedKey(dead, "2025-01-29T00:00:00.000Z"), trustedKey(live)]);

    expect(() =>
      verify([
        { keyid: dead.keyid, sig: signPayload(dead, PAYLOAD) },
        { keyid: live.keyid, sig: signPayload(live, PAYLOAD) },
      ]),
    ).not.toThrow();
  });

  it("honours a future expiry as live", () => {
    const npm = makeKeypair("SHA256:npm-primary");
    useTrustStore([trustedKey(npm, "2999-01-01T00:00:00.000Z")]);

    expect(() => verify([{ keyid: npm.keyid, sig: signPayload(npm, PAYLOAD) }])).not.toThrow();
  });
});

describe("verifySignature — curve validation (§06.3)", () => {
  it("rejects a key that is not P-256 rather than mis-verifying", () => {
    const p384 = makeKeypair("SHA256:npm-p384", "secp384r1");
    useTrustStore([trustedKey(p384)]);

    expect(() => verify([{ keyid: p384.keyid, sig: signPayload(p384, PAYLOAD) }])).toThrow(
      /expected an ECDSA P-256 public key/,
    );
  });

  it("rejects unusable key material", () => {
    const npm = makeKeypair("SHA256:npm-primary");
    useTrustStore([{ ...trustedKey(npm), key: "bm90LWEta2V5" }]);

    expect(() => verify([{ keyid: npm.keyid, sig: signPayload(npm, PAYLOAD) }])).toThrow(
      /Invalid trusted key/,
    );
  });
});

describe("parseSri — §14.12", () => {
  it("parses sha512 without assuming the prefix length", () => {
    const digest = createHash("sha512").update("hello").digest();
    const { algo, hex } = parseSri(`sha512-${digest.toString("base64")}`);

    expect(algo).toBe("sha512");
    expect(hex).toBe(digest.toString("hex"));
    expect(hex).toHaveLength(128);
  });

  it("parses sha256 — the case corepack's slice(7) gets silently wrong", () => {
    const digest = createHash("sha256").update("hello").digest();
    const { algo, hex } = parseSri(`sha256-${digest.toString("base64")}`);

    // corepack keeps the payload (the prefix happens to be 7 chars) but then
    // hashes the tarball with sha512, so the comparison is meaningless. The
    // algorithm has to come out of the string.
    expect(algo).toBe("sha256");
    expect(hex).toBe(digest.toString("hex"));
    expect(hex).toHaveLength(64);
  });

  it("parses an algorithm whose prefix is not 7 characters", () => {
    const digest = createHash("sha1").update("hello").digest();
    const sri = `sha1-${digest.toString("base64")}`;

    expect(parseSri(sri)).toEqual({ algo: "sha1", hex: digest.toString("hex") });
    // slice(7) would have eaten two characters of base64 payload.
    expect(Buffer.from(sri.slice(7), "base64").toString("hex")).not.toBe(digest.toString("hex"));
  });

  it("ignores SRI options and extra entries", () => {
    const digest = createHash("sha384").update("hello").digest();
    const first = `sha384-${digest.toString("base64")}?foo=bar`;

    expect(parseSri(`${first} sha512-ignored`).hex).toBe(digest.toString("hex"));
  });

  it("rejects an unsupported algorithm", () => {
    const digest = createHash("sha256").update("hello").digest();

    expect(() => parseSri(`md5-${digest.toString("base64")}`)).toThrow(
      "Unsupported hash algorithm 'md5' in the packageManager field",
    );
    expect(() => parseSri("sha512")).toThrow(/Unsupported hash algorithm/);
    expect(() => parseSri("")).toThrow(/Unsupported hash algorithm/);
  });

  it("rejects a digest whose length contradicts its algorithm", () => {
    expect(() => parseSri(`sha512-${createHash("sha256").update("x").digest("base64")}`)).toThrow(
      /Unsupported hash algorithm/,
    );
  });

  it("exposes the hex digest of a verified SRI string", () => {
    const digest = createHash("sha512").update("hello").digest();

    expect(parseSri(`sha512-${digest.toString("base64")}`).hex).toBe(digest.toString("hex"));
  });
});

describe("assertSupportedAlgo — §14.11", () => {
  it("accepts every allowlisted algorithm", () => {
    for (const algo of ["sha1", "sha224", "sha256", "sha384", "sha512"]) {
      expect(assertSupportedAlgo(algo)).toBe(algo);
    }
  });

  it("rejects anything else with a UsageError", () => {
    expect(() => assertSupportedAlgo("md5")).toThrow(UsageError);
    expect(() => assertSupportedAlgo("blake3")).toThrow(
      "Unsupported hash algorithm 'blake3' in the packageManager field",
    );
  });

  it("stays quiet for an algorithm the user did not choose (§06.2)", () => {
    // Every embedded default is sha1 (§02.5), so an unconditional warning means
    // a plain `yarn` in an unpinned directory scolds the user about a hash we
    // picked. §06.2 scopes the warning to a `packageManager` field.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(assertSupportedAlgo("sha1")).toBe("sha1");

    expect(warn).not.toHaveBeenCalled();
  });
});

describe("compareDigest — §14.11", () => {
  it("is true for equal digests", () => {
    const digest = createHash("sha512").update("hello").digest("hex");
    expect(compareDigest(digest, digest)).toBe(true);
  });

  it("is false for unequal digests of the same length", () => {
    const a = createHash("sha512").update("hello").digest("hex");
    const b = createHash("sha512").update("world").digest("hex");
    expect(compareDigest(a, b)).toBe(false);
    // A single flipped character is still a mismatch.
    expect(compareDigest(a, `${a.slice(0, -1)}${a.endsWith("a") ? "b" : "a"}`)).toBe(false);
  });

  it("is false for different-length inputs without throwing", () => {
    const digest = createHash("sha512").update("hello").digest("hex");
    expect(compareDigest(digest, digest.slice(0, 32))).toBe(false);
    expect(compareDigest("", digest)).toBe(false);
    expect(compareDigest("", "")).toBe(true);
  });
});

describe("shouldSkipIntegrityCheck — §06.4 (test 80)", () => {
  it('is true for exactly "" and "0"', () => {
    delete process.env.COREPACK_INTEGRITY_KEYS;
    expect(shouldSkipIntegrityCheck()).toBe(false);

    process.env.COREPACK_INTEGRITY_KEYS = "0";
    expect(shouldSkipIntegrityCheck()).toBe(true);

    process.env.COREPACK_INTEGRITY_KEYS = "";
    expect(shouldSkipIntegrityCheck()).toBe(true);

    process.env.COREPACK_INTEGRITY_KEYS = JSON.stringify({ npm: [] });
    expect(shouldSkipIntegrityCheck()).toBe(false);

    process.env.COREPACK_INTEGRITY_KEYS = "1";
    expect(shouldSkipIntegrityCheck()).toBe(false);
  });
});

describe("hashStream / hashFile — §06.2", () => {
  it("digests a web stream as it flows", async () => {
    const chunks = ["hello ", "integrity", " world"];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(new TextEncoder().encode(chunk));
        }
        controller.close();
      },
    });

    await expect(hashStream(stream, "sha512")).resolves.toBe(
      createHash("sha512").update(chunks.join("")).digest("hex"),
    );
  });

  it("validates the algorithm before hashing", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });

    await expect(hashStream(stream, "md5")).rejects.toThrow(/Unsupported hash algorithm/);
  });
});
