/**
 * Registry protocols — §05.2 (npm), §05.3 (url).
 *
 * The npm layer checks `COREPACK_ENABLE_NETWORK` itself and names the
 * *registry*; the transport layer names the *URL*. Both messages are observable
 * and both must be reproduced.
 */

import type { NpmRegistrySpec, RegistrySignature, RegistrySpec } from "./types.ts";

/** Base registry with **all** trailing slashes stripped — mirrors 404 on a doubled slash. */
export function getRegistryUrl(): string {
  throw new Error(`TODO(T11): getRegistryUrl()`);
}

/** Requests the abbreviated packument; both response shapes must be parsed. */
export const NPM_ACCEPT_HEADER =
  "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8";

export function fetchAvailableVersions(spec: RegistrySpec): Promise<string[]> {
  throw new Error(`TODO(T11): fetchAvailableVersions(${spec.type})`);
}

export function fetchAvailableTags(spec: RegistrySpec): Promise<Record<string, string>> {
  throw new Error(`TODO(T11): fetchAvailableTags(${spec.type})`);
}

/**
 * §04.5 — npm reads `{registry}/{package}/latest` and returns a hash-bearing
 * reference; url registries read `data[fields.tags].stable` (note **stable**,
 * not `latest`) and attach no hash. Any failure in the npm path is re-thrown
 * wrapped in `messages.cannotDownloadLatest`.
 */
export function fetchLatestStableVersion(spec: RegistrySpec): Promise<string> {
  throw new Error(`TODO(T11): fetchLatestStableVersion(${spec.type})`);
}

/**
 * §07.3 — the tarball URL is read verbatim from `dist.tarball`, never
 * synthesised, and validated through `assertSafeArtifactUrl` (§14.9).
 */
export function fetchTarballURLAndSignature(
  spec: NpmRegistrySpec,
  version: string,
): Promise<{ tarball: string; integrity?: string; signatures?: RegistrySignature[] }> {
  throw new Error(`TODO(T11): fetchTarballURLAndSignature(${spec.package}@${version})`);
}
