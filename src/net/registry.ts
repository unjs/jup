/**
 * Registry protocols — §05.2 (npm), §05.3 (url).
 *
 * The npm layer checks `COREPACK_ENABLE_NETWORK` itself and names the
 * *registry*; the transport layer names the *URL*. Both messages are observable
 * and both must be reproduced.
 */

import { ENV, envEntry, readEnv } from "../config/env-vars.ts";
import { DEFAULT_REGISTRY } from "../config/keys.ts";
import { npmAlternativeFor, packageManagerForRegistry } from "../config/table.ts";
import { envDisabled, envFlag } from "../project/env.ts";
import { advisory, messages, networkError, redactUserinfo, UsageError } from "../errors.ts";
import { assertSafeArtifactUrl, httpGetJson } from "./http.ts";
import { parseSri, shouldSkipIntegrityCheck } from "../verify/integrity.ts";
import { npmProtocolRegistry, registryVariableFor, resolveRegistry } from "./npmrc.ts";
import { isPrerelease, rcompare } from "../version/semver.ts";
import { verifySignatureWithRefresh } from "../verify/trust.ts";
import type { NpmRegistrySpec, RegistrySignature, RegistrySpec } from "../types.ts";

/** The origin every table URL is written against, and the only one §07.3 rewrites. */
const DEFAULT_REGISTRY_ORIGIN = new URL(DEFAULT_REGISTRY).origin;

/**
 * The npm-protocol base for a request, with **all** trailing slashes stripped —
 * mirrors 404 on a doubled slash.
 *
 * §15.1 and §15.2 turn what used to be one environment variable into a four-tier
 * decision (`COREPACK_REGISTRY_<NAME>`, `COREPACK_NPM_REGISTRY`, `.npmrc`, the
 * built-in default); `npmrc.resolveRegistry` owns it, so this is one call rather
 * than a second copy of the precedence.
 *
 * @param options `name` selects §15.2's per-package-manager override;
 * `packageName` selects §15.1's `@scope:registry`.
 */
export function getRegistryUrl(options?: { name?: string; packageName?: string }): string {
  return resolveRegistry(options).registry;
}

/**
 * §05.2 rewrite 1 — a band's `npmRegistry` replaces its `registry` once the user
 * has configured an npm-protocol registry that would serve it.
 *
 * `resolve.ts` performs the same substitution for `COREPACK_NPM_REGISTRY`
 * before it ever calls in here, and the two are idempotent: given an npm spec
 * this returns it unchanged. What this adds is the `.npmrc` half — §15.38 row
 * 150 configures nothing but `@yarnpkg:registry`, and that alone must switch
 * Yarn Berry onto `@yarnpkg/cli-dist`.
 *
 * `COREPACK_REGISTRY_YARN` deliberately does **not** trigger the switch: §15.2
 * defines it as an origin replacement on Yarn's own distribution URLs, i.e. a
 * mirror of `repo.yarnpkg.com`, which is exactly what #872 could not have.
 */
export function resolveRegistrySpec(spec: RegistrySpec): RegistrySpec {
  if (spec.type === "npm") return spec;

  const alternative = npmAlternativeFor(spec);
  if (alternative === undefined) return spec;

  // A per-source mirror is a mirror of this very document, so it stays here.
  const name = packageManagerForRegistry(spec);
  if (name !== undefined && sourceOverrideFor(name) !== undefined) return spec;

  return npmProtocolRegistry({ packageName: alternative.package }) === undefined
    ? spec
    : alternative;
}

/** §15.2's `COREPACK_REGISTRY_<NAME>`, trailing slashes stripped, or `undefined`. */
function sourceOverrideFor(name: string): string | undefined {
  const configured = readEnv(registryVariableFor(name));
  if (configured === undefined || configured === "") return undefined;
  return configured.replace(/\/+$/, "");
}

/**
 * §15.2 — move a URL derived from a package manager's **own** table entry onto
 * `COREPACK_REGISTRY_<NAME>`.
 *
 * Unconditional origin replacement, unlike {@link applyRegistryOverride}: the
 * table URL is by construction on that package manager's distribution origin,
 * whatever that origin happens to be, so there is nothing to match against.
 * `repo.yarnpkg.com` is the case the whole item exists for — it is not an npm
 * registry, it is not `registry.npmjs.org`, and before §15.2 nothing could
 * redirect it.
 *
 * Idempotent: a URL already sitting under the override is returned untouched,
 * so applying this twice cannot double the override's path prefix.
 */
