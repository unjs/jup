/**
 * The store — §07.
 *
 * The tool owns exactly one directory. Its concurrency story is a single
 * primitive: **rename is atomic within a filesystem, and losing that race is a
 * success**. There is no lockfile and must never be one (§07.5).
 */

const {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} = process.getBuiltinModule("node:fs");
const { homedir } = process.getBuiltinModule("node:os");
const { dirname, isAbsolute, join, relative, sep } = process.getBuiltinModule("node:path");
import { ENV, readEnv, SYSTEM_ENV } from "../config/env-vars.ts";
import { isPerHost, isSupportedPackageManager } from "../config/table.ts";
import { envDisabled } from "../project/env.ts";
import { messages, UsageError } from "../errors.ts";
import {
  compare,
  isValidVersion,
  lt,
  major,
  parse,
  satisfiesWithPrereleases,
} from "../version/semver.ts";
import type { SemVer } from "../version/semver.ts";
import type { CorepackMarker, Installation, ResolvedSpec } from "../types.ts";

/** §07.2 — the file whose presence means "this install is complete and valid". */
export const MARKER_NAME = ".jup";

/** §04.5 — the global default map. Lives outside `v1`, so `cache clean` spares it. */
export const LAST_KNOWN_GOOD_NAME = "lastKnownGood.json";

/** §07.2 — the layout-version segment; bumping it abandons old caches wholesale. */
export const LAYOUT_VERSION = "v1";

/**
 * §07.11 — where `self-install` keeps jup's own files.
 *
 * Beside `v1` rather than inside it, for the reason {@link LAST_KNOWN_GOOD_NAME}
 * is: `cache clean` empties the cache, and the copy of jup that the shims on the
 * user's `PATH` point at is not a cache entry. Under `v1` a `jup cache clean`
 * would delete the very executable that ran it and leave every shim dying with
 * `bad interpreter` — §07.11's failure, one directory over, and this time with
 * no `enable` left to repair it.
 */
export const SELF_FOLDER_NAME = "self";

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/**
 * Four random bytes, hex encoded, for a temp file name.
 *
 * `node:crypto` is reached through `process.getBuiltinModule` rather than an
 * `import`: importing it pulls in two dozen native modules and neither caller —
 * `createTempDir`, `writeLastKnownGood` — is on the warm path (§01.3, §16, Build shape).
 */
function randomSuffix(): string {
  return process.getBuiltinModule("node:crypto").randomBytes(4).toString("hex");
}

/**
 * Cache root precedence: `COREPACK_HOME`; otherwise `XDG_CACHE_HOME`; on Windows only, `LOCALAPPDATA`; otherwise the platform home default. Empty `COREPACK_HOME` is honored. Append `jup`.
 */
export function getHomeFolder(): string {
  const home = readEnv(ENV.HOME);
  if (home !== undefined) return home;

  const isWindows = process.platform === "win32";
  const cacheRoot =
    process.env[SYSTEM_ENV.XDG_CACHE_HOME] ??
    (isWindows ? process.env[SYSTEM_ENV.LOCALAPPDATA] : undefined) ??
    join(homedir(), isWindows ? join("AppData", "Local") : ".cache");

  return join(cacheRoot, "jup");
}

/** `<home>/v1` — a layout-version segment. Incrementing it abandons old caches wholesale. */
export function getInstallFolder(): string {
  return join(getHomeFolder(), LAYOUT_VERSION);
}

/** `<home>/self` — §07.11's root, one directory per installed version of jup. */
export function getSelfFolder(): string {
  return join(getHomeFolder(), SELF_FOLDER_NAME);
}

/**
 * §10.2 — would `cache clean` delete `file`?
 *
 * That is the question every caller is actually asking, and the answer is the
 * *install folder* rather than the whole of `<home>`. {@link cacheClean} removes
 * `getInstallFolder()` and nothing else, and §07.11's `self/` is a sibling of
 * `v1` precisely so that it cannot be reached; a runtime parked beside it —
 * `<home>/node`, which an install script downloads when the machine has none —
 * is as durable as one the user installed by hand. Refusing to name those is
 * what leaves a machine with no host `node` holding shims that resolve to
 * nothing, which is the opposite of what §10.2 is for.
 *
 * A path-boundary test rather than a `startsWith` on the two strings: an install
 * folder of `~/.cache/jup/v1` would otherwise swallow `~/.cache/jup/v10`.
 * `relative` gives the boundary — empty or `..`-leading means "not below" — and
 * handles Windows's case-insensitive comparison on the way.
 *
 * `file` is expected to be a realpath already; the root is resolved here, and
 * falls back to its literal spelling when it does not exist yet, which cannot
 * answer wrongly since nothing is inside a directory that is not there.
 */
