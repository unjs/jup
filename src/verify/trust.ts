/**
 * §15.9 — trust-key freshness, decoupled from release cadence.
 *
 * Corepack bakes npm's signing keys into its bundle at release time, so when npm
 * rotated them in February 2025 (#612/#616) every released version broke
 * worldwide and the only remedy was a manual upgrade. This module is the other
 * half of that story: a cached, refreshable key set that is consulted **only**
 * when the embedded one has already failed to explain a signature.
 *
 * Four properties are load-bearing, and each is a rule below:
 *
 * * **A successful verification never touches this file or the network.** The
 *   refresh hangs off one branch of §06.3 — "no trusted key matched the
 *   signature's keyid" — and nothing else reads the cache, so §01.3's fast path
 *   and the ordinary cold install are byte-for-byte what they were.
 * * **Keys are fetched from `registry.npmjs.org` and nowhere else.** Not from
 *   `COREPACK_NPM_REGISTRY`, not from a `.npmrc` registry — see
 *   {@link KEYS_ENDPOINT}. This is §15.10's "never auto-fetched from that
 *   registry itself", and it is what keeps §15.9 from being the circular trust
 *   path the objection on #884 describes.
 * * **The fetched set is merged with the embedded one, never substituted for
 *   it.** An embedded key stays trusted until its own `expires` says otherwise;
 *   a refresh can only *add* keyids.
 * * **A damaged cache is not fatal.** Same precedent as `lastKnownGood.json`
 *   (§04.4, §07.8) and `jup.lock` (§15.23): every failure mode degrades to
 *   "no cached keys", which is where this build started.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ENV, readEnv } from "../config/env-vars.ts";
import { DEFAULT_REGISTRY } from "../config/keys.ts";
import { envDisabled } from "../project/env.ts";
import { httpGetJson } from "../net/http.ts";
import { getTrustedKeys, UntrustedKeyidError, verifySignature } from "./integrity.ts";
import { getHomeFolder } from "../cache/store.ts";
import type { RegistrySignature, TrustedKey } from "../types.ts";

/** §15.9 — `<home>/keys.json`, a sibling of `lastKnownGood.json` and outside `v1`. */
export const KEYS_CACHE_NAME = "keys.json";

/** The only shape this build understands; anything else reads as "no cached keys". */
export const KEYS_CACHE_VERSION = 1;

/**
 * The document npm publishes its signing keys at, on **npm's own registry**.
 *
 * Hardcoded to {@link DEFAULT_REGISTRY} rather than resolved from the registry
 * in force, and that is the whole security argument. §06.6 defends a compromised
 * mirror serving unpinned versions on exactly one ground — the mirror does not
 * have npm's key — and asking that same mirror which keys to trust hands it the
 * one thing it lacked. So a mirrored deployment gets no automatic rotation here;
 * its remedy is `COREPACK_INTEGRITY_KEYS`, which §06.4 already makes final.
 */
export const KEYS_ENDPOINT = `${DEFAULT_REGISTRY}/-/npm/v1/keys`;

/**
 * How long a *fruitless* refresh suppresses the next one.
 *
 * §15.9 requires the fetch timestamp to be recorded and says nothing about what
 * to do with it, so: it is a rate limit on failure, not a time-to-live. A cached
 * set that **already carries the keyid the registry signed with** is used at any
 * age — it is exactly the answer a refresh would fetch, and re-fetching it would
 * put a request on every run of a repeatedly-failing build. Only when the cache
 * cannot explain the signature does the timestamp matter, and then it is short
 * on purpose: a CI loop must not hammer `/-/npm/v1/keys`, but a client that
 * refreshed one minute before npm's new key finished propagating must not stay
 * bricked for a day over it. Five minutes buys the first and costs the second
 * almost nothing, since the run it applies to is failing either way.
 */
export const REFRESH_INTERVAL = 5 * 60 * 1000;

export interface CachedKeys {
  keys: TrustedKey[];
  /** Epoch milliseconds, or `undefined` when the file records no usable timestamp. */
  fetchedAt: number | undefined;
}

const EMPTY: CachedKeys = { keys: [], fetchedAt: undefined };

/**
 * §06.3 with §15.9's one repair attached.
 *
 * The happy path is `verifySignature` and a `return` — no cache read, no
 * request, nothing on disk touched. Only {@link UntrustedKeyidError}, the
 * "keyid we have never heard of" branch, continues past the `catch`.
 */
