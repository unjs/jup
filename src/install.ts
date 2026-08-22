/**
 * Download, verify, promote — §06.1, §07.3–§07.6.
 *
 * One streaming pass: socket -> tee -> digest, and -> gunzip -> tar -> disk
 * (§16.5). Caps are checked as the stream flows, not afterwards; by then the
 * disk is full.
 */

import { open, rm } from "node:fs/promises";
import { join, posix } from "node:path";
import { getSpecFor, isEmbeddedReference, isSupportedPackageManager } from "./config/table.ts";
import { envFlag, isCI } from "./env.ts";
import { messages, UsageError } from "./errors.ts";
import { httpGet } from "./http.ts";
import {
  assertSupportedAlgo,
  compareDigest,
  hashFile,
  hashStream,
  parseSri,
  shouldSkipIntegrityCheck,
} from "./integrity.ts";
import { resolveRegistry } from "./npmrc.ts";
import {
  applyRegistryOverride,
  applySourceOverride,
  fetchTarballURLAndSignature,
  getRegistryUrl,
  resolveRegistrySpec,
  verifyRegistryTrust,
  warnUnsignedRegistry,
} from "./registry.ts";
import { parse } from "./semver.ts";
import {
  bumpLastKnownGood,
  createTempDir,
  getInstallFolder,
  getVersionDir,
  promote,
  readInstalledSpec,
  resolveBin,
  writeMarker,
} from "./store.ts";
import { extract } from "./tar.ts";
import type { InstallSpec, Locator, RegistrySignature, RegistrySpec } from "./types.ts";

/** §07.4 — the two artifact shapes the table can produce. */
const TARBALL_EXT = ".tgz";
const SCRIPT_EXT = ".js";

/** §06.2 — `build[0]` absent means `sha512`. */
const DEFAULT_HASH_ALGO = "sha512";

/** Everything §07.3 works out before a single artifact byte is fetched. */
interface ArtifactSource {
  url: string;
  /** §07.4 — a path *inside* the tarball; set, only that one entry is extracted. */
  binPath?: string;
  /** The registry in force for this download; it selects §06.1's row. */
  registry?: RegistrySpec;
  /**
   * The registry **base URL** in force, after §15.1's and §15.2's precedence.
   * Carried rather than recomputed: `getRegistryUrl()` with no arguments answers
   * for the *default* package manager, and §15.2 exists precisely so that yarn
   * and pnpm can have different answers in the same run.
   */
  registryUrl: string;
  /** Reused by §06.3 rather than re-fetched, when §07.3 already asked for it. */
  integrity?: string;
  /** §15.7's legacy digest, used only when the registry publishes no `integrity`. */
  shasum?: string;
  signatures?: RegistrySignature[];
  /**
   * Whether the version metadata has been read. Not `integrity !== undefined`:
   * a registry that publishes none is exactly the §15.7 case, and asking twice
   * would double the requests on the path that can least afford them.
   */
  fetched?: boolean;
}

/** §02.1 — a reference's build suffix, from semver build metadata or a URL fragment. */
interface HashPin {
  algo: string;
  digest?: string;
}

/**
 * Returns the install spec, downloading only on a `.corepack` miss.
 *
 * Verification follows §06.1's decision table exactly. Two of its consequences
 * are deliberate and must not be "fixed": a user-supplied hash overrides
 * signature verification, and a hash mismatch discards the temp folder so
 * nothing is ever cached — a re-run must fail identically.
 *
 * Per §14.10, the **tarball stream** is hashed even on the single-file
 * (`registry.bin`) path and compared against the signed `dist.integrity`, which
 * closes the hole where Yarn Berry through a corporate mirror arrives unverified.
 */
