/**
 * §09.12 — `self-install`: put jup itself in the store, and its own names on `PATH`.
 *
 * Every other command in §09 installs something the table describes. This one
 * installs *us*, and it exists because the installation a user reaches for first
 * is frequently not one they can keep: `npx jup` runs out of a cache npm empties,
 * a downloaded tarball unpacks wherever the shell happened to be, and a global
 * npm install is tied to the Node that owns it. `self-install` copies whichever
 * of those is running into `<home>/self/<version>` — a directory `cache clean`
 * does not touch (§07.11) — and links `jup` and `corepack` to it from the same
 * per-user directory `enable` uses (§15.13), so one directory on `PATH` ends up
 * holding jup and the tool commands alike.
 *
 * What it copies is a package — `dist/`, `bin/` and the manifest of an npm
 * install — so the copy is a complete installation and §10's shim machinery
 * applies to it unchanged.
 *
 * What it deliberately does **not** do is touch the table: `self-install` never
 * resolves a version, never opens a socket, and never reads the project. It
 * copies the bytes that are already running, which is the only way a command
 * that installs the tool can be run *by* the tool it installs.
 */

const {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} = process.getBuiltinModule("node:fs");
const { basename, dirname, join, sep } = process.getBuiltinModule("node:path");
import { createTempDir, getSelfFolder, promote, readMarker, writeMarker } from "../cache/store.ts";
import { advisory, messages, UsageError } from "../errors-cold.ts";
import { isValidVersion } from "../version/semver.ts";
import {
  chooseInstallDirectory,
  installSelfShims,
  prepareInstallDirectory,
  type SelfInstall,
  type ShimOptions,
  shimDirectoryPreferred,
  systemAndInstallDirectory,
  verifyOnPath,
} from "./shims.ts";
import {
  CLI_ENTRY_NAME,
  DIST_FOLDER_NAME,
  getOwnRoot,
  getOwnVersion,
  OWN_BIN_NAMES,
  STUB_FOLDER_NAME,
} from "../utils/self.ts";

export const TOOL_NAME = "jup";

/** The manifest, which travels with a package payload for one specific reason. */
const MANIFEST_NAME = "package.json";

/**
 * The digest algorithm the marker records for a self-install.
 *
 * `sha256` and not §06.2's default: this digest is not a *verification*, since
 * nothing signed the files and the bytes came from a running process rather than
 * from a registry. It answers one question — "are the files in the store already
 * the ones I would copy?" — and answering it is what makes a repeated
 * `self-install` free and a rebuilt one at the same version actually replace
 * what is there.
 */
const DIGEST_ALGO = "sha256";

/* -------------------------------------------------------------------------- */
/* Messages                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * These live here for the reason `shims.ts` and `info.ts` keep their own: they
 * are this command's vocabulary and nothing else refers to them.
 */

/**
 * A source checkout has an `src/` and no build, and the two things this command
 * copies are exactly the two the bundler produces.
 *
 * Refusing rather than copying `src/` is the same call §15.46 makes about the
 * shebang pin: a checkout is not an installation. Copying one would put a tree
 * that changes under `git pull` behind the `jup` on someone's `PATH`, and every
 * `.ts` in it would then be type-stripped on every invocation.
 */
export const noBuildToInstall = (root: string) =>
  `Unable to install ${TOOL_NAME} from ${root}: that is a source checkout, and \`${TOOL_NAME} self-install\` copies the built files a published install has (\`${DIST_FOLDER_NAME}/\` and \`${STUB_FOLDER_NAME}/\`). Run \`pnpm build\` there first, or install ${TOOL_NAME} from npm and run this from that copy.`;

/**
 * The store already holds this version and the running copy differs from it, but
 * the old directory could not be moved out of the way.
 *
 * Windows, essentially always: a directory holding a file a running process has
 * open cannot be renamed, so a copy that reinstalls *itself* lands here. Saying
 * so is the whole remedy — the next run from anywhere else succeeds.
 */
export const selfDirectoryBusy = (directory: string, reason: string) =>
  `Unable to replace ${directory}: ${reason}. That directory holds the copy of ${TOOL_NAME} this command is trying to update, and on Windows a running executable cannot be moved. Run \`${TOOL_NAME} self-install\` from a copy outside the store — the one you downloaded, or \`npx ${TOOL_NAME}\` — or delete that directory and try again.`;

/**
 * Our own version is not something a path segment can be built from.
 *
 * It cannot happen through npm, which will not publish a manifest whose
 * `version` is not semver, and it cannot happen through the bundled literal,
 * which the build reads out of that same manifest. It is checked because the
 * value becomes a directory name under `<home>` and the check costs one call:
 * everything else the store turns into a path segment is validated the same way
 * (§07.2, §07.10), and this is the one that would otherwise be trusted for being
 * ours.
 */