export function applySourceOverride(url: string, name: string | undefined): string {
  if (name === undefined) return url;
  const override = sourceOverrideFor(name);
  if (override === undefined) return url;
  return rebase(url, override);
}

/** Requests the abbreviated packument; both response shapes must be parsed. */
export const NPM_ACCEPT_HEADER =
  "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8";

/**
 * §15.35e — the only header that gets a `time` map back.
 *
 * The abbreviated packument {@link NPM_ACCEPT_HEADER} asks for deliberately
 * omits per-version publish dates, and it is an order of magnitude smaller. So
 * this header is sent on exactly one request, on exactly one path: the candidate
 * list of §04.1 step 6, and only while `COREPACK_MINIMUM_RELEASE_AGE` is set.
 * Every other request — dist-tags, `latest`, the version document, §15.8's
 * signature fallback — keeps the abbreviated header whatever the gate says.
 */
export const NPM_FULL_ACCEPT_HEADER = "application/json";

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
  try {
    if (new URL(url).origin !== DEFAULT_REGISTRY_ORIGIN) return url;
  } catch {
    // Not our business to diagnose: the caller validates (§14.9) and reports.
    return url;
  }
  return rebase(url, registryUrl);
}

/**
 * §15.3's rewrite, in one place: parse both, take the override's scheme, host,
 * port and userinfo, and prepend the override's own path prefix.
 *
 * Never a string operation. Corepack's `url.replace("https://registry.npmjs.org",
 * override)` misses a differing trailing slash or host case — `new URL` has
 * already normalised both by the time these are compared — and would happily
 * rewrite the *middle* of a URL that merely contains the literal.
 */
function rebase(url: string, base: string): string {
  let target: URL;
  let override: URL;
  try {
    target = new URL(url);
    override = new URL(base);
  } catch {
    return url;
  }

  const prefix = override.pathname.replace(/\/+$/, "");
  // Already there: re-applying must not double the prefix (§15.38 row 152).
  if (target.origin === override.origin && (prefix === "" || target.pathname.startsWith(prefix))) {
    return url;
  }

  // Resolving an absolute path against the override keeps its scheme, host,
  // port and userinfo, and drops its path — which `prefix` puts back.
  return new URL(`${prefix}${target.pathname}${target.search}${target.hash}`, override).href;
}

/* -------------------------------------------------------------------------- */
/* §15.35e — COREPACK_MINIMUM_RELEASE_AGE                                      */
/* -------------------------------------------------------------------------- */

/**
 * The gate, in milliseconds, or `undefined` when it is off.
 *
 * Hours, per §15.37's table. Unset and empty are off; so is an explicit `0`,
 * which is how npm and pnpm spell "no minimum" for the same setting.
 *
 * **An unparseable or negative value is refused, not ignored.** Every other
 * numeric variable in this codebase (`COREPACK_NETWORK_TIMEOUT`,
 * `COREPACK_NETWORK_RETRIES`) falls back to its default on garbage, because a
 * mistyped timeout costs a user some latency. This one is a supply-chain
 * control: falling back would mean `COREPACK_MINIMUM_RELEASE_AGE=24h` silently
 * turns the protection *off* on the machine of someone who believes they turned
 * it on, which is the same fail-open shape §15.35e exists to close.
 *
 * Read at the point of use rather than at startup: the whole feature is
 * cold-path, and a warm run (§01.3) must not parse an environment variable it
 * can never act on.
 */
export function minimumReleaseAge(): number | undefined {
  const raw = readEnv(ENV.MINIMUM_RELEASE_AGE);
  if (raw === undefined || raw.trim() === "") return undefined;

  const hours = Number(raw.trim());
  if (!Number.isFinite(hours) || hours < 0) {
    throw new UsageError(
      `COREPACK_MINIMUM_RELEASE_AGE must be a non-negative number of hours, got ${JSON.stringify(raw)}`,
    );
  }

  return hours === 0 ? undefined : hours * 60 * 60 * 1000;
}