export async function ensureInstalled(
  locator: Locator,
  options?: { cacheOnly?: boolean },
): Promise<InstallSpec> {
  const versionDir = getVersionDir(locator);
  const location = join(getInstallFolder(), locator.name, versionDir);

  // §07.2 / §01.3 — the entire warm path. No network, no directory scan, no
  // last-known-good read: one `open` of the marker and we are done. The proxy
  // path in `main` performs this same check *before* importing this module, so
  // reaching here at all normally means a miss.
  const installed = readInstalledSpec(locator);
  if (installed !== null) {
    return installed;
  }

  const parsed = parse(locator.reference);
  // Corepack's `isSupportedPackageManagerLocator`: a known name *and* a version
  // reference. A URL reference is always the "custom URL" shape, even for `yarn`.
  const isKnown = parsed !== null && isSupportedPackageManager(locator.name);
  const version = parsed?.version;

  const pin = readHashPin(locator, parsed?.build);
  // A bad algorithm in the `packageManager` field must fail before the network,
  // not with an opaque crypto error halfway through the download (§14.11).
  //
  // The weak-algorithm warning is scoped to a hash the *user* pinned, per §06.2:
  // every embedded default is itself sha1 (§02.5), so warning unconditionally
  // means a plain `yarn` in an unpinned directory scolds the user about an
  // algorithm we picked for them and they cannot change.
  const userPinned =
    pin.digest !== undefined && !isEmbeddedReference(locator.name, locator.reference);
  const algo = assertSupportedAlgo(pin.algo, userPinned);

  const source = await chooseSource(locator, versionDir, isKnown ? version : undefined);
  const pathname = new URL(source.url).pathname;
  const ext = posix.extname(pathname);

  // §07.4 — dispatch on the URL path's extension, never on Content-Type, and
  // fail loudly rather than guessing. Checked before the prompt so an
  // unrecognised artifact costs no bandwidth and asks no questions.
  if (ext !== TARBALL_EXT && ext !== SCRIPT_EXT) {
    throw new Error(
      `Refusing to download ${source.url}: unsupported artifact extension '${ext}' (expected '${TARBALL_EXT}' or '${SCRIPT_EXT}')`,
    );
  }

  // §06.1 rows 2–5, decided *before* the stream opens because the digest has to
  // be taken as the bytes arrive (§16.5) and the algorithm comes from the SRI.
  const expected = await resolveExpectedIntegrity(source, pin, version);

  // §05.5 — artifacts only. The metadata request above deliberately does not
  // prompt, which is also what makes tests 49/50 name the *tarball* URL.
  await confirmDownload(source.url);

  const tmp = createTempDir();
  try {
    const response = await httpGet(source.url, { registryOrigin: source.registryUrl });
    const body = response.body;
    if (body === null) {
      throw new Error(messages.requestFailed(source.url));
    }

    // §16.5 — the one pass. One branch feeds the digest, the other gunzip+tar
    // (or the file writer); both are consumed concurrently so `tee` never has
    // to buffer more than the slower consumer is behind by.
    const [digestBranch, contentBranch] = body.tee();
    const streamAlgo = expected?.algo ?? algo;
    const digesting = hashStream(digestBranch, streamAlgo);
    const writing =
      ext === TARBALL_EXT
        ? extract(contentBranch, tmp, { strip: 1, filter: source.binPath })
        : writeStreamToFile(contentBranch, join(tmp, posix.basename(pathname)));

    // `allSettled`, not `all`: a rejected extraction must not leave the digest
    // promise unhandled, and the body still has to drain either way.
    const [digestOutcome, writeOutcome] = await Promise.allSettled([digesting, writing]);
    if (writeOutcome.status === "rejected") throw writeOutcome.reason as Error;
    if (digestOutcome.status === "rejected") throw digestOutcome.reason as Error;
    const streamDigest = digestOutcome.value;

    // §07.4 — a filtered extraction produced exactly one file, promoted to
    // `<tmp>/<basename(binPath)>` by the extractor.
    const isFiltered = ext === TARBALL_EXT && source.binPath !== undefined;
    const isSingleFile = isFiltered || ext === SCRIPT_EXT;

    // §06.2 — the artifact whose digest the *reference* names: the extracted
    // file on the filtered path, the received bytes everywhere else.
    const artifactAlgo = isFiltered ? algo : streamAlgo;
    const artifactDigest = isFiltered
      ? await hashFile(join(tmp, posix.basename(source.binPath!)), algo)
      : streamDigest;

    // §06.1 row 1 — an explicit pin is the *only* check. Not "as well as" the
    // signature: pinning a hash against a bad-signature registry must fail with
    // a hash mismatch (test 77), and the correct hash must install despite that
    // signature (test 78).
    if (pin.digest !== undefined) {
      assertDigest(pin.digest, artifactDigest);
    }

    // §06.1 row 2, widened by §14.10: `dist.integrity` describes the tarball as
    // published, so it is checked against the *stream* digest whether we
    // extracted the whole archive or filtered it down to one file. Corepack
    // skips this entirely when `registry.bin` is set, which is what leaves Yarn
    // Berry unverified behind every corporate mirror.
    if (expected !== undefined) {
      assertDigest(expected.hex, streamDigest);
    }

    const bin = resolveBin(tmp, locator, isSingleFile);
    const hash = `${artifactAlgo}.${artifactDigest}`;

    // §07.6 step 3 — the reference now carries the digest we actually saw, which
    // is what `use`/`up` write into `package.json` and what makes that pin
    // trustworthy. URL references keep their own `#algo.digest` notation and are
    // never rewritten into a version.
    if (isKnown) locator.reference = `${version!}+${hash}`;

    writeMarker(tmp, { locator: { name: locator.name, reference: locator.reference }, bin, hash });

    // §07.5 — the commit point. Losing the rename race is a success: the winner
    // installed content-identical bytes.
    promote(tmp, location);

    // §04.7 — only ever within the same major, only when an entry already
    // exists, and never when the caller only wanted the cache warmed. The guards
    // live in `store.bumpLastKnownGood`; `isKnown` only spares it the read.
    if (isKnown && options?.cacheOnly !== true) {
      bumpLastKnownGood(locator);
    }

    return { location, bin, hash };
  } catch (error) {
    // §06.2 — nothing is cached on any failure, so a re-run fails identically
    // (test 79) and a bad artifact never reaches the store.
    await rm(tmp, { recursive: true, force: true });
    throw error;
  }
}

