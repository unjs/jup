/**
 * Integrity and trust — §06, §14.4, §14.11, §14.12.
 *
 * Three independent mechanisms applied in a specific order; §06.1's decision
 * table says which one fires when, and two of its consequences must **not** be
 * accidentally "fixed": a user-supplied hash overrides signature verification,
 * and that is intended.
 */

import type { RegistrySignature, TrustedKey } from "./types.ts";

/** §14.11 — explicit allowlist; anything else is a clear error, not a crash. */
export const SUPPORTED_HASH_ALGOS = ["sha1", "sha224", "sha256", "sha384", "sha512"] as const;

export type HashAlgo = (typeof SUPPORTED_HASH_ALGOS)[number];

export function assertSupportedAlgo(algo: string): HashAlgo {
  throw new Error(`TODO(T8): assertSupportedAlgo(${algo})`);
}

/** Hex digest of a stream, computed as it flows (§16.5). */
export function hashStream(stream: ReadableStream<Uint8Array>, algo: string): Promise<string> {
  throw new Error(`TODO(T8): hashStream(${algo})`);
}

export function hashFile(path: string, algo: string): Promise<string> {
  throw new Error(`TODO(T8): hashFile(${path}, ${algo})`);
}

/** §14.12 — parse `<algo>-<base64>` properly; never `slice(7)`. */
export function parseSri(integrity: string): { algo: HashAlgo; hex: string } {
  throw new Error(`TODO(T8): parseSri(${integrity})`);
}

/** §14.11 — constant-time. */
export function compareDigest(expected: string, actual: string): boolean {
  throw new Error(`TODO(T8): compareDigest(${expected}, ${actual})`);
}

/** §06.4 — true for exactly `""` and `"0"`. Any other value replaces the trust store. */
export function shouldSkipIntegrityCheck(): boolean {
  throw new Error(`TODO(T8): shouldSkipIntegrityCheck()`);
}

export function getTrustedKeys(registryOrigin?: string): TrustedKey[] {
  throw new Error(`TODO(T8): getTrustedKeys(${registryOrigin})`);
}

/**
 * §06.3 — verify npm's ECDSA signature over `<packageName>@<version>:<integrity>`.
 *
 * Walks trusted keys **in order**, taking the first whose `keyid` matches a
 * signature. Per §14.4, expired keys are excluded from selection. The key
 * material is a bare base64 DER SPKI; the signature is base64 DER `(r, s)`. The
 * parsed curve must be P-256.
 */
export function verifySignature(input: {
  signatures: RegistrySignature[] | undefined;
  integrity: string;
  packageName: string;
  version: string;
  registryOrigin?: string;
}): void {
  throw new Error(`TODO(T8): verifySignature(${input.packageName}@${input.version})`);
}