export const implausibleVersion = (version: string) =>
  `Unable to install ${TOOL_NAME}: its own version reads as ${JSON.stringify(version)}, which is not a version a store directory can be named after. The installation this was run from has a corrupt \`${MANIFEST_NAME}\`.`;

/** Where the copy went. Informational, on stdout (§09.11). */
export const installedTo = (version: string, directory: string) =>
  `${TOOL_NAME} ${version} -> ${directory}`;

/** Which names went on `PATH`, and where. */
export const shimmedInto = (names: string[], directory: string) =>
  `${names.join(", ")} -> ${directory}`;

/* -------------------------------------------------------------------------- */
/* The payload                                                                 */
/* -------------------------------------------------------------------------- */

/** One file to copy: where it comes from, and what it is called in the store. */
interface PayloadFile {
  /** Store-relative path, `/`-separated, and the sort key for the digest. */
  rel: string;
  path: string;
  executable: boolean;
}

/** What is being installed, resolved from the running process alone. */
interface Payload {
  version: string;
  files: PayloadFile[];
}

/** What is running, as a list of files to copy. */
function resolvePayload(): Payload {
  const version = getOwnVersion();
  if (!isValidVersion(version)) throw new UsageError(implausibleVersion(version));

  const root = getOwnRoot(import.meta.url);
  // Both folders, and the manifest — see {@link manifestFile}. A missing `dist/`
  // is the source checkout §16 keeps `bin/` out of `dist/` for: `bin/` alone
  // survives a `pnpm build --clean`, so it is the bundle that decides.
  if (!existsSync(join(root, DIST_FOLDER_NAME)) || !existsSync(join(root, STUB_FOLDER_NAME))) {
    throw new UsageError(noBuildToInstall(root));
  }

  const files = [
    ...expand(root, DIST_FOLDER_NAME),
    ...expand(root, STUB_FOLDER_NAME),
    ...manifestFile(root),
  ];
  return { version, files };
}

/**
 * The manifest, when there is one to copy — and there is a reason it is not
 * optional in practice.
 *
 * §08.7 hands the package manager `COREPACK_ROOT`, which is the directory
 * holding our own `package.json`, found by walking up from the entry module. In
 * the store that walk starts at `<home>/self/<version>/dist/` and, with no
 * manifest copied, would keep going: past `<home>`, past the cache root, and
 * into the user's home directory, where it may well find one belonging to
 * something else entirely. Copying ours stops the walk where it belongs.
 */
function manifestFile(root: string): PayloadFile[] {
  const path = join(root, MANIFEST_NAME);
  return existsSync(path) ? [{ rel: MANIFEST_NAME, path, executable: false }] : [];
}

/** Every regular file under `<root>/<folder>`, depth first, sorted by name. */
function expand(root: string, folder: string): PayloadFile[] {
  const files: PayloadFile[] = [];

  const walk = (rel: string): void => {
    const dir = join(root, ...rel.split("/"));
    const entries = readdirSync(dir, { withFileTypes: true }).sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );

    for (const entry of entries) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(child);
        continue;
      }
      // Regular files only. A symlink, a socket or a device in `dist/` is not
      // something a published package has, and copying one is §07.4 rule 3's
      // hazard with the roles reversed.
      if (!entry.isFile()) continue;
      const stats = statSync(join(dir, entry.name));
      files.push({
        rel: child,
        path: join(dir, entry.name),
        executable: (stats.mode & 0o111) !== 0,
      });
    }
  };

  walk(folder);
  return files;
}

/**
 * `<algo>.<hex>` over the payload — the marker's `hash`, and the only thing that
 * decides whether a copy has to happen at all.
 *
 * Names and the execute bit are hashed alongside the bytes, so a file that only
 * moved or only lost its mode still reads as a change; the store cares about
 * both (§15.45). It is computed over the *source* rather than over a staged
 * copy, which is what lets a repeated `self-install` do no I/O beyond reading
 * what it would otherwise have written.
 */
function digestPayload(files: PayloadFile[]): string {
  const hash = process.getBuiltinModule("node:crypto").createHash(DIGEST_ALGO);
  for (const file of files) {
    hash.update(`${file.rel}\0${file.executable ? "x" : "-"}\0`);
    hash.update(readFileSync(file.path));
  }
  return `${DIGEST_ALGO}.${hash.digest("hex")}`;
}

/* -------------------------------------------------------------------------- */
/* The copy                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Copy the payload into `directory`, which is a fresh temp directory.
 *
 * The execute bit is re-applied rather than inherited: `copyFileSync` carries
 * the source mode over, but a package unpacked by npm can arrive with its stubs
 * at `0o644` (§16 says why), and a shim linked to a stub the kernel will not
 * execute is passed over in silence — §15.45's failure. The bit is set from what
 * the source *is*, so nothing gains one it did not have.
 */
