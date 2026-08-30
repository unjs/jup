/**
 * Download, verify, promote — §06.1, §07.3–§07.6.
 *
 * One streaming pass: socket -> tee -> digest, and -> gunzip -> tar -> disk
 * (§06.2). Caps are checked as the stream flows, not afterwards; by then the
 * disk is full.
 */

const { readFileSync } = process.getBuiltinModule("node:fs");
const { chmod, open, rm, stat } = process.getBuiltinModule("node:fs/promises");
const { join, posix, resolve, sep } = process.getBuiltinModule("node:path");
import { ENV, SYSTEM_ENV } from "../config/env-vars.ts";
import {
  getSpecFor,
  hasRangeBand,
  isEmbeddedReference,
  isPerHostSpec,
  isSupportedPackageManager,
  resolveArtifactRegistry,
  resolveSpecBin,
  resolveSpecUrl,
} from "../config/table.ts";
import { envFlag } from "../project/env.ts";
import { advisory, messages, UsageError } from "../errors-cold.ts";
import { err, errColors, warn } from "../utils/log.ts";
import { httpGet } from "../net/http.ts";
import {
  assertSupportedAlgo,
  compareDigest,
  hashStream,
  parseSri,
  shouldSkipIntegrityCheck,
} from "../verify/integrity.ts";
import { resolveRegistry } from "../net/npmrc.ts";
import {
  applyRegistryOverride,
  applySourceOverride,
  fetchTarballURLAndSignature,
  getRegistryUrl,
  verifyRegistryTrust,
  warnUnsignedRegistry,
} from "../net/registry.ts";
import { parse } from "../version/semver.ts";
import {
  bumpLastKnownGood,
  createTempDir,
  getVersionDir,
  type HashPin,
  promote,
  readHashPin,
  resolveInstallTarget,
  writeMarker,
} from "./store.ts";
import { extract } from "./tar.ts";
import type {
  BinSpec,
  Installation,
  ResolvedSpec,
  RegistrySignature,
  RegistrySpec,
} from "../types.ts";

/** §07.4 — the two artifact shapes the table can produce. */
const TARBALL_EXT = ".tgz";
const SCRIPT_EXT = ".js";

/** Everything §07.3 works out before a single artifact byte is fetched. */
interface ArtifactSource {
  url: string;
  /** The registry in force for this download; it selects §06.1's row. */
  registry?: RegistrySpec;
  /**
   * The registry **base URL** in force, after §05.2's precedence.
   * Carried rather than recomputed: `getRegistryUrl()` with no arguments answers
   * for the *default* package manager, and §05.2 exists precisely so that yarn
   * and pnpm can have different answers in the same run.
   */
  registryUrl: string;
  /** Reused by §06.3 rather than re-fetched, when §07.3 already asked for it. */
  integrity?: string;
  /** §06.1's legacy digest, used only when the registry publishes no `integrity`. */
  shasum?: string;
  signatures?: RegistrySignature[];
  /**
   * Whether the version metadata has been read. Not `integrity !== undefined`:
   * a registry that publishes none is exactly the §06.1 case, and asking twice
   * would double the requests on the path that can least afford them.
   */
  fetched?: boolean;
}

/**
 * Returns the install spec, downloading only on a `.jup` miss.
 *
 * Verification follows §06.1's decision table exactly. Two of its consequences
 * are deliberate and must not be "fixed": a user-supplied hash overrides
 * signature verification, and a hash mismatch discards the temp folder so
 * nothing is ever cached — a re-run must fail identically.
 *
 * Per §06.2, the **tarball stream** is hashed even on the single-file
 * (`registry.bin`) path and compared against the signed `dist.integrity`, which
 * closes the hole where Yarn Berry through a corporate mirror arrives unverified.
 */
