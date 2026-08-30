/**
 * Integrity uses synchronous `node:crypto`: npm signatures are DER ECDSA, key curves must be inspected, SHA-1/SHA-224 pins remain supported, and artifact hashes stream.
 */

const {
  createHash,
  createPublicKey,
  timingSafeEqual,
  verify: cryptoVerify,
} = process.getBuiltinModule("node:crypto");
const { createReadStream } = process.getBuiltinModule("node:fs");
import { ENV, readEnv } from "../config/env-vars.ts";
import { DEFAULT_REGISTRY, getTrustedKeys as getEmbeddedTrustedKeys } from "../config/keys.ts";
import { advisory, messages, UsageError } from "../errors-cold.ts";
import type { RegistrySignature, TrustedKey, TrustStore } from "../types.ts";

/** §06.2 — explicit allowlist; anything else is a clear error, not a crash. */
export const SUPPORTED_HASH_ALGOS = ["sha1", "sha224", "sha256", "sha384", "sha512"] as const;

export type HashAlgo = (typeof SUPPORTED_HASH_ALGOS)[number];

/** Digest sizes, used to reject SRI strings whose payload cannot be what it claims. */
const DIGEST_BYTES: Record<HashAlgo, number> = {
  sha1: 20,
  sha224: 28,
  sha256: 32,
  sha384: 48,
  sha512: 64,
};

/** §06.2 — a pin is not rejected for being weak, but it is called out once. */
const WEAK_HASH_ALGOS = new Set(["sha1", "md5"]);

const warnedWeakAlgos = new Set<string>();

/**
 * Signatures outlive key expiry, so strict expiry would reject otherwise valid
 * releases. Acceptance still requires valid ECDSA verification, prefers live
 * keys, and warns; abbreviated packuments provide no publish time.
 */
const ACCEPT_EXPIRED_KEY_WITH_WARNING: boolean = true;

/**
 * Warn only for user-supplied weak pins; embedded SHA-1 defaults are not actionable.
 * @param userPinned Whether the project supplied the algorithm.
 */
export function assertSupportedAlgo(algo: string, userPinned = false): HashAlgo {
  const normalized = algo.toLowerCase();
  if (!(SUPPORTED_HASH_ALGOS as readonly string[]).includes(normalized)) {
    throw new UsageError(messages.unsupportedHashAlgo(algo));
  }
  if (userPinned && WEAK_HASH_ALGOS.has(normalized) && !warnedWeakAlgos.has(normalized)) {
    warnedWeakAlgos.add(normalized);
    advisory(
      `⚠ jup integrity warning: '${normalized}' is a weak hash algorithm; prefer sha256 or stronger`,
    );
  }
  return normalized as HashAlgo;
}

/** Hex digest of a stream, computed as it flows (§06.2). */
export async function hashStream(
  stream: ReadableStream<Uint8Array>,
  algo: string,
): Promise<string> {
  const hash = createHash(assertSupportedAlgo(algo));
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        hash.update(value);
      }
    }
  } finally {
    reader.releaseLock();
  }
  return hash.digest("hex");
}

export async function hashFile(path: string, algo: string): Promise<string> {
  const hash = createHash(assertSupportedAlgo(algo));
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Uint8Array);
  }
  return hash.digest("hex");
}

/**
 * §06.2 — parse `<algo>-<base64>` without assuming an algorithm. SRI strings
 * may carry multiple space-separated entries and `?opt` suffixes; the first
 * entry wins, and algorithms outside the allowlist are rejected.
 */
export function parseSri(integrity: string): { algo: HashAlgo; hex: string } {
  const entry = integrity.trim().split(/\s+/)[0] ?? "";
  const dash = entry.indexOf("-");
  if (dash <= 0) {
    throw new UsageError(messages.unsupportedHashAlgo(entry));
  }

  const algo = assertSupportedAlgo(entry.slice(0, dash));
  const base64 = entry.slice(dash + 1).split("?")[0] ?? "";
  const digest = Buffer.from(base64, "base64");

  if (digest.length !== DIGEST_BYTES[algo]) {
    throw new UsageError(messages.unsupportedHashAlgo(entry));
  }

  return { algo, hex: digest.toString("hex") };
}

