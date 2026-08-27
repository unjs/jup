/**
 * Integrity and trust — §06, §14.4, §14.11, §14.12.
 *
 * Three independent mechanisms applied in a specific order; §06.1's decision
 * table says which one fires when, and two of its consequences must **not** be
 * accidentally "fixed": a user-supplied hash overrides signature verification,
 * and that is intended.
 *
 * Crypto choice: `node:crypto` throughout rather than `crypto.subtle`.
 * `verifySignature` is synchronous and `subtle.verify` is not; `subtle` also
 * only accepts IEEE-P1363 `r‖s` signatures, while npm publishes DER-encoded
 * `(r, s)` (§06.3), and it exposes no way to read back the curve of an imported
 * key. `node:crypto` handles all three directly. On the hashing side `sha1` and
 * `sha224` — both of which appear in real `packageManager` pins (§06.2) — have
 * no WebCrypto equivalent at all, and `createHash` is the only streaming digest
 * available, so hashing is `node:crypto` too.
 */

import { createHash, createPublicKey, timingSafeEqual, verify as cryptoVerify } from "node:crypto";
import { createReadStream } from "node:fs";
import { ENV, readEnv } from "../config/env-vars.ts";
import { DEFAULT_REGISTRY, getTrustedKeys as getEmbeddedTrustedKeys } from "../config/keys.ts";
import { advisory, messages, UsageError } from "../errors.ts";
import type { RegistrySignature, TrustedKey, TrustStore } from "../types.ts";

/** §14.11 — explicit allowlist; anything else is a clear error, not a crash. */
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

/** §14.11 — a pin is not rejected for being weak, but it is called out once. */
const WEAK_HASH_ALGOS = new Set(["sha1", "md5"]);

const warnedWeakAlgos = new Set<string>();

/**
 * §14.4 — accept an otherwise-valid signature from an expired key, loudly.
 *
 * This was `false` once, on the reading that expiry should be enforceable and
 * that §14.4's leniency is only a SHOULD. The reading was defensible; the blast
 * radius was not. npm rotated its signing key on **2025-01-29**, and
 * `dist.signatures` is written at publish time and never rewritten, so *every*
 * artifact published before that date carries the old keyid — measured, each
 * with a fresh store:
 *
 * | spec | strict | lenient |
 * | --- | --- | --- |
 * | `yarn@1.22.19`, `yarn@1.22.22` | expired-key error | installs |
 * | `npm@9.9.4`, `npm@10.9.2` | expired-key error | installs |
 * | `pnpm@6.6.2`, `pnpm@8.15.0`, `pnpm@10.0.0` | expired-key error | installs |
 * | `pnpm@9.15.9`, `pnpm@10.15.0`, `npm@11.6.0` | installs | installs |
 *
 * That is all of Yarn 1.x — last published in 2024, so it can never be re-signed
 * — plus every npm through 10.9.2 and most of pnpm's history. Corepack installs
 * every one of them. A project pinning `yarn@1.22.22` could not use this tool at
 * all, which costs more than the property being defended: with the registry
 * offering one key per rotation, strictness turns a *key* expiry into a
 * retroactive expiry of everything that key ever signed.
 *
 * What is kept is everything that makes the signature mean something. The ECDSA
 * check below runs first and must pass, so a forged or tampered artifact is
 * still refused — with `expiredKey`, which now fires only when the signature
 * does *not* verify. An expired key is never chosen over a live one (the loop
 * above skips it and keeps walking), and acceptance is never silent.
 *
 * The `sha1`-style option of accepting only signatures made *before* the expiry
 * was investigated and rejected: the publish time is not on this path. §05.1
 * requests the abbreviated packument, whose top-level keys are `name`,
 * `dist-tags`, `versions` and `modified` — no `time`. Only the full packument
 * carries `time[version]`, and fetching it would put a much larger response on
 * every install.
 */
const ACCEPT_EXPIRED_KEY_WITH_WARNING: boolean = true;

/**
 * @param userPinned Whether this algorithm came from the project's own
 * `packageManager` field. §06.2/§14.11 scope the weak-algorithm warning to a
 * *pin*, and that scoping is load-bearing: the embedded table's own defaults are
 * sha1 (§02.5), so warning unconditionally means every default install scolds the
 * user about a hash we chose and they cannot change. A warning nobody can act on
 * is noise, and noise is how real warnings get ignored.
 */
export function assertSupportedAlgo(algo: string, userPinned = false): HashAlgo {
  const normalized = algo.toLowerCase();
  if (!(SUPPORTED_HASH_ALGOS as readonly string[]).includes(normalized)) {
    throw new UsageError(messages.unsupportedHashAlgo(algo));
  }
  if (userPinned && WEAK_HASH_ALGOS.has(normalized) && !warnedWeakAlgos.has(normalized)) {
    warnedWeakAlgos.add(normalized);
    advisory(
      `! jup integrity warning: '${normalized}' is a weak hash algorithm; prefer sha256 or stronger`,
    );
  }
  return normalized as HashAlgo;
}

/** Hex digest of a stream, computed as it flows (§16.5). */
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
 * §14.12 — parse `<algo>-<base64>` properly; never `slice(7)`.
 *
 * Corepack assumes the SRI algorithm is always `sha512`, so a registry that
 * answers `sha256-…` yields a silently wrong expected digest. Real SRI strings
 * may carry several space-separated entries and `?opt` suffixes; the first
 * entry wins, and an algorithm outside the allowlist is an error rather than a
 * guess.
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

/** §14.11 — constant-time. */
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
 * §06.4, §15.10 — the trust store in force for one registry origin.
 *
 * `COREPACK_INTEGRITY_KEYS` **replaces** the embedded store (it never merges).
 * Both shapes are accepted: corepack's legacy `{"npm": [...]}`, which predates
 * per-origin trust and therefore applies to whichever registry is being used,
 * and the origin-keyed `{"https://registry.npmjs.org": [...]}` of §02.6.
 * Malformed JSON throws here, at verification time, not at startup (§06.4).
 *
 * Note the env var is ineligible in an env file (§14.5); `env.ts` drops it
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
 * §15.9 — "no trusted key matched the signature's keyid", distinguishably.
 *
 * The one failure a key *refresh* can repair, and the trigger `trust.ts` gates
 * on. Every other outcome of §06.3 is left as it was: a matched-but-unusable
 * signature, an expired key and a failed ECDSA check all describe a key we
 * already hold, so fetching more of them would only add a request to an answer
 * that is not going to change.
 *
 * A subclass rather than a flag, so §12.1's presentation is untouched:
 * `UsageError`'s `name` is inherited, the message is byte-identical, and
 * `main.ts` cannot tell the two apart.
 */
export class UntrustedKeyidError extends UsageError {}

/**
 * §06.3 — verify npm's ECDSA signature over `<packageName>@<version>:<integrity>`.
 *
 * Walks trusted keys **in order**, taking the first whose `keyid` matches a
 * signature. Per §14.4, expired keys are excluded from selection. The key
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
   * §15.9 — the trust store to walk, when it is not the configured one.
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
      // §14.4 — an expired key is never *selected*: the walk keeps going, so a
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
    // §15.9's one repairable failure — see {@link UntrustedKeyidError}. Note
    // that the branch above is deliberately *not* repairable: the keyid matched,
    // so a refresh would return the same key with the same expiry. (A packument
    // carrying both an expired and a fresh signature would be repairable in
    // principle; npm publishes one signature per version, and §15.9 scopes the
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
 * buy no safety and would reject legitimate keys — a custom registry is free to
 * sign on any curve OpenSSL supports, and corepack's own test registry mints
 * `sect239k1`.
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