export async function ensureInstalled(
  locator: ResolvedSpec,
  options?: { cacheOnly?: boolean },
): Promise<Installation> {
  const versionDir = getVersionDir(locator);

  // §07.2 / §01.3 — the entire warm path. No network, no directory scan, no
  // last-known-good read: one `open` of the marker and we are done. The proxy
  // path in `main` performs this same check *before* importing this module, so
  // reaching here at all normally means a miss.
  //
  // §07.2 — `location` is the probe's answer, not `<name>/<version>` computed
  // afresh: a reference whose pin the cached marker does not prove installs
  // into a directory of its own rather than adopting bytes nothing checked
  // against *its* digest.
  const { location, installed } = resolveInstallTarget(locator);
  if (installed !== null) {
    return installed;
  }

  const parsed = parse(locator.reference);
  // A known locator requires a table name and version; URL references use the
  // custom-URL path even for known names.
  const isKnown = parsed !== null && isSupportedPackageManager(locator.name);
  const version = parsed?.version;

  const pin = readHashPin(locator.reference, parsed?.build);
  // A bad algorithm in the `packageManager` field must fail before the network,
  // not with an opaque crypto error halfway through the download (§06.2).
  //
  // The weak-algorithm warning is scoped to a hash the *user* pinned, per §06.2.
  // An embedded default is an algorithm we picked and the user cannot change, so
  // warning about one would scold them for our choice; the scoping is what keeps
  // a plain `yarn` in an unpinned directory quiet whatever §02.3's table holds.
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
  // be taken as the bytes arrive (§06.2) and the algorithm comes from the SRI.
  const expected = await resolveExpectedIntegrity(source, pin, version);

  // §06.1 — every artifact clears one verification tier before a byte moves.
  assertVerificationTier(locator, source, pin, expected, version);

  // §05.4 — artifacts only. The metadata request above deliberately announces
  // nothing, which is also what makes tests 49/50 name the *tarball* URL.
  announceDownload(source.url);

  const tmp = createTempDir();
  try {
    const streamAlgo = expected?.algo ?? algo;
    const streamDigest = await streamArtifact(source.url, {
      algo: streamAlgo,
      registryUrl: source.registryUrl,
      write: (stream) =>
        ext === TARBALL_EXT
          ? extract(stream, tmp, { strip: 1 })
          : writeStreamToFile(stream, join(tmp, posix.basename(pathname))),
    });

    // A `.js` URL is a single-file artifact; tarballs are installed whole.
    const singleFileName = ext === SCRIPT_EXT ? posix.basename(pathname) : undefined;

    // Hash the received artifact bytes.
    const artifactAlgo = streamAlgo;
    const artifactDigest = streamDigest;

    // An explicit reference pin is the only verification check for that artifact.
    if (pin.digest !== undefined) {
      assertDigest(pin.digest, artifactDigest);
    }

    // Otherwise compare the received stream with registry integrity.
    if (expected !== undefined) {
      assertDigest(expected.hex, streamDigest);
    }

    const bin = resolveBin(tmp, locator, singleFileName);
    await makeEntryPointsExecutable(tmp, locator, version, bin);
    const hash = `${artifactAlgo}.${artifactDigest}`;

    // §07.6 step 3 — the reference now carries the digest we actually saw, which
    // is what `use`/`up` write into `package.json` and what makes that pin
    // trustworthy. URL references keep their own `#algo.digest` notation and are
    // never rewritten into a version.
    //
    // §02.4 — except for a per-host artifact, where the digest describes *this
    // machine's* download and nothing else. Folding it in here would put it in
    // the reference `use` writes to `package.json`, where a colleague on another
    // platform meets it as a pin their own artifact can never match. The marker
    // still records the hash below — the store is host-local, so there it is
    // exactly the right fact — and §04.4 records it per host.
    if (isKnown && !isPerHostSpec(getSpecFor(locator.name, version!))) {
      locator.reference = `${version!}+${hash}`;
    }

    writeMarker(tmp, { locator: { name: locator.name, reference: locator.reference }, bin, hash });

    // §07.5 — the commit point.
    let spec: Installation = { location, bin, hash };
    if (!promote(tmp, location)) {
      // Lost the rename race. The winner is a completed install, but not
      // necessarily *this* reference's artifact: the §07.2 probe that chose
      // `location` ran before the download, when the plain directory was still
      // empty, so two references pinning different digests both aimed here.
      // Re-running the probe now that the marker exists is the same decision on
      // current facts — it adopts the winner when the marker proves this pin,
      // and hands back a qualified directory when it does not.
      const settled = resolveInstallTarget(locator);
      if (settled.installed === null) {
        promote(tmp, settled.location);
        spec = { location: settled.location, bin, hash };
      } else {
        await rm(tmp, { recursive: true, force: true });
        spec = settled.installed;
      }
    }

    // §04.8 — only ever within the same major, only when an entry already
    // exists, and never when the caller only wanted the cache warmed. The guards
    // live in `store.bumpLastKnownGood`; `isKnown` only spares it the read.
    if (isKnown && options?.cacheOnly !== true) {
      bumpLastKnownGood(locator);
    }

    return spec;
  } catch (error) {
    // §06.2 — nothing is cached on any failure, so a re-run fails identically
    // (test 79) and a bad artifact never reaches the store.
    await rm(tmp, { recursive: true, force: true });
    throw error;
  }
}

