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

// --------------------------------------------------------------------------
// Grammar
// --------------------------------------------------------------------------

/** `<major>`: no leading zeroes. */
const NUM = String.raw`0|[1-9]\d*`;

/** One dot-separated prerelease identifier. */
const PRE_ID = String.raw`(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)`;

const BUILD = String.raw`[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*`;

const FULL_RE = new RegExp(
  String.raw`^[v=]*(${NUM})\.(${NUM})\.(${NUM})(?:-(${PRE_ID}(?:\.${PRE_ID})*))?(?:\+(${BUILD}))?$`,
);

/** `<major>` with the wildcard spellings a range may use in its place. */
const NUM_OR_X = String.raw`(?:${NUM}|x|X|\*)`;

/** A version with optional trailing wildcards, as used inside ranges. */
const PARTIAL_RE = new RegExp(
  String.raw`^[v=]*(${NUM_OR_X})(?:\.(${NUM_OR_X}))?(?:\.(${NUM_OR_X}))?(?:-(${PRE_ID}(?:\.${PRE_ID})*))?(?:\+(${BUILD}))?$`,
);

const OPERATOR_RE = /^(<=|>=|<|>|=)?([^\s<>=]*)$/;

// --------------------------------------------------------------------------
// Versions
// --------------------------------------------------------------------------

function toNumber(raw: string): number | null {
  const value = Number.parseInt(raw, 10);
  return Number.isSafeInteger(value) ? value : null;
}

function splitPrerelease(raw: string | undefined): Array<string | number> {
  if (!raw) return [];
  return raw.split(".").map((id) => {
    if (/^\d+$/.test(id)) {
      const value = Number.parseInt(id, 10);
      if (Number.isSafeInteger(value)) return value;
    }
    return id;
  });
}

function formatVersion(
  major: number,
  minor: number,
  patch: number,
  prerelease: Array<string | number>,
): string {
  const base = `${major}.${minor}.${patch}`;
  return prerelease.length > 0 ? `${base}-${prerelease.join(".")}` : base;
}

function makeSemVer(
  major: number,
  minor: number,
  patch: number,
  prerelease: Array<string | number> = [],
  build: string[] = [],
): SemVer {
  return {
    major,
    minor,
    patch,
    prerelease,
    build,
    version: formatVersion(major, minor, patch, prerelease),
  };
}

/**
 * Parse a semver 2.0.0 version. Returns `null` — never throws — when `version`
 * is not a valid version. Build metadata is retained in `build` but excluded
 * from `version`, since it takes no part in comparison.
 */
export function parse(version: string): SemVer | null {
  if (typeof version !== "string") return null;
  const trimmed = version.trim();
  if (trimmed.length === 0 || trimmed.length > 256) return null;

  const match = FULL_RE.exec(trimmed);
  if (!match) return null;

  const major = toNumber(match[1]!);
  const minor = toNumber(match[2]!);
  const patch = toNumber(match[3]!);
  if (major === null || minor === null || patch === null) return null;

  const build = match[5] ? match[5].split(".") : [];
  return makeSemVer(major, minor, patch, splitPrerelease(match[4]), build);
}

export function isValidVersion(value: string): boolean {
  return parse(value) !== null;
}

export function isValidRange(value: string): boolean {
  return parseRange(value) !== null;
}

function compareIdentifiers(a: string | number, b: string | number): -1 | 0 | 1 {
  const aNum = typeof a === "number";
  const bNum = typeof b === "number";
  // Numeric identifiers always have lower precedence than alphanumeric ones.
  if (aNum && !bNum) return -1;
  if (bNum && !aNum) return 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function comparePrerelease(a: Array<string | number>, b: Array<string | number>): -1 | 0 | 1 {
  // A version with a prerelease is lower than the same version without one.
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;

  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const result = compareIdentifiers(a[i]!, b[i]!);
    if (result !== 0) return result;
  }
  if (a.length === b.length) return 0;
  return a.length < b.length ? -1 : 1;
}

/** Compare two already-parsed versions. Build metadata is ignored. */
function compareSemVer(a: SemVer, b: SemVer): -1 | 0 | 1 {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return comparePrerelease(a.prerelease, b.prerelease);
}

/**
 * -1 / 0 / 1. Build metadata is ignored, so `4.1.0+sha224.abc` equals `4.1.0`.
 *
 * Never throws: an unparseable version sorts below every parseable one, and two
 * unparseable versions compare equal.
 */
