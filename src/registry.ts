/**
 * Registry protocols — §05.2 (npm), §05.3 (url).
 *
 * The npm layer checks `COREPACK_ENABLE_NETWORK` itself and names the
 * *registry*; the transport layer names the *URL*. Both messages are observable
 * and both must be reproduced.
 */

import { DEFAULT_REGISTRY } from "./config/keys.ts";
import { envDisabled, envFlag } from "./env.ts";
import { messages, redactUserinfo, UsageError } from "./errors.ts";
import { assertSafeArtifactUrl, httpGetJson } from "./http.ts";
import { parseSri, shouldSkipIntegrityCheck, verifySignature } from "./integrity.ts";
import type { NpmRegistrySpec, RegistrySignature, RegistrySpec } from "./types.ts";

/** The origin every table URL is written against, and the only one §07.3 rewrites. */
const DEFAULT_REGISTRY_ORIGIN = new URL(DEFAULT_REGISTRY).origin;

/** Base registry with **all** trailing slashes stripped — mirrors 404 on a doubled slash. */
export function getRegistryUrl(): string {
  const configured = process.env.COREPACK_NPM_REGISTRY;
  const raw = configured === undefined || configured === "" ? DEFAULT_REGISTRY : configured;
  // `registry.example.org//pkg` is a 404 on registry.npmmirror.com and friends,
  // so strip every trailing slash, not just one.
  return raw.replace(/\/+$/, "");
}

/** Requests the abbreviated packument; both response shapes must be parsed. */
export const NPM_ACCEPT_HEADER =
  "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8";

/**
 * §05.2 rewrite 2 / §15.3 — move a URL that lives on the default registry onto
 * `COREPACK_NPM_REGISTRY`.
 *
 * Corepack does `url.replace("https://registry.npmjs.org", override)`, which
 * misses URLs differing only in case or trailing slash and would happily rewrite
 * the *middle* of a URL that merely contains the literal. This compares
 * **origins** (the `URL` parser has already lower-cased the host and normalised
 * the default port) and rebuilds the target on the override, prepending the
 * override's own path prefix — so `http://host/npm-mirror` works.
 *
 * A no-op when the override is unset: the computed registry is then the default
 * registry, whose origin matches and whose path prefix is empty.
 *
 * Exported because §07.3's download path (T15) applies the same rewrite; it is
 * idempotent, since a rewritten URL no longer sits on the default origin.
 */
export function applyRegistryOverride(url: string, registryUrl: string = getRegistryUrl()): string {
  let target: URL;
  let override: URL;
  try {
    target = new URL(url);
    override = new URL(registryUrl);
  } catch {
    // Not our business to diagnose: the caller validates (§14.9) and reports.
    return url;
  }

  if (target.origin !== DEFAULT_REGISTRY_ORIGIN) {
    return url;
  }

  const prefix = override.pathname.replace(/\/+$/, "");
  // Resolving an absolute path against the override keeps its scheme, host,
  // port and userinfo, and drops its path — which `prefix` puts back.
  return new URL(`${prefix}${target.pathname}${target.search}${target.hash}`, override).href;
}

export async function fetchAvailableVersions(spec: RegistrySpec): Promise<string[]> {
  if (spec.type === "npm") {
    const body = asRecord(await npmGetJson(spec.package));
    // Both packument shapes carry `versions` as an object keyed by version.
    return keysOrValues(body?.versions);
  }

  const body = asRecord(await urlGetJson(spec.url));
  // §05.3 — an array of versions *or* an object whose keys are versions.
  return keysOrValues(body?.[spec.fields.versions]);
}

export async function fetchAvailableTags(spec: RegistrySpec): Promise<Record<string, string>> {
  if (spec.type === "npm") {
    const body = asRecord(await npmGetJson(spec.package));
    return stringMap(body?.["dist-tags"]);
  }

  const body = asRecord(await urlGetJson(spec.url));
  // Yarn's document maps tags -> "aliases" and versions -> "tags"; follow the
  // mapping, not the names.
  return stringMap(body?.[spec.fields.tags]);
}

