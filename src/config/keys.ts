/**
 * The embedded trust store — §02.6.
 *
 * `key` is a base64 DER SubjectPublicKeyInfo for an ECDSA public key; the keys
 * embedded here are NIST P-256, though §06.3 reads the curve from the key
 * material, so a store supplied for another registry need not be. Keyed
 * by registry origin so custom-registry trust is additive later; phase 1
 * populates only the default registry.
 *
 * Per §06.5 the `expires` field is honoured, and only unexpired keys should ship
 * — refreshed by the scheduled job in §16, Built-in table and trust keys.
 */

import type { TrustedKey, TrustStore } from "../types.ts";

export const DEFAULT_REGISTRY = "https://registry.npmjs.org";

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
 * Select the requested origin’s keys, followed by npm’s embedded keys, deduplicated by key ID. Never include keys belonging only to another custom origin. Compare parsed origins; fall back to literal equality for unparseable values.
 */
export function getTrustedKeys(
  registry: string = DEFAULT_REGISTRY,
  store: TrustStore = TRUST_KEYS,
): TrustedKey[] {
  const wanted = originOf(registry);

  const selected: TrustedKey[] = [];
  const seen = new Set<string>();

  const take = (origin: string): void => {
    for (const [configured, keys] of Object.entries(store)) {
      if (originOf(configured) !== origin || !Array.isArray(keys)) continue;
      for (const key of keys) {
        const keyid = (key as TrustedKey | undefined)?.keyid;
        if (typeof keyid === "string") {
          if (seen.has(keyid)) continue;
          seen.add(keyid);
        }
        selected.push(key);
      }
    }
  };

  take(wanted);
  if (wanted !== DEFAULT_REGISTRY) take(DEFAULT_REGISTRY);

  return selected;
}

/**
 * The origin a store key or a registry URL denotes.
 *
 * Falls back to the raw string when it does not parse: a store written with a
 * bare hostname still selects for a registry written the same way, which is
 * friendlier than dropping the entry and pretending nothing was configured.
 */
function originOf(value: string): string {
  try {
    const { origin } = new URL(value);
    // Opaque origins ("null") all compare equal, which must not read as a match.
    return origin === "null" ? value : origin;
  } catch {
    return value;
  }
}