export function compare(a: string, b: string): -1 | 0 | 1 {
  const left = parse(a);
  const right = parse(b);
  if (left === null || right === null) {
    if (left === right) return 0;
    return left === null ? -1 : 1;
  }
  return compareSemVer(left, right);
}

export function rcompare(a: string, b: string): -1 | 0 | 1 {
  const result = compare(a, b);
  return result === 0 ? 0 : result === 1 ? -1 : 1;
}

export function lt(a: string, b: string): boolean {
  return compare(a, b) === -1;
}

/** The major component, or `NaN` when `version` is not a valid version. */
export function major(version: string): number {
  return parse(version)?.major ?? Number.NaN;
}

// --------------------------------------------------------------------------
// Ranges
// --------------------------------------------------------------------------

type Operator = "<" | "<=" | ">" | ">=" | "=";

interface Comparator {
  op: Operator;
  /** `null` is the `*` comparator: it matches every version. */
  ver: SemVer | null;
}

type ComparatorSet = Comparator[];

/** A parsed range: a union of comparator sets (`||` of whitespace-joined ANDs). */
type Range = ComparatorSet[];

const ANY: Comparator = { op: ">=", ver: null };

/** A comparator no version can satisfy — the expansion of `>*` and `<*`. */
const NONE: Comparator = { op: "<", ver: makeSemVer(0, 0, 0, [0]) };

interface Partial {
  /** `null` means "wildcard" (`x`, `X`, `*`, or simply absent). */
  major: number | null;
  minor: number | null;
  patch: number | null;
  prerelease: Array<string | number>;
}

function isWildcard(raw: string | undefined): boolean {
  return raw === undefined || raw === "x" || raw === "X" || raw === "*";
}

function parsePartial(value: string): Partial | null {
  const match = PARTIAL_RE.exec(value);
  if (!match) return null;

  if (isWildcard(match[1])) {
    return { major: null, minor: null, patch: null, prerelease: [] };
  }
  const major = toNumber(match[1]!);
  if (major === null) return null;

  if (isWildcard(match[2])) {
    return { major, minor: null, patch: null, prerelease: [] };
  }
  const minor = toNumber(match[2]!);
  if (minor === null) return null;

  if (isWildcard(match[3])) {
    return { major, minor, patch: null, prerelease: [] };
  }
  const patch = toNumber(match[3]!);
  if (patch === null) return null;

  return { major, minor, patch, prerelease: splitPrerelease(match[4]) };
}

function partialToSemVer(p: Partial): SemVer {
  return makeSemVer(p.major ?? 0, p.minor ?? 0, p.patch ?? 0, p.prerelease);
}

/** `1.x` / `1.2.x` / `*`, optionally carrying an operator. */
function xRangeComparators(op: Operator, p: Partial): ComparatorSet {
  if (p.major === null) {
    // Nothing is strictly greater or lower than "any version".
    return op === ">" || op === "<" ? [NONE] : [ANY];
  }
  if (p.minor === null) {
    switch (op) {
      case ">": {
        return [{ op: ">=", ver: makeSemVer(p.major + 1, 0, 0) }];
      }
      case ">=": {
        return [{ op: ">=", ver: makeSemVer(p.major, 0, 0) }];
      }
      case "<": {
        return [{ op: "<", ver: makeSemVer(p.major, 0, 0) }];
      }
      case "<=": {
        return [{ op: "<", ver: makeSemVer(p.major + 1, 0, 0) }];
      }
      default: {
        return [
          { op: ">=", ver: makeSemVer(p.major, 0, 0) },
          { op: "<", ver: makeSemVer(p.major + 1, 0, 0) },
        ];
      }
    }
  }
  if (p.patch === null) {
    switch (op) {
      case ">": {
        return [{ op: ">=", ver: makeSemVer(p.major, p.minor + 1, 0) }];
      }
      case ">=": {
        return [{ op: ">=", ver: makeSemVer(p.major, p.minor, 0) }];
      }
      case "<": {
        return [{ op: "<", ver: makeSemVer(p.major, p.minor, 0) }];
      }
      case "<=": {
        return [{ op: "<", ver: makeSemVer(p.major, p.minor + 1, 0) }];
      }
      default: {
        return [
          { op: ">=", ver: makeSemVer(p.major, p.minor, 0) },
          { op: "<", ver: makeSemVer(p.major, p.minor + 1, 0) },
        ];
      }
    }
  }
  return [{ op, ver: partialToSemVer(p) }];
}

