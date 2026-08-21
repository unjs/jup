/**
 * The store — §07.
 *
 * The tool owns exactly one directory. Its concurrency story is a single
 * primitive: **rename is atomic within a filesystem, and losing that race is a
 * success**. There is no lockfile and must never be one (§07.5, §16.6).
 */

import type { BinList, BinSpec, CorepackMarker, InstallSpec, Locator } from "./types.ts";

/**
 * §07.1 — `COREPACK_HOME`, else `XDG_CACHE_HOME`/`LOCALAPPDATA`/platform default,
 * joined with `node/corepack`.
 *
 * Note `XDG_CACHE_HOME` is consulted **before** `LOCALAPPDATA` on every platform,
 * and `LOCALAPPDATA` is consulted on POSIX if set. Both are quirks of the
 * fallback chain rather than design, and both must be reproduced for cache
 * compatibility. (§15.13 narrows this later.)
 */
export function getHomeFolder(): string {
  throw new Error(`TODO(T12): getHomeFolder()`);
}

/** `<home>/v1` — a layout-version segment. Incrementing it abandons old caches wholesale. */
export function getInstallFolder(): string {
  throw new Error(`TODO(T12): getInstallFolder()`);
}

/**
 * Plain semver with the build suffix removed, so two references differing only
 * in their hash share one directory. URL references use
 * `encodeURIComponent(url without fragment)`.
 */
export function getVersionDir(locator: Locator): string {
  throw new Error(`TODO(T12): getVersionDir(${locator.name}@${locator.reference})`);
}

/**
 * §07.2 — read the `.corepack` marker. Its presence is the "this install is
 * complete and valid" signal, and reading it is the entire warm path: `ENOENT`
 * proceeds to download, any other error propagates.
 */
export function readMarker(dir: string): CorepackMarker | null {
  throw new Error(`TODO(T12): readMarker(${dir})`);
}

export function writeMarker(dir: string, marker: CorepackMarker): void {
  throw new Error(`TODO(T12): writeMarker(${dir})`);
}

/** Temp dirs live **inside** the install folder so the promoting rename never crosses a filesystem. */
export function createTempDir(): string {
  throw new Error(`TODO(T12): createTempDir()`);
}

/**
 * §07.5 — the rename is the commit point. `EEXIST`/`ENOTEMPTY` (and win32
 * `EPERM` onto a directory) mean another process installed the same version
 * first: discard the temp and continue as if we had won. Windows retries 5x with
 * `100 * 2^i` ms backoff.
 */
export function promote(tmp: string, dest: string): void {
  throw new Error(`TODO(T12): promote(${tmp}, ${dest})`);
}

/**
 * §04.3 + §14.1 + §14.2 — the cache probe.
 *
 * For an **exact** version this must `stat` the marker directly and skip the
 * directory scan entirely; the scan is for genuine ranges only. Dot-entries are
 * skipped, and matching uses `satisfiesWithPrereleases` to stay consistent with
 * the rest of the pipeline.
 */
export function findInstalledVersion(name: string, range: string): string | null {
  throw new Error(`TODO(T12): findInstalledVersion(${name}, ${range})`);
}

/**
 * §04.4 — maximally forgiving. Every failure mode returns `{}` rather than
 * erroring, and entries whose value is not a string are dropped.
 */
export function readLastKnownGood(): Record<string, string> {
  throw new Error(`TODO(T12): readLastKnownGood()`);
}

/** §14.3 — write to a temp file in the same directory and rename over. `EROFS` is swallowed. */
export function writeLastKnownGood(lkg: Record<string, string>): void {
  throw new Error(`TODO(T12): writeLastKnownGood()`);
}

/**
 * §07.7 — the `isValidBinList` / `isValidBinSpec` discrimination is load-bearing:
 * Yarn Berry declares an array `bin`, but when fetched from a custom npm
 * registry it arrives as a *tarball*, so the array is ignored and the package's
 * own `bin` map is used.
 */
export function resolveBin(
  tmpDir: string,
  locator: Locator,
  isSingleFile: boolean,
): BinSpec | BinList {
  throw new Error(`TODO(T12): resolveBin(${tmpDir})`);
}

/** §07.9 — `rm -rf <home>/v1`, forced. `lastKnownGood.json` is **not** removed. */
export function cacheClean(): void {
  throw new Error(`TODO(T12): cacheClean()`);
}

export type { InstallSpec };
