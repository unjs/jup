/**
 * Registry protocols — §05.2 (npm), §05.3 (url).
 *
 * The npm layer checks `COREPACK_ENABLE_NETWORK` itself and names the
 * *registry*; the transport layer names the *URL*. Both messages are observable
 * and both must be reproduced.
 */

import { DEFAULT_REGISTRY } from "./config/keys.ts";
import { envDisabled } from "./env.ts";
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

    // §15.7 — corepack destructures `dist` here and throws a raw `TypeError`
    // when a private registry omits it. Say what happened instead.
    const dist = requireDist(metadata, spec.package, version, registryUrl);
    const integrity = asString(dist.integrity);
    const shasum = asString(dist.shasum);

    // The signature covers the integrity string; with no integrity there is
    // nothing signed to verify, and the legacy `shasum` path below is all the
    // registry offers. (§15.7's soft-fail tiering refines this in phase 2.)
    if (integrity !== undefined && !shouldSkipIntegrityCheck()) {
      verifySignature({
        signatures: readSignatures(dist),
        integrity,
        packageName: spec.package,
        version,
        registryOrigin: registryUrl,
      });
    }

    if (integrity !== undefined) {
      // §14.12 — the algorithm comes from the SRI string, never from `slice(7)`:
      // a `sha256-…` registry would otherwise produce a silently wrong digest,
      // and §06.2 reads this very algorithm back off the reference.
      const { algo, hex } = parseSri(integrity);
      return `${version}+${algo}.${hex}`;
    }

    if (shasum === undefined) {
      throw new Error(
        `${spec.package}@${version} metadata from ${redactUserinfo(registryUrl)} has neither "dist.integrity" nor "dist.shasum"`,
      );
    }

    // Taking the legacy branch means nothing was verified. Say so rather than
    // downgrading silently — §15.7 turns this into a hard failure under
    // COREPACK_REQUIRE_SIGNATURES in phase 2.
    if (!shouldSkipIntegrityCheck()) {
      console.warn(messages.unverifiableIntegrity(registryUrl, spec.package, version));
    }

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
): Promise<{ tarball: string; integrity?: string; signatures?: RegistrySignature[] }> {
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
    signatures: readSignatures(dist),
  };
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

/** §15.7 — an absent `dist` is a clear error, never a `TypeError`. */
function requireDist(
  metadata: Record<string, unknown> | undefined,
  packageName: string,
  version: string,
  registryUrl: string,
): Record<string, unknown> {
  const dist = asRecord(metadata?.dist);
  if (dist === undefined) {
    throw new Error(
      `${packageName}@${version} metadata from ${redactUserinfo(registryUrl)} has no "dist" section; this registry may not be npm-compatible`,
    );
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
