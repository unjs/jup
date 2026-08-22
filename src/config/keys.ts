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
 * §06.3 step 2 / §15.10 — the keys that may vouch for an artifact served by one
 * registry origin: **that origin's own keys, then the npm origin's**.
 *
 * Two rules, pulling in opposite directions, and both are load-bearing.
 *
 * *Every* origin gets npm's keys, because §06.6's threat table depends on it: a
 * compromised mirror serving unpinned versions is defended precisely because
 * npm's signature travels with the package and the mirror cannot forge it.
 * Selecting *only* by origin returned an empty list for every custom registry,
 * so verification hard-failed on exactly the deployments the defence exists for
 * — the bug this function was corrected for once already.
 *
 * No origin gets *another custom origin's* keys, because that is what §15.10
 * means by "keyed by registry origin, not by the literal string `npm`". A user
 * who configures keys for their Cloudsmith mirror has said nothing about who may
 * sign packages from `registry.npmjs.org`, and flattening the store — the shape
 * this had while §15.10 was outstanding — silently widened every configured key
 * to every registry. Note that the *embedded* store carries the npm origin
 * alone, so on a machine that configures nothing the two rules produce exactly
 * the same list, and a test built on the embedded store alone cannot tell them
 * apart (`test/unit/config.test.ts` uses a two-origin store for precisely that
 * reason).
 *
 * Comparison is by parsed **origin**, so a trailing slash, a registry URL with a
 * path (`https://artifactory.corp/api/npm/npm-remote`) and a differing host case
 * all land on the same entry. An unparseable key or registry falls back to a
 * literal string comparison rather than being dropped.
 *
 * Order is §06.3 step 3's walk order: the origin's own keys first — the more
 * specific statement — then npm's, with a keyid seen twice kept only at its
 * first position.
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