/** §06.2 — constant-time. */
export function compareDigest(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(actual, "utf8");
  if (a.length !== b.length) {
    // Lengths are public (they follow from the algorithm), but the *contents*
    // must not leak through an early return, so still do one comparison.
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

/** §06.4 — true for exactly `""` and `"0"`. Any other value replaces the trust store. */
export function shouldSkipIntegrityCheck(): boolean {
  const raw = readEnv(ENV.INTEGRITY_KEYS);
  return raw === "" || raw === "0";
}

/**
 * §06.4 — the trust store in force for one registry origin.
 *
 * `COREPACK_INTEGRITY_KEYS` **replaces** the embedded store (it never merges).
 * Both compatibility shapes are accepted: `{"npm": [...]}` applies to the
 * active registry, while §02.6's form is keyed by registry origin.
 * Malformed JSON throws here, at verification time, not at startup (§06.4).
 *
 * Note the env var is ineligible in an env file (§03.2); `env.ts` drops it
 * before it can reach `process.env`, so reading it here is safe.
 */
export function getTrustedKeys(registryOrigin?: string): TrustedKey[] {
  const raw = readEnv(ENV.INTEGRITY_KEYS);

  // `""` / `"0"` disable verification outright; callers gate on
  // `shouldSkipIntegrityCheck()`, and neither value is a trust store, so fall
  // back to the embedded one rather than parsing them as JSON.
  if (raw === undefined || shouldSkipIntegrityCheck()) {
    return getEmbeddedTrustedKeys(registryOrigin ?? DEFAULT_REGISTRY);
  }

  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object") {
    return [];
  }

  const store = parsed as Record<string, unknown>;
  const legacy = store.npm;
  if (Array.isArray(legacy)) {
    return legacy as TrustedKey[];
  }

  return getEmbeddedTrustedKeys(registryOrigin ?? DEFAULT_REGISTRY, store as TrustStore);
}

/**
 * Marks an unmatched-key-ID failure so trust refresh can occur without changing `UsageError` presentation.
 */
export class UntrustedKeyidError extends UsageError {}

/**
 * §06.3 — verify npm's ECDSA signature over `<packageName>@<version>:<integrity>`.
 *
 * Walks trusted keys **in order**, taking the first whose `keyid` matches a
 * signature. Per §06.5, expired keys are excluded from selection. The key
 * material is a bare base64 DER SPKI; the signature is base64 DER `(r, s)`; the
 * curve is whatever that SPKI declares.
 */
export function verifySignature(input: {
  signatures: RegistrySignature[] | undefined;
  integrity: string;
  packageName: string;
  version: string;
  registryOrigin?: string;
  /**
   * §06.3 — the trust store to walk, when it is not the configured one.
   *
   * `trust.ts` passes the embedded set merged with the keys it just refreshed,
   * for the retry. Nothing else supplies it, so the ordinary path still reads
   * {@link getTrustedKeys} and the env override keeps its §06.4 meaning.
   */
  trustedKeys?: TrustedKey[];
}): void {
  const { signatures, integrity, packageName, version, registryOrigin } = input;

  if (!Array.isArray(signatures) || signatures.length === 0) {
    throw new Error(messages.noCompatibleSignature());
  }

  const trustedKeys = input.trustedKeys ?? getTrustedKeys(registryOrigin);

  let selected: { key: TrustedKey; signature: RegistrySignature } | undefined;
  let expired: { key: TrustedKey; signature: RegistrySignature; expires: string } | undefined;

  for (const key of trustedKeys) {
    // A registry-supplied entry may be any JSON value at all, so the comparison
    // must not assume an object: a `null` in the array is a malformed packument,
    // not a crash.
    const signature = signatures.find(
      (candidate) =>
        typeof candidate === "object" &&
        candidate !== null &&
        (candidate as RegistrySignature).keyid === key.keyid,
    );
    if (!signature) {
      continue;
    }
    const expiresAt = expiryOf(key);
    if (expiresAt !== undefined) {
      // §06.5 — an expired key is never *selected*: the walk keeps going, so a
      // live key later in the store always wins. The first expired match is
      // remembered only for the fallback below, which needs to name it.
      expired ??= { key, signature, expires: expiresAt };
      continue;
    }
    // §06.3 step 3: stop at the first trusted key that has a match, even if
    // that match turns out to be unusable.
    selected = { key, signature };
    break;
  }

  // The signed statement: no whitespace, UTF-8, `integrity` including its
  // `sha512-` prefix exactly as `dist.integrity` gave it.
  const payload = `${packageName}@${version}:${integrity}`;

  if (!selected) {
    if (expired) {
      if (ACCEPT_EXPIRED_KEY_WITH_WARNING && verifyEcdsa(expired.key, expired.signature, payload)) {
        advisory(
          messages.expiredKeyAccepted(packageName, version, expired.key.keyid, expired.expires),
        );
        return;
      }
      // The signature did not verify under the expired key either, so this is a
      // mismatch *and* a stale key. Naming the key is still §06.5's requirement
      // and still the more actionable half.
      throw new Error(messages.expiredKey(expired.key.keyid, expired.expires));
    }
    // §06.3's one repairable failure — see {@link UntrustedKeyidError}. Note
    // that the branch above is deliberately *not* repairable: the keyid matched,
    // so a refresh would return the same key with the same expiry. (A packument
    // carrying both an expired and a fresh signature would be repairable in
    // principle; npm publishes one signature per version, and §06.3 scopes the
    // refresh to "no trusted key matched" rather than to "nothing usable
    // matched".)
    throw new UntrustedKeyidError(messages.notSignedByTrustedKeys({ signatures, trustedKeys }));
  }

  // §06.3 step 4 — "the matched signature has no `.sig`". A non-string `sig` is
  // the same thing: unusable, and reported rather than fed to the decoder.
  if (typeof selected.signature.sig !== "string" || selected.signature.sig === "") {
    throw new UsageError(messages.notSignedByTrustedKeys({ signatures, trustedKeys }));
  }

  if (!verifyEcdsa(selected.key, selected.signature, payload)) {
    throw new Error(messages.signatureMismatch());
  }
}

/** `undefined` when the key is live; the ISO timestamp when it has expired. */
function expiryOf(key: TrustedKey): string | undefined {
  const { expires } = key;
  if (typeof expires !== "string" || expires.length === 0) {
    return undefined;
  }
  const at = Date.parse(expires);
  // An unparseable timestamp is treated as "no expiry" rather than as an
  // instant expiry: refusing every key over a malformed field would be a
  // denial of service, and the ECDSA check is what actually carries the trust.
  if (Number.isNaN(at) || at > Date.now()) {
    return undefined;
  }
  return expires;
}

/**
 * ECDSA-with-SHA-256 over whatever curve the trusted key declares.
 *
 * `key.key` is a bare base64 DER SubjectPublicKeyInfo, so the PEM armour is put
 * back on here. §06.3's rule is that the signature algorithm is *generic*
 * ECDSA-with-SHA-256 and the curve comes from the key material — `keytype` and
 * `scheme` (both `ecdsa-sha2-nistp256` in npm's own store) are never consulted.
 * Its P-256 assertion is scoped to "a native implementation targeting only
 * P-256", which must reject other curves rather than mis-verify them; running on
 * `node:crypto`, this one targets no curve in particular, so pinning P-256 would
 * buy no safety and would reject legitimate keys: custom registries may use any
 * curve OpenSSL supports, including `sect239k1`.
 *
 * The `"ec"` half of the guard stays. It is not a curve restriction but a
 * key-*type* one: an RSA or Ed25519 SPKI parses happily and would then be handed
 * to a verifier under `dsaEncoding: "der"`, where the DER `(r, s)` decoding of
 * §06.3 means nothing. Refusing it by name beats discovering it as an opaque
 * false.
 */
function verifyEcdsa(key: TrustedKey, signature: RegistrySignature, payload: string): boolean {
  const pem = `-----BEGIN PUBLIC KEY-----\n${key.key}\n-----END PUBLIC KEY-----`;

  let publicKey;
  try {
    publicKey = createPublicKey({ key: pem, format: "pem", type: "spki" });
  } catch (error) {
    throw new Error(`Invalid trusted key ${key.keyid}: ${(error as Error).message}`);
  }

  if (publicKey.asymmetricKeyType !== "ec") {
    throw new Error(`Unsupported trusted key ${key.keyid}: expected an ECDSA public key`);
  }

  // `dsaEncoding: "der"` is the default, but npm's signatures being DER `(r, s)`
  // rather than a raw 64-byte `r‖s` is exactly the thing to be explicit about.
  try {
    return cryptoVerify(
      "sha256",
      Buffer.from(payload, "utf8"),
      { key: publicKey, dsaEncoding: "der" },
      Buffer.from(signature.sig ?? "", "base64"),
    );
  } catch {
    // A malformed signature is a mismatch, not a crash.
    return false;
  }
}