export function isInsideInstallFolder(file: string): boolean {
  return isBelow(getInstallFolder(), file);
}

/**
 * Is `file` below `root`? The shared half of the test above.
 *
 * `root` is resolved here and falls back to its literal spelling when it does
 * not exist yet, which cannot answer wrongly since nothing is inside a directory
 * that is not there.
 */
function isBelow(root: string, file: string): boolean {
  let resolved = root;
  try {
    resolved = realpathSync(root);
  } catch {
    // Not created yet, or not readable: the literal spelling is the best there is.
  }
  // `..hidden` is a legal name, so the escape test compares whole segments.
  const rel = relative(resolved, file);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * Plain semver with the build suffix removed, so two references differing only
 * in their hash share one directory. URL references use
 * `encodeURIComponent(url without fragment)`.
 */
export function getVersionDir(locator: ResolvedSpec): string {
  return versionDirFor(locator, parse(locator.reference));
}

/** {@link getVersionDir} with the parse already done — the probe needs both. */
function versionDirFor(locator: ResolvedSpec, parsed: SemVer | null): string {
  if (parsed !== null) return parsed.version;

  // A URL reference: the fragment carries the hash (§02.1), so it is stripped
  // before encoding. The result is one filesystem-safe path segment.
  if (URL.canParse(locator.reference)) {
    const url = new URL(locator.reference);
    const href = url.hash ? url.href.slice(0, url.href.length - url.hash.length) : url.href;
    return encodeURIComponent(href);
  }

  // Neither a version nor a URL. Unreachable through §04, but encoding keeps a
  // stray reference from escaping its directory.
  return encodeURIComponent(locator.reference);
}

/**
 * §07.2 — read the `.jup` marker. Its presence is the "this install is
 * complete and valid" signal, and reading it is the entire warm path: `ENOENT`
 * proceeds to download, any other error propagates, and a marker whose shape is
 * wrong reads as absent.
 */
export function readMarker(dir: string): CorepackMarker | null {
  let text: string;
  try {
    text = readFileSync(join(dir, MARKER_NAME), "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }

  // A truncated or corrupt marker is a broken install, not a cache miss:
  // propagate rather than silently re-downloading over it.
  const marker: unknown = JSON.parse(text);

  // A marker of the wrong *shape*, though, is not a marker — and not everything
  // that writes one is this tool (§07.10). `hash` is re-attached to the locator
  // by `referenceWithHash` and lands in the **committed** `packageManager`
  // field; `bin` names paths §08 executes. Both are checked, and anything else
  // is the missing marker every caller already handles (§07.2).
  const hash: unknown = (marker as { hash?: unknown } | null)?.hash;
  if (typeof hash !== "string" || !/^[a-z0-9]{1,32}\.[0-9a-z]{1,128}$/.test(hash)) return null;
  // §08.1 — `bin` is optional, and when present it is §02.4's one form: a
  // `{name: path}` map. An array is not that shape and reads as no marker.
  const bin: unknown = (marker as { bin?: unknown }).bin;
  if (bin !== undefined) {
    if (typeof bin !== "object" || bin === null || Array.isArray(bin)) return null;
    if (!Object.values(bin).every((entry) => typeof entry === "string")) return null;
  }
  return marker as CorepackMarker;
}

/**
 * §07.2 / §01.3 — the entire warm path, in one call: the store location for a
 * locator plus its marker, or `null` when the version is not installed.
 *
 * It lives here rather than in `install` so the proxy path can answer "is this
 * already installed?" without loading the download-and-verify stack — `http`,
 * `tar`, `integrity` and `registry` are ~36 KB of code and 70-odd native modules
 * that a warm run never executes (§16, Build shape).
 */
export function readInstalledSpec(locator: ResolvedSpec): Installation | null {
  return resolveInstallTarget(locator).installed;
}

/**
 * A pinned cache hit requires the marker hash to match. If the plain version directory contains another artifact, use `<version>+<algo>.<digest>` so distinct pins cannot silently share bytes.
 */
export function resolveInstallTarget(locator: ResolvedSpec): {
  location: string;
  installed: Installation | null;
} {
  const root = join(getInstallFolder(), locator.name);
  const parsed = parse(locator.reference);
  const versionDir = versionDirFor(locator, parsed);

  const location = join(root, versionDir);
  const marker = readMarker(location);
  const pin = readHashPin(locator.reference, parsed?.build);

  if (pin.digest === undefined) {
    return {
      location,
      installed: marker === null ? null : { location, bin: marker.bin, hash: marker.hash },
    };
  }

  if (marker !== null && markerProvesPin(marker, pin)) {
    return { location, installed: { location, bin: marker.bin, hash: marker.hash } };
  }

  // The plain directory holds something else — or nothing. Either way this
  // reference's artifact belongs in a directory named after the digest it pins.
  const qualified = join(root, `${versionDir}+${serializePin(pin)}`);
  const other = readMarker(qualified);
  if (other === null) {
    // With the plain directory free, keep §07.2's layout: qualifying is for
    // resolving a collision, not for every pinned project.
    return { location: marker === null ? location : qualified, installed: null };
  }
  if (!markerProvesPin(other, pin)) {
    // Only reachable if something outside the tool wrote this directory: it is
    // named after the very digest its marker must carry. §06.2's message is the
    // right one — the store holds bytes other than the ones the pin names.
    throw new Error(messages.mismatchHashes(pin.digest, other.hash));
  }
  return {
    location: qualified,
    installed: { location: qualified, bin: other.bin, hash: other.hash },
  };
}

/**
 * `<algo>.<hex>`, the serialized form §07.2 stores in the marker. Encoded
 * because it becomes a path segment: a URL reference takes its digest from
 * `new URL(ref).hash`, which may hold `/` and `..`. `versionDirFor` encodes for
 * the same reason.
 */
function serializePin(pin: HashPin): string {
  return encodeURIComponent(`${pin.algo.toLowerCase()}.${pin.digest ?? ""}`);
}

/**
 * Whether the marker's recorded hash is the one this reference pinned.
 *
 * Constant-time in the digest bytes. Lengths are public — they follow from the
 * algorithm name, which is in the reference the attacker is trying to match —
 * so an early return on a length difference leaks nothing, and `node:crypto`'s
 * `timingSafeEqual` stays unimported: it would put twenty-odd native modules on
 * a path the warm run exists to keep empty (§16, Build shape).
 */
function markerProvesPin(marker: CorepackMarker, pin: HashPin): boolean {
  const expected = serializePin(pin);
  const actual = marker.hash;
  if (typeof actual !== "string" || actual.length !== expected.length) return false;

  let diff = 0;
  for (let index = 0; index < expected.length; index++) {
    diff |= expected.charCodeAt(index) ^ actual.charCodeAt(index);
  }
  return diff === 0;
}

/** §02.1 — a reference's build suffix, from semver build metadata or a URL fragment. */
export interface HashPin {
  algo: string;
  digest?: string;
}

/** §06.2 — `build[0]` absent means `sha512`. */
const DEFAULT_HASH_ALGO = "sha512";

/**
 * §06.2 — `algo` from `build[0]`/the URL fragment, `digest` from `build[1]`.
 *
 * Lives beside the store rather than in `install` because §06.1's cache-hit
 * check needs exactly the same reading of a reference, and a second copy of it
 * would be a second chance to disagree about what counts as a pin.
 */
export function readHashPin(reference: string, build?: readonly string[]): HashPin {
  if (build !== undefined) {
    return { algo: build[0] ?? DEFAULT_HASH_ALGO, digest: build[1] };
  }

  // A URL reference carries the same information in its fragment:
  // `https://example.com/yarn.js#sha256.deadbeef` (§02.1).
  let fragment = "";
  try {
    fragment = new URL(reference).hash.slice(1);
  } catch {
    // Not a URL either; there is simply no pin to read.
  }

  const dot = fragment.indexOf(".");
  if (fragment === "") return { algo: DEFAULT_HASH_ALGO };
  if (dot === -1) return { algo: fragment };
  return { algo: fragment.slice(0, dot), digest: fragment.slice(dot + 1) };
}

export function writeMarker(dir: string, marker: CorepackMarker): void {
  writeFileSync(join(dir, MARKER_NAME), JSON.stringify(marker), "utf8");
}

/**
 * §07.10 — the `hash` written over a claim that nothing here could attribute.
 *
 * `cache install -g <archive>.tgz` promotes markers it did not write, over bytes it
 * never hashed (`pack` ships extracted subtrees, not the artifact tarball the
 * digest was taken over). The claim is replaced rather than deleted, because
 * §07.2 requires the field and a marker failing shape validation is treated as
 * no marker at all — which would make the promoted entry unusable rather than
 * merely unpinnable.
 *
 * Deliberately not spelled like an algorithm: a value reading as `sha512.…`
 * would be a lie of a different kind. It satisfies §07.2's character class, so
 * the marker still parses, but it can never satisfy {@link markerProvesPin}.
 */
export const UNATTRIBUTABLE_HASH = "unattributable.0";

/**
 * §07.6 step 3 — the reference that goes into `package.json` and the store's
 * bookkeeping, carrying the hash of the bytes we actually have.
 *
 * `ensureInstalled` rewrites `locator.reference` on the download path, but the
 * warm path returns from the `.jup` marker without touching it, so the hash
 * has to be re-attached here. The installed artifact's hash always wins:
 * composing the result from `parse().version` rather than appending means a
 * reference that already carries a suffix is rewritten, not grown a second one.
 *
 * It lives here because both callers — `main`'s auto-pin (§03.6) and the four
 * `cli` commands that record a reference (§09) — already sit above `store`, and
 * `main` must not import `cli`.
 */
export function referenceWithHash(name: string, reference: string, hash: string): string {
  const parsed = parse(reference);
  // A URL reference keeps its own `#algo.digest` notation and is never rewritten.
  if (parsed === null) return reference;

  // §02.4 — a per-host artifact's digest is a fact about *this machine*, and a
  // reference is the wrong place to keep it: references travel. They go into
  // `packageManager`, which is committed, and into `lastKnownGood.json`, which
  // is copied into container images and warmed caches. Either way the digest
  // arrives somewhere it cannot match, and §06.1 row 1 then treats it as an
  // explicit pin and refuses the correct artifact. The store's marker is where
  // a host-local digest belongs, and it already holds one.
  if (isPerHost({ name, reference })) return parsed.version;

  // §07.10 — the same reasoning, for a digest that is not a fact about anything.
  // An archive-seeded entry carries {@link UNATTRIBUTABLE_HASH} in place of a
  // claim nothing verified, and this is the one function standing between that
  // marker and the user's committed `packageManager` field. A pin nobody can
  // satisfy is worse than no pin: it would refuse the correct artifact on every
  // other machine (§06.1 row 1) and re-download on this one.
  if (hash === UNATTRIBUTABLE_HASH) return parsed.version;

  return `${parsed.version}+${hash}`;
}

/**
 * `mkdir -p`, mapping the one filesystem failure users actually hit to §12.8's
 * message. `target` names the directory reported to the user (§07.8).
 */
function ensureDir(dir: string, target: string): void {
  try {
    // §07.4 rule 6's ceiling, applied to the store's own directories: `mkdir`
    // defaults to `0o777 & ~umask`, and a `0` umask — the default in a good
    // many container images — would make the store world-writable. `mkdirSync`
    // narrows this by the umask itself, so it is a ceiling and not a grant.
    mkdirSync(dir, { recursive: true, mode: 0o755 });
  } catch (error) {
    if (errorCode(error) === "EACCES") {
      throw new UsageError(messages.failedToCreateCacheDir(target));
    }
    throw error;
  }
}

/** Temp dirs live **inside** the install folder so the promoting rename never crosses a filesystem. */
export function createTempDir(): string {
  const installFolder = getInstallFolder();
  ensureDir(installFolder, installFolder);

  // The name only has to be unique; `EEXIST` simply means "draw again".
  for (;;) {
    const dir = join(installFolder, `jup-${process.pid}-${randomSuffix()}`);
    try {
      // `0o700` while it fills: under a `0` umask the default would let any
      // local user edit the tree between the digest check and the rename that
      // publishes it. `promote` widens it to the ceiling at that rename.
      mkdirSync(dir, { mode: 0o700 });
      return dir;
    } catch (error) {
      const code = errorCode(error);
      if (code === "EEXIST") continue;
      if (code === "EACCES") throw new UsageError(messages.failedToCreateCacheDir(installFolder));
      throw error;
    }
  }
}

/** Synchronous sleep — the Windows rename retry is on a synchronous path. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * §07.5 — the rename is the commit point. `true` when this call published `tmp`;
 * `false` when another process won, leaving `tmp` for the caller to dispose of
 * once it knows whether the winner is what it wanted. An occupied `dest` with no
 * marker is neither, and throws. Windows retries 5x, `100 * 2^i` ms.
 */
export function promote(tmp: string, dest: string): boolean {
  ensureDir(dirname(dest), getInstallFolder());

  // The rename publishes the staging tree, so `0o700` widens to the ceiling the
  // extractor gave the directories inside it: a store seeded by one user for
  // another to run (§07.4) has to be traversable. Best-effort, and a
  // filesystem without modes simply keeps the stricter one.
  try {
    chmodSync(tmp, 0o755 & ~process.umask());
  } catch {}

  const isWindows = process.platform === "win32";
  const attempts = isWindows ? 5 : 1;

  for (let i = 0; i < attempts; i++) {
    try {
      renameSync(tmp, dest);
      return true;
    } catch (error) {
      const code = errorCode(error);

      // Occupied. A benign lost race *only* if it proves to be a completed
      // install: the marker goes in before the rename, so a winner always has
      // one. Without it this is a foreign or half-copied tree, and adopting it
      // hands the caller unverified bytes plus an entry that re-downloads for
      // ever.
      if (
        code === "EEXIST" ||
        code === "ENOTEMPTY" ||
        (isWindows && code === "EPERM" && isDirectory(dest))
      ) {
        if (readMarker(dest) === null) throw new UsageError(messages.occupiedInstallDir(dest));
        // `tmp` is the caller's: whether those bytes are still wanted depends
        // on what the winner turned out to be, which this cannot answer.
        return false;
      }

      // Windows antivirus holds newly-written files open; back off and retry.
      if (isWindows && i < attempts - 1 && (code === "EPERM" || code === "ENOENT")) {
        sleepSync(100 * 2 ** i);
        continue;
      }

      throw error;
    }
  }

  // Unreachable: the retry branch is gated on `i < attempts - 1`. For the type.
  /* v8 ignore next */
  throw new Error(messages.occupiedInstallDir(dest));
}

/**
 * §04.2 + §04.3 — the cache probe.
 *
 * For an **exact** version this must `stat` the marker directly and skip the
 * directory scan entirely; the scan is for genuine ranges only. Dot-entries are
 * skipped, and matching uses `satisfiesWithPrereleases` to stay consistent with
 * the rest of the pipeline.
 */
export function findInstalledVersion(name: string, range: string): string | null {
  const installFolder = getInstallFolder();

  // §04.3 — the hottest path in the tool: an exactly-pinned `packageManager`
  // field. The answer is trivially the version itself, so one `stat` replaces an
  // `opendir` plus a semver parse per installed version. The build suffix is
  // dropped because the directory name never carries one (§07.2), and the marker
  // hands the real hash back to the caller.
  if (isValidVersion(range)) {
    const parsed = parse(range)!;
    const version = parsed.version;
    const pin = readHashPin(range, parsed.build);

    // §06.1 — a reference with no digest has nothing to prove, so this stays
    // the single `stat` §04.3 budgets.
    if (pin.digest === undefined) {
      try {
        statSync(join(installFolder, name, version, MARKER_NAME));
        return version;
      } catch (error) {
        const code = errorCode(error);
        if (code === "ENOENT" || code === "ENOTDIR") return null;
        throw error;
      }
    }

    // §06.1 — a hash-bearing reference is a cache *hit* only if the stored
    // marker proves that hash. It has to happen here as well as in
    // {@link resolveInstallTarget}, because §04.1 step 4 answers with the bare
    // version and the pin is gone from the locator by the time anything reads
    // the marker again. The `stat` becomes a read of the same file.
    const proven = readMarker(join(installFolder, name, version));
    if (proven !== null && markerProvesPin(proven, pin)) return version;

    // A previous collision may have put this reference's artifact in a
    // directory of its own. Answering with the *pinned* reference is what
    // routes the caller back to it; the bare version would send it to the
    // directory that just failed to prove the pin.
    const qualified = `${version}+${serializePin(pin)}`;
    const other = readMarker(join(installFolder, name, qualified));
    return other !== null && markerProvesPin(other, pin) ? qualified : null;
  }

  let entries: string[];
  try {
    entries = readdirSync(join(installFolder, name));
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }

  let best: string | null = null;
  for (const entry of entries) {
    // macOS drops `.DS_Store` into every directory it displays.
    if (entry.startsWith(".")) continue;

    // §04.2 — prerelease-tolerant, matching every other range test in the
    // pipeline. Strict `range.test` here makes a prerelease install re-hit the
    // network on every single run.
    if (!satisfiesWithPrereleases(entry, range)) continue;

    // §04.3 — a pin-qualified directory (`1.22.22+sha512.<hex>`, §07.2) MUST NOT
    // answer a range. Semver ignores build metadata, so such an entry both
    // satisfies the range and *ties* with its bare sibling under `compare`,
    // leaving `readdirSync` order to decide which one answers. What it answers
    // with becomes `locator.reference`, so the tie would carry a digest the user
    // never pinned into `bumpLastKnownGood` and on into `lastKnownGood.json`. For
    // a per-host tool that also bypasses {@link referenceWithHash}'s deliberate
    // refusal to attach a per-host digest (§07.6), because the digest would
    // arrive by directory name rather than from the install. A range is answered
    // by the bare version, and the pinned reference routes to its own directory
    // through the exact branch above.
    if (entry.includes("+")) continue;

    // `!== 1` accepts a tie, so the later directory entry wins.
    if (best === null || compare(best, entry) !== 1) best = entry;
  }

  return best;
}

/**
 * §04.5 — maximally forgiving. Every failure mode returns `{}` rather than
 * erroring, and entries whose value is not a string are dropped — which is what
 * makes {@link STAMPS_KEY}'s object value invisible here, and to every older
 * build that reads this file.
 */
export function readLastKnownGood(): Record<string, string> {
  return readLastKnownGoodParts().entries;
}

/**
 * §04.5 — the whole file, parsed once.
 *
 * Callers that want both halves take them from **one** read. There is no lock
 * here (§07.5) and a write commits with a single `rename`, so each read is
 * self-consistent but two of them can straddle a concurrent write and pair one
 * version's entries with another's stamps. The cost of that would only ever be a
 * stamp attached to a reference it did not describe — one stale answer or one
 * extra request — but it is avoidable for the price of not reading twice.
 */
function readLastKnownGoodParts(): {
  entries: Record<string, string>;
  stamps: Record<string, LastKnownGoodStamp>;
} {
  const data = readLastKnownGoodFile() as Record<string, unknown>;

  const entries: Record<string, string> = {};
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === "string") entries[key] = value;
  }

  const stamps: Record<string, LastKnownGoodStamp> = {};
  const raw = data[STAMPS_KEY];
  if (raw && typeof raw === "object") {
    for (const [key, value] of Object.entries(raw)) {
      if (value === PINNED_STAMP) stamps[key] = PINNED_STAMP;
      else if (typeof value === "number" && Number.isFinite(value)) stamps[key] = value;
    }
  }

  return { entries, stamps };
}

/** The parsed file, or `{}` for every way it can fail to be one. */
function readLastKnownGoodFile(): object {
  let text: string;
  try {
    text = readFileSync(join(getHomeFolder(), LAST_KNOWN_GOOD_NAME), "utf8");
  } catch {
    // Missing, unreadable, a directory — all of it is bookkeeping, and §07.8
    // requires bookkeeping to degrade rather than block.
    return {};
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return {};
  }

  // Arrays deliberately pass; their numeric keys are harmless.
  if (!data || typeof data !== "object") return {};
  return data;
}

/**
 * §04.5 — write to a temp file in the same directory and rename over. `EROFS` is
 * swallowed.
 *
 * Omitting `stamps` **keeps** the ones already on disk: a caller changing which
 * version is recorded is not thereby saying anything about when it was last
 * checked, and the safe default for a whole-map write is not to silently drop a
 * key it never mentioned. Pass `{}` to clear them.
 *
 * An empty stamp map writes **no** {@link STAMPS_KEY} at all, so a store that
 * has never needed one keeps a file byte-identical to what every earlier release
 * wrote.
 */
export function writeLastKnownGood(
  lkg: Record<string, string>,
  stamps?: Record<string, LastKnownGoodStamp>,
): void {
  const home = getHomeFolder();
  const target = join(home, LAST_KNOWN_GOOD_NAME);
  const kept = stamps ?? readLastKnownGoodStamps();
  const data = Object.keys(kept).length === 0 ? lkg : { ...lkg, [STAMPS_KEY]: kept };
  const content = `${JSON.stringify(data, null, 2)}\n`;

  let tmp: string | undefined;
  try {
    mkdirSync(home, { recursive: true, mode: 0o755 });

    // Same directory, so the rename is atomic: a concurrent reader sees either
    // the old file or the new one, never a truncated interleaving (§04.5).
    tmp = `${target}.${process.pid}-${randomSuffix()}`;
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, target);
  } catch (error) {
    if (tmp !== undefined) rmSync(tmp, { force: true });

    // §07.8 — a read-only or unwritable store (`EROFS`, `EACCES`, a
    // deleted home) must never fail a run or print anything. Anything without an
    // errno is a bug in this module and still propagates.
    if (errorCode(error) !== undefined) return;
    throw error;
  }
}

