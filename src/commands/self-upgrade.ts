/**
 * §09.13 — `self-upgrade`: fetch the newest published jup and become it.
 *
 * `self-install` (§09.12) installs the bytes that are already running, which is
 * what makes it work from anywhere and cost nothing. This is the other half of
 * the same story: the copy in `<home>/self` was put there by whichever jup the
 * user happened to run once, and nothing has moved it since. Rather than asking
 * them to remember where that copy came from — an `npx`, a tarball, a global
 * install tied to a Node they have since replaced — this resolves `latest` from
 * the registry, downloads it under §06's rules, and hands the result to §09.12's
 * own second half, so the names on `PATH` and the directory they live in are
 * decided in exactly one place.
 *
 * Two properties are worth stating outright, because they are what make an
 * upgrade command trustworthy:
 *
 * * **The download is verified like any other artifact.** The version comes back
 *   from §04.6's `latest` lookup carrying the registry's *signed* digest, the
 *   stream is hashed as it is written (§06.2), and a mismatch discards the temp
 *   directory so nothing is ever cached (§06.2). §06.1's rule holds here too:
 *   an artifact that clears no verification tier is refused, and upgrading
 *   ourselves is the last place to make an exception.
 * * **Nothing downloaded is rewritten.** The new version's CLI entry is *its*
 *   entry; regenerating it from the running version's source (which is what
 *   `enable` does, correctly, for an installation it belongs to) would put an
 *   old entry in front of a new bundle. §10.9 links the file as it arrived, and
 *   the only byte that may change is §10.2's shebang.
 */

const { chmodSync, existsSync, rmSync } = process.getBuiltinModule("node:fs");
const { join } = process.getBuiltinModule("node:path");
import { assertDigest, confirmDownload, streamArtifact } from "../cache/install.ts";
import {
  createTempDir,
  getSelfFolder,
  type HashPin,
  readHashPin,
  writeMarker,
} from "../cache/store.ts";
import { extract } from "../cache/tar.ts";
import { messages, UsageError } from "../errors-cold.ts";
import { out } from "../utils/log.ts";
import {
  fetchLatestStableVersion,
  fetchTarballURLAndSignature,
  registryUrlFor,
} from "../net/registry.ts";
import {
  CLI_ENTRY_NAME,
  DIST_FOLDER_NAME,
  findEntrySpecifier,
  OWN_BIN_NAMES,
  STUB_FOLDER_NAME,
} from "../utils/self.ts";
import { shouldSkipIntegrityCheck } from "../verify/integrity.ts";
import { parse } from "../version/semver.ts";
import {
  installedHash,
  linkSelf,
  parseSelfArgs,
  publish,
  sweepSuperseded,
  TOOL_NAME,
} from "./self-install.ts";
import type { NpmRegistrySpec } from "../types.ts";

/**
 * Us, on npm — the one package name this command may fetch.
 *
 * A literal and not `package.json`'s `name`, for the reason §07.11 gives about
 * the version: the manifest that travels with an installation is data, and this
 * decides what gets downloaded and put on the user's `PATH`.
 */
const SELF_PACKAGE: NpmRegistrySpec = { type: "npm", package: TOOL_NAME };

/**
 * The dist-tag an upgrade follows.
 *
 * `latest` is what the publisher points at the release they want installed, and
 * §04.6 already knows how to read it: one request, resolved server-side, coming
 * back with the digest the registry signed. `COREPACK_MINIMUM_RELEASE_AGE`
 * applies to it exactly as it does everywhere else (§04.1), so an organisation
 * that quarantines fresh releases quarantines ours too.
 */
const UPGRADE_TAG = "latest";

/* -------------------------------------------------------------------------- */
/* Messages                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * What arrived is not a layout this command can shim.
 *
 * Two different things end up here, and the message names both because the
 * archive alone cannot tell them apart. One is a release whose layout predates
 * the one §10.9 links — the entry point has not always lived in `bin/` — and the
 * other is a mirror publishing an unrelated package under our name. Neither is a
 * trust failure: the digest was checked above, so these are the bytes the
 * publisher signed.
 *
 * Checked before the promotion, because the failure it replaces is worse than
 * the message: two names on the user's `PATH` pointing at files that do not
 * exist, with the store copy already in place.
 */
