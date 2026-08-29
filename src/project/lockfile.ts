/**
 * `jup.lock` records authoritative project resolutions; host-local cache entries expire. Reads stay bounded, offline failures may use stale entries, writes are atomic, and invalid state degrades to a miss.
 */

const { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } =
  process.getBuiltinModule("node:fs");
const { join } = process.getBuiltinModule("node:path");
import {
  isValidRange,
  isValidVersion,
  parse,
  satisfiesWithPrereleases,
} from "../version/semver.ts";
import { hostTarget, isPerHost } from "../config/table.ts";
import type { Descriptor, Locator } from "../types.ts";

/**
 * Store authoritative resolutions at the project root without compatibility probes.
 */
export const LOCKFILE_NAME = "jup.lock";

/** The directory the memo lives inside, and the one jup never creates. */
const MODULES_DIRECTORY = "node_modules";

/**
 * Keep the host-local cache in an existing `node_modules/.jup`; never create `node_modules` solely for metadata.
 */
export const CACHE_DIRECTORY = join(MODULES_DIRECTORY, ".jup");

/**
 * §04.4 — how long a cached resolution stands before it is resolved again.
 *
 * The cache keeps a range off the network; it does not freeze it there, which is
 * the committed file's job. A day is short enough that `pnpm@latest` still means
 * "recent", long enough that a working day makes one request per range.
 */
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** The only `version` this build understands; anything else reads as "no resolutions". */
export const LOCKFILE_VERSION = 1;

/** §04.4 — one recorded resolution: the concrete version, and the hash of its artifact. */
export interface Resolution {
  resolved: string;
  /**
   * SRI, as npm spells it (`sha512-<base64>`); absent in a hand-written file.
   *
   * §04.4 — for a package manager whose artifact is per-host (bun, deno) there
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
  /**
   * Cache entries only (§04.4): epoch milliseconds after which the range is
   * resolved again. The recorded file never carries one — a committed decision
   * does not rot.
   *
   * A stamp is believed only inside the window it may claim: one *without* an
   * `expires` reads as already expired, and so does one further out than
   * {@link CACHE_TTL_MS} from now. Both halves are needed for the property that
   * matters — a memo can cost a resolution, never pin a version forever — since
   * a `node_modules` restored from an image, or written under a fast clock,
   * carries a stamp that would otherwise hold the range for as long as it says.
   */
  expires?: number;
}

interface LockfileData {
  version: number;
  resolutions: Record<string, Resolution>;
}

/**
 * Whether this descriptor resolves through the lockfile at all.
 *
 * An **exact version** is already its own record — the pin names the version and
 * may carry the hash — so §04.4's "an exact-version spec continues to work with
 * no lockfile involvement whatsoever" is exactly this early `false`. A **URL**
 * reference is likewise self-describing (§02.1 puts its digest in the fragment).
 * Everything else — a range, or a dist-tag — needs recording.
 */
export function usesLockfile(descriptor: Descriptor): boolean {
  const { range } = descriptor;
  if (range === "" || isValidVersion(range)) return false;
  return !URL.canParse(range);
}