/**
 * §05.5 — printed before any **artifact** download, never before metadata.
 *
 * The notice needs `COREPACK_ENABLE_DOWNLOAD_PROMPT=1`; the interactive
 * confirmation additionally needs a TTY stdin and an unset `CI`. Any input other
 * than `n`/`N` — including a bare newline — is yes.
 */
export async function confirmDownload(url: string): Promise<void> {
  // §15.20 — `0` (and anything that is not `1`) suppresses both the notice and
  // the confirmation, from every entry point, unconditionally.
  if (!envFlag("COREPACK_ENABLE_DOWNLOAD_PROMPT")) return;

  process.stderr.write(`${messages.aboutToDownload(url)}\n`);

  // §08.6 — stdin is never touched unless we are actually going to ask. An
  // empty `CI` counts as unset, matching the reference implementation.
  if (process.stdin.isTTY !== true || isCI()) return;

  process.stderr.write(messages.downloadPrompt());

  const first = await readFirstByte();
  // 0x6e / 0x4e. Anything else — including a bare newline, and including EOF —
  // is yes.
  if (first === 0x6e || first === 0x4e) {
    throw new UsageError(messages.abortedByUser());
  }

  process.stderr.write("\n");
}

/* -------------------------------------------------------------------------- */
/* §07.3 — choosing the URL                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Where the artifact comes from, after §15.1's and §15.2's precedence.
 *
 * Two independent decisions live here, and keeping them apart is what makes
 * §15.2 possible at all:
 *
 * * **Which registry spec.** A configured *npm-protocol* registry switches Yarn
 *   Berry onto its `npmRegistry` entry — `@yarnpkg/cli-dist`, a tarball with a
 *   `bin` filter — instead of the single `.js` file `repo.yarnpkg.com` serves.
 * * **Which base URL.** `COREPACK_REGISTRY_<NAME>` replaces the origin of that
 *   package manager's own table URLs without changing the protocol, which is the
 *   only way to mirror Yarn without also redirecting npm and pnpm (#753).
 */