/**
 * §05.4 — printed before any **artifact** download, never before metadata.
 *
 * A notice, not a question. It goes to stderr from every entry point,
 * unconditionally, and nothing is read back: a run behaves the same on a TTY, on
 * a pipe and with stdin closed, and buffered input the tool did not need is left
 * untouched for the package manager (§08.6).
 */
export function announceDownload(url: string): void {
  err(`${messages.aboutToDownload(url)}\n`);
}

/**
 * §06.2 — fetch `url` and hash it while it is being written, in one pass, and
 * return the digest of what actually arrived.
 *
 * One branch of the tee feeds the digest and the other feeds `write` — gunzip
 * plus tar, or the single-file writer — and both are consumed concurrently, so
 * the tee never has to buffer more than the slower consumer is behind by. That
 * is also the only reason `allSettled` is right here: a rejected extraction must
 * not leave the digest promise unhandled, and the body has to drain either way.
 *
 * Exported because §09.13 downloads an artifact the table knows nothing about
 * and must do it under exactly these rules; nothing about this depends on the
 * caller being a table entry.
 */
export async function streamArtifact(
  url: string,
  options: {
    algo: string;
    registryUrl: string;
    write: (stream: ReadableStream<Uint8Array>) => Promise<unknown>;
  },
): Promise<string> {
  const response = await httpGet(url, { registryOrigin: options.registryUrl });
  const body = response.body;
  if (body === null) {
    throw new Error(messages.requestFailed(url));
  }

  const [digestBranch, contentBranch] = body.tee();
  const digesting = hashStream(digestBranch, options.algo);
  const writing = options.write(contentBranch);

  const [digestOutcome, writeOutcome] = await Promise.allSettled([digesting, writing]);
  if (writeOutcome.status === "rejected") throw writeOutcome.reason as Error;
  if (digestOutcome.status === "rejected") throw digestOutcome.reason as Error;
  return digestOutcome.value;
}

/**
 * Select the artifact registry and apply its configured origin independently.
 */
async function chooseSource(
  locator: ResolvedSpec,
  versionDir: string,
  version: string | undefined,
): Promise<ArtifactSource> {
  const { name } = locator;

  if (version === undefined) {
    // A URL reference. `versionDir` is `encodeURIComponent(url without fragment)`
    // (§07.2), so decoding it is exactly §07.3's `decodeURIComponent(version)`.
    // It belongs to no package manager's table entry, so §05.2 does not touch
    // it; only §05.2's default-origin rewrite applies.
    const registryUrl = getRegistryUrl({ name });
    return {
      url: applyRegistryOverride(decodeURIComponent(versionDir), registryUrl),
      registryUrl,
    };
  }

  const spec = getSpecFor(locator.name, version);

  // §02.4 — a native band answers version questions and artifact questions from
  // two different npm packages, and it is the **artifact** one that governs
  // everything below: the URL, the digest, and the signature over it. Resolving
  // it here also means an unsupported host fails before any request, naming the
  // host rather than 404ing on `@oven/bun-{target}`.
  const artifactRegistry = resolveArtifactRegistry(spec, locator);

  // An artifact registry already identifies an npm tarball; otherwise the
  // band's own registry does (§02.2 — every band is on npm).
  const registry = artifactRegistry ?? spec.registry;
  const packageName = registry.package;
  const registryUrl = getRegistryUrl({ name, packageName });

  const source: ArtifactSource = {
    // §02.4 — `{}`, and optionally `{platform}` / `{arch}`. An unsupported host
    // fails here, before any bytes move, rather than 404ing on a URL that still
    // carries the placeholder.
    url: resolveSpecUrl(spec, locator, version),
    registry,
    registryUrl,
  };

  // The packument path is taken only when a registry is actually configured for
  // this package manager — through any of §05.2's tiers. Otherwise
  // the download URL comes from the table (§05.2), and no metadata request is
  // made until §06 needs one.
  const configured = resolveRegistry({ name, packageName }).kind !== "built-in";
  if (configured) {
    // `dist.tarball` verbatim — never synthesised — already rewritten onto the
    // configured registry and validated by §05.2.
    const metadata = await fetchTarballURLAndSignature(registry, version);
    source.url = metadata.tarball;
    source.integrity = metadata.integrity;
    source.shasum = metadata.shasum;
    source.signatures = metadata.signatures;
    source.fetched = true;
  } else {
    source.url = applySourceOverride(source.url, name);
  }

  // §05.2 — compare origins to handle case and trailing slashes without
  // rewriting matching text in the middle of a URL. Re-applying it to a
  // `dist.tarball` that `fetchTarballURLAndSignature` already rewrote is a no-op.
  source.url = applyRegistryOverride(source.url, registryUrl);

  return source;
}