/** §04.4 — `<name>@<the range as written>`, the key the file is indexed by. */
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
  // the same rule §04.5 applies to a non-string last-known-good value.
  const kept: Record<string, Resolution> = {};
  for (const [key, value] of Object.entries(resolutions as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const { resolved, integrity, expires } = value as {
      resolved?: unknown;
      integrity?: unknown;
      expires?: unknown;
    };
    if (typeof resolved !== "string" || !isValidVersion(resolved)) continue;
    const recorded = readIntegrityField(integrity);
    const entry: Resolution =
      recorded === undefined ? { resolved } : { resolved, integrity: recorded };
    if (typeof expires === "number" && Number.isFinite(expires)) entry.expires = expires;
    kept[key] = entry;
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
 * back to the registry — the one thing §04.4 exists to prevent. (The strict
 * rule stays where §03.3 puts it, on the `devEngines` cross-check.)
 *
 * A **dist-tag** key has no range to violate, so an entry for one always stands.
 * In the recorded file that means a hand-written entry is honoured until a hand
 * edit removes it; in the cache, where tags actually land, {@link CACHE_TTL_MS}
 * is what keeps `packageManager: "pnpm@latest"` meaning "recent" instead of
 * "whatever it meant the first time anyone ran it".
 */
export function readResolution(dir: string, descriptor: Descriptor): Locator | null {
  const entry = readEntry(dir, descriptor);
  return entry === null ? null : locatorFor(descriptor, entry);
}

/** A cache hit, and whether its {@link CACHE_TTL_MS} window has closed. */
export interface CachedResolution {
  locator: Locator;
  /**
   * `true` when the entry has aged out. It is returned anyway: the caller
   * resolves afresh and falls back to it only if that fails, because an expired
   * memo beats no answer when the registry is unreachable (§04.4) — §04.5's
   * "degrade, never block" rule, applied to a project's own file.
   */
  expired: boolean;
}

/**
 * §04.4 — the cached resolution in `<dir>/node_modules/.jup`, or `null`.
 *
 * Consulted only after the recorded file has said nothing: a committed decision
 * outranks a memo about what the registry answered yesterday, always.
 */
export function readCachedResolution(
  dir: string,
  descriptor: Descriptor,
  now = Date.now(),
): CachedResolution | null {
  const hit = readCachedEntry(dir, descriptor, now);
  if (hit === null) return null;

  return { locator: locatorFor(descriptor, hit.entry), expired: hit.expired };
}

/** What a project's two files already know, without a request (§04.4). */
export interface KnownResolution {
  /** The recorded resolution, else an unexpired memo; `null` when neither answers. */
  locator: Locator | null;
  /**
   * The memo as read, expired or not: an aged-out one is still §04.4's answer
   * of last resort. `null` when the recorded file answered, which outranks it.
   */
  cached: CachedResolution | null;
}

/**
 * §04.4's read order — the recorded resolution, then an unexpired memo — in the
 * one place both callers reach for it. The proxy path and `install` (§09.2) must
 * agree to the version, or a Docker layer caches one and runs another, offline.
 */
export function readKnownResolution(
  dir: string,
  descriptor: Descriptor,
  now = Date.now(),
): KnownResolution {
  const recorded = readResolution(dir, descriptor);
  if (recorded !== null) return { locator: recorded, cached: null };

  const cached = readCachedResolution(dir, descriptor, now);
  return { locator: cached === null || cached.expired ? null : cached.locator, cached };
}

/** The memo as the file holds it, for a caller that wants to *report* it. */
export interface CachedEntry {
  entry: Resolution;
  expired: boolean;
}

/**
 * {@link readCachedResolution}, stopping at the entry: `info` prints §04.4's
 * whole host map rather than this host's one digest, so it cannot take the
 * flattened locator. Reading through here rather than indexing the parsed file
 * is what keeps that command honest — the range gate and the expiry rule are
 * applied once, and it reports what the next run would accept.
 */
export function readCachedEntry(
  dir: string,
  descriptor: Descriptor,
  now = Date.now(),
): CachedEntry | null {
  const entry = readEntry(join(dir, CACHE_DIRECTORY), descriptor);
  return entry === null ? null : { entry, expired: hasExpired(entry, now) };
}

/**
 * Whether a memo has aged out — bounded at both ends (§04.4).
 *
 * A stamp beyond one full {@link CACHE_TTL_MS} window is one this build cannot
 * have written, so it is treated as expired rather than believed. Clamping
 * rather than dropping the entry keeps it available as the stale-but-better-
 * than-nothing answer when the re-resolution fails.
 */
function hasExpired(entry: Resolution, now: number): boolean {
  const { expires } = entry;
  if (typeof expires !== "number") return true;
  return !(expires > now && expires <= now + CACHE_TTL_MS);
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
 * `perHost` is §04.4's answer for this locator, and it is passed in rather than
 * asked for: the callers hold the table already, and importing it here to answer
 * a question only the *write* path asks would put `resolveArtifactRegistry` and
 * its caches into the chunk a warm read is measured on (§16, Build shape).
 *
 * A write failure is swallowed, per §07.8's rule for derived state: a read-only
 * checkout must still be able to *run*, and the cost of not recording is one
 * extra resolution next time. Frozen mode (§04.4) is the deliberate refusal and
 * is decided by the caller, before any of this.
 */
export function writeResolution(
  dir: string,
  descriptor: Descriptor,
  locator: Locator,
  hash: string | undefined,
  perHost = false,
): void {
  writeEntry(dir, descriptor, locator, hash, perHost);
}

/**
 * §04.4 — memo the resolution in `<dir>/node_modules/.jup`, with an expiry stamp.
 *
 * Does nothing when `node_modules` is not already a directory: creating it would
 * be jup conjuring the package manager's own directory into existence — possibly
 * in a repository holding nothing but an `.nvmrc` — for a run asked only to print
 * a version. Not caching costs one resolution next time, and §04.1 step 4's store
 * probe already answers most of those offline.
 *
 * The `.jup` directory within it is jup's own and is created on demand — the one
 * directory that rule is not about, and without it there is nowhere to write.
 */
export function writeCachedResolution(
  dir: string,
  descriptor: Descriptor,
  locator: Locator,
  hash: string | undefined,
  perHost = false,
  now = Date.now(),
): void {
  try {
    const modules = statSync(join(dir, MODULES_DIRECTORY), { throwIfNoEntry: false });
    if (modules?.isDirectory() !== true) return;
  } catch {
    return;
  }

  const cacheDir = join(dir, CACHE_DIRECTORY);
  try {
    mkdirSync(cacheDir, { recursive: true });
  } catch {
    // Read-only, or `.jup` already there as a file: derived state, so the run
    // continues and pays one resolution next time (see `writeResolution`).
    return;
  }

  writeEntry(cacheDir, descriptor, locator, hash, perHost, now + CACHE_TTL_MS);
}

function writeEntry(
  dir: string,
  descriptor: Descriptor,
  locator: Locator,
  hash: string | undefined,
  perHost: boolean,
  expires?: number,
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
      // §04.4 — one key per host, and the other hosts' keys are carried over,
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

  if (expires !== undefined) resolution.expires = expires;

  data.resolutions[key] = resolution;

  save(dir, data);
}

/**
 * Removing a range pin retires its resolution so restoring the range cannot resurrect stale state.
 */
export function removeResolution(dir: string, key: string): void {
  // The cache is keyed by the same string, so a range the field no longer names
  // loses its memo too: otherwise editing the pin back to that range would
  // resurrect a stale resolution without even the request that would correct it.
  removeCachedResolution(dir, key);
  dropResolution(dir, key);
}

/**
 * Drop one key from the **memo** alone (§04.4).
 *
 * What `use` and `up` record supersedes the memo beside it, and a memo left
 * there answers alone wherever the recorded file is not visible — an uncommitted
 * write, a `git stash`, a CI cache holding `node_modules` but not the lockfile —
 * with the version the command just replaced. An emptied `.jup` is left alone:
 * removing it would race the next run's `mkdir`.
 */
export function removeCachedResolution(dir: string, key: string): void {
  dropResolution(join(dir, CACHE_DIRECTORY), key);
}

function dropResolution(dir: string, key: string): void {
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
/**
 * The entry `descriptor` would use out of the file in `dir`, if it still stands.
 * "Still satisfies" is the **lenient** test (§04.2); {@link readResolution} says why.
 *
 * Exported for `info`, which must report the entry through the gate the run
 * applies: a recorded version outside its range is one the run skips, so naming
 * it would describe a resolution the very next invocation refuses.
 */
export function readEntry(dir: string, descriptor: Descriptor): Resolution | null {
  const data = readLockfile(dir);
  if (data === null) return null;

  const key = resolutionKey(descriptor);
  if (!Object.hasOwn(data.resolutions, key)) return null;
  const entry = data.resolutions[key]!;

  if (isValidRange(descriptor.range) && !satisfiesWithPrereleases(entry.resolved, descriptor.range))
    return null;

  return entry;
}

/**
 * The locator one entry stands for. The recorded digest becomes a build suffix,
 * which is what makes it *used* rather than merely stored: §06.1 row 1 treats a
 * reference-borne hash as an explicit pin and checks the bytes against it.
 *
 * §04.4 — a **bare** digest recorded for a tool whose artifact is per-host is
 * not this host's fact and is not treated as one. Nothing writes such an entry:
 * {@link writeEntry} takes that branch on `perHost` and records a map keyed by
 * host. Such a digest may describe a portable artifact while the active band is
 * per-host, so applying it would reject the correct host artifact. Drop the
 * digest but retain the version; the bytes are still verified,
 * by npm's signature over them (§06.3), and the next `use` or `up` records the
 * host map.
 */
function locatorFor(descriptor: Descriptor, entry: Resolution): Locator {
  const stale =
    typeof entry.integrity === "string" &&
    isPerHost({ name: descriptor.name, reference: entry.resolved });
  const integrity = stale ? undefined : integrityForHost(entry);
  const hash = integrity === undefined ? undefined : hashFromIntegrity(integrity);
  return {
    name: descriptor.name,
    reference: hash === undefined ? entry.resolved : `${entry.resolved}+${hash}`,
  };
}

function serialise(data: LockfileData): string {
  const resolutions: Record<string, Resolution> = {};
  for (const key of Object.keys(data.resolutions).sort()) {
    const entry = data.resolutions[key]!;
    // §04.4's map is sorted for the same reason the keys above are: a host that
    // records its own digest must produce a one-line diff, not a reordering of
    // everybody else's.
    resolutions[key] =
      typeof entry.integrity === "object"
        ? { ...entry, integrity: sorted(entry.integrity) }
        : entry;
  }
  return `${JSON.stringify({ version: LOCKFILE_VERSION, resolutions }, undefined, 2)}\n`;
}

/**
 * Skip byte-identical writes to preserve mtime and avoid concurrent churn; otherwise replace atomically.
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
    // In `dir`, the destination's own directory, because `rename` is atomic
    // only within one filesystem — a temp elsewhere would be a copy that tears.
    // Dot-prefixed, though the file it replaces is not: the temp name is the one
    // thing here that can be left behind — a kill between write and rename — and
    // an orphan at the project root should not turn up in `git status` next to
    // the file it failed to become. `pin.ts` hides its manifest temp for the
    // same reason.
    tmp = join(dir, `.${LOCKFILE_NAME}.${process.pid}.tmp`);
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

/** Sort an object's keys, so re-serialising an unchanged file round-trips. */
function sorted(map: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(map).sort()) out[key] = map[key]!;
  return out;
}

/**
 * Validate the `integrity` field of one entry: a string, or §04.4's host map
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
 * machine (§04.4).
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
 * pulls `node:crypto` (§16, Build shape). An algorithm this implementation does not support
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