export async function verifySignatureWithRefresh(input: {
  signatures: RegistrySignature[] | undefined;
  integrity: string;
  packageName: string;
  version: string;
  registryOrigin?: string;
}): Promise<void> {
  try {
    verifySignature(input);
    return;
  } catch (error) {
    // Everything else — an unsigned packument, an expired key, a signature that
    // does not verify — describes keys we already hold. Refreshing them would
    // buy a request and change no answer.
    if (!(error instanceof UntrustedKeyidError) || !refreshable()) throw error;
  }

  // §15.9: merged with, never substituted for. The embedded set is the base and
  // keeps its walk position; the refresh may only add keyids to the end.
  const base = getTrustedKeys(input.registryOrigin);

  // The cache is read even with `COREPACK_ENABLE_NETWORK=0`: a machine that
  // refreshed while it had a network must keep working after it loses one, and
  // reading a local file is not the network access that flag forbids.
  const cached = readKeysCache();
  let refreshed = cached.keys;

  if (shouldRefresh(cached, input.signatures)) {
    const fetched = await fetchNpmKeys();
    if (fetched !== undefined) {
      writeKeysCache(fetched);
      refreshed = fetched;
    }
  }

  // One retry, reporting *its* failure rather than the first one: the diagnostic
  // then lists everything actually tried. This is also what makes the
  // npm-rotation case work at all — the embedded table ships only unexpired keys
  // (§14.4), so a pre-2025-01-29 artifact arrives here as "no trusted key
  // matched", the refresh supplies the expired key npm still publishes, and
  // §06.5's leniency accepts the signature it verifies with a warning instead of
  // failing on a keyid nobody could have recognised.
  verifySignature({ ...input, trustedKeys: mergeKeys(base, refreshed) });
}

/**
 * §15.9's two hard stops.
 *
 * `COREPACK_INTEGRITY_KEYS` set to anything at all — including the `""` and `"0"`
 * that disable verification outright, which never reach here — means the user
 * has pinned a trust store, and a pinned store is final: no cache, no fetch, no
 * merge. `COREPACK_ENABLE_NETWORK=0` stops the fetch alone (see above).
 */
function refreshable(): boolean {
  return readEnv(ENV.INTEGRITY_KEYS) === undefined;
}

/**
 * Whether to spend a request.
 *
 * "The cache already holds a keyid the registry signed with" is the answer that
 * makes the steady state free: after one refresh, a package signed with the
 * rotated key — or with a key that turns out to be *expired*, which is every
 * package manager npm published before 2025-01-29 — is decided from disk
 * forever, with no further requests.
 *
 * Exported for the tests, and not only for convenience: `httpGet` refuses under
 * `COREPACK_ENABLE_NETWORK=0` on its own, so a test that counts sockets cannot
 * see the difference between §15.9's rule and no rule at all. The decision is
 * the observable thing, so the decision is what gets asserted.
 */
export function shouldRefresh(
  cached: CachedKeys,
  signatures: RegistrySignature[] | undefined,
): boolean {
  if (envDisabled(ENV.ENABLE_NETWORK)) return false;
  if (matchesSignature(cached.keys, signatures)) return false;
  return cached.fetchedAt === undefined || Date.now() - cached.fetchedAt >= REFRESH_INTERVAL;
}

function matchesSignature(
  keys: TrustedKey[],
  signatures: RegistrySignature[] | undefined,
): boolean {
  if (!Array.isArray(signatures)) return false;
  return keys.some((key) =>
    signatures.some(
      (signature) =>
        typeof signature === "object" && signature !== null && signature.keyid === key.keyid,
    ),
  );
}

/** Embedded first, refreshed after, a keyid seen twice kept at its first position. */
export function mergeKeys(base: TrustedKey[], extra: TrustedKey[]): TrustedKey[] {
  const merged = [...base];
  const seen = new Set(base.map((key) => key.keyid));
  for (const key of extra) {
    if (seen.has(key.keyid)) continue;
    seen.add(key.keyid);
    merged.push(key);
  }
  return merged;
}

/* -------------------------------------------------------------------------- */
/* The cache file                                                             */
/* -------------------------------------------------------------------------- */

export function keysCachePath(): string {
  return join(getHomeFolder(), KEYS_CACHE_NAME);
}

/**
 * Read `<home>/keys.json`, or answer "nothing cached".
 *
 * Missing, unreadable, unparseable, not an object, a `version` this build does
 * not know, an entry for another origin: all of them are the same answer, and
 * the caller carries on with the embedded set. Individual keys are validated
 * one by one, so a single malformed entry cannot poison the rest — the rule
 * §04.4 sets for a non-string last-known-good value.
 */
