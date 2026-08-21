/**
 * The semver subset — see `.agents/04-version-resolution.md` §04.2.
 *
 * Exactly these operations are needed; nothing more. Every function returns a
 * falsy/null result rather than throwing on malformed input.
 *
 * Range grammar to support: `||` (union), whitespace-joined comparators
 * (intersection), `^ ~ > >= < <= =`, exact versions, `*`, `x`/`X` wildcards,
 * and hyphen ranges.
 */

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: Array<string | number>;
  build: string[];
  /** The version without build metadata, e.g. `4.1.0` for `4.1.0+sha224.abc`. */
  version: string;
}

export function parse(version: string): SemVer | null {
  throw new Error(`TODO(T1): parse(${version})`);
}

export function isValidVersion(value: string): boolean {
  throw new Error(`TODO(T1): isValidVersion(${value})`);
}

export function isValidRange(value: string): boolean {
  throw new Error(`TODO(T1): isValidRange(${value})`);
}

/** -1 / 0 / 1. Build metadata is ignored, so `4.1.0+sha224.abc` equals `4.1.0`. */
export function compare(a: string, b: string): -1 | 0 | 1 {
  throw new Error(`TODO(T1): compare(${a}, ${b})`);
}

export function rcompare(a: string, b: string): -1 | 0 | 1 {
  throw new Error(`TODO(T1): rcompare(${a}, ${b})`);
}

export function lt(a: string, b: string): boolean {
  throw new Error(`TODO(T1): lt(${a}, ${b})`);
}

export function major(version: string): number {
  throw new Error(`TODO(T1): major(${version})`);
}

/**
 * Standard, prerelease-excluding satisfaction. Used **only** for the devEngines
 * cross-checks (§03.3, §03.7). Keep it distinct from the lenient form below.
 */
export function satisfies(version: string, range: string): boolean {
  throw new Error(`TODO(T1): satisfies(${version}, ${range})`);
}

/**
 * Lenient satisfaction — used everywhere else.
 *
 * Strips the prerelease tag from **both** the version and every comparator, then
 * tests normally. This is *not* semver's `includePrerelease` flag, whose
 * behaviour corepack explicitly rejected. A user pinning `yarn@4.0.0-rc.1` must
 * still land in the `>=2.0.0` band.
 */
export function satisfiesWithPrereleases(version: string, range: string, loose?: boolean): boolean {
  throw new Error(`TODO(T1): satisfiesWithPrereleases(${version}, ${range}, ${loose})`);
}