/** `^1.2.3` → `>=1.2.3 <2.0.0`, with the 0.x and 0.0.x special cases. */
function caretComparators(p: Partial): ComparatorSet {
  if (p.major === null) return [ANY];

  const lower: Comparator = { op: ">=", ver: partialToSemVer(p) };
  if (p.minor === null) {
    return [lower, { op: "<", ver: makeSemVer(p.major + 1, 0, 0) }];
  }
  if (p.patch === null) {
    return p.major === 0
      ? [lower, { op: "<", ver: makeSemVer(0, p.minor + 1, 0) }]
      : [lower, { op: "<", ver: makeSemVer(p.major + 1, 0, 0) }];
  }
  if (p.major === 0) {
    return p.minor === 0
      ? [lower, { op: "<", ver: makeSemVer(0, 0, p.patch + 1) }]
      : [lower, { op: "<", ver: makeSemVer(0, p.minor + 1, 0) }];
  }
  return [lower, { op: "<", ver: makeSemVer(p.major + 1, 0, 0) }];
}

/** `~1.2.3` → `>=1.2.3 <1.3.0`; `~1` → `>=1.0.0 <2.0.0`. */
function tildeComparators(p: Partial): ComparatorSet {
  if (p.major === null) return [ANY];

  const lower: Comparator = { op: ">=", ver: partialToSemVer(p) };
  if (p.minor === null) {
    return [lower, { op: "<", ver: makeSemVer(p.major + 1, 0, 0) }];
  }
  return [lower, { op: "<", ver: makeSemVer(p.major, p.minor + 1, 0) }];
}

/** `1.2.3 - 2.3.4` → `>=1.2.3 <=2.3.4`, with partial bounds widened. */
function hyphenComparators(from: string, to: string): ComparatorSet | null {
  const low = parsePartial(from);
  const high = parsePartial(to);
  if (!low || !high) return null;

  const set: ComparatorSet = [];
  if (low.major !== null) {
    set.push({ op: ">=", ver: partialToSemVer(low) });
  }
  if (high.major !== null) {
    if (high.minor === null) {
      set.push({ op: "<", ver: makeSemVer(high.major + 1, 0, 0) });
    } else if (high.patch === null) {
      set.push({ op: "<", ver: makeSemVer(high.major, high.minor + 1, 0) });
    } else {
      set.push({ op: "<=", ver: partialToSemVer(high) });
    }
  }
  return set.length > 0 ? set : [ANY];
}

function parseComparatorToken(token: string): ComparatorSet | null {
  const head = token[0];
  if (head === "^" || head === "~") {
    // `~>1.2.3` is the same as `~1.2.3`.
    const rest = token.slice(head === "~" && token[1] === ">" ? 2 : 1);
    const p = parsePartial(rest);
    if (!p) return null;
    return head === "^" ? caretComparators(p) : tildeComparators(p);
  }

  const match = OPERATOR_RE.exec(token);
  if (!match) return null;

  const op = (match[1] ?? "=") as Operator;
  const rest = match[2] ?? "";
  // A bare operator (`>`) carries no constraint, matching node-semver.
  if (rest.length === 0) return [ANY];

  const p = parsePartial(rest);
  if (!p) return null;
  return xRangeComparators(op, p);
}

function parseComparatorSet(input: string): ComparatorSet | null {
  // Detach operators from their operand (`>= 1.2.3`) and normalise whitespace.
  const normalized = input.replaceAll(/(?<=[<>]=?|[~^]|=)\s+/g, "").trim();
  if (normalized.length === 0) return [ANY];

  const tokens = normalized.split(/\s+/);
  const hyphenAt = tokens.indexOf("-");
  if (hyphenAt !== -1) {
    if (tokens.length !== 3 || hyphenAt !== 1) return null;
    return hyphenComparators(tokens[0]!, tokens[2]!);
  }

  const set: ComparatorSet = [];
  for (const token of tokens) {
    const comparators = parseComparatorToken(token);
    if (!comparators) return null;
    set.push(...comparators);
  }
  return set;
}

