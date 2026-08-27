/**
 * The store — §07.
 *
 * The tool owns exactly one directory. Its concurrency story is a single
 * primitive: **rename is atomic within a filesystem, and losing that race is a
 * success**. There is no lockfile and must never be one (§07.5, §16.6).
 */

import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ENV, readEnv, SYSTEM_ENV } from "../config/env-vars.ts";
import { isSupportedPackageManager } from "../config/table.ts";
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
import type { CorepackMarker, InstallSpec, Locator } from "../types.ts";

/** §07.2 — the file whose presence means "this install is complete and valid". */
export const MARKER_NAME = ".jup";

/** §04.4 — the global default map. Lives outside `v1`, so `cache clean` spares it. */
export const LAST_KNOWN_GOOD_NAME = "lastKnownGood.json";

/** §07.2 — the layout-version segment; bumping it abandons old caches wholesale. */
export const LAYOUT_VERSION = "v1";

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/**
 * Four random bytes, hex encoded, for a temp file name.
 *
 * `node:crypto` is reached through `process.getBuiltinModule` rather than an
 * `import`, because importing it pulls in two dozen native modules (webcrypto,
 * x509, keygen, diffiehellman, …) and neither caller — `createTempDir` and
 * `writeLastKnownGood` — is on the warm path (§01.3, §16.3). The lookup itself
 * loads nothing until it is called.
 */
function randomSuffix(): string {
  return process.getBuiltinModule("node:crypto").randomBytes(4).toString("hex");
}

/**
 * §07.1 — `COREPACK_HOME`, else `XDG_CACHE_HOME`/`LOCALAPPDATA`/platform default,
 * joined with `jup`.
 *
 * No `node/` segment, and `jup` not `corepack` (§14.24): the tool does not ship
 * inside Node and the store holds package managers, not anything Node owns. So a
 * corepack cache under `node/corepack` is never read — `v1`'s abandon-wholesale
 * migration, applied one segment higher up.
 *
 * `XDG_CACHE_HOME` is consulted **before** `LOCALAPPDATA` on every platform,
 * including Windows. That is a quirk of corepack's fallback chain rather than
 * design, kept because nothing recommends changing it.
 *
 * §15.13 point 5 narrows the other half: `LOCALAPPDATA` is consulted **only on
 * Windows** (row 171). Corepack reads it on POSIX too, which is #673 — a Linux
 * process started from WSL interop inherits `LOCALAPPDATA` and lands its cache
 * on `/mnt/c`, with alien permissions and Windows path semantics. This is the
 * one place the spec deliberately breaks store-location compatibility, and the
 * same rule governs §15.13's per-user shim directory.
 *
 * Nullish coalescing, not truthiness: an explicitly empty `COREPACK_HOME` is
 * honoured verbatim, exactly as corepack honours it.
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

/**
 * Plain semver with the build suffix removed, so two references differing only
 * in their hash share one directory. URL references use
 * `encodeURIComponent(url without fragment)`.
 */
export function getVersionDir(locator: Locator): string {
  return versionDirFor(locator, parse(locator.reference));
}

/** {@link getVersionDir} with the parse already done — the probe needs both. */
function versionDirFor(locator: Locator, parsed: SemVer | null): string {
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
 * proceeds to download, any other error propagates.
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
  return JSON.parse(text) as CorepackMarker;
}

/**
 * §07.2 / §01.3 — the entire warm path, in one call: the store location for a
 * locator plus its marker, or `null` when the version is not installed.
 *
 * It lives here rather than in `install` so the proxy path can answer "is this
 * already installed?" without loading the download-and-verify stack — `http`,
 * `tar`, `integrity` and `registry` are ~36 KB of code and 70-odd native modules
 * that a warm run never executes (§16.3).
 */
export function readInstalledSpec(locator: Locator): InstallSpec | null {
  return resolveInstallTarget(locator).installed;
}