async function chooseSource(
  locator: Locator,
  versionDir: string,
  version: string | undefined,
): Promise<ArtifactSource> {
  const { name } = locator;

  if (version === undefined) {
    // A URL reference. `versionDir` is `encodeURIComponent(url without fragment)`
    // (§07.2), so decoding it is exactly §07.3's `decodeURIComponent(version)`.
    // It belongs to no package manager's table entry, so §15.2 does not touch
    // it; only §05.2's default-origin rewrite applies.
    const registryUrl = getRegistryUrl({ name });
    return {
      url: applyRegistryOverride(decodeURIComponent(versionDir), registryUrl),
      registryUrl,
    };
  }

  const spec = getSpecFor(locator.name, version);

  // §05.2 rewrite 1, kept in one place (`registry.resolveRegistrySpec`): an
  // npm-protocol registry configured for the band's `npmRegistry` package
  // switches Yarn Berry onto `@yarnpkg/cli-dist`, while §15.2's
  // `COREPACK_REGISTRY_YARN` deliberately does not — it mirrors
  // `repo.yarnpkg.com` as it stands, which is exactly what #872 asked for.
  const registry = resolveRegistrySpec(spec.registry);
  const packageName = registry.type === "npm" ? registry.package : undefined;
  const registryUrl = getRegistryUrl({ name, packageName });

  const source: ArtifactSource = {
    url: spec.url.replace("{}", version),
    registry,
    registryUrl,
  };

  // The packument path is taken only when a registry is actually configured for
  // this package manager — through any of §15.1's or §15.2's tiers. Otherwise
  // the download URL comes from the table (§05.2), and no metadata request is
  // made until §06 needs one.
  const configured = resolveRegistry({ name, packageName }).kind !== "built-in";
  if (registry.type === "npm" && configured) {
    // `dist.tarball` verbatim — never synthesised — already rewritten onto the
    // configured registry and validated by §14.9.
    const metadata = await fetchTarballURLAndSignature(registry, version);
    source.url = metadata.tarball;
    source.integrity = metadata.integrity;
    source.shasum = metadata.shasum;
    source.signatures = metadata.signatures;
    source.fetched = true;
    if (registry.bin !== undefined) source.binPath = registry.bin;
  } else {
    // §15.2 — the table URL sits on this package manager's own distribution
    // origin (`repo.yarnpkg.com`, `registry.yarnpkg.com`), and
    // `COREPACK_REGISTRY_<NAME>` is the only thing that can move it. Corepack
    // rewrites exactly one hardcoded prefix and so cannot mirror Yarn at all,
    // which is #753 and #872.
    source.url = applySourceOverride(source.url, name);
  }

  // §15.3 — origin comparison rather than corepack's substring `replace`, which
  // misses a differing case or trailing slash and would rewrite the *middle* of
  // a URL that merely contains the literal. Idempotent, so re-applying it to a
  // `dist.tarball` that `fetchTarballURLAndSignature` already rewrote is a no-op.
  source.url = applyRegistryOverride(source.url, registryUrl);

  return source;
}

/* -------------------------------------------------------------------------- */
/* §06 — the decision table                                                    */
/* -------------------------------------------------------------------------- */

/**
 * §06.1 rows 2–5 — the expected digest the *registry* vouches for, or
 * `undefined` when nothing is to be checked.
 *
 * Resolved before the download for two reasons: the digest algorithm comes from
 * the SRI string (§14.12) and the stream can only be hashed once (§16.5); and a
 * signature we already know is bad should not cost a tarball's worth of
 * bandwidth. Corepack fetches this metadata *after* the download instead, which
 * is unobservable apart from the wasted transfer.
 */
async function resolveExpectedIntegrity(
  source: ArtifactSource,
  pin: HashPin,
  version: string | undefined,
): Promise<{ algo: string; hex: string } | undefined> {
  // Rows 4 and 5: a url-type registry publishes no signatures at all, and
  // `COREPACK_INTEGRITY_KEYS` in {"", "0"} disables the whole mechanism.
  const registry = source.registry;
  if (registry?.type !== "npm" || version === undefined) return undefined;
  if (shouldSkipIntegrityCheck()) return undefined;

  const registryUrl = source.registryUrl;

  // Row 1: an explicit pin is a stronger, user-chosen assertion than the
  // registry's claim about itself, and it turns signature verification off —
  // including §15.7's requirement and §15.8's extra request, neither of which
  // may add a fetch to a path that already knows what it expects. When §07.3
  // fetched the metadata anyway (a configured registry supplies `dist.tarball`),
  // an unsigned registry is still worth one warning.
  if (pin.digest !== undefined) {
    if (source.fetched && source.signatures === undefined) {
      warnUnsignedRegistry(registryUrl, registry.package, version);
    }
    return undefined;
  }

  // §07.3 fetched this already when a custom registry is configured; on the
  // default registry the artifact URL comes from the table, so the metadata has
  // to be asked for separately.
  if (source.fetched !== true) {
    const metadata = await fetchTarballURLAndSignature(registry, version);
    source.integrity = metadata.integrity;
    source.shasum = metadata.shasum;
    source.signatures = metadata.signatures;
    source.fetched = true;
  }

  // §15.7 tiers 2 and 3, plus §15.8's package-root retry: a verified signature,
  // a warned soft-fail onto the registry's own digest, or a refusal.
  await verifyRegistryTrust({
    spec: registry,
    version,
    registryUrl,
    signatures: source.signatures,
    integrity: source.integrity,
    hasDigest: source.integrity !== undefined || source.shasum !== undefined,
  });

  // Trusted key -> signature -> `integrity` -> the bytes checked by the caller.
  if (source.integrity !== undefined) return parseSri(source.integrity);

  // Soft-fail: unsigned, but the bytes are still checked against the legacy
  // digest, which is strictly more than corepack does here (it checks nothing).
  return source.shasum === undefined ? undefined : { algo: "sha1", hex: source.shasum };
}

