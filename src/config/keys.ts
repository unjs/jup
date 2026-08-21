/**
 * The embedded trust store — §02.6.
 *
 * `key` is a base64 DER SubjectPublicKeyInfo for a NIST P-256 public key. Keyed
 * by registry origin so §15.10's custom-registry trust is additive later; phase 1
 * populates only the default registry.
 *
 * Per §14.4 the `expires` field is honoured, and only unexpired keys should ship
 * — refreshed by the scheduled job in §16.9.
 */

import type { TrustedKey, TrustStore } from "../types.ts";

export const DEFAULT_REGISTRY = "https://registry.npmjs.org";

/**
 * §02.6's first key (`SHA256:jl3bwswu80PjjokCgh0o2w5c2U4LhQAE57gj9cz1kzA`) expired
 * on 2025-01-29 and is deliberately not shipped — §14.4 calls it dead weight.
 */
export const TRUST_KEYS: TrustStore = {
  [DEFAULT_REGISTRY]: [
    {
      expires: null,
      keyid: "SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U",
      keytype: "ecdsa-sha2-nistp256",
      scheme: "ecdsa-sha2-nistp256",
      key: "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEY6Ya7W++7aUPzvMTrezH6Ycx3c+HOKYCcNGybJZSCJq/fd7Qa8uuAKtdIkUQtQiEKERhAmE5lMMJhP8OkDOa2g==",
    },
  ],
};

/**
 * §15.10 seam — trust is looked up by registry origin, never by the literal
 * string `npm`. Callers pass a registry URL; only its origin is significant.
 */
export function getTrustedKeys(
  registry: string = DEFAULT_REGISTRY,
  store: TrustStore = TRUST_KEYS,
): TrustedKey[] {
  return store[originOf(registry)] ?? [];
}

function originOf(registry: string): string {
  try {
    return new URL(registry).origin;
  } catch {
    return registry;
  }
}