/** What one registry offers as candidates for §04.1 step 6. */
export interface VersionCandidates {
  /**
   * The versions this source lists — already age-filtered when the gate is on
   * *and* the source dates its releases.
   */
  versions: string[];
  /**
   * §15.35e, blocker 3 — set to the document's URL when the gate is on and this
   * source publishes no release dates at all, so nothing in {@link versions}
   * could be filtered.
   *
   * The caller must **refuse** rather than resolve from it, but only once it
   * knows the source actually contributes a candidate: `yarn@^1.22` fans out
   * over the Berry band too (§04.1 step 6 queries every band), and that band
   * matching nothing is not a reason to fail the run.
   */
  undatedSource?: string;
}

/**
 * §15.35e's refusal. Deliberately fail **closed**: a source that publishes no
 * dates cannot be gated, and a security control that reports success without
 * having been applied is worse than one that stops.
 *
 * Narrow by construction — §04.1 step 5 returns an exact version before any of
 * this runs, so the usual `packageManager: "yarn@4.14.1"` is untouched; only
 * *implicit* resolution against `repo.yarnpkg.com` is refused. And the way out
 * is named: an npm-protocol registry switches Yarn Berry onto
 * `@yarnpkg/cli-dist` (§05.2 rewrite 1), which does date its releases.
 */
export function undatedSourceError(url: string): UsageError {
  return new UsageError(
    `COREPACK_MINIMUM_RELEASE_AGE is set, but ${redactUserinfo(url)} publishes no release dates, so the minimum age cannot be enforced there; pin an exact version, or set COREPACK_NPM_REGISTRY to an npm registry that serves this package manager`,
  );
}

function noEligibleReleaseError(packageName: string): UsageError {
  return new UsageError(
    `No release of ${packageName} is old enough for ${envEntry(ENV.MINIMUM_RELEASE_AGE)?.name ?? ENV.MINIMUM_RELEASE_AGE}=${readEnv(ENV.MINIMUM_RELEASE_AGE)}`,
  );
}

/**
 * §04.1 step 6's candidate set — {@link fetchAvailableVersions}, with §15.35e
 * applied.
 *
 * With the gate off this **is** `fetchAvailableVersions`: the same one request,
 * with the same abbreviated `Accept` header. The only thing the gate changes is
 * that this asks for the full document instead, because that is the only one
 * carrying `time`.
 *
 * A version the `time` map does not mention is dropped rather than kept: we
 * cannot say how old it is, and the whole point is to not choose what we cannot
 * vouch for. A response with no `time` map at all is the undated-source case —
 * some private registries strip it — and is reported the same way as §05.3's
 * url-typed sources.
 */
export async function fetchResolvableVersions(input: RegistrySpec): Promise<VersionCandidates> {
  const minimumAge = minimumReleaseAge();
  if (minimumAge === undefined) {
    return { versions: await fetchAvailableVersions(input) };
  }

  const spec = resolveRegistrySpec(input);
  if (spec.type !== "npm") {
    // §05.3's tags document has versions and aliases and nothing dated.
    const name = packageManagerForRegistry(spec);
    return {
      versions: keysOrValues(asRecord(await urlGetJson(spec.url, spec))?.[spec.fields.versions]),
      undatedSource: applySourceOverride(spec.url, name),
    };
  }

  const body = asRecord(await npmGetJson(spec.package, spec, { full: true }));
  const versions = keysOrValues(body?.versions);
  const times = asRecord(body?.time);
  if (times === undefined) {
    return { versions, undatedSource: `${registryUrlFor(spec)}/${spec.package}` };
  }

  const cutoff = Date.now() - minimumAge;
  return {
    versions: versions.filter((version) => {
      const published = Date.parse(asString(times[version]) ?? "");
      return Number.isFinite(published) && published <= cutoff;
    }),
  };
}

/**
 * §15.35e applied to a single version the *registry* chose — §04.1 step 3's
 * dist-tag, and §04.5's `latest`.
 *
 * A tag is not an exact pin: the user named a channel and let the registry
 * decide what is in it, which is precisely the choice a freshly-published
 * compromised release subverts. So the tag's target is **capped** at the newest
 * release that is no newer than it and old enough to be chosen — the same rule
 * npm and pnpm apply to a tag under `minimumReleaseAge`.
 *
 * Returns `version` untouched, and makes **no request**, when the gate is off.
 *
 * @param version The tag's target, or `undefined` to mean "the newest eligible
 * stable release" — §04.5's `latest`, where the target is not yet known and
 * asking for it would cost a request this can answer from the same document.
 */