function stage(files: PayloadFile[], directory: string): void {
  for (const file of files) {
    const target = join(directory, ...file.rel.split("/"));
    mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
    copyFileSync(file.path, target);
    chmodSync(target, file.executable ? 0o755 : 0o644);
  }
}

/** Four random bytes, hex encoded — `store.ts`'s temp-name suffix, for its reason. */
function randomSuffix(): string {
  return process.getBuiltinModule("node:crypto").randomBytes(4).toString("hex");
}

/** The name a superseded install is moved aside under before it is deleted. */
const SUPERSEDED_PREFIX = ".superseded-";

/**
 * Publish the staged tree at `dest`, replacing whatever is there.
 *
 * §07.5's `promote` is the ordinary path and does the whole job when the
 * directory is free. It is not enough on its own here, because the one case
 * `install` never has is the one this command is *for*: the same version already
 * installed, with different bytes — a rebuilt maintainer's copy, or a partial
 * install being repaired. `promote` treats an occupied directory with a valid
 * marker as a lost race and keeps what is there, which for a self-install would
 * silently do nothing.
 *
 * So the old directory is renamed aside first and deleted after, rather than
 * removed before the rename: the window in which `<dest>` does not exist is then
 * one rename long, and a `jup` running through the shims during it fails no
 * differently than it would mid-`rm`. If the promotion fails the old directory
 * goes back, and the command has changed nothing.
 */
export function publish(tmp: string, dest: string): void {
  if (!existsSync(dest)) {
    // A concurrent self-install won: its bytes are the same version's, and its
    // marker is what `promote` checked before answering `false`.
    if (!promote(tmp, dest)) rmSync(tmp, { recursive: true, force: true });
    return;
  }

  const aside = join(dirname(dest), `${SUPERSEDED_PREFIX}${basename(dest)}-${randomSuffix()}`);
  try {
    renameSync(dest, aside);
  } catch (error) {
    rmSync(tmp, { recursive: true, force: true });
    throw new UsageError(
      selfDirectoryBusy(dest, (error as NodeJS.ErrnoException).code ?? "rename failed"),
    );
  }

  try {
    if (!promote(tmp, dest)) rmSync(tmp, { recursive: true, force: true });
  } catch (error) {
    renameSync(aside, dest);
    throw error;
  }

  // Best effort: on Windows the files just moved aside may still be open, and a
  // superseded copy left behind is litter rather than a failure. The next run
  // sweeps it.
  rmSync(aside, { recursive: true, force: true, maxRetries: 3 });
}

/**
 * Delete what an earlier {@link publish} could not.
 *
 * Cheap — one `readdir` of a directory holding a handful of version names — and
 * it runs before the install rather than after, so the sweep never races the
 * rename it is cleaning up after.
 */
export function sweepSuperseded(selfFolder: string): void {
  let entries: string[];
  try {
    entries = readdirSync(selfFolder);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith(SUPERSEDED_PREFIX)) continue;
    rmSync(join(selfFolder, entry), { recursive: true, force: true, maxRetries: 3 });
  }
}

/* -------------------------------------------------------------------------- */
/* The command                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A deliberately small parser: this command takes no names and no values beyond
 * a directory, so anything else is a typo worth reporting rather than ignoring.
 * `enable`'s parser is not reused because its vocabulary — names to shim, names
 * to exclude — has no meaning here.
 */
export function parseSelfArgs(args: string[], command: string): ShimOptions {
  const options: ShimOptions = {};

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    const equals = arg.indexOf("=");
    const name = equals === -1 ? arg : arg.slice(0, equals);
    const inline = equals === -1 ? undefined : arg.slice(equals + 1);

    switch (name) {
      case "--install-directory": {
        const value = inline ?? args[++index];
        if (value === undefined || value === "") {
          throw new UsageError(`--install-directory requires a path`);
        }
        options.installDirectory = value;
        break;
      }
      case "--system": {
        options.system = true;
        break;
      }
      case "--force": {
        options.force = true;
        break;
      }
      default: {
        throw new UsageError(
          `The '${TOOL_NAME} ${command}' command takes no arguments other than --install-directory, --system and --force; received ${JSON.stringify(arg)}`,
        );
      }
    }
  }

  // §15.13 point 8 — the two spellings of "install here" are equally explicit,
  // and picking one silently would put shims where the command line also said
  // not to. `shims.ts` raises the same refusal for `enable`.
  if (options.system === true && options.installDirectory !== undefined) {
    throw new UsageError(systemAndInstallDirectory());
  }

  return options;
}

/**
 * The hash the store already records for `dest`, or `undefined`.
 *
 * §07.2 propagates an unparseable marker rather than reading it as a cache miss,
 * because for a package manager that is a broken install and re-downloading over
 * it would hide the breakage. Here it is the opposite: this command is the
 * repair, and a marker nobody can parse is exactly the state it has to be able
 * to write over.
 */
