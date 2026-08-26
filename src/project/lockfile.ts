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

import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  isValidRange,
  isValidVersion,
  parse,
  satisfiesWithPrereleases,
} from "../version/semver.ts";
import type { Descriptor, Locator } from "../types.ts";

/** §15.23 — the file lives at the project root, next to the manifest that declared the spec. */
export const LOCKFILE_NAME = ".jup.lock";

/**
 * §15.23 / §17.6 C9 — the name an older build wrote, read when
 * {@link LOCKFILE_NAME} is absent.
 *
 * Only jup has ever written this file — corepack has no lockfile — so the
 * compatibility is with our own past, and it is worth having because the file
 * sits at the **project root** and is committed. A write always produces
 * `.jup.lock`, and `save` retires the legacy file once its contents have moved.
 */
export const LEGACY_LOCKFILE_NAME = ".corepack.lock";

/** The only `version` this build understands; anything else reads as "no resolutions". */
export const LOCKFILE_VERSION = 1;

/** §15.23 — one recorded resolution: the concrete version, and the hash of its artifact. */
export interface Resolution {
  resolved: string;
  /** SRI, as npm spells it (`sha512-<base64>`); absent in a hand-written file. */
  integrity?: string;
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

/** Both lockfile names, in probe order (§17.6 C9). */
const LOCKFILE_NAMES = [LOCKFILE_NAME, LEGACY_LOCKFILE_NAME] as const;

/**
 * The lockfile's text, or `undefined`.
 *
 * `.jup.lock` first; the legacy name is opened only after that missed, so a
 * project on the current name still costs the one `readFileSync` §15.23 budgets.
 * Every failure is a miss — the file is derived state (§07.8) and a damaged one
 * degrades to "resolve normally", never to a broken checkout.
 */
function readLockfileText(dir: string): string | undefined {
  for (const name of LOCKFILE_NAMES) {
    try {
      return readFileSync(join(dir, name), "utf8");
    } catch {
      // Missing, unreadable, a directory: try the other name, then give up.
    }
  }
  return undefined;
}

/**
 * The lockfile this directory is governed by — the one that exists, else the one
 * a write would create. §17.6 C9 requires the frozen-mode error to name **the
 * file it actually looked at**, which is why this is a function rather than the
 * constant; it is reached only while building a message or a report, never on the
 * resolution path, so its `stat` is off the warm path.
 */
export function lockfileName(dir: string): string {
  for (const name of LOCKFILE_NAMES) {
    if (statSync(join(dir, name), { throwIfNoEntry: false }) !== undefined) return name;
  }
  return LOCKFILE_NAME;
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
  const text = readLockfileText(dir);
  if (text === undefined) return null;

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
    kept[key] = typeof integrity === "string" ? { resolved, integrity } : { resolved };
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
  const hash = entry.integrity === undefined ? undefined : hashFromIntegrity(entry.integrity);
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
): void {
  const parsed = parse(locator.reference);
  // A reference we cannot reduce to a plain version is not recordable — and
  // cannot arrive here, since `usesLockfile` already excluded URL references.
  if (parsed === null) return;

  const data = readLockfile(dir) ?? { version: LOCKFILE_VERSION, resolutions: {} };
  const resolution: Resolution = { resolved: parsed.version };
  const integrity = hash === undefined ? undefined : integrityFromHash(hash);
  if (integrity !== undefined) resolution.integrity = integrity;
  data.resolutions[resolutionKey(descriptor)] = resolution;

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
    // Both names, because the file that became empty may be the legacy one and
    // leaving it behind would resurrect the resolution the caller just retired.
    // This is the one place jup removes a `.corepack.lock` it did not write, and
    // it is removing a record it has just emptied rather than migrating a file.
    for (const name of LOCKFILE_NAMES) {
      try {
        rmSync(join(dir, name), { force: true });
      } catch {
        // Derived state: see `writeResolution`.
      }
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
    resolutions[key] = data.resolutions[key]!;
  }
  return `${JSON.stringify({ version: LOCKFILE_VERSION, resolutions }, undefined, 2)}\n`;
}

/**
 * Write-temp-then-rename, so a concurrent reader never sees a half-written file (§14.3).
 *
 * The target is always `.jup.lock` (§17.6 C9). When a legacy `.corepack.lock`
 * supplied the data it is removed afterwards: every resolution it held has just
 * been rewritten into the new file, so what would remain is a duplicate that
 * disagrees the moment either is edited — and one the reader would fall back to
 * if `.jup.lock` ever went away. A rename in `git status` is a better answer than
 * two lockfiles at the project root.
 */
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
    rmSync(join(dir, LEGACY_LOCKFILE_NAME), { force: true });
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
export function hashFromIntegrity(integrity: string): string | undefined {
  const entry = integrity.trim().split(/\s+/)[0] ?? "";
  const dash = entry.indexOf("-");
  if (dash <= 0) return undefined;

  const algo = entry.slice(0, dash).toLowerCase();
  if (!/^[a-z][\da-z]*$/.test(algo)) return undefined;

  const hex = Buffer.from(entry.slice(dash + 1).split("?")[0] ?? "", "base64").toString("hex");
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