export async function capToReleaseAge(
  input: RegistrySpec,
  version: string | undefined,
): Promise<string> {
  if (minimumReleaseAge() === undefined) {
    if (version === undefined) throw new Error("capToReleaseAge: no target and no gate");
    return version;
  }

  const candidates = await fetchResolvableVersions(input);
  if (candidates.undatedSource !== undefined) {
    throw undatedSourceError(candidates.undatedSource);
  }

  // §15.24 — a prerelease is never chosen implicitly unless the thing being
  // capped is itself one (`yarn@canary` stays on the canary line).
  const wantsPrereleases = version !== undefined && isPrerelease(version);

  const capped = candidates.versions
    .filter(
      (candidate) =>
        (wantsPrereleases || !isPrerelease(candidate)) &&
        (version === undefined || rcompare(candidate, version) >= 0),
    )
    .sort(rcompare)[0];

  if (capped === undefined) {
    const spec = resolveRegistrySpec(input);
    throw noEligibleReleaseError(spec.type === "npm" ? spec.package : spec.url);
  }
  return capped;
}

export async function fetchAvailableVersions(input: RegistrySpec): Promise<string[]> {
  const spec = resolveRegistrySpec(input);

  if (spec.type === "npm") {
    const body = asRecord(await npmGetJson(spec.package, spec));
    // Both packument shapes carry `versions` as an object keyed by version.
    return keysOrValues(body?.versions);
  }

  const body = asRecord(await urlGetJson(spec.url, spec));
  // §05.3 — an array of versions *or* an object whose keys are versions.
  return keysOrValues(body?.[spec.fields.versions]);
}