/**
 * §04.5 — npm reads `{registry}/{package}/latest` and returns a hash-bearing
 * reference; url registries read `data[fields.tags].stable` (note **stable**,
 * not `latest`) and attach no hash. Any failure in the npm path is re-thrown
 * wrapped in `messages.cannotDownloadLatest`.
 */
export async function fetchLatestStableVersion(spec: RegistrySpec): Promise<string> {
  if (spec.type !== "npm") {
    const body = asRecord(await urlGetJson(spec.url));
    const stable = stringMap(body?.[spec.fields.tags]).stable;
    if (stable === undefined) {
      throw new Error(messages.tagNotFound("stable"));
    }
    return stable;
  }

  const registryUrl = getRegistryUrl();

  try {
    // `latest` is a dist-tag the registry resolves server-side, so this is one
    // request rather than two.
    const metadata = asRecord(await npmGetJson(`${spec.package}/latest`));
    const version = asString(metadata?.version);
    if (version === undefined) {
      throw new Error(
        `${spec.package} metadata from ${redactUserinfo(registryUrl)} has no "version" field; this registry may not be npm-compatible`,
      );
    }

    // §15.7 tier 1 — corepack destructures `dist` here and throws a raw
    // `TypeError` when a private registry omits it. Say what happened instead.
    const dist = requireDist(metadata, spec.package, version, registryUrl);
    const integrity = asString(dist.integrity);
    const shasum = asString(dist.shasum);

    // §15.7 tiers 2 and 3. The digest this returns becomes the reference's pin,
    // so "the bytes match the registry's claim" is enforced by §06.2 at download
    // time; what this decides is whether that claim was *signed*.
    await verifyRegistryTrust({
      packageName: spec.package,
      version,
      registryUrl,
      signatures: readSignatures(dist),
      integrity,
      hasDigest: integrity !== undefined || shasum !== undefined,
    });

    if (integrity !== undefined) {
      // §14.12 — the algorithm comes from the SRI string, never from `slice(7)`:
      // a `sha256-…` registry would otherwise produce a silently wrong digest,
      // and §06.2 reads this very algorithm back off the reference.
      const { algo, hex } = parseSri(integrity);
      return `${version}+${algo}.${hex}`;
    }

    if (shasum === undefined) {
      // Only reachable with integrity checks disabled; otherwise
      // `verifyRegistryTrust` has already refused for the same reason.
      throw new Error(messages.noRegistryDigest(spec.package, version, registryUrl));
    }

    // §04.5's legacy branch: unsigned, but still a digest the download is
    // checked against. `verifyRegistryTrust` has warned about the missing
    // signature already.
    return `${version}+sha1.${shasum}`;
  } catch (error) {
    // Verbatim §04.5 wrapper — both env var names in it are asserted, which is
    // why it comes from the message builder rather than from here.
    throw new Error(messages.cannotDownloadLatest(spec.package), { cause: error });
  }
}

/**
 * §07.3 — the tarball URL is read verbatim from `dist.tarball`, never
 * synthesised, and validated through `assertSafeArtifactUrl` (§14.9).
 */
export async function fetchTarballURLAndSignature(
  spec: NpmRegistrySpec,
  version: string,
): Promise<{
  tarball: string;
  integrity?: string;
  shasum?: string;
  signatures?: RegistrySignature[];
}> {
  const registryUrl = getRegistryUrl();
  const metadata = asRecord(await npmGetJson(`${spec.package}/${version}`));
  const dist = requireDist(metadata, spec.package, version, registryUrl);

  const tarball = asString(dist.tarball);
  if (tarball === undefined || !URL.canParse(tarball)) {
    throw new Error(messages.noValidTarball(spec.package, version));
  }

  // Proxying registries (Artifactory, Nexus) hand back `dist.tarball` values
  // still pointing at registry.npmjs.org. Rewrite before validating, so §14.9's
  // host check sees the URL that will actually be fetched — §15.3's "composes
  // with §14.9".
  const rewritten = applyRegistryOverride(tarball, registryUrl);
  assertSafeArtifactUrl(rewritten, registryUrl);

  return {
    tarball: rewritten,
    integrity: asString(dist.integrity),
    // §15.7's soft-fail accepts the legacy digest when that is all the registry
    // publishes, so the caller needs it in hand — §04.5's `latest` path has
    // always used it, and refusing it only here would make the same registry
    // work for `pnpm` and fail for `pnpm@6.x`.
    shasum: asString(dist.shasum),
    signatures: readSignatures(dist),
  };
}