/**
 * The leading bytes of a file the kernel would agree to execute, for
 * {@link isProgramImage}.
 *
 * A shebang, ELF, and Mach-O in its four single-architecture forms plus the
 * universal-binary wrapper. Windows never reaches this — a `.exe` runs because
 * of its name — so `MZ` is deliberately absent.
 */
const PROGRAM_MAGIC: readonly (readonly number[])[] = [
  [0x23, 0x21], // `#!` — any interpreted script
  [0x7f, 0x45, 0x4c, 0x46], // ELF: Linux, the BSDs, Solaris
  [0xfe, 0xed, 0xfa, 0xce], // Mach-O, 32-bit, big-endian
  [0xfe, 0xed, 0xfa, 0xcf], // Mach-O, 64-bit, big-endian
  [0xce, 0xfa, 0xed, 0xfe], // Mach-O, 32-bit, little-endian
  [0xcf, 0xfa, 0xed, 0xfe], // Mach-O, 64-bit, little-endian
  [0xca, 0xfe, 0xba, 0xbe], // Mach-O universal binary
];

/** Whether `path` begins with one of {@link PROGRAM_MAGIC}. */
async function isProgramImage(path: string): Promise<boolean> {
  const file = await open(path, "r");
  try {
    const head = Buffer.alloc(4);
    const { bytesRead } = await file.read(head, 0, 4, 0);
    return PROGRAM_MAGIC.some(
      (magic) => magic.length <= bytesRead && magic.every((byte, at) => head[at] === byte),
    );
  } finally {
    await file.close();
  }
}

/**
 * Archive modes are attacker-controlled, so executable-bit grants are bounded
 * to native bands, confined declared `bin` paths, and recognized program images.
 * Grant only ordinary execute bits permitted by the umask, never special bits.
 * Best effort: execution reports any remaining `EACCES`.
 */
async function makeEntryPointsExecutable(
  tmpDir: string,
  locator: ResolvedSpec,
  version: string | undefined,
  bin: BinSpec,
): Promise<void> {
  // Windows has no execute bit; a `.exe` runs because of its name.
  if (process.platform === "win32" || version === undefined) return;
  if (!isSupportedPackageManager(locator.name)) return;
  if (getSpecFor(locator.name, version).exec !== "native") return;

  // Deduped: `nub` and `nubx` are one file, and so are bun's two.
  const paths = new Set(Object.values(bin).map((relative) => join(tmpDir, relative)));

  await Promise.all(
    [...paths].map(async (path) => {
      try {
        const mode = (await stat(path)).mode & 0o777;
        const wanted = mode | (0o111 & ~UMASK);
        if (wanted === mode) return;
        if (!(await isProgramImage(path))) return;
        await chmod(path, wanted);
      } catch {
        // See the note above: never fail an install for this.
      }
    }),
  );
}

/**
 * The process umask, read the way §07.4 rule 6's mask reads it.
 *
 * `process.umask()` with no argument is a read; calling it with one would be a
 * write, and a global one at that.
 */
const UMASK = process.umask();
/**
 * §02.4's one `bin` shape: a non-empty `{name: path}` map of strings.
 *
 * The values are checked, not just the container. `readMarker` already refuses a
 * map whose entries are not strings, so accepting one here would write a marker
 * that cannot be read back — and `confine` reaches `resolve()` first anyway,
 * where a number turns into a `TypeError` from `node:path` in place of the
 * documented fall-through to the table band.
 */