export const notAnInstallation = (version: string, url: string) =>
  `Unable to upgrade to ${TOOL_NAME}@${version}: the package downloaded from ${url} has no \`${STUB_FOLDER_NAME}/\` folder holding ${CLI_ENTRY_NAME} beside a \`${DIST_FOLDER_NAME}/\` bundle, so there is nothing to point \`${OWN_BIN_NAMES.join("` and `")}\` at. Either that release predates the layout this version installs, or the registry it came from is publishing something else under that name.`;

/**
 * The registry named a version that cannot be a directory name.
 *
 * §07.10's rule, applied to the one path segment this command does not choose
 * for itself. `implausibleVersion` in §09.12 is the same check on our own
 * manifest; this is its remote twin, and it is the more important of the two.
 */
export const implausiblePublishedVersion = (reference: string) =>
  `Unable to upgrade ${TOOL_NAME}: the registry resolved \`${UPGRADE_TAG}\` to ${JSON.stringify(reference)}, which is not a version a store directory can be named after.`;

/* -------------------------------------------------------------------------- */
/* The download                                                                */
/* -------------------------------------------------------------------------- */

/** Everything §04.6's lookup settles before an artifact byte is asked for. */
interface Release {
  version: string;
  /** §06.1 — the digest the registry signed, and the algorithm to hash with. */
  pin: HashPin;
  registryUrl: string;
}

/**
 * Resolve `latest` into a version and the digest that must arrive with it.
 *
 * §04.6's own lookup, unchanged and unwrapped: it verifies the registry's
 * signature over `<name>@<version>:<integrity>` (§06.3), honours §06.1's tiers,
 * §06.3's fallback and §04.1's release-age gate, and hands back
 * `<version>+<algo>.<hex>`. Reusing it rather than reading the packument here is
 * the point — an upgrade path with its own idea of what a trustworthy version
 * looks like is an upgrade path that can be weaker than the install path.
 */
async function resolveRelease(): Promise<Release> {
  const reference = await fetchLatestStableVersion(SELF_PACKAGE);

  const parsed = parse(reference);
  if (parsed === null) throw new UsageError(implausiblePublishedVersion(reference));

  return {
    version: parsed.version,
    pin: readHashPin(reference, parsed.build),
    registryUrl: registryUrlFor(SELF_PACKAGE),
  };
}

/**
 * Download `release` into a temp directory and promote it to `dest`.
 *
 * §07.3–§07.6 for an artifact the table does not describe: metadata first so the
 * digest is known before the stream opens (§06.2), one pass over the body
 * (§06.2), and a temp directory that is discarded on any failure so a re-run
 * fails identically (§06.2) and a bad artifact never reaches the store.
 */
async function download(release: Release, dest: string): Promise<void> {
  const { version, pin, registryUrl } = release;

  // §07.3 — `dist.tarball` verbatim, rewritten onto the configured registry and
  // validated by §05.2. The signatures it carries were checked by the lookup
  // above, over this same document.
  const metadata = await fetchTarballURLAndSignature(SELF_PACKAGE, version);
  const url = metadata.tarball;

  // §06.1 — one verification tier or nothing moves. Reaching here without a
  // digest means the registry published neither `integrity` nor `shasum`, which
  // §04.6 would already have refused; the check is repeated because this is the
  // one download whose payload becomes the program doing the checking.
  if (pin.digest === undefined && !shouldSkipIntegrityCheck()) {
    throw new UsageError(messages.refusingUnverified(TOOL_NAME, version, new URL(url).origin));
  }

  // §05.4 — artifacts only, and after the metadata, exactly as §07.3 orders it.
  await confirmDownload(url);

  const tmp = createTempDir();
  try {
    const digest = await streamArtifact(url, {
      algo: pin.algo,
      registryUrl,
      // §07.4 — the same hostile-archive rules as every other tarball: one
      // leading path component stripped, traversal and links refused, modes
      // clamped.
      write: (stream) => extract(stream, tmp, { strip: 1 }),
    });
    if (pin.digest !== undefined) assertDigest(pin.digest, digest);

    assertInstallation(tmp, version, url);
    makeStubsExecutable(tmp);

    writeMarker(tmp, {
      locator: { name: TOOL_NAME, reference: version },
      // §09.12's shape. Both of our names run the CLI entry: on POSIX by a
      // symlink straight at it, on Windows through §10.4's wrappers.
      bin: Object.fromEntries(
        OWN_BIN_NAMES.map((binName) => [binName, `./${STUB_FOLDER_NAME}/${CLI_ENTRY_NAME}`]),
      ),
      // §07.2's `hash`, meaning here what it means for every other download: the
      // digest of the artifact these files came out of.
      hash: `${pin.algo}.${digest}`,
    });
  } catch (error) {
    rmSync(tmp, { recursive: true, force: true });
    throw error;
  }

  publish(tmp, dest);
}