/* -------------------------------------------------------------------------- */
/* §15.7 / §15.8 — registry metadata tiering                                   */
/* -------------------------------------------------------------------------- */

/** One warning per `<registry>\0<pkg>\0<version>`; §15.7 asks for exactly one. */
const warnedUnsigned = new Set<string>();

/**
 * §15.7's tier-2 warning, emitted at most once per package and version.
 *
 * Exported because §06.1 row 1 short-circuits the rest of the tiering — a
 * user-pinned hash is the check, and it must not be turned into a signature
 * requirement — while the observation that the registry publishes no signatures
 * is still worth making, and costs no request when the metadata is already in
 * hand.
 */
export function warnUnsignedRegistry(
  registryUrl: string,
  packageName: string,
  version: string,
): void {
  const seen = `${registryUrl}\0${packageName}\0${version}`;
  if (warnedUnsigned.has(seen)) return;
  warnedUnsigned.add(seen);
  console.warn(messages.unsignedRegistry(registryUrl, packageName, version));
}

/**
 * §15.7's three outcomes, in one place, for every site that reads `dist`.
 *
 * | Registry response | Outcome |
 * |---|---|
 * | `dist` absent | already an error — `requireDist`, upstream of here |
 * | `signatures` absent or empty | §15.8's retry, then soft-fail: proceed on a digest, warn once |
 * | `signatures` present | verified; an invalid one is `Signature does not match` |
 *
 * `COREPACK_REQUIRE_SIGNATURES=1` turns the soft-fail into a hard failure, for
 * organisations mandating signed sources. It is deliberately *not* consulted on
 * §06.1 row 1's pinned-hash path, which never reaches here: an explicit hash is
 * a stronger, user-chosen assertion than the registry's own claim (§14.21), and
 * making it depend on registry metadata would both weaken that rule and cost a
 * request the fast path does not make.
 *
 * §06.1 row 5 is handled here rather than at each call site: `COREPACK_INTEGRITY_KEYS`
 * in {"", "0"} disables the mechanism outright rather than tiering it, so this
 * returns without a warning, a request, or a refusal.
 */
export async function verifyRegistryTrust(input: {
  packageName: string;
  version: string;
  registryUrl: string;
  signatures: RegistrySignature[] | undefined;
  integrity: string | undefined;
  /** Whether the caller holds *some* digest to check the downloaded bytes against. */
  hasDigest: boolean;
}): Promise<void> {
  const { packageName, version, registryUrl, integrity, hasDigest } = input;

  if (shouldSkipIntegrityCheck()) return;

  // §15.8 — the version endpoint is the one Artifactory strips; the package
  // root often still carries the signatures. One extra request, on a path that
  // was heading for a degraded outcome anyway, and never on the happy path.
  // Skipped when there is no `integrity` either: the signed statement is *about*
  // that string, so a recovered signature would have nothing to cover.
  const signatures =
    input.signatures ??
    (integrity === undefined ? undefined : await fetchRootSignatures(packageName, version));

  // Tier 3: a signature exists, so it decides. `verifySignature` reports an
  // untrusted keyid, an expired key and a bad signature distinctly (§06.3).
  if (signatures !== undefined && integrity !== undefined) {
    verifySignature({ signatures, integrity, packageName, version, registryOrigin: registryUrl });
    return;
  }

  // Tier 2. A registry that publishes signatures but no `integrity` is in the
  // same position: the signed statement is *about* the integrity string, so
  // without one there is nothing signed to check, and the same soft-fail
  // applies.
  if (envFlag("COREPACK_REQUIRE_SIGNATURES")) {
    throw new UsageError(messages.noCompatibleSignature());
  }

  // "otherwise refuse": no signature *and* no digest is an unverifiable
  // artifact, and installing it would be the silent downgrade §15.7 exists to
  // prevent.
  if (!hasDigest) {
    throw new Error(messages.noRegistryDigest(packageName, version, registryUrl));
  }

  warnUnsignedRegistry(registryUrl, packageName, version);
}