export function readKeysCache(): CachedKeys {
  let text: string;
  try {
    text = readFileSync(keysCachePath(), "utf8");
  } catch {
    return EMPTY;
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return EMPTY;
  }

  if (!data || typeof data !== "object" || Array.isArray(data)) return EMPTY;
  const { version, registries } = data as { version?: unknown; registries?: unknown };
  if (version !== KEYS_CACHE_VERSION) return EMPTY;
  if (!registries || typeof registries !== "object" || Array.isArray(registries)) return EMPTY;

  // Only npm's origin is ever written here (see {@link KEYS_ENDPOINT}), so only
  // npm's origin is ever read back: a hand-edited file cannot introduce trust
  // for a registry §15.10 says may not auto-fetch keys at all.
  const entry = (registries as Record<string, unknown>)[DEFAULT_REGISTRY];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return EMPTY;

  const { fetchedAt, keys } = entry as { fetchedAt?: unknown; keys?: unknown };
  const at = typeof fetchedAt === "string" ? Date.parse(fetchedAt) : Number.NaN;

  return {
    keys: sanitiseKeys(keys),
    // An unparseable timestamp reads as "never fetched", i.e. refresh again —
    // the keys themselves stay usable, since they were verified into the file by
    // the same code that would fetch them.
    fetchedAt: Number.isNaN(at) ? undefined : at,
  };
}

/**
 * Replace `<home>/keys.json` atomically, and never fail a run over it.
 *
 * Write-temp-then-rename (§14.3), so a concurrent reader sees the old file or
 * the new one and never a truncated interleaving; every filesystem error is
 * swallowed, per §07.8 — a read-only `COREPACK_HOME` costs one request next
 * time, not a broken install.
 */
export function writeKeysCache(keys: TrustedKey[]): void {
  const home = getHomeFolder();
  const target = join(home, KEYS_CACHE_NAME);
  const content = `${JSON.stringify(
    {
      version: KEYS_CACHE_VERSION,
      registries: { [DEFAULT_REGISTRY]: { fetchedAt: new Date().toISOString(), keys } },
    },
    undefined,
    2,
  )}\n`;

  let tmp: string | undefined;
  try {
    mkdirSync(home, { recursive: true });
    tmp = `${target}.${process.pid}.tmp`;
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, target);
  } catch {
    if (tmp !== undefined) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        // Nothing further to try; the run continues either way.
      }
    }
  }
}

/**
 * `GET https://registry.npmjs.org/-/npm/v1/keys`, best effort.
 *
 * One attempt, not §15.5's three: this is a repair on a path that is already
 * failing, and a user waiting for an error deserves it promptly. No credentials
 * are offered — the document is public, and `registryOrigin` is deliberately
 * omitted so that a token scoped to some *other* registry cannot be sent to
 * npm's on the way past (§14.6).
 *
 * A failure — offline, proxied, 404 on a mirror that intercepts the host — is
 * swallowed: the caller then retries with what it already had, and reports the
 * trust error it was always going to report.
 */
export async function fetchNpmKeys(): Promise<TrustedKey[] | undefined> {
  let body: unknown;
  try {
    // `anonymous`, not merely "no `registryOrigin`": the document is public, and
    // a `.npmrc` line scoped to registry.npmjs.org would otherwise attach the
    // user's npm token to a request that has no use for it.
    body = await httpGetJson(KEYS_ENDPOINT, { attempts: 1, anonymous: true });
  } catch {
    return undefined;
  }

  if (!body || typeof body !== "object") return undefined;
  const keys = sanitiseKeys((body as { keys?: unknown }).keys);
  return keys.length === 0 ? undefined : keys;
}

/**
 * Registry JSON is untrusted input, so every field is checked before it can
 * become a trust-store entry.
 *
 * `keyid` and `key` must be non-empty strings — an entry without them can never
 * be selected, and a non-string `key` would reach `createPublicKey`. `expires`
 * must be a string or `null`; anything else is dropped rather than read as
 * "never expires", because guessing in that direction is the one that widens
 * trust. `keytype` and `scheme` are carried for the diagnostic only (§06.3 does
 * not consult them) and default to the empty string.
 */
export function sanitiseKeys(value: unknown): TrustedKey[] {
  if (!Array.isArray(value)) return [];

  const keys: TrustedKey[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const { expires, keyid, keytype, scheme, key } = entry as Record<string, unknown>;
    if (typeof keyid !== "string" || keyid === "") continue;
    if (typeof key !== "string" || key === "") continue;
    if (expires !== undefined && expires !== null && typeof expires !== "string") continue;
    keys.push({
      expires: typeof expires === "string" ? expires : null,
      keyid,
      keytype: typeof keytype === "string" ? keytype : "",
      scheme: typeof scheme === "string" ? scheme : "",
      key,
    });
  }
  return keys;
}