/**
 * §04.5 — the stamp for one recorded default: when it was last taken from the
 * registry, or {@link PINNED_STAMP} for a default the user chose outright.
 */
export type LastKnownGoodStamp = number | typeof PINNED_STAMP;

/**
 * §04.5 — `install -g` and `pack` write this instead of a timestamp.
 *
 * `jup cache install -g yarn@1.22.22` is a statement about what the user wants to run,
 * not a cache of what the registry last said, so §04.6's TTL must not quietly
 * carry it to 4.x overnight. A sentinel rather than a far-future timestamp: the
 * distinction is "explicit", not "expires late", and a clock that jumps must not
 * be able to turn one into the other.
 */
export const PINNED_STAMP = "pinned";

/**
 * §04.5 — where the stamps live *inside* `lastKnownGood.json`.
 *
 * One file, not two. The reference and its stamp are one fact and land in one
 * `rename`, so no crash can leave a recorded default whose stamp says something
 * else, and there is no second file to drift, race or clean up.
 *
 * A **reserved key** rather than a richer value, because the file's shape —
 * `{"<tool>": "<reference>"}` — is what {@link readLastKnownGood} and any
 * corepack sharing this `COREPACK_HOME` read. Both look entries up *by tool
 * name* and never enumerate, so a key that cannot be one is invisible to them:
 * this build's reader already drops every non-string value, and an older one
 * does the same. Tool names come from the compiled-in table (§02.5), so `#` at
 * the front makes the collision impossible rather than merely unlikely.
 */