export function installedHash(dest: string): string | undefined {
  try {
    return readMarker(dest)?.hash;
  } catch {
    return undefined;
  }
}

/**
 * Delete every other copy of ourselves in `<home>/self`.
 *
 * The shims were repointed at `keep` a moment ago, so nothing on the user's
 * `PATH` names any of the rest: they are the previous version an upgrade
 * replaced, and without this they accumulate a megabyte a time, in a directory
 * §07.11 deliberately puts beyond `cache clean`'s reach.
 *
 * Best effort, and only ever after a successful install, so a failure here
 * leaves litter rather than a broken installation. Two things are never removed:
 * anything that is not a version directory, which is not ours to interpret, and
 * the copy this process is running from — deleting that would pull the files out
 * from under our own remaining `import()`s, and on Windows would fail outright.
 */
function pruneOtherVersions(selfFolder: string, keep: string): void {
  let entries: string[];
  try {
    entries = readdirSync(selfFolder);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry === keep || !isValidVersion(entry)) continue;
    const directory = join(selfFolder, entry);
    if (isRunningFrom(directory)) continue;
    try {
      rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // A running executable on Windows, or an install owned by another user.
      // The next run tries again.
    }
  }
}

/** Whether the process executing this call lives inside `directory`. */
function isRunningFrom(directory: string): boolean {
  const own = getOwnRoot(import.meta.url);
  return own === directory || own.startsWith(directory + sep);
}

/**
 * The half of §09.12 that §09.13 shares: announce the copy, put our names on
 * `PATH`, and check that they are the ones a lookup finds.
 *
 * Both commands end here, and they must: `self-install` and `self-upgrade`
 * disagreeing about where a user's shims live, or about which of them is allowed
 * to displace a foreign entry, would be two answers to one question.
 */
export async function linkSelf(
  version: string,
  dest: string,
  install: Omit<SelfInstall, "directory">,
  options: ShimOptions,
): Promise<void> {
  process.stdout.write(`${installedTo(version, dest)}\n`);

  // §15.13 — choose, announce, probe, then fall back; nothing is written before
  // the directory is known to be writable. `enable`'s chain exactly, because the
  // two commands must not disagree about where a user's shims live.
  const choice = chooseInstallDirectory(options);
  if (choice.preferredOver !== undefined) {
    advisory(shimDirectoryPreferred(choice.preferredOver, choice.directory));
  }
  const installDirectory = prepareInstallDirectory(choice.directory, () =>
    choice.named === true && options.system !== true
      ? chooseInstallDirectory({}).directory
      : choice.directory,
  );

  const installed = await installSelfShims(
    installDirectory,
    { directory: dest, ...install },
    options,
  );

  if (installed.length > 0) {
    process.stdout.write(
      `${shimmedInto(
        installed.map(([binName]) => binName),
        installDirectory,
      )}\n`,
    );
  }

  // §15.29 — verify the post-condition and name whatever beat the shims.
  verifyOnPath(installDirectory, installed);

  // Only now: until the names point at `dest`, an older copy is still the one a
  // shim would run.
  pruneOtherVersions(dirname(dest), version);
}

/**
 * §09.12 — copy, then shim. Exit 0, and idempotent in both halves: an unchanged
 * payload writes nothing to the store, and a correct shim is left alone (§10.2).
 */
export async function cmdSelfInstall(args: string[]): Promise<number> {
  const options = parseSelfArgs(args, "self-install");
  const payload = resolvePayload();

  const selfFolder = getSelfFolder();
  sweepSuperseded(selfFolder);

  const dest = join(selfFolder, payload.version);
  const hash = digestPayload(payload.files);

  process.stdout.write(`${messages.installing(TOOL_NAME, payload.version)}\n`);

  // The whole of the "already installed" test. §07.2's marker is what says an
  // install is complete, and its recorded hash is what says it is *this* one.
  if (installedHash(dest) !== hash) {
    const tmp = createTempDir();
    try {
      stage(payload.files, tmp);
      writeMarker(tmp, {
        locator: { name: TOOL_NAME, reference: payload.version },
        // §08.1's shape, naming the entry point each of our names runs. The
        // store never executes it — we are not a table entry, and nothing
        // resolves `jup` through §04 — but a marker that describes its own
        // directory is what lets `promote` and every later run read it back.
        bin: Object.fromEntries(
          OWN_BIN_NAMES.map((binName) => [binName, `./${STUB_FOLDER_NAME}/${CLI_ENTRY_NAME}`]),
        ),
        hash,
      });
    } catch (error) {
      rmSync(tmp, { recursive: true, force: true });
      throw error;
    }
    publish(tmp, dest);
  }

  await linkSelf(payload.version, dest, {}, options);

  return 0;
}