function isValidBinSpec(value: unknown): value is BinSpec {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length > 0 &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

/**
 * Prefer a valid package manifest `bin`; otherwise use the declared band's
 * `bin`. Manifest paths are confined to the installation root before storage.
 */
export function resolveBin(
  tmpDir: string,
  locator: ResolvedSpec,
  /** The file's basename when the artifact is a lone `.js`; absent for a tarball. */
  singleFileName?: string,
): BinSpec {
  const parsed = parse(locator.reference);
  const known = parsed !== null && isSupportedPackageManager(locator.name);
  const banded = known && hasRangeBand(locator.name, parsed.version);
  // §02.4 — `resolveSpecBin`, not `.bin`: a native band spells its entry points
  // with `{exe}`, and what goes in the marker must be the path that exists.
  const tableBin = known ? resolveSpecBin(getSpecFor(locator.name, parsed.version)) : undefined;

  if (singleFileName !== undefined) {
    return { [locator.name]: singleFileName };
  }

  const manifest = readManifest(tmpDir);
  const packageBin = manifest?.bin;

  // A string `bin` is shorthand for `{ <package name>: <path> }`, so it says
  // nothing usable without a name to key it by: `String(undefined)` would key it
  // `"undefined"`, which installs and marks up cleanly and then fails on every
  // later run, because §08.1 looks the entry up by *command* name.
  const named = typeof packageBin === "string" && typeof manifest?.name === "string";

  if (named || isValidBinSpec(packageBin)) {
    const bin = named
      ? { [manifest.name as string]: packageBin as string }
      : (packageBin as BinSpec);
    // §07.7 — the two maintenance signals, both debug-level because
    // neither changes the outcome of this run.
    if (known && !banded) {
      debugNote(messages.binFromPackage(locator.name, parsed.version));
    } else if (banded && isValidBinSpec(tableBin) && !sameBin(tableBin, bin)) {
      debugNote(messages.binBandStale(locator.name, parsed.version, tableBin, bin));
    }
    return confine(bin, tmpDir, locator, parsed?.version);
  }

  // Nothing usable in the package. The band is the fallback, and only a
  // declared one: falling forward here would put a guess in the marker.
  if (banded && isValidBinSpec(tableBin)) return tableBin;

  throw new Error(messages.unableToLocateBin());
}

/**
 * The install's own `package.json`, or `null` when there is nothing to read.
 *
 * Missing or corrupt manifests degrade to the embedded table.
 */
function readManifest(tmpDir: string): { name?: unknown; bin?: unknown } | null {
  try {
    return JSON.parse(readFileSync(join(tmpDir, "package.json"), "utf8")) as {
      name?: unknown;
      bin?: unknown;
    } | null;
  } catch {
    return null;
  }
}

/** Whether two `bin` maps name the same entry points, `./`-insensitively. */
function sameBin(a: BinSpec, b: BinSpec): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every(
    (key) => Object.hasOwn(b, key) && a[key]!.replace(/^\.\//, "") === b[key]!.replace(/^\.\//, ""),
  );
}

/**
 * §08.1 — every value of a package-supplied `bin` map stays inside the install.
 *
 * `"bin": {"yarn": "../../../../etc/…"}` is one `join` away from writing the
 * tool's own handover at an attacker-chosen path. The check is one comparison,
 * and it runs against the *temporary* extraction directory, which is where the
 * install still is at this point; the layout is identical to the promoted one.
 */
function confine(
  bin: BinSpec,
  tmpDir: string,
  locator: ResolvedSpec,
  version: string | undefined,
): BinSpec {
  const root = resolve(tmpDir);
  for (const declared of Object.values(bin)) {
    const target = resolve(root, declared);
    if (target !== root && !target.startsWith(root + sep)) {
      // The same sentence `exec.resolveBinPath` produces for the same path, so
      // the two checks are indistinguishable to a caller reading stderr.
      throw new Error(messages.binEscapes(declared, locator.name, version ?? locator.reference));
    }
  }
  return bin;
}

/**
 * A note for whoever maintains the embedded table, on the debug channel.
 *
 * `DEBUG=jup` and `DEBUG=corepack` enable this compatibility channel (§11.5),
 * as a debugging aid, not a substitute for command output — so this is the one
 * place a message is allowed to be conditional on it. Both names are honoured,
 * for the same reason §11.6 keeps both env-var prefixes.
 *
 * Not routed through `advisory()`: `DEBUG=jup` is a request for *more* output,
 * and the more specific ask wins over §11.3's blanket mute.
 */
function debugNote(message: string): void {
  const debug = process.env[SYSTEM_ENV.DEBUG];
  if (
    debug === "*" ||
    (debug !== undefined && (debug.includes("jup") || debug.includes("corepack")))
  ) {
    warn(`! ${errColors.dim(message)}`);
  }
}
/**
 * §06.1 rows 2–5 — the expected digest the *registry* vouches for, or
 * `undefined` when nothing is to be checked.
 *
 * Resolved before the download for two reasons: the digest algorithm comes from
 * the SRI string and the stream can only be hashed once (§06.2); and a
 * signature we already know is bad should not cost a tarball's worth of
 * bandwidth. Metadata therefore precedes the artifact transfer.
 */
async function resolveExpectedIntegrity(
  source: ArtifactSource,
  pin: HashPin,
  version: string | undefined,
): Promise<{ algo: string; hex: string } | undefined> {
  // Row 5: `COREPACK_INTEGRITY_KEYS` in {"", "0"} disables the whole mechanism.
  // A source with no registry, or none resolved to a version, has no claim to
  // check against.
  const registry = source.registry;
  if (registry === undefined || version === undefined) return undefined;
  if (shouldSkipIntegrityCheck()) return undefined;

  const registryUrl = source.registryUrl;

  // Row 1: an explicit pin is a stronger, user-chosen assertion than the
  // registry's claim about itself, and it turns signature verification off —
  // including §06.1's requirement and §06.3's extra request, neither of which
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

  // §06.1 tiers 2 and 3, plus §06.3's package-root retry: a verified signature,
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

  // Soft-fail unsigned artifacts only after checking the available legacy digest.
  return source.shasum === undefined ? undefined : { algo: "sha1", hex: source.shasum };
}

/**
 * §06.1 — refuse an artifact that clears no verification tier.
 *
 * The three tiers are a **user-pinned hash** (`pin.digest`), a **verified
 * registry signature** and the digest it covers, and §06.1's soft-fail onto a
 * registry-published digest — all three of which arrive here as either
 * `pin.digest` or `expected`. Nothing else counts: TLS says the bytes came from
 * the host the URL named, not that the host is publishing what it published
 * yesterday, and §06.6 records the two rows where TLS was all there was.
 *
 * What this actually closes:
 *
 * * A registry that publishes no signatures and no digests, so a version
 *   resolved from it rather than pinned had *nothing* checking it. This is the
 *   breaking half of §06.1: such a `packageManager` spec now needs a pinned
 *   hash, a `jup.lock` resolution (§04.4 records one, with its integrity), or
 *   the opt-out.
 * * A custom `packageManager` URL with no `#<algo>.<hex>` fragment. That path
 *   is already behind `COREPACK_ENABLE_UNSAFE_CUSTOM_URLS`, which permits the
 *   *host*; §02.1's fragment is how the user says what should arrive from it.
 *
 * The built-in table pins a hash on `default` and on `transparent.default`
 * (§02.5), and §04.6's `latest` lookup attaches the registry's own signed
 * digest as a build suffix, so an unpinned `yarn`/`pnpm`/`npm` still clears a
 * tier and this never fires for them.
 *
 * `COREPACK_INTEGRITY_KEYS` in {"", "0"} is honoured as an equivalent opt-out
 * rather than as a way past this check: §06.4 defines those two values as
 * "disable the mechanism", the variable is environment-only (§03.2), and making
 * it refuse everything instead would turn one documented escape hatch into a
 * second, differently-spelled failure.
 */
function assertVerificationTier(
  locator: ResolvedSpec,
  source: ArtifactSource,
  pin: HashPin,
  expected: { algo: string; hex: string } | undefined,
  version: string | undefined,
): void {
  if (pin.digest !== undefined || expected !== undefined) return;
  if (shouldSkipIntegrityCheck()) return;

  // The reference for a URL locator *is* the URL, which is the most useful
  // thing to name; for everything else it is the plain version.
  const shownVersion = version ?? locator.reference;
  const origin = URL.canParse(source.url) ? new URL(source.url).origin : source.url;

  if (envFlag(ENV.ALLOW_UNVERIFIED)) {
    advisory(messages.allowingUnverified(locator.name, shownVersion, origin));
    return;
  }

  throw new UsageError(messages.refusingUnverified(locator.name, shownVersion, origin));
}

/** §06.2 — constant-time, and the message format is load-bearing (§12.7). */
export function assertDigest(expected: string, actual: string): void {
  if (!compareDigest(expected, actual)) {
    throw new Error(messages.mismatchHashes(expected, actual));
  }
}
/** §07.4 — a `.js` artifact is written verbatim under its own basename. */
/**
 * §07.4 rule 7 applies here too.
 *
 * The `.tgz` path bounds its output inside the extractor; the single-file path
 * had no cap at all, so a source that controls the served `.js` could write
 * until the disk filled. The exposure is narrow — §02.2 leaves no non-opt-in
 * `.js` source, and an adversary behind the opt-in already controls the code we
 * are about to execute — but a counter costs nothing and the cap should not
 * depend on which branch of the download the artifact took.
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