/**
 * The probe {@link readInstalledSpec} is the read-only half of: where this
 * locator's artifact lives, and whether it is already there.
 *
 * ## §15.11 — a pinned hash that is never checked is not a verification tier
 *
 * §07.2 makes the directory name the plain semver version, so
 * `pnpm@9.0.0+sha512.<A>` and `pnpm@9.0.0+sha512.<B>` name one directory and
 * the second reference silently gets whatever the first installed. Corepack
 * does the same — the marker's hash is *re-attached* to the locator (§07.6
 * step 3), never compared against it — so it is not a regression, but it means
 * a pin is decorative for every project that is not the one that warmed the
 * cache. §15.11 requires every artifact to clear a tier, and this is the one
 * place where the tier was recorded and then not enforced.
 *
 * The enforcement is one string comparison against the marker already being
 * read: no network, no store scan, and no second file. §04.1 step 4's probe
 * ({@link findInstalledVersion}) has to make the same comparison, because it
 * answers *before* this does and its answer sheds the build suffix; there the
 * `stat` §14.1 budgets becomes a read of that same file, which is the whole
 * cost of §15.11 on the warm path.
 *
 * **When the marker does not prove the pin** the entry is not usable for *this*
 * reference, and there are only three possible answers: run the wrong bytes
 * (what happens today), refuse, or install the pinned artifact somewhere of its
 * own. Refusing is wrong because the collision has a legitimate shape: the
 * embedded defaults pin `sha1` (§02.5) while `corepack use` writes the
 * registry's `sha512`, so a bare `yarn` followed by a `yarn@1.22.22+sha512.…`
 * project is a mismatch nobody misconfigured and whose only remedy would be
 * wiping the cache. So the install target becomes a **pin-qualified**
 * directory, `<version>+<algo>.<hex>`, which is itself valid semver and
 * therefore still a legal `<name>/<reference>` subtree for `pack` (§07.10),
 * `cache list` and `info`.
 *
 * The cost is a second marker read, paid only by a reference that collides, and
 * one extra download the first time it does. The plain directory keeps its
 * §07.2 name, so nothing about the common case changes on disk.
 */
export function resolveInstallTarget(locator: Locator): {
  location: string;
  installed: InstallSpec | null;
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

/** `<algo>.<hex>`, the serialized form §07.2 stores in the marker. */
function serializePin(pin: HashPin): string {
  return `${pin.algo.toLowerCase()}.${pin.digest ?? ""}`;
}

/**
 * Whether the marker's recorded hash is the one this reference pinned.
 *
 * Constant-time in the digest bytes. Lengths are public — they follow from the
 * algorithm name, which is in the reference the attacker is trying to match —
 * so returning early on a length difference leaks nothing, and `node:crypto`'s
 * `timingSafeEqual` is deliberately not reached for: importing that module here
 * would put twenty-odd native modules on the path that a warm run exists to
 * keep empty (§16.3).
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
 * Lives beside the store rather than in `install` because §15.11's cache-hit
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
export function referenceWithHash(reference: string, hash: string): string {
  const parsed = parse(reference);
  // A URL reference keeps its own `#algo.digest` notation and is never rewritten.
  return parsed === null ? reference : `${parsed.version}+${hash}`;
}

/**
 * `mkdir -p`, mapping the one filesystem failure users actually hit to §12.8's
 * message. `target` names the directory reported to the user (§07.8).
 */
function ensureDir(dir: string, target: string): void {
  try {
    mkdirSync(dir, { recursive: true });
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
      mkdirSync(dir);
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
 * §07.5 — the rename is the commit point. `EEXIST`/`ENOTEMPTY` (and win32
 * `EPERM` onto a directory) mean another process installed the same version
 * first: discard the temp and continue as if we had won. Windows retries 5x with
 * `100 * 2^i` ms backoff.
 */
export function promote(tmp: string, dest: string): void {
  ensureDir(dirname(dest), getInstallFolder());

  const isWindows = process.platform === "win32";
  const attempts = isWindows ? 5 : 1;

  for (let i = 0; i < attempts; i++) {
    try {
      renameSync(tmp, dest);
      return;
    } catch (error) {
      const code = errorCode(error);

      // Lost a benign race: the winner's tree is content-identical to ours.
      if (
        code === "EEXIST" ||
        code === "ENOTEMPTY" ||
        (isWindows && code === "EPERM" && isDirectory(dest))
      ) {
        rmSync(tmp, { recursive: true, force: true });
        return;
      }

      // Windows antivirus holds newly-written files open; back off and retry.
      if (isWindows && i < attempts - 1 && (code === "EPERM" || code === "ENOENT")) {
        sleepSync(100 * 2 ** i);
        continue;
      }

      throw error;
    }
  }
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
  const installFolder = getInstallFolder();

  // §14.1 — the hottest path in the tool: an exactly-pinned `packageManager`
  // field. The answer is trivially the version itself, so one `stat` replaces an
  // `opendir` plus a semver parse per installed version. The build suffix is
  // dropped because the directory name never carries one (§07.2), and the marker
  // hands the real hash back to the caller.
  if (isValidVersion(range)) {
    const parsed = parse(range)!;
    const version = parsed.version;
    const pin = readHashPin(range, parsed.build);

    // §15.11 — a reference with no digest has nothing to prove, so this stays
    // the single `stat` §14.1 budgets.
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

    // §15.11 — a hash-bearing reference is a cache *hit* only if the stored
    // marker proves that hash.
    //
    // This has to happen here rather than in {@link resolveInstallTarget} alone,
    // because §04.1 step 4 answers with the bare version and the pin is gone
    // from the locator by the time anything reads the marker again — which is
    // exactly how `pnpm@9.0.0+sha512.<A>` and `+sha512.<B>` came to share one
    // directory with the second silently running the first's bytes. The stat
    // becomes a read of the same file, and no other syscall is added.
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

    // §14.2 — prerelease-tolerant, matching every other range test in the
    // pipeline. Strict `range.test` here makes a prerelease install re-hit the
    // network on every single run.
    if (!satisfiesWithPrereleases(entry, range)) continue;

    // `!== 1` accepts a tie, so the later directory entry wins.
    if (best === null || compare(best, entry) !== 1) best = entry;
  }

  return best;
}

/**
 * §04.4 — maximally forgiving. Every failure mode returns `{}` rather than
 * erroring, and entries whose value is not a string are dropped.
 */
export function readLastKnownGood(): Record<string, string> {
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

  // Falsy or non-object. Arrays deliberately pass, as they do in corepack
  // (`typeof [] === "object"`); their numeric keys are harmless.
  if (!data || typeof data !== "object") return {};

  const lkg: Record<string, string> = {};
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === "string") lkg[key] = value;
  }
  return lkg;
}

/** §14.3 — write to a temp file in the same directory and rename over. `EROFS` is swallowed. */
export function writeLastKnownGood(lkg: Record<string, string>): void {
  const home = getHomeFolder();
  const target = join(home, LAST_KNOWN_GOOD_NAME);
  const content = `${JSON.stringify(lkg, null, 2)}\n`;

  let tmp: string | undefined;
  try {
    mkdirSync(home, { recursive: true });

    // Same directory, so the rename is atomic: a concurrent reader sees either
    // the old file or the new one, never a truncated interleaving (§14.3).
    tmp = `${target}.${process.pid}-${randomSuffix()}`;
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, target);
  } catch (error) {
    if (tmp !== undefined) rmSync(tmp, { force: true });

    // §07.8 / §16.7 — a read-only or unwritable store (`EROFS`, `EACCES`, a
    // deleted home) must never fail a run or print anything. Anything without an
    // errno is a bug in this module and still propagates.
    if (errorCode(error) !== undefined) return;
    throw error;
  }
}