/**
 * The files §10.9 is going to point a name at, before anything is promoted.
 *
 * A shape check and not a trust check — the digest above is the trust check.
 * What it buys is that a registry serving an unrelated package under our name
 * fails here, with the store untouched, rather than after the promotion with two
 * dead entries on the user's `PATH`.
 *
 * The bundle and the CLI entry, and nothing else — §10.9 points both of our
 * names at {@link CLI_ENTRY_NAME} on every platform, and those are the two files
 * a name is about to be pointed at. §10.3's per-name stubs are not checked: this
 * command installs no shim for a table binary, and a later `enable` reports its
 * own missing stub far better than a shape check here could.
 */
function assertInstallation(directory: string, version: string, url: string): void {
  const stubFolder = join(directory, STUB_FOLDER_NAME);
  const complete =
    findEntrySpecifier(stubFolder) !== undefined && existsSync(join(stubFolder, CLI_ENTRY_NAME));

  if (!complete) throw new UsageError(notAnInstallation(version, url));
}

/**
 * §10.3 — the file this command's own shims run, made executable.
 *
 * §07.4 rule 6 lets an archive contribute only its execute bit, and npm has been
 * observed to publish `bin` targets without one. A symlink to a file the kernel
 * will not execute is passed over in silence by a `PATH` lookup, so the bit is
 * set here rather than discovered later.
 *
 * One name, because §10.9 points both of ours at it. The per-name stubs in the
 * same folder arrive `0o644` too and are not touched here: nothing links them
 * until a `jup enable`, and that is where §10.3 already chmods the stub it is
 * about to link. Everything else in the archive stays exactly as §07.4 wrote it.
 */
function makeStubsExecutable(directory: string): void {
  if (process.platform === "win32") return;
  chmodSync(join(directory, STUB_FOLDER_NAME, CLI_ENTRY_NAME), 0o755);
}

/* -------------------------------------------------------------------------- */
/* The command                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * §09.13 — resolve, download, shim. Exit 0.
 *
 * Idempotent in both halves like §09.12, and by the same marker: a version
 * already complete in `<home>/self` is not downloaded again, and a shim that is
 * already correct is left alone (§10.3 property 4). The version already being
 * installed is the ordinary outcome of running this twice, and it is also what
 * makes the command a repair — a store copy whose shims were removed, or whose
 * marker cannot be read, is put back without touching the network more than the
 * one resolution costs.
 *
 * @param command The word it was invoked as, for §12.1's usage line.
 */
export async function cmdSelfUpgrade(args: string[], command: string): Promise<number> {
  const options = parseSelfArgs(args, command);

  const release = await resolveRelease();

  const selfFolder = getSelfFolder();
  sweepSuperseded(selfFolder);
  const dest = join(selfFolder, release.version);

  out(`${messages.installing(TOOL_NAME, release.version)}\n`);

  // §07.2's marker is what says an install is complete. Unlike §09.12 the
  // *contents* are not compared: there are no local bytes to compare against
  // without downloading them first, and a completed install of this version is
  // the thing being asked for.
  if (installedHash(dest) === undefined) {
    await download(release, dest);
  }

  // §10.9 links the copy as it arrived: it belongs to the version that
  // published it, not to the version installing it.
  await linkSelf(release.version, dest, options);

  return 0;
}