export const STAMPS_KEY = "#stamps";

/**
 * §04.5 — as forgiving as {@link readLastKnownGood}, and for the same reason.
 *
 * A stamp this function drops reads as expired (§04.6), so corruption costs one
 * registry request, never a wrong answer.
 */
export function readLastKnownGoodStamps(): Record<string, LastKnownGoodStamp> {
  return readLastKnownGoodParts().stamps;
}

/**
 * §04.5 — record one default and, optionally, restamp it.
 *
 * Read-modify-write, so the other tools' entries and every stamp this call is
 * not about survive. Omitting `stamp` leaves the existing one alone: §02.4's
 * repair and §04.8's bump both change *which version* is recorded without
 * changing when it was last taken from the registry.
 */
export function recordLastKnownGood(
  name: string,
  reference: string,
  stamp?: LastKnownGoodStamp,
): void {
  // One read, and it happens as late as possible. There is no lock (§07.5), so
  // this is a read-modify-write whose loser is whoever renames first; keeping
  // the window to the two statements below is the whole of the mitigation, and
  // it is why the caller does not hand its own much older map back to us.
  const { entries, stamps } = readLastKnownGoodParts();
  entries[name] = reference;
  if (stamp !== undefined) stamps[name] = stamp;
  writeLastKnownGood(entries, stamps);
}

