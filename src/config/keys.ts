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

import type { TrustStore } from "../types.ts";

export const DEFAULT_REGISTRY = "https://registry.npmjs.org";

export const TRUST_KEYS: TrustStore = {
  // TODO(T2): transcribe §02.6, dropping keys that have already expired.
};