const RANGE_CACHE = new Map<string, Range | null>();
const RANGE_CACHE_LIMIT = 256;

/** Parse a range into a union of comparator sets. `null` when malformed. */
function parseRange(range: string): Range | null {
  if (typeof range !== "string") return null;

  const cached = RANGE_CACHE.get(range);
  if (cached !== undefined) return cached;

  let parsed: Range | null = [];
  for (const part of range.split("||")) {
    const set = parseComparatorSet(part);
    if (!set) {
      parsed = null;
      break;
    }
    parsed.push(set);
  }

  if (RANGE_CACHE.size >= RANGE_CACHE_LIMIT) RANGE_CACHE.clear();
  RANGE_CACHE.set(range, parsed);
  return parsed;
}

function testComparator(cmp: Comparator, version: SemVer): boolean {
  if (cmp.ver === null) return true;
  const result = compareSemVer(version, cmp.ver);
  switch (cmp.op) {
    case "<": {
      return result === -1;
    }
    case "<=": {
      return result !== 1;
    }
    case ">": {
      return result === 1;
    }
    case ">=": {
      return result !== -1;
    }
    default: {
      return result === 0;
    }
  }
}

function stripPrerelease(version: SemVer): SemVer {
  if (version.prerelease.length === 0) return version;
  return makeSemVer(version.major, version.minor, version.patch, [], version.build);
}

/**
 * Standard, prerelease-excluding satisfaction. Used **only** for the devEngines
 * cross-checks (§03.3, §03.7). Keep it distinct from the lenient form below.
 */
export function satisfies(version: string, range: string): boolean {
  const parsedRange = parseRange(range);
  if (!parsedRange) return false;
  const v = parse(version);
  if (!v) return false;

  return parsedRange.some((set) => {
    if (!set.every((cmp) => testComparator(cmp, v))) return false;
    if (v.prerelease.length === 0) return true;
    // A prerelease only satisfies a range that itself names a prerelease at the
    // very same [major, minor, patch] tuple.
    return set.some(
      (cmp) =>
        cmp.ver !== null &&
        cmp.ver.prerelease.length > 0 &&
        cmp.ver.major === v.major &&
        cmp.ver.minor === v.minor &&
        cmp.ver.patch === v.patch,
    );
  });
}

/**
 * Lenient satisfaction — used everywhere else.
 *
 * Strips the prerelease tag from **both** the version and every comparator, then
 * tests normally. This is *not* semver's `includePrerelease` flag, whose
 * behaviour corepack explicitly rejected. A user pinning `yarn@4.0.0-rc.1` must
 * still land in the `>=2.0.0` band.
 */
export function satisfiesWithPrereleases(version: string, range: string): boolean {
  const parsedRange = parseRange(range);
  if (!parsedRange) return false;
  if (!version) return false;
  const parsed = parse(version);
  if (!parsed) return false;

  const v = stripPrerelease(parsed);
  return parsedRange.some((set) =>
    set.every((cmp) =>
      testComparator(
        cmp.ver === null || cmp.ver.prerelease.length === 0
          ? cmp
          : { op: cmp.op, ver: stripPrerelease(cmp.ver) },
        v,
      ),
    ),
  );
}

/**
 * §15.24 — whether the range itself names a prerelease.
 *
 * The implicit-resolution filter in §04.1 step 6 discards prerelease candidates,
 * but a user who wrote `>=11.0.0-0` or `^4.0.0-rc.1` has asked for that band on
 * purpose and must still get it. This answers "did they ask?", and it is
 * deliberately a property of the *range* rather than of any candidate: the
 * question is what the project declared, not what the registry happens to hold.
 *
 * {@link NONE} is excluded by identity. It is the expansion of `>*` and `<*` —
 * a comparator no version satisfies — and it is spelled `<0.0.0-0`, so a
 * structural test would read it as a range naming a prerelease and quietly
 * re-open the very gate this closes.
 */
export function rangeNamesPrerelease(range: string): boolean {
  const parsed = parseRange(range);
  if (parsed === null) return false;

  return parsed.some((set) =>
    set.some((cmp) => cmp !== NONE && cmp.ver !== null && cmp.ver.prerelease.length > 0),
  );
}

/** Whether a version string carries a prerelease tag. Malformed input is not one. */
export function isPrerelease(version: string): boolean {
  return (parse(version)?.prerelease.length ?? 0) > 0;
}