/**
 * §04.7 — advance the recorded default after a successful install, but only
 * within the same major and only strictly upward. If there is no existing entry,
 * nothing is written.
 *
 * It lives here, next to the two accessors it is built from, because both of its
 * callers (`resolve`'s §04 pipeline and `install`'s §07.6 promotion) sit *above*
 * `store` in the layering of §16.10 — putting it in either one would force an
 * upward import from the other.
 */
export function bumpLastKnownGood(locator: Locator): void {
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

  // The entry is only ever *created* by §04.5 step 3 or by `install -g`. A
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

  lkg[locator.name] = locator.reference;
  writeLastKnownGood(lkg);
}

/**
 * Every complete install in the store, sorted by name then version.
 *
 * "Complete" means §07.2's definition and nothing looser: a directory carrying a
 * `.jup` marker. A half-extracted temp folder (`jup-<pid>-<rand>`) and
 * a `.DS_Store` are both directory entries, and neither is a cached version —
 * counting them would make `cache list` (§15.19) report an image as seeded when
 * it is not.
 *
 * §15.19's "did my image get seeded correctly?" and §15.30's "the cached
 * versions present" are the same directory listing, so there is one of it.
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
 * §15.18: the survival is deliberate — a recorded default is a preference, not a
 * cache entry — but the documentation said otherwise, so `all` is the explicit
 * way to ask for both. Nothing else may remove that file implicitly.
 */
export function cacheClean(options?: { all?: boolean }): void {
  rmSync(getInstallFolder(), { recursive: true, force: true });
  if (options?.all === true) {
    rmSync(join(getHomeFolder(), LAST_KNOWN_GOOD_NAME), { force: true });
  }
}