/**
 * §04.6 — how long a recorded default stands before it is re-checked, in hours.
 *
 * `0` disables the TTL, which is the behaviour every version before this one
 * had: the entry stands until `install -g`, `pack`, §04.8's bump or a hand edit
 * replaces it. Unlike `JUP_MINIMUM_RELEASE_AGE`, garbage falls back to the
 * default instead of being refused — §04.1's rule for every numeric variable
 * that is not a supply-chain control. A mistyped TTL costs one request a day; it
 * cannot turn a protection off, because it is not one.
 */
export function defaultTtlMs(): number {
  const raw = readEnv(ENV.DEFAULT_TTL);
  const hours = raw === undefined || raw.trim() === "" ? DEFAULT_TTL_HOURS : Number(raw.trim());
  if (!Number.isFinite(hours) || hours < 0) return DEFAULT_TTL_HOURS * 60 * 60 * 1000;
  return hours * 60 * 60 * 1000;
}

/** §04.6 — the TTL a machine gets when it says nothing. */
const DEFAULT_TTL_HOURS = 24;

/**
 * §04.6 — whether the recorded default may answer without asking the registry.
 *
 * A **missing** stamp reads as expired, exactly as §04.4's memo does with a
 * missing `expires`, and so does one further out than a whole TTL window from
 * now — a home restored from an image, or written under a fast clock, would
 * otherwise pin a default for as long as its stamp claimed. That also makes the
 * upgrade to a stamped store self-healing: every default already on disk is
 * re-checked once, which is the whole point of the feature.
 *
 * {@link PINNED_STAMP} never expires: §04.5's sentinel marks a default the user
 * stated outright, and a TTL is a statement about *derived* state.
 */
