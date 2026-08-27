/**
 * `.jup.lock` — the resolution file for non-exact project specs (§15.23).
 *
 * Corepack's four-year objection to ranges in `packageManager` is that they
 * "prevent using hashes" and "give a false sense of confidence". That is an
 * argument against *unrecorded* ranges, not against ranges: this module is the
 * other half, a file that records which concrete version a range resolved to and
 * the digest of the bytes that version produced. Ranges for humans, a recorded
 * hash for reproducibility and integrity.
 *
 * Three properties are load-bearing and each shows up as a rule below:
 *
 * * **An exact pin never touches this file** — not a read, not a `stat`. The
 *   gate is {@link usesLockfile}, and every caller asks it first.
 * * **A recorded resolution costs one `readFileSync` and no network.** §01.3's
 *   fast-path budget extends to ranges, so a hit must not consult the registry,
 *   `lastKnownGood.json`, or the store directory listing.
 * * **A damaged file is not fatal.** It is derived state; the same precedent
 *   §04.4 sets for `lastKnownGood.json` applies, and every failure mode here
 *   degrades to "resolve normally" rather than blocking a run.
 */

import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  isValidRange,
  isValidVersion,
  parse,
  satisfiesWithPrereleases,
} from "../version/semver.ts";
import { hostTarget } from "../config/table.ts";
import type { Descriptor, Locator } from "../types.ts";

/**
 * §15.23 — at the project root, next to the manifest that declared the spec.
 * The name is jup's own: corepack has no lockfile of any name.
 *
 * So this is the one layout path §14.24 renamed that must **not** grow a
 * `.corepack.lock` fallback — unlike `.corepack.env`, which keeps one because
 * real repositories have committed it. Corepack rejects ranges outright and has
 * never written a lockfile of any spelling, so a legacy read path would be
 * compatibility with a file that never existed, bought with a second `stat` on
 * the range fast path.
 */
export const LOCKFILE_NAME = ".jup.lock";

/** The only `version` this build understands; anything else reads as "no resolutions". */
export const LOCKFILE_VERSION = 1;

/** §15.23 — one recorded resolution: the concrete version, and the hash of its artifact. */
export interface Resolution {
  resolved: string;
  /**
   * SRI, as npm spells it (`sha512-<base64>`); absent in a hand-written file.
   *
   * §15.28 — for a package manager whose artifact is per-host (bun, deno) there
   * is no single answer, so the field holds a **map** keyed by the normalised
   * `<platform>-<arch>` instead:
   *
   * ```json
   * {"resolved": "1.4.0",
   *  "integrity": {"linux-x64": "sha512-…", "darwin-arm64": "sha512-…"}}
   * ```
   *
   * The map fills in as hosts run, and each host reads only its own key — so a
   * Linux CI job and a Mac laptop pin the same *version* by the same recorded
   * decision, and each still checks the bytes it actually downloads. A host with
   * no entry yet resolves the version from the lockfile without a network
   * request and verifies through npm's signature (§06.3), which is the tier a
   * native artifact always has; it then records its own key.
   *
   * A build that does not know about the map form reads `typeof integrity ===
   * "string"`, finds it false, and treats the entry as version-only — which is
   * exactly the right degradation, and is why this did not need a `version` bump.
   */
  integrity?: string | Record<string, string>;
}

interface LockfileData {
  version: number;
  resolutions: Record<string, Resolution>;
}

/**
 * Whether this descriptor resolves through the lockfile at all.
 *
 * An **exact version** is already its own record — the pin names the version and
 * may carry the hash — so §15.23's "an exact-version spec continues to work with
 * no lockfile involvement whatsoever" is exactly this early `false`. A **URL**
 * reference is likewise self-describing (§02.1 puts its digest in the fragment).
 * Everything else — a range, or a dist-tag — needs recording.
 */
export function usesLockfile(descriptor: Descriptor): boolean {
  const { range } = descriptor;
  if (range === "" || isValidVersion(range)) return false;
  return !URL.canParse(range);
}

/** §15.23 — `<name>@<the range as written>`, the key the file is indexed by. */
export function resolutionKey(descriptor: Descriptor): string {
  return `${descriptor.name}@${descriptor.range}`;
}

/**
 * Read the file, or `null`.
 *
 * Missing, unreadable, unparseable, not an object, or carrying a `version` this
 * build does not know: all of them answer `null`, and the caller resolves
 * normally. A future format bump therefore degrades to "one extra network
 * resolution", never to a broken checkout.
 */