export async function fetchAvailableTags(input: RegistrySpec): Promise<Record<string, string>> {
  const spec = resolveRegistrySpec(input);

  if (spec.type === "npm") {
    const body = asRecord(await npmGetJson(spec.package, spec));
    return stringMap(body?.["dist-tags"]);
  }

  const body = asRecord(await urlGetJson(spec.url, spec));
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
export async function fetchLatestStableVersion(input: RegistrySpec): Promise<string> {
  const spec = resolveRegistrySpec(input);

  if (spec.type !== "npm") {
    // §15.35e — `stable` is the document choosing on the user's behalf, and this
    // document dates nothing, so the gate cannot be enforced here at all.
    if (minimumReleaseAge() !== undefined) {
      throw undatedSourceError(applySourceOverride(spec.url, packageManagerForRegistry(spec)));
    }
    const body = asRecord(await urlGetJson(spec.url, spec));
    const stable = stringMap(body?.[spec.fields.tags]).stable;
    if (stable === undefined) {
      throw new Error(messages.tagNotFound("stable"));
    }
    return stable;
  }

  const registryUrl = registryUrlFor(spec);

  try {
    // `latest` is a dist-tag the registry resolves server-side, so this is one
    // request rather than two.
    //
    // §15.35e — with the gate on it cannot be: the age of what `latest` points
    // at is only in the packument, so the selector becomes the newest eligible
    // stable release instead. That costs one extra request, and only while the
    // gate is set. (Taking the eligible semver maximum rather than capping at
    // `dist-tags.latest` is the same choice §15.24 was decided on here — §04.1
    // step 6 unions bands, a dist-tag names one.)
    const selector =
      minimumReleaseAge() === undefined ? "latest" : await capToReleaseAge(spec, undefined);
    const metadata = asRecord(await npmGetJson(`${spec.package}/${selector}`, spec));
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
      spec,
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
    //
    // The wrapper names two remedies but never the reason, and the reason is
    // what a user needs: as of writing, npm signs `yarn@latest` with keyid
    // `SHA256:jl3bws…`, which npm's own `/-/npm/v1/keys` marks
    // `expires: 2025-01-29`, so a bare `yarn` fails here on an untrusted keyid
    // and the sentence alone reads like a network fault. §15.5 requires the
    // underlying cause to survive; `networkError` appends it to the stack,
    // where `main.ts` will actually print it, and leaves the message byte for
    // byte as §04.5 specifies.
    throw networkError(new Error(messages.cannotDownloadLatest(spec.package)), error);
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
  const registryUrl = registryUrlFor(spec);
  const metadata = asRecord(await npmGetJson(`${spec.package}/${version}`, spec));
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
  advisory(messages.unsignedRegistry(registryUrl, packageName, version));
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
  /** The npm registry spec in force; §15.8's fallback re-queries it. */
  spec: NpmRegistrySpec;
  version: string;
  registryUrl: string;
  signatures: RegistrySignature[] | undefined;
  integrity: string | undefined;
  /** Whether the caller holds *some* digest to check the downloaded bytes against. */
  hasDigest: boolean;
}): Promise<void> {
  const { spec, version, registryUrl, integrity, hasDigest } = input;
  const packageName = spec.package;

  if (shouldSkipIntegrityCheck()) return;

  // §15.8 — the version endpoint is the one Artifactory strips; the package
  // root often still carries the signatures. One extra request, on a path that
  // was heading for a degraded outcome anyway, and never on the happy path.
  // Skipped when there is no `integrity` either: the signed statement is *about*
  // that string, so a recovered signature would have nothing to cover.
  const signatures =
    input.signatures ??
    (integrity === undefined ? undefined : await fetchRootSignatures(spec, version));

  // Tier 3: a signature exists, so it decides. `verifySignature` reports an
  // untrusted keyid, an expired key and a bad signature distinctly (§06.3), and
  // §15.9's wrapper turns the first of those three — and only the first — into
  // one key refresh and one retry.
  if (signatures !== undefined && integrity !== undefined) {
    await verifySignatureWithRefresh({
      signatures,
      integrity,
      packageName,
      version,
      registryOrigin: registryUrl,
    });
    return;
  }

  // Tier 2. A registry that publishes signatures but no `integrity` is in the
  // same position: the signed statement is *about* the integrity string, so
  // without one there is nothing signed to check, and the same soft-fail
  // applies.
  if (envFlag(ENV.REQUIRE_SIGNATURES)) {
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
  spec: NpmRegistrySpec,
  version: string,
): Promise<RegistrySignature[] | undefined> {
  // Not a request we are allowed to make; the soft-fail applies unchanged.
  if (envDisabled(ENV.ENABLE_NETWORK)) return undefined;

  try {
    const body = asRecord(await npmGetJson(spec.package, spec));
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
 * §15.1 + §15.2 — the base URL for one registry spec.
 *
 * The spec knows which package manager declared it (§15.2's
 * `COREPACK_REGISTRY_<NAME>`) and which npm package is being fetched (§15.1's
 * `@scope:registry`), which is everything the precedence chain needs.
 */
export function registryUrlFor(spec: NpmRegistrySpec): string {
  return getRegistryUrl({
    name: packageManagerForRegistry(spec),
    packageName: spec.package,
  });
}

/**
 * One npm-protocol GET. `path` is interpolated **without** percent-encoding, so
 * `@yarnpkg/cli-dist` appears literally — npm registry convention (§05.2).
 */
function npmGetJson(
  path: string,
  spec: NpmRegistrySpec,
  options?: { full?: boolean },
): Promise<unknown> {
  const registryUrl = registryUrlFor(spec);

  // §05.2 — the registry layer checks the flag itself, and its message names the
  // *registry*; the transport layer's names the URL. Both are observable.
  if (envDisabled(ENV.ENABLE_NETWORK)) {
    throw new UsageError(messages.networkDisabledRegistry(registryUrl));
  }

  return httpGetJson(`${registryUrl}/${path}`, {
    // §15.35e — the abbreviated document unless the caller needs `time`, which
    // only §04.1 step 6's candidate list ever does.
    headers: { accept: options?.full === true ? NPM_FULL_ACCEPT_HEADER : NPM_ACCEPT_HEADER },
    // §14.6 — without this the HTTP layer sends no credentials at all.
    registryOrigin: registryUrl,
  });
}

/**
 * §05.3 — a url-typed registry is a plain JSON document, fetched through the
 * same HTTP layer. It is not the npm registry, so the network flag is left to
 * the transport layer (whose message names the URL), and credentials only go out
 * if the document happens to live on the configured registry's origin.
 *
 * §15.2 applies here too, and this is the half corepack has no answer for at
 * all: `https://repo.yarnpkg.com/tags` is the *only* place Yarn Berry's version
 * list comes from, and `COREPACK_REGISTRY_YARN` is what finally moves it.
 */
function urlGetJson(url: string, spec: RegistrySpec): Promise<unknown> {
  const name = packageManagerForRegistry(spec);
  const target = applySourceOverride(url, name);
  return httpGetJson(target, { registryOrigin: getRegistryUrl({ name }) });
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