export function isDefaultFresh(name: string): boolean {
  const ttl = defaultTtlMs();
  if (ttl === 0) return true;

  const stamp = readLastKnownGoodStamps()[name];
  if (stamp === PINNED_STAMP) return true;
  if (stamp === undefined) return false;

  const now = Date.now();
  return stamp + ttl > now && stamp <= now;
}

/**
 * §04.8 — advance the recorded default after a successful install, but only
 * within the same major and only strictly upward. If there is no existing entry,
 * nothing is written.
 *
 * It lives next to the two accessors it is built from: both callers (§04's
 * pipeline, §07.6's promotion) sit *above* `store` in the layering described in
 * §16, Source map.
 */
export function bumpLastKnownGood(locator: ResolvedSpec): void {
  if (envDisabled(ENV.DEFAULT_TO_LATEST)) {
    return;
  }

  // "Supported (non-URL)": an unknown name has no default to advance, and a URL
  // reference is not a version at all.
  if (!isSupportedPackageManager(locator.name) || !isValidVersion(locator.reference)) {
    return;
  }

  const lkg = readLastKnownGood();
  const current = lkg[locator.name];

  // The entry is only ever *created* by §04.6 step 3 or by `install -g`. A
  // one-off `jup yarn@4.9.0 …` must not silently become the global default.
  if (current === undefined || !isValidVersion(current)) {
    return;
  }

  // Major bumps are never automatic, and the comparison ignores build metadata,
  // so re-installing the same version with a different hash suffix writes
  // nothing.
  if (major(current) !== major(locator.reference) || !lt(current, locator.reference)) {
    return;
  }

  // No restamp: §04.6's stamp records when the *registry* last chose, and an
  // install is not that. A pinned entry advanced here stays pinned.
  recordLastKnownGood(locator.name, locator.reference);
}

