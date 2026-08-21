/**
 * The store — §07.
 *
 * The tool owns exactly one directory. Its concurrency story is a single
 * primitive: **rename is atomic within a filesystem, and losing that race is a
 * success**. There is no lockfile and must never be one (§07.5, §16.6).
 */

import { randomBytes } from "node:crypto";
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
import { getSpecFor, isSupportedPackageManager } from "./config/table.ts";
import { envDisabled } from "./env.ts";
import { messages, UsageError } from "./errors.ts";
import { compare, isValidVersion, lt, major, parse, satisfiesWithPrereleases } from "./semver.ts";
import type { BinList, BinSpec, CorepackMarker, InstallSpec, Locator } from "./types.ts";

/** §07.2 — the file whose presence means "this install is complete and valid". */
export const MARKER_NAME = ".corepack";

/** §04.4 — the global default map. Lives outside `v1`, so `cache clean` spares it. */
export const LAST_KNOWN_GOOD_NAME = "lastKnownGood.json";

/** §07.2 — the layout-version segment; bumping it abandons old caches wholesale. */
export const LAYOUT_VERSION = "v1";

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/**
 * §07.1 — `COREPACK_HOME`, else `XDG_CACHE_HOME`/`LOCALAPPDATA`/platform default,
 * joined with `node/corepack`.
 *
 * Note `XDG_CACHE_HOME` is consulted **before** `LOCALAPPDATA` on every platform,
 * and `LOCALAPPDATA` is consulted on POSIX if set. Both are quirks of the
 * fallback chain rather than design, and both must be reproduced for cache
 * compatibility. (§15.13 narrows this later: in phase 2 `LOCALAPPDATA` becomes
 * Windows-only, which is the one place this spec breaks store-location
 * compatibility with corepack — see #673.)
 *
 * Nullish coalescing, not truthiness: an explicitly empty `COREPACK_HOME` is
 * honoured verbatim, exactly as corepack honours it.
 */
export function getHomeFolder(): string {
  const home = process.env.COREPACK_HOME;
  if (home !== undefined) return home;

  const cacheRoot =
    process.env.XDG_CACHE_HOME ??
    process.env.LOCALAPPDATA ??
    join(homedir(), process.platform === "win32" ? join("AppData", "Local") : ".cache");

  return join(cacheRoot, "node", "corepack");
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
  const parsed = parse(locator.reference);
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
 * §07.2 — read the `.corepack` marker. Its presence is the "this install is
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

export function writeMarker(dir: string, marker: CorepackMarker): void {
  writeFileSync(join(dir, MARKER_NAME), JSON.stringify(marker), "utf8");
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
    const dir = join(installFolder, `corepack-${process.pid}-${randomBytes(4).toString("hex")}`);
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
    const version = parse(range)!.version;
    try {
      statSync(join(installFolder, name, version, MARKER_NAME));
      return version;
    } catch (error) {
      const code = errorCode(error);
      if (code === "ENOENT" || code === "ENOTDIR") return null;
      throw error;
    }
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
    tmp = `${target}.${process.pid}-${randomBytes(4).toString("hex")}`;
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
  if (envDisabled("COREPACK_DEFAULT_TO_LATEST")) {
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
  // one-off `corepack yarn@4.9.0 …` must not silently become the global default.
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

function isValidBinList(value: unknown): value is BinList {
  return Array.isArray(value) && value.length > 0;
}

function isValidBinSpec(value: unknown): value is BinSpec {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length > 0
  );
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
  const parsed = parse(locator.reference);
  const tableBin =
    parsed !== null && isSupportedPackageManager(locator.name)
      ? getSpecFor(locator.name, parsed.version).bin
      : undefined;

  if (isSingleFile) {
    if (isValidBinList(tableBin)) return tableBin;
    return [locator.name];
  }

  if (isValidBinSpec(tableBin)) return tableBin;

  const manifest = JSON.parse(readFileSync(join(tmpDir, "package.json"), "utf8")) as {
    name?: unknown;
    bin?: unknown;
  } | null;

  const packageBin = manifest?.bin;
  if (typeof packageBin === "string") return { [String(manifest?.name)]: packageBin };
  if (isValidBinSpec(packageBin)) return packageBin;

  throw new Error(messages.unableToLocateBin());
}

/** §07.9 — `rm -rf <home>/v1`, forced. `lastKnownGood.json` is **not** removed. */
export function cacheClean(): void {
  rmSync(getInstallFolder(), { recursive: true, force: true });
}

export type { InstallSpec };