/** §06.2 — `algo` from `build[0]`/the URL fragment, `digest` from `build[1]`. */
function readHashPin(locator: Locator, build: string[] | undefined): HashPin {
  if (build !== undefined) {
    return { algo: build[0] ?? DEFAULT_HASH_ALGO, digest: build[1] };
  }

  // A URL reference carries the same information in its fragment:
  // `https://example.com/yarn.js#sha256.deadbeef` (§02.1).
  let fragment = "";
  try {
    fragment = new URL(locator.reference).hash.slice(1);
  } catch {
    // Not a URL either; there is simply no pin to read.
  }

  const dot = fragment.indexOf(".");
  if (fragment === "") return { algo: DEFAULT_HASH_ALGO };
  if (dot === -1) return { algo: fragment };
  return { algo: fragment.slice(0, dot), digest: fragment.slice(dot + 1) };
}

/** §06.2 + §14.11 — constant-time, and the message format is load-bearing (§12.7). */
function assertDigest(expected: string, actual: string): void {
  if (!compareDigest(expected, actual)) {
    throw new Error(messages.mismatchHashes(expected, actual));
  }
}

/* -------------------------------------------------------------------------- */
/* §07.4 / §07.6 — the pieces around the stream                                */
/* -------------------------------------------------------------------------- */

/** §07.4 — a `.js` artifact is written verbatim under its own basename. */
/**
 * §07.4 rule 7 applies here too.
 *
 * The `.tgz` path bounds its output inside the extractor; the single-file path
 * had no cap at all, so a source that controls the served `.js` could write
 * until the disk filled. The exposure is narrow — the only non-opt-in `.js`
 * source is Yarn Berry from repo.yarnpkg.com, which §15.11 leaves at the
 * TLS-only tier, and an adversary there already controls the code we are about
 * to execute — but a counter costs nothing and the cap should not depend on
 * which branch of the download the artifact took.
 */
const MAX_SINGLE_FILE_BYTES = 512 * 1024 * 1024;

async function writeStreamToFile(
  stream: ReadableStream<Uint8Array>,
  target: string,
): Promise<void> {
  // `wx`: the temp folder is ours alone, so an existing file is a bug, not a race.
  const handle = await open(target, "wx");
  try {
    const reader = stream.getReader();
    let written = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          written += value.byteLength;
          if (written > MAX_SINGLE_FILE_BYTES) {
            throw new Error(
              `Refusing to download: the artifact exceeds the ${MAX_SINGLE_FILE_BYTES} byte limit`,
            );
          }
          await handle.write(value);
        }
      }
    } finally {
      reader.releaseLock();
    }
  } finally {
    await handle.close();
  }
}

/** One chunk from stdin, then stdin is released again (§08.6). */
function readFirstByte(): Promise<number | undefined> {
  return new Promise<number | undefined>((resolve) => {
    const stdin = process.stdin;

    const finish = (value: number | undefined): void => {
      stdin.off("data", onData);
      stdin.off("end", onEnd);
      stdin.pause();
      resolve(value);
    };
    const onData = (chunk: Buffer | string): void => {
      finish(typeof chunk === "string" ? chunk.codePointAt(0) : chunk[0]);
    };
    const onEnd = (): void => finish(undefined);

    stdin.on("data", onData);
    stdin.on("end", onEnd);
    stdin.resume();
  });
}