/**
 * Every complete install in the store, sorted by name then version.
 *
 * "Complete" means §07.2's definition and nothing looser: a directory carrying a
 * `.jup` marker. A half-extracted temp folder (`jup-<pid>-<rand>`) and
 * a `.DS_Store` are both directory entries, and neither is a cached version —
 * counting them would make `cache list` (§09.7) report an image as seeded when
 * it is not. §09.7's "did my image get seeded?" and §09.9's "the cached
 * versions present" are the same listing, so there is one of it.
 */
export function listInstalled(): Array<{ name: string; version: string }> {
  const installFolder = getInstallFolder();

  const found: Array<{ name: string; version: string }> = [];
  for (const name of readdirSafe(installFolder)) {
    if (name.startsWith(".")) continue;
    for (const version of readdirSafe(join(installFolder, name))) {
      if (version.startsWith(".")) continue;
      // The marker's *presence* is the signal (§07.2); its contents are not
      // parsed here, so a corrupt one still lists rather than throwing out of a
      // read-only command.
      if (
        statSync(join(installFolder, name, version, MARKER_NAME), { throwIfNoEntry: false }) ===
        undefined
      ) {
        continue;
      }
      found.push({ name, version });
    }
  }

  return found.sort((a, b) => a.name.localeCompare(b.name) || compare(a.version, b.version));
}

/** A directory listing where "not there" and "not a directory" are both empty. */
function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * §07.9 — `rm -rf <home>/v1`, forced. `lastKnownGood.json` is **not** removed.
 *
 * The survival is deliberate — a recorded default is a preference, not a
 * cache entry — but the documentation said otherwise, so `all` is the explicit
 * way to ask for both. Nothing else may remove that file implicitly.
 *
 * §07.11's `self/` survives both, and `all` does not reach it either: it holds
 * the copy of jup the shims on `PATH` execute, so deleting it would not free a
 * cache entry but uninstall the tool. Removing a self-install is a deliberate
 * act and not a cache operation.
 */
export function cacheClean(options?: { all?: boolean }): void {
  rmSync(getInstallFolder(), { recursive: true, force: true });
  if (options?.all === true) {
    rmSync(join(getHomeFolder(), LAST_KNOWN_GOOD_NAME), { force: true });
  }
}