export function readLockfile(dir: string): LockfileData | null {
  let text: string;
  try {
    text = readFileSync(join(dir, LOCKFILE_NAME), "utf8");
  } catch {
    return null;
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }

  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const { version, resolutions } = data as { version?: unknown; resolutions?: unknown };
  if (version !== LOCKFILE_VERSION) return null;
  if (!resolutions || typeof resolutions !== "object" || Array.isArray(resolutions)) return null;

  // Entry-level validation, so one malformed entry cannot poison the others —
  // the same rule §04.4 applies to a non-string last-known-good value.
  const kept: Record<string, Resolution> = {};
  for (const [key, value] of Object.entries(resolutions as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const { resolved, integrity } = value as { resolved?: unknown; integrity?: unknown };
    if (typeof resolved !== "string" || !isValidVersion(resolved)) continue;
    const recorded = readIntegrityField(integrity);
    kept[key] = recorded === undefined ? { resolved } : { resolved, integrity: recorded };
  }

  return { version: LOCKFILE_VERSION, resolutions: kept };
}

/**
 * The locator a recorded resolution stands for, or `null` to resolve normally.
 *
 * "Still satisfies the range" is tested with the **lenient** satisfaction
 * (§04.2), matching every other range test on the resolution path: the recorded
 * version was itself chosen by that rule, so testing it with the strict one
 * would make a recorded prerelease fail its own range and send every single run
 * back to the registry — the one thing §15.23 exists to prevent. (The strict
 * rule stays where §03.3 puts it, on the `devEngines` cross-check.)
 *
 * A **dist-tag** key has no range to violate, so a recorded resolution for one
 * always stands until `corepack up` refreshes it. That is the whole point of
 * recording it: `packageManager: "pnpm@latest"` otherwise means a registry
 * request on every invocation.
 */
export function readResolution(dir: string, descriptor: Descriptor): Locator | null {
  const data = readLockfile(dir);
  if (data === null) return null;

  const key = resolutionKey(descriptor);
  if (!Object.hasOwn(data.resolutions, key)) return null;
  const entry = data.resolutions[key]!;

  if (isValidRange(descriptor.range) && !satisfiesWithPrereleases(entry.resolved, descriptor.range))
    return null;

  // The recorded digest becomes a build suffix, which is what makes it *used*
  // rather than merely stored: §06.1 row 1 treats a reference-borne hash as an
  // explicit pin and checks the downloaded bytes against it.
  const integrity = integrityForHost(entry);
  const hash = integrity === undefined ? undefined : hashFromIntegrity(integrity);
  return {
    name: descriptor.name,
    reference: hash === undefined ? entry.resolved : `${entry.resolved}+${hash}`,
  };
}

/**
 * Record (or refresh) one resolution.
 *
 * Formatting is chosen for humans and for `git diff`: two-space indent, one
 * key per line, a trailing newline, and resolution keys sorted, so re-recording
 * an unchanged resolution round-trips byte-for-byte and a changed one produces a
 * one-line diff.
 *
 * `hash` is the `<algo>.<hex>` the store already computed for these bytes
 * (§07.2); it is written as SRI, the spelling npm's own lockfiles use.
 *
 * `perHost` is §15.28's answer for this locator, and it is passed in rather than
 * asked for: the callers hold the table already, and importing it here to answer
 * a question only the *write* path asks would put `resolveArtifactRegistry` and
 * its caches into the chunk a warm read is measured on (§16.3).
 *
 * A write failure is swallowed, per §07.8's rule for derived state: a read-only
 * checkout must still be able to *run*, and the cost of not recording is one
 * extra resolution next time. Frozen mode (§15.23) is the deliberate refusal and
 * is decided by the caller, before any of this.
 */
export function writeResolution(
  dir: string,
  descriptor: Descriptor,
  locator: Locator,
  hash: string | undefined,
  perHost = false,
): void {
  const parsed = parse(locator.reference);
  // A reference we cannot reduce to a plain version is not recordable — and
  // cannot arrive here, since `usesLockfile` already excluded URL references.
  if (parsed === null) return;

  const data = readLockfile(dir) ?? { version: LOCKFILE_VERSION, resolutions: {} };
  const key = resolutionKey(descriptor);
  const resolution: Resolution = { resolved: parsed.version };
  const integrity = hash === undefined ? undefined : integrityFromHash(hash);

  if (integrity !== undefined) {
    if (perHost) {
      // §15.28 — one key per host, and the other hosts' keys are carried over,
      // but only while the *version* is unchanged: a resolution that moved to a
      // new version has nothing to say about what the old one hashed to on a
      // machine that is not this one.
      const previous = data.resolutions[key];
      const carried =
        previous?.resolved === parsed.version && typeof previous.integrity === "object"
          ? previous.integrity
          : undefined;
      resolution.integrity = { ...carried, [hostTarget()]: integrity };
    } else {
      resolution.integrity = integrity;
    }
  }

  data.resolutions[key] = resolution;

  save(dir, data);
}

/**
 * Drop one key, deleting the file once nothing is left in it.
 *
 * `corepack use` pins exactly, which retires whatever range the field used to
 * hold; leaving that key behind would keep a resolution nothing points at, and
 * the next `use` back to a range would silently reuse a stale one.
 */
export function removeResolution(dir: string, key: string): void {
  const data = readLockfile(dir);
  if (data === null || !Object.hasOwn(data.resolutions, key)) return;

  delete data.resolutions[key];
  if (Object.keys(data.resolutions).length === 0) {
    try {
      rmSync(join(dir, LOCKFILE_NAME), { force: true });
    } catch {
      // Derived state: see `writeResolution`.
    }
    return;
  }

  save(dir, data);
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

function serialise(data: LockfileData): string {
  const resolutions: Record<string, Resolution> = {};
  for (const key of Object.keys(data.resolutions).sort()) {
    const entry = data.resolutions[key]!;
    // §15.28's map is sorted for the same reason the keys above are: a host that
    // records its own digest must produce a one-line diff, not a reordering of
    // everybody else's.
    resolutions[key] =
      typeof entry.integrity === "object"
        ? { ...entry, integrity: sorted(entry.integrity) }
        : entry;
  }
  return `${JSON.stringify({ version: LOCKFILE_VERSION, resolutions }, undefined, 2)}\n`;
}

/** Write-temp-then-rename, so a concurrent reader never sees a half-written file (§14.3). */
function save(dir: string, data: LockfileData): void {
  const target = join(dir, LOCKFILE_NAME);
  const content = serialise(data);

  // An unchanged file is left alone: two processes racing on the same
  // resolution must not churn the project's mtime, and `git status` should stay
  // quiet when nothing was decided.
  try {
    if (readFileSync(target, "utf8") === content) return;
  } catch {
    // Missing or unreadable — fall through and write it.
  }

  let tmp: string | undefined;
  try {
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
 * `sha512-<base64>` -> `sha512.<hex>`, the build-suffix spelling of §02.1.
 *
 * Deliberately not `integrity.parseSri`: that module reaches for `node:crypto`,
 * which drags seventy-odd native modules into a process that, on a lockfile hit,
 * is about to do nothing but `stat` a marker and `exec` (§01.3, §16.3). The
 * algorithm name is passed through rather than checked against an allowlist —
 * `install` already rejects an unsupported one with §12's message, and doing it
 * twice would only give the same input two different errors.
 */
/** Sort an object's keys, so re-serialising an unchanged file round-trips. */
function sorted(map: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(map).sort()) out[key] = map[key]!;
  return out;
}

/**
 * Validate the `integrity` field of one entry: a string, or §15.28's host map
 * with every value a string. Anything else is dropped, per the entry-level rule
 * above — a damaged field costs one extra resolution, never a broken checkout.
 */
function readIntegrityField(value: unknown): string | Record<string, string> | undefined {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;

  const kept: Record<string, string> = {};
  for (const [host, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string") kept[host] = entry;
  }
  return Object.keys(kept).length > 0 ? kept : undefined;
}

/**
 * The SRI this host should check its download against, if the file records one.
 *
 * A host map with no entry for *this* host answers `undefined`, which is the
 * whole point of the shape: the version stands, and the bytes are verified
 * through npm's signature rather than against a digest taken on somebody else's
 * machine (§15.28).
 */
export function integrityForHost(entry: Resolution): string | undefined {
  const { integrity } = entry;
  if (integrity === undefined || typeof integrity === "string") return integrity;
  return integrity[hostTarget()];
}

/**
 * `sha512-<base64>` -> `sha512.<hex>`, the build-suffix spelling of §02.1.
 *
 * The base64 body is matched before it is decoded, because `Buffer.from` drops
 * characters it does not recognise: without the test, `sha512-a!b` decodes to a
 * byte and a malformed field becomes a plausible-looking digest instead of
 * `undefined`.
 *
 * `integrity` itself is a different matter, and is not reached for here: it
 * pulls `node:crypto` (§16.3). An algorithm this implementation does not support
 * is rejected by `install` with §12's own message, and rejecting it twice would
 * give one input two errors.
 */
export function hashFromIntegrity(integrity: string): string | undefined {
  const entry = integrity.trim().split(/\s+/)[0] ?? "";
  const dash = entry.indexOf("-");
  if (dash <= 0) return undefined;

  const algo = entry.slice(0, dash).toLowerCase();
  if (!/^[a-z][\da-z]*$/.test(algo)) return undefined;

  const base64 = entry.slice(dash + 1).split("?")[0] ?? "";
  if (!/^[\d+/A-Za-z]+={0,2}$/.test(base64)) return undefined;

  const hex = Buffer.from(base64, "base64").toString("hex");
  return hex === "" ? undefined : `${algo}.${hex}`;
}

/** `sha512.<hex>` -> `sha512-<base64>`; the inverse of {@link hashFromIntegrity}. */
export function integrityFromHash(hash: string): string | undefined {
  const dot = hash.indexOf(".");
  if (dot <= 0) return undefined;

  const algo = hash.slice(0, dot).toLowerCase();
  const hex = hash.slice(dot + 1);
  if (!/^[a-z][\da-z]*$/.test(algo) || !/^(?:[\da-f]{2})+$/i.test(hex)) return undefined;

  return `${algo}-${Buffer.from(hex, "hex").toString("base64")}`;
}