/**
 * §15.8 — `versions[<version>].dist.signatures` from `GET /<pkg>`.
 *
 * Exactly one extra request, and only from a caller that has already seen an
 * unsigned version endpoint. Best-effort by construction: a failure here leaves
 * the caller where it already was — at §15.7's soft-fail — rather than turning a
 * metadata quirk into an error.
 */
async function fetchRootSignatures(
  packageName: string,
  version: string,
): Promise<RegistrySignature[] | undefined> {
  // Not a request we are allowed to make; the soft-fail applies unchanged.
  if (envDisabled("COREPACK_ENABLE_NETWORK")) return undefined;

  try {
    const body = asRecord(await npmGetJson(packageName));
    const doc = asRecord(asRecord(body?.versions)?.[version]);
    const dist = asRecord(doc?.dist);
    return dist === undefined ? undefined : readSignatures(dist);
  } catch {
    return undefined;
  }
}

/* -------------------------------------------------------------------------- */
/* Transport helpers                                                          */
/* -------------------------------------------------------------------------- */

/**
 * One npm-protocol GET. `path` is interpolated **without** percent-encoding, so
 * `@yarnpkg/cli-dist` appears literally — npm registry convention (§05.2).
 */
function npmGetJson(path: string): Promise<unknown> {
  const registryUrl = getRegistryUrl();

  // §05.2 — the registry layer checks the flag itself, and its message names the
  // *registry*; the transport layer's names the URL. Both are observable.
  if (envDisabled("COREPACK_ENABLE_NETWORK")) {
    throw new UsageError(messages.networkDisabledRegistry(registryUrl));
  }

  return httpGetJson(`${registryUrl}/${path}`, {
    headers: { accept: NPM_ACCEPT_HEADER },
    // §14.6 — without this the HTTP layer sends no credentials at all.
    registryOrigin: registryUrl,
  });
}

/**
 * §05.3 — a url-typed registry is a plain JSON document, fetched through the
 * same HTTP layer. It is not the npm registry, so the network flag is left to
 * the transport layer (whose message names the URL), and credentials only go out
 * if the document happens to live on the configured registry's origin.
 */
function urlGetJson(url: string): Promise<unknown> {
  return httpGetJson(url, { registryOrigin: getRegistryUrl() });
}

/* -------------------------------------------------------------------------- */
/* Shape readers — a registry's JSON is untrusted input, not a typed object     */
/* -------------------------------------------------------------------------- */

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** §15.7 tier 1 — an absent `dist` is a clear error, never a `TypeError`. */
function requireDist(
  metadata: Record<string, unknown> | undefined,
  packageName: string,
  version: string,
  registryUrl: string,
): Record<string, unknown> {
  const dist = asRecord(metadata?.dist);
  if (dist === undefined) {
    throw new Error(messages.noDistSection(packageName, version, registryUrl));
  }
  return dist;
}

/**
 * `undefined` rather than a half-typed array, so `verifySignature` can report it.
 *
 * §06.3 branches on the *array*, not on its usable entries: an empty or absent
 * array is step 1's `No compatible signature found in package metadata`, while a
 * non-empty array none of whose entries matches a trusted key is step 4's
 * `The package was not signed by any trusted keys: …` — a `UsageError` that
 * prints the offending entries for the user to inspect. Dropping entries that
 * carry no `keyid` (and collapsing an emptied list to `undefined`) reported the
 * step-1 bug-shaped error instead, with a stack trace and none of the diagnostic.
 * Entries are therefore passed through untouched; a missing `keyid` simply never
 * matches a trusted key, whose own keyid is always a string.
 */
function readSignatures(dist: Record<string, unknown>): RegistrySignature[] | undefined {
  const { signatures } = dist;
  if (!Array.isArray(signatures) || signatures.length === 0) {
    return undefined;
  }
  return signatures as RegistrySignature[];
}

/** §05.3 — an array of versions, or an object whose keys are versions. */
function keysOrValues(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }
  const record = asRecord(value);
  return record === undefined ? [] : Object.keys(record);
}

/** A tag -> version map, with anything non-string dropped. */
function stringMap(value: unknown): Record<string, string> {
  const record = asRecord(value);
  if (record === undefined) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry === "string") {
      result[key] = entry;
    }
  }
  return result;
}
