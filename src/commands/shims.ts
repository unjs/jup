/**
 * Shims and PATH integration — §10, §15.13, §15.14, §15.15, §15.16, §15.29.
 *
 * `enable` puts our names on PATH; `disable` takes them off.
 *
 * Node preserves the invoked path in `process.argv[1]`, so POSIX shims link to
 * one name-agnostic stub that reads its name from that path.
 *
 * Windows keeps §10.3's three script variants per name, because a `.cmd` or
 * `.ps1` wrapper invokes `node <stub>` and the invocation name is genuinely gone
 * by then. That is the whole of the platform split, and the per-name stub
 * machinery below exists for it alone.
 *
 * Four §15 items reshape the command around that core:
 *
 * * **§15.13** — shims go to a per-user directory by default, never somewhere
 *   that needs elevation. When that directory is not on `PATH`, `enable` prefers
 *   another entry from a **closed list** of per-user directories that is (point
 *   6), and says so; if none is, it says what line to add (point 3). `disable`
 *   and `info` find the result by looking for the shims, never by reading `PATH`
 *   (point 7).
 * * **§15.15** — anything `enable` displaces is recorded in `<home>/shims.json`
 *   and put back by `disable`, which now removes only entries it created.
 * * **§15.16** — npm is shimmed by default; `--exclude npm` opts out.
 * * **§15.29** — after writing, `enable` checks that the shims actually won on
 *   `PATH` and names whatever beat them.
 */

const {
  accessSync,
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  constants: fsConstants,
} = process.getBuiltinModule("node:fs");
import type { Stats } from "node:fs";
const {
  chmod,
  lstat,
  open,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} = process.getBuiltinModule("node:fs/promises");
const {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve: resolvePath,
} = process.getBuiltinModule("node:path");
const { fileURLToPath } = process.getBuiltinModule("node:url");
import { ENV, jupSpelling, readEnv, SYSTEM_ENV } from "../config/env-vars.ts";
import { DEFINITIONS, getBinariesFor, shimsByDefault } from "../config/table.ts";
import { advisory, messages, UsageError } from "../errors-cold.ts";
import {
  isOurShim,
  perUserShimDirectory as perUserDefault,
  shimDirectoryCandidates,
  SHIM_MARKER,
  PROXY_STUB_NAME,
  stubNameFor,
  systemShimDirectory,
  WIN32_WRAPPER_HEADS,
} from "../run/exec.ts";
import {
  BUILT_ENTRY_SPECIFIER,
  findCliEntry,
  findEntryModule,
  findEntrySpecifier,
  findStubFolder,
  ownModuleUrl,
} from "../utils/self.ts";
import { getHomeFolder, isInsideHome } from "../cache/store.ts";

/** Our own binary name — what §15.29's `PATH` verification and §10.4's lookup search for. */
const TOOL_NAME = "jup";

/**
 * §14.16 — how we recognise a stub we wrote. A regular file that does not carry
 * this marker is somebody else's binary and is never replaced without `--force`.
 *
 * Declared in `exec.ts` because §15.32's `PATH` promotion reads it on every
 * invocation and this module imports that one, not the other way round;
 * re-exported here because this is where the concept belongs.
 */
export { SHIM_MARKER, PROXY_STUB_NAME, stubNameFor, WIN32_WRAPPER_HEADS } from "../run/exec.ts";

/**
 * §10.1 — the interpreter the generic shebang names.
 *
 * It is also a binary name in the table (§15.39), and that coincidence is a
 * hazard rather than a curiosity: a shim called `node` whose stub starts
 * `#!/usr/bin/env node` re-searches the very `PATH` §15.32 told the user to
 * prepend the shim directory to, finds *itself*, and execs forever. See
 * {@link interpreterPath}.
 */
const INTERPRETER_NAME = "node";

/**
 * §10.1 — the absolute path of the runtime to bake into a shebang or a Windows
 * wrapper, so that no `PATH` lookup happens at invocation time. `undefined` when
 * there is no such runtime, which §15.43 makes a refusal rather than a fallback.
 *
 * `realpath` throughout, because `process.execPath` is frequently a symlink
 * (`/usr/bin/node` into a version manager's store) and the point of baking a
 * path in is that it names one file rather than whatever a lookup would answer
 * later.
 *
 * **The runtime running `enable` is not always usable.** §15.39 makes `node` a
 * table entry, so `enable node` puts a shim of ours on that name and §15.32 asks
 * for the shim directory to go *first* on `PATH`; from then on anything that
 * starts `#!/usr/bin/env node` — our own `bin/jup.mjs` included — resolves through
 * that shim, which downloads the project's runtime and spawns it. `enable` run
 * from inside that chain has a `process.execPath` under `<home>`, and baking it
 * in would tie every shim on the machine to a file `jup cache clean` exists to
 * delete: the next clean leaves every shim dying with `bad interpreter` (exit
 * 126), and `enable` cannot repair them because `env node` now finds only the
 * broken `node` shim (exit 127). §15.43 has the three tiers below instead.
 *
 * Resolve at `enable` time; generated stubs keep `#!/usr/bin/env node` so build
 * artifacts remain relocatable.
 *
 * Deliberately uncached. It is called once per `enable`, so a cache buys
 * nothing, and the answer now depends on the environment and on `PATH` — which
 * is exactly what a module-level cache would freeze across the runs a test makes
 * in one process.
 */
export function interpreterPath(): string | undefined {
  const own = realpathOr(process.execPath);
  // Tier 0 — the ordinary case: whatever is running `enable` is outside the
  // store, so it is the runtime the user chose and the one to name.
  if (!isInsideHome(own)) return own;

  // Tier 1 — the forwarded host runtime. Whichever process in this chain was
  // last running outside the store recorded itself there (§15.43,
  // `forwardHostRuntime`), so this is the runtime that would have been baked in
  // had the user typed `enable` one level up.
  const forwarded = readEnv(ENV.HOST_RUNTIME);
  if (forwarded !== undefined && forwarded !== "" && isAbsolute(forwarded)) {
    // Validated rather than trusted: it survives an env-file refusal (§14.5) but
    // it is still a string, and a value naming one of our own shims would
    // reintroduce §14.26's exec loop.
    if (isExecutableFile(forwarded) && !isOurShim(forwarded, INTERPRETER_NAME)) {
      const resolved = realpathOr(forwarded);
      if (!isInsideHome(resolved)) return resolved;
    }
  }

  // Tier 2 — walk `PATH` for a runtime that is neither one of our shims nor in
  // the store. This is the `enable` invoked directly under a store runtime, with
  // nothing forwarded: the user's own Node is still installed, it has merely
  // been displaced on `PATH` by the shim directory.
  return hostRuntimeOnPath();
}

/**
 * §15.43 tier 2 — the first `node` on `PATH` that `enable` may name.
 *
 * Both exclusions are load-bearing and neither is redundant. A shim of ours is
 * refused because naming it is §14.26's exec loop written by hand; a runtime
 * inside `<home>` is refused because that is the whole of §15.43. The ownership
 * test is the same one `enable` uses to decide what it may overwrite, so a
 * directory holding *someone else's* `node` still answers.
 */
function hostRuntimeOnPath(): string | undefined {
  for (const candidate of whichAll(INTERPRETER_NAME)) {
    if (isOurShim(candidate, INTERPRETER_NAME)) continue;
    const resolved = realpathOr(candidate);
    if (isInsideHome(resolved)) continue;
    return resolved;
  }
  return undefined;
}

/**
 * {@link interpreterPath}, with §15.43's tier 3 — the refusal — applied.
 *
 * Every caller that is about to *write* a baked-in interpreter goes through
 * this, so the "no usable runtime" case cannot reach a shebang as `undefined`
 * and silently become `#!/usr/bin/env node` again.
 */
function requireInterpreterPath(): string {
  const interpreter = interpreterPath();
  if (interpreter === undefined) {
    throw new UsageError(interpreterOnlyInStore(realpathOr(process.execPath), getHomeFolder()));
  }
  return interpreter;
}

/**
 * §15.44 — the interpreter an *installed* set of shims actually runs under, or
 * `undefined` when there is none to read.
 *
 * This is {@link interpreterPath} asked backwards. That one answers "what should
 * `enable` bake in?"; this one answers "what did some earlier `enable` already
 * bake in?", which is the only question `cache clean` can act on. The two are
 * deliberately not the same call: §15.43 makes the *new* answer safe, and the
 * whole point of the backstop is the installs whose answer was written before
 * that rule existed, or by some route that never went through it.
 *
 * The shims themselves are the record, exactly as §15.13 point 7 has it — a
 * sidecar naming the interpreter could disagree with the file the kernel will
 * actually exec. On POSIX the answer is the shebang of the stub each installed
 * shim links to, read *through* the shim so that a shim written by another copy
 * of the tool still answers; on Windows it is the wrappers, which name the
 * interpreter each (§10.3) because the stub's own shebang is dead weight there.
 * Neither lookup consults `PATH`, and both answer "none" rather than failing
 * when there is no shim directory to read.
 *
 * Both seams exist for the tests, which drive a temporary dist folder and a
 * temporary shim directory; production passes neither.
 */
export async function bakedInterpreter(options?: {
  distFolder?: string;
  installDirectory?: string;
}): Promise<string | undefined> {
  if (process.platform === "win32") return win32BakedInterpreter(options?.installDirectory);

  // The installed shims first, and only then our own copy of the stub. A shim is
  // a symlink (§10.2), so opening it reads the stub it actually points at —
  // which is the stub of whichever copy of the tool wrote it. That copy is
  // frequently not this one (an `npx jup enable`, a global that has since been
  // reinstalled), and reading only our own `dist/` would then miss the store
  // path the running shims are dying on and let `cache clean` delete it. Falling
  // back to our own stub covers the install that has no shim directory to read —
  // §15.44 answers "none" rather than failing there, and our stub is the same
  // record one directory over.
  return (
    (await posixShimInterpreter(options?.installDirectory)) ??
    (await readShebangOf(join(options?.distFolder ?? resolveStubFolder(), PROXY_STUB_NAME)))
  );
}

/**
 * The shebang of the stub the *installed* shims run through, or `undefined`.
 *
 * `resolveInstallDirectory` rather than `chooseInstallDirectory`, and for the
 * reason {@link win32BakedInterpreter} gives: this is a read of where the shims
 * already are, and §15.13 point 7 forbids that read from consulting `PATH`.
 *
 * Only an entry carrying {@link SHIM_MARKER} answers. The per-user shim
 * directory is full of other programs (§15.32 says so), and a foreign `node`
 * sitting there would otherwise contribute its own first line to a decision
 * about what `cache clean` may delete.
 */
async function posixShimInterpreter(installDirectory?: string): Promise<string | undefined> {
  let directory: string;
  try {
    directory = installDirectory ?? resolveInstallDirectory({}, false);
  } catch {
    return undefined;
  }

  for (const binName of targetBinaries([], [], { includeOptOut: true })) {
    // `readHead` opens through the symlink, so this is the stub's own first
    // line without a `readlink` of our own.
    const head = await readHead(join(directory, binName), 1024);
    if (head === undefined || !head.includes(SHIM_MARKER)) continue;
    const interpreter = shebangOf(head);
    if (interpreter !== undefined) return interpreter;
  }
  return undefined;
}

/** The interpreter named by `file`'s shebang, or `undefined` if it has none. */
async function readShebangOf(file: string): Promise<string | undefined> {
  // 1 KiB covers a shebang naming any path a filesystem will hold; the first
  // line is all that is read out of it.
  const head = await readHead(file, 1024);
  return head === undefined ? undefined : shebangOf(head);
}

/**
 * The interpreter out of a file's first line.
 *
 * `#!/usr/bin/env node` — the relocatable spelling the shipped stubs keep —
 * lands here too and is simply not a path any caller will find in the store.
 * `trim` takes the `\r` off a stub that has been through a CRLF checkout.
 */
function shebangOf(head: string): string | undefined {
  if (!head.startsWith("#!")) return undefined;
  const interpreter = (head.split("\n", 1)[0] ?? "").slice(2).trim();
  return interpreter === "" ? undefined : interpreter;
}

/**
 * The §10.3 `.cmd` wrapper's **fallback** branch: `"<interpreter>"  "%~dp0\<rel>" %*`.
 *
 * The lookahead is what separates it from the branch above it, which has the
 * same shape with `"%~dp0\node.exe"` in the interpreter's place — the relocatable
 * case, where the shim directory *is* a Node install and there is no absolute
 * path to read.
 */
const WIN32_CMD_INTERPRETER_RE = /^\s*"((?!%~dp0)[^"\n]+)"\s\s"%~dp0[\\/]/m;

/**
 * {@link bakedInterpreter} on Windows, where the answer lives in the shim
 * directory rather than beside the tool.
 *
 * `resolveInstallDirectory` rather than `chooseInstallDirectory`: this is not
 * `enable` choosing where to write, it is a read of where the shims already are,
 * and §15.13 point 7 forbids that read from consulting `PATH`. It throws when
 * there is no home directory to default to (§14.17), and a `cache clean` has no
 * business failing over that — there are then no shims to protect either.
 *
 * Every name is tried rather than just `node`, because §10.3 bakes the
 * interpreter into all three wrappers of every name unconditionally; the first
 * one that answers answers for the set.
 */
async function win32BakedInterpreter(installDirectory?: string): Promise<string | undefined> {
  let directory: string;
  try {
    directory = installDirectory ?? resolveInstallDirectory({}, false);
  } catch {
    return undefined;
  }

  for (const binName of targetBinaries([], [], { includeOptOut: true })) {
    const head = await readHead(join(directory, `${binName}.cmd`), 1024);
    const match = head === undefined ? null : WIN32_CMD_INTERPRETER_RE.exec(head);
    if (match !== null) return match[1];
  }
  return undefined;
}

/** §10.2 — a Yarn Switch install lives under `…/switch/bin/…`. */
const YARN_SWITCH_RE = /[/\\]switch[/\\]bin[/\\]/;

/** Windows writes three files per binary name (§10.3); `disable` removes all three. */
const WIN32_EXTENSIONS = ["", ".ps1", ".cmd"];

/** `0` where the platform has no `O_NOFOLLOW` (Windows), exactly as `tar.ts` does it. */
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;

/** §15.15 — where the record of displaced entries lives, under `<home>`. */
const DISPLACED_RECORD_NAME = "shims.json";

/** §15.15 — where the *content* of a displaced regular file is parked. */
const DISPLACED_BACKUP_DIR = "displaced";

export interface ShimOptions {
  installDirectory?: string;
  /** §15.13 point 8 — install to the system-wide directory instead of a per-user one. */
  system?: boolean;
  /** §14.16 — required to replace an entry we did not create. */
  force?: boolean;
}
/**
 * These live here rather than in `errors.ts` for the same reason `info.ts` keeps
 * its own: they are this command's vocabulary and nothing else refers to them.
 *
 * The two `!` lines quoted verbatim by §15.13 and §15.29 are byte-exact
 * contract; the rest are ours to word.
 */

/**
 * §14.18 — `EROFS`/`EACCES` on the shim directory is the container and
 * OS-package case, and a raw errno tells the user nothing. Name the ways out.
 */
export const shimDirectoryNotWritable = (directory: string) =>
  `Unable to write shims to ${directory}: the directory is not writable. Either re-run with --install-directory <a writable directory on your PATH>, set JUP_SHIM_DIRECTORY, or define shell aliases instead (e.g. alias yarn="${TOOL_NAME} yarn")`;

/**
 * §15.13 point 8 — `--system` and `--install-directory` name the same thing.
 *
 * A refusal rather than a precedence rule: the two spellings are equally
 * explicit, so there is no reading of `--system --install-directory /opt/bin`
 * that is obviously right, and picking one silently would put shims somewhere
 * the command line also said not to.
 */
export const systemAndInstallDirectory = () =>
  `Options --system and --install-directory both name an install directory; pass one or the other`;

/**
 * §15.13 point 8 — `--system` on a Windows without `%ProgramData%`.
 *
 * The variable is set on every supported Windows, so this is the stripped
 * environment (a service, a locked-down CI runner) rather than a version
 * difference. Guessing `C:\ProgramData` from a drive letter that may not be the
 * system one is exactly the kind of invention point 6 refuses, so `--system`
 * says it has no directory and points at the one flag that always does.
 */
export const noSystemShimDirectory = () =>
  `--system has no directory on this platform: %ProgramData% is not set. Pass --install-directory <a writable directory on your PATH> instead`;

/**
 * §10.7 + §15.43 — the *other* read-only directory, and a different failure.
 *
 * `guardWrites` covers the shim directory and the package directory alike, and
 * the message above names neither: it says "shims", and its two remedies
 * (`--install-directory`, `JUP_SHIM_DIRECTORY`) both move where the shims land,
 * which is not what failed. What failed is the shared stub inside jup's own
 * installation, which §10.1 rewrites to pin the interpreter — so the shim
 * directory is irrelevant and saying so is most of the value here. `enable`
 * without ${INTERPRETER_NAME} never reaches this: `ensureStub` compares before it
 * writes, so a stub that is already correct is left alone (§10.7).
 */
export const stubNotWritable = (stub: string) =>
  `Unable to update ${stub}: the shim stub has to be rewritten — shimming ${INTERPRETER_NAME} pins the interpreter into it — and the directory holding ${TOOL_NAME}'s own files is not writable. --install-directory and JUP_SHIM_DIRECTORY move the shims, not this file, so neither helps: install ${TOOL_NAME} somewhere writable, or run \`${TOOL_NAME} enable\` without ${INTERPRETER_NAME}, which leaves the stub untouched.`;

/**
 * §15.45 — the stub is byte-correct but not executable, and cannot be fixed.
 *
 * A POSIX shim is a symlink (§10.2), so the execute bit the kernel checks lives
 * on the stub, not on the name. Without it `execve` skips the shim and the
 * `PATH` lookup falls through in silence — no error, the shim simply never
 * runs — which is why this is a failure rather than an advisory even though
 * §14.18 lets a read-only installation through elsewhere: there, nothing needed
 * writing; here, every shim `enable` is about to write is dead on arrival.
 *
 * The remedies are the two that reach the file itself. {@link stubNotWritable}'s
 * "run `enable` without ${INTERPRETER_NAME}" is not among them — the bit is
 * needed whichever names are enabled.
 */
export const stubNotExecutable = (stub: string) =>
  `Unable to make ${stub} executable: the shims are symlinks to that file, so it is the one that has to carry the execute bit, and the mode could not be changed — ${TOOL_NAME}'s own files are read-only or owned by another user. Shims installed against it would be passed over in silence. Run \`chmod +x ${stub}\` as the owner of that file, or install ${TOOL_NAME} somewhere writable and re-run \`${TOOL_NAME} enable\`.`;

/**
 * §15.46 — the pin could not be written into ${TOOL_NAME}'s own CLI entry.
 *
 * A third read-only failure, and a third diagnosis. {@link stubNotWritable} is
 * about the file the *shims* run; this one is about the file `${TOOL_NAME}`
 * itself runs, and the harm it prevents is not a broken shim but a recursion —
 * with our ${INTERPRETER_NAME} shim first on `PATH` (§15.32), an entry point that
 * opens `#!/usr/bin/env ${INTERPRETER_NAME}` finds *us*, so every `${TOOL_NAME}`
 * command resolves the project's runtime and downloads it to print its own
 * version.
 *
 * The remedies differ accordingly. {@link stubNotExecutable}'s `chmod` reaches
 * the wrong property, and the shim-directory options reach the wrong directory;
 * what does reach it is installing ${TOOL_NAME} somewhere writable, or not
 * claiming the name at all — which here means `disable` as well as `enable`,
 * because an earlier run's ${INTERPRETER_NAME} shim is enough to require the pin
 * (§10.1, `claimsInterpreter`).
 */
export const cliEntryNotWritable = (entry: string) =>
  `Unable to update ${entry}: shimming ${INTERPRETER_NAME} puts ${TOOL_NAME}'s own ${INTERPRETER_NAME} shim ahead of the runtime on your PATH, so ${TOOL_NAME}'s entry point has to name its interpreter by absolute path — otherwise every ${TOOL_NAME} command re-enters that shim and downloads a runtime to run ${TOOL_NAME} itself. That file could not be rewritten: ${TOOL_NAME}'s own files are read-only or owned by another user. Install ${TOOL_NAME} somewhere writable and re-run \`${TOOL_NAME} enable\`, or run \`${TOOL_NAME} disable ${INTERPRETER_NAME}\` and keep ${INTERPRETER_NAME} out of \`${TOOL_NAME} enable\`, which leaves this file untouched.`;

/**
 * §15.43 — every runtime `enable` can see lives in the store, so there is
 * nothing safe to bake in.
 *
 * Refusing is the only correct answer. `#!/usr/bin/env node` is §14.26's exec
 * loop once the shim directory is first on `PATH`, and the store path is the
 * bug this whole section exists to close, so neither is a fallback — the user
 * has to name a runtime that will outlive `${TOOL_NAME} cache clean`.
 */
export const interpreterOnlyInStore = (interpreter: string, home: string) =>
  `Unable to bake an interpreter into the shims: the only ${INTERPRETER_NAME} available (${interpreter}) is inside ${home}, ${TOOL_NAME}'s own cache. Baking it into the shims would break every one of them the next time \`${TOOL_NAME} cache clean\` runs. Re-run \`${TOOL_NAME} enable\` under a ${INTERPRETER_NAME} installed outside ${home}.`;

/** §15.13 point 2 — verbatim. */
export const shimDirectoryFallback = (directory: string, fallback: string) =>
  `! ${directory} is not writable; installing shims to ${fallback} instead`;

/** §15.13 point 6 — verbatim. Deliberately shaped like the fallback line above. */
export const shimDirectoryPreferred = (fallback: string, chosen: string) =>
  `! ${fallback} is not on your PATH; installing shims to ${chosen} instead`;

/** §15.29 point 2 — verbatim. */
export const shimShadowed = (name: string, path: string, shim: string) =>
  `! ${name} on PATH resolves to ${path}, not the shim just installed at ${shim}. Another version manager may be shadowing it.`;

const REHASH_ADVICE =
  "A shell that is already open may need `hash -r` before the change is visible.";

/** §15.13 point 3 / §15.29 point 3 — the exact line to add, for the detected shell. */
export const shimDirectoryNotOnPath = (directory: string) =>
  [
    `! ${directory} is not on your PATH, so the shims installed there will not be found.`,
    `! Add it by running:`,
    `!     ${pathExportLine(directory)}`,
    `! ${REHASH_ADVICE}`,
  ].join(`\n`);

/** §15.29 point 4. */
export const rehashNotice = () => `! ${REHASH_ADVICE}`;

/** §15.15 — "if a recorded entry can no longer be restored, say so and continue". */
export const restoreFailed = (path: string, reason: string) =>
  `! Unable to restore ${path}: ${reason}`;
interface ParsedArgs {
  options: ShimOptions;
  names: string[];
  exclude: string[];
}

/**
 * §09.8 — `[--install-directory <path>] [...name]`, plus §14.16's `--force` and
 * §15.16's `--exclude <name>`.
 *
 * `--exclude` is repeatable and accepts a comma-separated list, because that is
 * what a user who has just read "`--exclude npm`" will try next.
 */
function parseShimArgs(args: string[]): ParsedArgs {
  const options: ShimOptions = {};
  const names: string[] = [];
  const exclude: string[] = [];

  const valueOf = (arg: string, index: number): [string, number] => {
    const inline = arg.indexOf("=");
    if (inline !== -1) return [arg.slice(inline + 1), index];
    const value = args[index + 1];
    if (value === undefined) {
      throw new UsageError(`Option ${arg} requires an argument`);
    }
    return [value, index + 1];
  };

  for (let index = 0; index < args.length; index++) {
    const arg = args[index] as string;

    if (arg === "--install-directory" || arg.startsWith("--install-directory=")) {
      const [value, next] = valueOf(arg, index);
      options.installDirectory = value;
      index = next;
    } else if (arg === "--exclude" || arg.startsWith("--exclude=")) {
      const [value, next] = valueOf(arg, index);
      for (const name of value.split(",")) {
        if (name !== "") exclude.push(name);
      }
      index = next;
    } else if (arg === "--system") {
      options.system = true;
    } else if (arg === "--force") {
      options.force = true;
    } else {
      // Anything else is a package manager name and is validated as one, which
      // is also how a typo'd flag reports itself (§12.9).
      names.push(arg);
    }
  }

  if (options.system === true && options.installDirectory !== undefined) {
    throw new UsageError(systemAndInstallDirectory());
  }

  return { options, names, exclude };
}

function assertKnownName(name: string): void {
  if (!Object.hasOwn(DEFINITIONS, name)) {
    throw new UsageError(messages.invalidPackageManagerName(name));
  }
}

/**
 * §10.5 as amended by §15.16 — with no names, every supported package manager
 * that opts into the default set, npm included; each name then expands to its
 * full binary set, so `disable yarn` takes `yarnpkg` with it.
 *
 * npm is included for consistent project-pin enforcement; `--exclude npm`
 * explicitly opts out.
 *
 * §15.28's native entries are the opposite case and opt *out*
 * (`shimByDefault: false`). `bun` and `deno` name runtimes that users install
 * deliberately and reach for outside any project; a bare `jup enable` claiming
 * those names on `PATH` would be a takeover nobody asked for, and — unlike the
 * npm question — it would land on people who upgraded rather than on people who
 * chose. Naming the entry is the opt-in: `jup enable bun` installs its shims,
 * and `jup disable` with no names still removes whatever is installed, because
 * removal has no such hazard.
 */
export function targetBinaries(
  names: string[],
  exclude: string[] = [],
  options?: { includeOptOut?: boolean },
): string[] {
  for (const name of exclude) assertKnownName(name);
  const excluded = new Set(exclude);

  const defaults = Object.keys(DEFINITIONS).filter(
    (name) => options?.includeOptOut === true || shimsByDefault(name),
  );

  const selected = (names.length > 0 ? names : defaults).filter((name) => {
    assertKnownName(name);
    return !excluded.has(name);
  });

  const binaries = new Set<string>();
  for (const name of selected) {
    for (const binName of getBinariesFor(name)) binaries.add(binName);
  }

  return [...binaries];
}
/**
 * The folder holding the stubs: `bin/` in a published install, the entry's own
 * directory (`src/`) from a source checkout.
 *
 * The entry is found by walking up rather than by taking this module's own
 * directory — a bundler may emit chunks into a subdirectory (obuild uses
 * `dist/_chunks/`), in which case this file's neighbour is not the entry.
 */
function resolveStubFolder(): string {
  // Not `import.meta.url` directly: inside a compiled binary that names the
  // build machine's checkout, whose `bin/` exists and whose stubs would be
  // linked onto this user's `PATH` (see {@link ownModuleUrl}).
  const self = ownModuleUrl(import.meta.url);
  const module = findEntryModule(self);
  return module === undefined ? dirname(fileURLToPath(self)) : findStubFolder(module);
}

function isExecutableFile(file: string): boolean {
  const stats = statSync(file, { throwIfNoEntry: false });
  if (stats === undefined || !stats.isFile()) return false;
  if (process.platform === "win32") return true;
  try {
    accessSync(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * `which -a name` — every executable of that name on `PATH`, in lookup order.
 *
 * A generator rather than an array because both callers stop early: §15.29's
 * verification wants the first hit, and §15.43's tier 2 wants the first hit that
 * passes two further tests. Neither should stat the tail of `PATH` to get it.
 */
function* whichAll(name: string): Generator<string> {
  const pathValue = process.env[SYSTEM_ENV.PATH] ?? "";
  const extensions =
    process.platform === "win32"
      ? (process.env[SYSTEM_ENV.PATHEXT] ?? ".COM;.EXE;.BAT;.CMD").split(";")
      : [""];

  for (const entry of pathValue.split(delimiter)) {
    if (entry === "") continue;
    for (const extension of extensions) {
      const candidate = join(entry, `${name}${extension}`);
      if (isExecutableFile(candidate)) yield candidate;
    }
  }
}

/** `which(name)` — the full path of the first executable of that name on `PATH`. */
export function whichFile(name: string): string | undefined {
  for (const file of whichAll(name)) return file;
  return undefined;
}

/** Two paths naming the same directory or file, symlinks resolved where possible. */
function samePath(left: string, right: string): boolean {
  if (left === right) return true;
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
}

/**
 * §15.13 point 1 — the per-user default, the one place a shim can always be
 * written without elevation.
 *
 * The chain itself lives in `exec.ts`, because §15.32 prepends this directory to
 * `PATH` on every proxy invocation and the two must name the same place. All
 * this adds is §14.17's error: without a home directory there is no per-user
 * default to fall back to, and the user has to name a directory.
 */
export function perUserShimDirectory(): string {
  const directory = perUserDefault();
  if (directory === undefined) throw new UsageError(messages.noShimDirectory());
  return directory;
}

/**
 * §15.13 point 7 — the first candidate that already holds a shim of ours, or
 * `undefined` when none does.
 *
 * This is the whole of the "record" of where `enable` put things. A sidecar file
 * was the alternative and the spec rejects it: it can disagree with the
 * filesystem, and it is keyed on a `<home>` that `COREPACK_HOME` may move between
 * the install and the removal. The shims answer the question themselves.
 *
 * Every binary name is scanned, opt-outs included, because `enable bun` on its
 * own is a supported thing to have done.
 */
function installedShimDirectory(): string | undefined {
  const binaries = targetBinaries([], [], { includeOptOut: true });
  for (const directory of shimDirectoryCandidates()) {
    for (const binName of binaries) {
      if (isOurShim(join(directory, binName), binName)) return directory;
    }
  }
  return undefined;
}

/**
 * §15.13 point 6 — is this alternate one we may install into?
 *
 * The default is never put through this: it is what jup would have used anyway,
 * and refusing it would leave `enable` nowhere to go. The gate is here to stop
 * the *preference* from choosing a worse target than the default, which means
 * three things — the directory must already exist (jup creates the default and
 * nothing else, so a `PATH` entry naming an absent directory stays inert), it
 * must be ours, and it must not be writable by anyone else. A shim is a file
 * every `yarn` on the machine runs through, so a group-writable directory on a
 * shared host is a local privilege escalation with extra steps; §07.4 takes the
 * same line on modes coming out of an archive.
 */
function eligibleAlternate(directory: string): boolean {
  const stats = statSync(directory, { throwIfNoEntry: false });
  if (stats === undefined || !stats.isDirectory()) return false;
  if (process.platform === "win32") return true;
  const uid = process.getuid?.();
  if (uid !== undefined && stats.uid !== uid) return false;
  return (stats.mode & 0o022) === 0;
}

/**
 * §15.13 points 1 and 8 — the directory the *user* named, or `undefined` when
 * they named none and the selection below has to choose one.
 *
 * `--system` is sugar for a directory, not a mode: it resolves to one name and
 * then travels the same path `--install-directory` does, which is why it is
 * answered here rather than anywhere in the selection. That also settles what it
 * outranks — `JUP_SHIM_DIRECTORY`, like any flag over any variable — and what it
 * does not: nothing, since the two flags that could disagree with it are refused
 * as a pair by `parseShimArgs`.
 */
function namedDirectory(options: ShimOptions): string | undefined {
  if (options.system === true) {
    const directory = systemShimDirectory();
    if (directory === undefined) throw new UsageError(noSystemShimDirectory());
    return directory;
  }
  const configured = options.installDirectory ?? readEnv(ENV.SHIM_DIRECTORY);
  return configured === undefined || configured === "" ? undefined : resolvePath(configured);
}

/**
 * §15.13 point 6 — where `enable` installs, and what it displaced to get there.
 *
 * `--system`, `--install-directory` and `COREPACK_SHIM_DIRECTORY` are answered
 * first and never second-guessed. After that the order is: the default when it
 * is already on `PATH` (nothing to improve on), then continuity, then the first
 * eligible alternate that is on `PATH`, then the default with §15.13 point 3's
 * advisory.
 *
 * `PATH` chooses among {@link shimDirectoryCandidates} and never supplies a
 * candidate: writable entries may belong to system or runtime-manager installs.
 * Only the explicit candidate list is eligible.
 */
export function chooseInstallDirectory(options: ShimOptions): {
  directory: string;
  /** The user named this directory; none of the selection below ran. */
  named?: true;
  /** The default it was preferred over, when an alternate won. */
  preferredOver?: string;
} {
  const named = namedDirectory(options);
  if (named !== undefined) return { directory: named, named: true };

  const fallback = perUserShimDirectory();
  if (directoryOnPath(fallback)) return { directory: fallback };

  // Continuity outranks the preference: moving an existing set would leave the
  // old one behind, and two sets of shims for one set of names is worse than one
  // set in a suboptimal place. `jup disable && jup enable` moves them.
  const installed = installedShimDirectory();
  if (installed !== undefined) return { directory: installed };

  for (const alternate of shimDirectoryCandidates().slice(1)) {
    if (!directoryOnPath(alternate)) continue;
    if (!eligibleAlternate(alternate)) continue;
    // Probed before anything is announced: a message naming a directory the
    // shims then fall back out of would be worse than no message.
    if (probeWritable(alternate) !== undefined) continue;
    return { directory: alternate, preferredOver: fallback };
  }

  return { directory: fallback };
}

/**
 * §15.13 points 1, 7 and 8 — `--system` or `--install-directory`, else
 * `COREPACK_SHIM_DIRECTORY`, else the candidate holding our shims, else the
 * per-user default.
 *
 * `--system` matters most here, on the removal side: `/usr/local/bin` is a
 * candidate only for `root` (point 8), so a non-root `enable --system` — a user
 * who is in a group that owns the directory, or one who chowned it — leaves
 * shims the scan cannot find, and `disable --system` is how they come back out.
 * Under `root` the scan finds them and a bare `disable` is enough.
 *
 * This is the resolver for everything that is **not** `enable`: `disable` (§10.6)
 * and `info` (§15.30). It MUST NOT read `PATH` — a removal that depended on the
 * `PATH` of the moment would strand shims installed from a shell with a different
 * one, and a report that did would name a directory the shims are not in.
 * `enable`'s own chain is {@link chooseInstallDirectory}.
 *
 * Do not infer the directory from this tool's `PATH` entry; that may select a
 * system installation. An explicit `--install-directory` remains available.
 *
 * `enable` realpaths the result so relative link targets are correct; `disable`
 * deliberately does not (§10.4).
 */
export function resolveInstallDirectory(options: ShimOptions, forEnable: boolean): string {
  const directory = namedDirectory(options) ?? installedShimDirectory() ?? perUserShimDirectory();

  if (!forEnable) return directory;

  // §10.2 property 2: a relative link target computed from a symlinked directory
  // would be wrong, so `enable` — and only `enable` — resolves it first.
  try {
    return realpathSync(directory);
  } catch {
    return directory;
  }
}

/**
 * Four random bytes, hex encoded, for a temp file name.
 *
 * `node:crypto` is reached through `process.getBuiltinModule` for the reason
 * `store.ts` gives: importing it pulls in two dozen native modules, and nothing
 * here is on the warm path (§16.3). The lookup loads nothing until it is called.
 */
function randomSuffix(): string {
  return process.getBuiltinModule("node:crypto").randomBytes(8).toString("hex");
}

/**
 * `undefined` when the directory can be created and written to, else the errno.
 *
 * The probe is a **create-exclusive, no-follow** open under an unguessable name,
 * not a plain write to `.jup-probe-<pid>`. A shared install directory
 * (`/usr/local/bin`, a CI prefix) is frequently group-writable, and the pid space
 * is small enough to pre-seed: an attacker who plants
 * `.jup-probe-<every pid>` as symlinks gets `sudo jup enable
 * --install-directory /usr/local/bin` to truncate whatever they aimed at.
 * `O_EXCL | O_NOFOLLOW` refuses to open through a link at all, and the random
 * name means there is nothing to pre-seed — the same pairing `tar.ts` uses on
 * extraction (§07.4 rule 5).
 *
 * The directory is created `0o755` rather than at the ambient default: under
 * `umask 000` — containers and some CI images — the default would make
 * `~/.local/bin` world-writable, and every `yarn` on the machine then runs
 * through a shim any local user can replace.
 */
function probeWritable(directory: string): NodeJS.ErrnoException | undefined {
  const probe = join(directory, `.${TOOL_NAME}-probe-${randomSuffix()}`);
  let handle: number | undefined;
  try {
    mkdirSync(directory, { recursive: true, mode: 0o755 });
    handle = openSync(
      probe,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW,
      0o600,
    );
    return undefined;
  } catch (error) {
    return error as NodeJS.ErrnoException;
  } finally {
    if (handle !== undefined) closeSync(handle);
    // `rm` never follows a symlink, so this drops a planted link and not its
    // target.
    rmSync(probe, { force: true });
  }
}

const NOT_WRITABLE = new Set(["EROFS", "EACCES", "EPERM"]);

/**
 * §15.13 point 2 — probe *before* writing anything, and fall back to the
 * per-user default rather than failing, saying so on the way.
 *
 * `fallback` is what point 6 would have chosen with no directory named, so a
 * `--install-directory` that turns out to be read-only lands where a bare
 * `enable` would have. Its own announcement is not repeated: the line below
 * already names the directory the shims went to.
 *
 * It is a **thunk**, and required rather than defaulted, because computing it can
 * run the whole of point 6's selection — `probeWritable` included, which creates
 * and unlinks a file in a directory this call may never touch. On the happy path
 * it is never called at all, so a writable `--install-directory` leaves every
 * candidate exactly as it found it. A side effect has no business hiding in a
 * default argument either.
 *
 * Returns the realpath of the directory that will actually be used.
 */
export function prepareInstallDirectory(directory: string, fallback: () => string): string {
  const failure = probeWritable(directory);
  if (failure === undefined) return realpathOr(directory);
  if (!NOT_WRITABLE.has(failure.code ?? "")) throw failure;

  const target = fallback();
  if (samePath(directory, target)) throw new UsageError(shimDirectoryNotWritable(directory));

  advisory(shimDirectoryFallback(directory, target));

  const second = probeWritable(target);
  if (second !== undefined) throw new UsageError(shimDirectoryNotWritable(target));

  return realpathOr(target);
}

function realpathOr(directory: string): string {
  try {
    return realpathSync(directory);
  } catch {
    return directory;
  }
}
/**
 * §10.1 — the stub bakes in the binary name, because Node loses it: it
 * `realpath`s the executed module, so a shim cannot ask how it was called.
 *
 * `COREPACK_ENABLE_DOWNLOAD_PROMPT` defaults to `1` here and to `0` in the CLI entry
 * (§05.5): the user asked for `yarn`, not for a download. `??=` in both, so a
 * real environment variable still wins.
 *
 * **The entry is resolved against the stub's own realpath, not by a relative
 * specifier.** `./index.mjs` would be the obvious spelling and it is wrong: the
 * shim on `PATH` is a *symlink* to this file (§10.2), so a relative specifier is
 * resolved against whichever path the runtime considers the main module's. That
 * happens to be the realpath under stock Node, which is why the relative form
 * worked — but it is a default, not a guarantee. `node
 * --preserve-symlinks-main`, a documented and supported flag, turns it off, and
 * the stub then looks for its entry *next to the symlink* and dies with
 * `ERR_MODULE_NOT_FOUND`; bun and deno resolve from the link too. Doing the
 * `realpath` ourselves makes the pair relocatable under every one of them, and
 * costs a single `stat` on a path the loader is about to stat anyway — measured
 * at no change against §16.3's budget, because `node:fs` and `node:url` are
 * already loaded by the warm chunk this stub is about to import.
 *
 * The two builtin imports are static, since neither reads our environment; the
 * `import()` of the entry stays *after* the download-prompt assignment, which
 * the entry does read.
 *
 * The exit code is assigned only when it is non-zero, exactly as the CLI entry does
 * it and for the same reason (§08.4): the in-process handover answers `0` before
 * the package manager's module body has run, and writing that would replace
 * `undefined` with `0` — after which a package manager whose `beforeExit` hook
 * guards on `process.exitCode === undefined` declines to set its own code. Node
 * exits 0 when nothing is assigned, so a plain success is unaffected. This is
 * the stub every `yarn`, `npm` and `pnpm` on the machine runs through, so the
 * reasoning lives here rather than in the handful of lines it emits.
 *
 * §14.15 — **`binName` is omitted on POSIX**, and the stub reads the name it was
 * invoked under from `basename(process.argv[1])` instead. Node does not
 * `realpath` `argv[1]` (it does `realpath` the *module*, which is what
 * {@link findEntrySpecifier} and the `realpathSync` below are for), so a symlink
 * named `yarn` still says `yarn` there — under a direct `PATH` execution, under
 * `node <shim>`, and under `--preserve-symlinks-main`. One stub therefore serves
 * every binary name, avoiding stale per-name files.
 *
 * Windows still passes a name, because §10.3's `.cmd` / `.ps1` wrappers invoke
 * `node <stub>` and the invocation name is gone by then. That is the *only*
 * reason the parameter still exists.
 *
 * `interpreter` is the other half of that: `#!/usr/bin/env node` re-searches
 * `PATH` at every invocation, and §15.32 asks the user to put the shim directory
 * *first* on `PATH`. Once `enable node` has claimed the name `node` there
 * (§10.5), `env` finds the shim rather than the runtime and the stub execs
 * itself until the machine gives up — a fork bomb through `cmd.exe` on Windows.
 * So when the interpreter's own name is in play, `enable` bakes in the absolute
 * path of the runtime it is itself running under and no lookup happens at all.
 * The build script passes nothing, so the *shipped* stubs stay relocatable.
 *
 * `enableCompileCache()` is §08.2's optional performance detail, with no
 * observable contract either way. It is asked for before the `import()` so the
 * entry module is covered too, and it is measured rather than assumed: on the
 * warm proxy path it is worth roughly 0.6 ms of a ~33 ms run: `codeSplitting:
 * false` puts the cold code in the same file, but behind rolldown's lazy init
 * thunks, so the run compiles the bundle once and evaluates only §16.3's warm
 * set. The CLI entry gains more (~2 ms), since it evaluates further into it. A runtime whose cache directory is not writable gets a
 * documented no-op — the call reports failure through its return value rather
 * than throwing, and nothing here reads it.
 *
 * It goes through the *default* export and is called optionally, exactly as
 * §10.1 writes it. A named import would be a link-time `SyntaxError` on any
 * runtime lacking the export — thrown before the stub's first line and catchable
 * by nobody, which for a file standing in for `npm` on someone's `PATH` is the
 * worst failure this module can produce. Deno 2.8's `node:module` has no
 * `enableCompileCache`, so that runtime is not hypothetical.
 *
 * @param entry The entry module's specifier relative to the stub, from
 * {@link findEntrySpecifier} — `index.ts` beside it in a source checkout,
 * `../dist/index.mjs` in a published one. Resolved against the stub's own
 * realpath, never against the process's working directory.
 * @param binName Windows only. Omitted, the stub dispatches on its own
 * invocation name.
 * @param interpreter Absolute path to put in the shebang. Omitted,
 * `/usr/bin/env node`.
 */
export function shimSource(entry: string, binName?: string, interpreter?: string): string {
  const name = binName === undefined ? "basename(process.argv[1])" : JSON.stringify(binName);
  return [
    interpreter === undefined ? "#!/usr/bin/env node" : `#!${interpreter}`,
    `// ${SHIM_MARKER} — generated by \`${TOOL_NAME} enable\`; edits are overwritten.`,
    // `process.getBuiltinModule` rather than four static imports: the stub is
    // parsed on every warm run, and skipping the ESM import machinery for
    // builtins the runtime has already loaded is worth ~2 ms of it (§16.3).
    `const { realpathSync } = process.getBuiltinModule("node:fs");`,
    `const nodeModule = process.getBuiltinModule("node:module");`,
    ...(binName === undefined
      ? [`const { basename } = process.getBuiltinModule("node:path");`]
      : []),
    `const { pathToFileURL } = process.getBuiltinModule("node:url");`,
    `nodeModule.enableCompileCache?.();`,
    `if (process.env.${jupSpelling(ENV.ENABLE_DOWNLOAD_PROMPT)} === undefined)`,
    `  process.env.${ENV.ENABLE_DOWNLOAD_PROMPT} ??= "1";`,
    `const entry = new URL(${JSON.stringify(entry)}, pathToFileURL(realpathSync(import.meta.filename)));`,
    `const { runMain } = await import(entry.href);`,
    `const code = await runMain([${name}, ...process.argv.slice(2)]);`,
    `if (code !== 0) process.exitCode = code;`,
    "",
  ].join("\n");
}

/**
 * The body of `bin/jup.mjs` — the file `package.json`'s `bin` points `jup` and
 * `corepack` at, shipped as a static file rather than as a second bundle.
 *
 * It was an entry of its own until it was not worth one: `codeSplitting: false`
 * makes every entry a full copy of the module graph, so `dist/bin.mjs` was 168 kB
 * of which all but ~300 bytes was `dist/index.mjs` again (§16.3). What is
 * actually specific to this entry is the nine lines below, and none of them need
 * a bundler.
 *
 * Everything here is {@link shimSource}'s, for {@link shimSource}'s reasons —
 * `process.getBuiltinModule` over static imports, the optional compile cache
 * through the namespace, the entry resolved against this file's own realpath so
 * an `npm` bin symlink and `--preserve-symlinks-main` cannot send it into
 * `node_modules/dist/`, and the exit code assigned only when non-zero (§08.4).
 *
 * Two things differ, both §05.5's:
 *
 * - the download prompt defaults to `0`, not `1`. The user typed our name, so
 *   they did ask to download something.
 * - `argv` is passed through unchanged. A shim prepends the name it was invoked
 *   under (§14.15); here that name *is* us, and `runMain` reads §09's commands
 *   from position 0.
 *
 * @param interpreter Absolute path for the shebang — §15.46's pin. Omitted,
 * `/usr/bin/env node`, which is how it ships.
 */
export function cliEntrySource(interpreter?: string): string {
  return [
    interpreter === undefined ? "#!/usr/bin/env node" : `#!${interpreter}`,
    `// ${TOOL_NAME}'s own CLI entry — generated by \`pnpm build\`; edits are overwritten.`,
    `const nodeModule = process.getBuiltinModule("node:module");`,
    `const { realpathSync } = process.getBuiltinModule("node:fs");`,
    `const { pathToFileURL } = process.getBuiltinModule("node:url");`,
    `nodeModule.enableCompileCache?.();`,
    `if (process.env.${jupSpelling(ENV.ENABLE_DOWNLOAD_PROMPT)} === undefined)`,
    `  process.env.${ENV.ENABLE_DOWNLOAD_PROMPT} ??= "0";`,
    `const entry = new URL(${JSON.stringify(BUILT_ENTRY_SPECIFIER)}, pathToFileURL(realpathSync(import.meta.filename)));`,
    `const { runMain } = await import(entry.href);`,
    `const code = await runMain(process.argv.slice(2));`,
    `if (code !== 0) process.exitCode = code;`,
    "",
  ].join("\n");
}

/**
 * §14.18 — map the read-only install to something the user can act on.
 *
 * `message` exists because this guard covers two different directories: the shim
 * directory, whose remedies are the default's, and jup's own package directory
 * (§10.7), whose remedies are nothing like them — see {@link stubNotWritable}.
 */
async function guardWrites<T>(
  directory: string,
  action: () => Promise<T>,
  message: (directory: string) => string = shimDirectoryNotWritable,
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (NOT_WRITABLE.has(code ?? "")) {
      throw new UsageError(message(directory));
    }
    throw error;
  }
}

/** First `length` bytes of a file as UTF-8, or `undefined` if it cannot be read. */
async function readHead(file: string, length: number): Promise<string | undefined> {
  const handle = await open(file, "r").catch(() => undefined);
  if (handle === undefined) return undefined;

  try {
    const buffer = Buffer.allocUnsafe(length);
    let filled = 0;
    while (filled < length) {
      const { bytesRead } = await handle.read(buffer, filled, length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return buffer.toString("utf8", 0, filled);
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}

/**
 * §15.45 — make sure the stub carries the execute bit, without writing when it
 * already does.
 *
 * Installed stubs may lack the execute bit, and a symlink has no mode of its
 * own. Ensure the target is executable so `PATH` lookup cannot skip it.
 *
 * `stat` first and chmod only what needs it: a no-op chmod is still a write, and
 * §10.2 property 4 and §10.7 both want a warm `enable` against a read-only
 * installation to touch nothing. Windows returns immediately — its wrappers are
 * regular files chmod'd as they are written (§10.3), and its mode bits do not
 * mean this anyway.
 */
async function ensureExecutable(file: string, distFolder: string): Promise<void> {
  if (process.platform === "win32") return;

  // `access`, not a mode comparison: §15.45 asks for a `chmod` "only when the
  // execute bits are missing", and the question that decides whether a shim runs
  // is whether *this* caller can exec the stub — which is what `X_OK` answers.
  // Demanding all three bits instead would fail a `0o744` or `0o700` stub that
  // already runs, and then either rewrite its mode on every warm `enable`
  // (§10.2 property 4) or, on an install owned by someone else, turn a working
  // installation into a refusal. It also loops: `chmod +x` under a non-zero
  // umask yields `0o744`, which would fail the same test the message just asked
  // the user to satisfy.
  if (isExecutableFile(file)) return;

  // Unreadable is not this function's failure to report: the caller has just
  // compared the file's contents, so anything that hides it now is a race, and
  // the shim it writes will fail loudly rather than silently.
  if ((await stat(file).catch(() => undefined)) === undefined) return;

  // `0o755`, the mode §10.1 states and every other write here uses, rather than
  // `mode | 0o111`: the point is to leave the file in the one shape the spec
  // describes, whatever partial mode it arrived with.
  await guardWrites(
    distFolder,
    () => chmod(file, 0o755),
    () => stubNotExecutable(file),
  );
}

/**
 * Make sure the stub exists and is current, and hand back its path. It is
 * rewritten only when the content differs, so a warm `enable` writes nothing at
 * all — which is what lets §10.2's idempotency hold even when the dist folder is
 * read-only. {@link ensureExecutable} is the one exception, and only for a stub
 * that arrived without the execute bit (§15.45).
 *
 * `binName` is Windows's: §10.3 needs one stub per name because its wrappers
 * cannot carry the invocation name. POSIX omits it and gets
 * {@link PROXY_STUB_NAME}, written once however many names are enabled.
 */
async function ensureStub(
  distFolder: string,
  binName?: string,
  interpreter?: string,
): Promise<string> {
  // The stub resolves its entry module against its own realpath, so the pair
  // stays relocatable (§10.2 property 2) whichever path the runtime hands the
  // stub — see `shimSource`. Which specifier it gets depends on whether we are
  // running from source (`index.ts`, beside the stub) or from a build
  // (`../dist/index.mjs`, one directory over); `findEntrySpecifier` is the single
  // definition of that order, and `build.config.ts` shares it so that
  // the shipped stubs and the ones `enable` writes are byte-identical.
  const entry = findEntrySpecifier(distFolder);
  if (entry === undefined) throw new UsageError(messages.assertStubFolderMissing());

  const file = join(distFolder, binName === undefined ? PROXY_STUB_NAME : stubNameFor(binName));
  const source = shimSource(entry, binName, interpreter);

  // One byte more than the stub is long, so a longer file cannot compare equal.
  // `byteLength`, not `length`: the banner is not ASCII.
  if ((await readHead(file, Buffer.byteLength(source) + 1)) === source) {
    // Current content and executable mode are both required by §15.45.
    await ensureExecutable(file, distFolder);
    return file;
  }

  await guardWrites(
    distFolder,
    async () => {
      await writeFile(file, source);
      await chmod(file, 0o755);
    },
    () => stubNotWritable(file),
  );

  return file;
}

/**
 * §15.46 — pin the interpreter into ${TOOL_NAME}'s **own** CLI entry, the same
 * way and for the same reason §10.1 pins it into the stub.
 *
 * `bin/jup.mjs` opens `#!/usr/bin/env ${INTERPRETER_NAME}`, and
 * that line is §14.26 consequence 2 waiting to happen to *us*. Once a
 * ${INTERPRETER_NAME} shim of ours is on the `PATH` §15.32 asks the user to
 * prepend the shim directory to, `env` finds the shim, the shim resolves the
 * project's `devEngines.runtime` or `.nvmrc` (§15.40), and `jup --version`
 * downloads a 171 MB runtime to print a version string. Every subsequent run
 * still pays for a resolution and a second process. Baking the absolute path in
 * removes the lookup, so the entry runs under the same host runtime `enable`
 * chose for the shims.
 *
 * **Only the first line, and only when it is wrong.** The shebang is the whole
 * of §15.46's business with this file; everything from the first newline on is
 * copied through byte for byte. We ship `bin/jup.mjs` verbatim and could compare
 * it against `cliEntrySource()` — but the installation being enabled is
 * frequently not the one that wrote it (an `npx jup enable`, a global since
 * upgraded), and a body comparison would turn a version skew into a refusal over
 * a line nobody asked us to police. Testing before writing is also what keeps
 * §10.7's read-only installation and §10.2's idempotency intact for the second
 * and every later `enable`.
 *
 * Temp-then-rename, unlike {@link ensureStub}: a `writeFile` truncates first, and
 * an interrupt between the two halves leaves an empty `jup.mjs`, which is the one
 * file that cannot be repaired by running this tool. The mode rides across, or a
 * `bin` target npm made `0o755` would come back as whatever the umask says and
 * stop being executable — §15.45's failure, one file over.
 */
async function pinCliEntry(distFolder: string, interpreter: string): Promise<void> {
  const file = findCliEntry(distFolder);
  // An installation with no built CLI entry beside its stubs — a source
  // checkout, a compiled binary — has nothing to pin. Nothing to do is a
  // success here, not a gap: `enable` must not fail for want of a build.
  if (file === undefined) return;

  const wanted = `#!${interpreter}`;

  // The cheap half of the comparison first: 1 KiB covers a shebang naming any
  // path a filesystem will hold, and the warm `enable node` — by far the common
  // one — then never reads the rest of the file.
  const head = await readHead(file, 1024);
  if (head === undefined || !head.startsWith("#!")) return;
  const firstLine = head.split("\n", 1)[0] ?? "";
  // Already ours to the byte. A `\r` from a CRLF checkout deliberately does not
  // compare equal: the kernel would take it as part of the interpreter path, so
  // that file is wrong and the rewrite below is the repair.
  if (firstLine === wanted) return;

  // Byte offsets from here on. `head` is a UTF-8 *decode*, and a path outside
  // ASCII would put its newline at a different index in the buffer than in the
  // string.
  const original = await readFile(file).catch(() => undefined);
  if (original === undefined) return;
  const end = original.indexOf(0x0a);
  // No line ending at all: a one-line file that is not something we can pin
  // without inventing the rest of it.
  if (end === -1) return;
  const pinned = Buffer.concat([Buffer.from(wanted, "utf8"), original.subarray(end)]);

  const mode = (await stat(file).catch(() => undefined))?.mode ?? 0o755;
  const suffix = process.getBuiltinModule("node:crypto").randomBytes(6).toString("hex");
  // The entry's own directory. It is the stub folder in both layouts we ship,
  // but a `rename` is only atomic within one directory — which is the whole
  // reason this write goes through a temp file — and it is this directory's
  // permissions that decide the write, so it is the one to name rather than the
  // one that happens to equal it.
  const cliFolder = dirname(file);
  const tmp = join(cliFolder, `.${basename(file)}.${suffix}.tmp`);

  await guardWrites(
    cliFolder,
    async () => {
      try {
        // `wx` under an unguessable name, so a link planted beside the entry is
        // not something we write through — `pin.ts` writes the user's manifest
        // the same way and for the same reason.
        await writeFile(tmp, pinned, { flag: "wx", mode: mode & 0o777 });
        // `open`'s mode argument is masked by the umask, so the `mode:` above is
        // a floor and not the mode: under `umask 077` a `0o755` entry comes back
        // `0o700`, and every other user's `jup` on `PATH` is then a file the
        // lookup passes over in silence — §15.45's failure, moved one file over,
        // which the last bullet of §15.46 exists to prevent. `chmod` is not
        // masked, so it is what actually carries the mode across (`ensureStub`
        // does the same after its own write).
        await chmod(tmp, mode & 0o777);
        await rename(tmp, file);
      } catch (error) {
        await rm(tmp, { force: true });
        throw error;
      }
    },
    () => cliEntryNotWritable(file),
  );
}
/** §10.2 — a `yarn`-ish name whose realpath lands inside a Yarn Switch install. */
async function isYarnSwitch(binName: string, file: string): Promise<boolean> {
  if (!binName.includes("yarn")) return false;
  // A dangling link has no realpath, and that is not a Switch install.
  const target = await realpath(file).catch(() => undefined);
  return target !== undefined && YARN_SWITCH_RE.test(target);
}

/**
 * Is the entry at `file` one *we* created?
 *
 * Both `enable` and `disable` check ownership before replacing or removing an
 * entry. The three owned shapes are:
 *
 * * a POSIX symlink whose target carries {@link SHIM_MARKER};
 * * a **dangling** symlink that still names a stub of ours — the shared
 *   {@link PROXY_STUB_NAME}, or a per-name `<binName>.mjs` from a Windows
 *   install, which `enable` replaces and `disable` removes;
 * * a regular file carrying the marker, or one of §10.3's three Windows
 *   wrappers, which cannot carry it (see {@link WIN32_WRAPPER_HEADS}).
 */
async function isOurEntry(file: string, binName: string, stats?: Stats): Promise<boolean> {
  const entry = stats ?? (await lstat(file).catch(() => undefined));
  if (entry === undefined) return false;

  if (entry.isSymbolicLink()) {
    const link = await readlink(file).catch(() => undefined);
    if (link === undefined) return false;
    const head = await readHead(resolvePath(dirname(file), link), 1024);
    // A live link is ours iff its target is ours; a dangling one is ours iff it
    // still names our stub.
    if (head !== undefined) return head.includes(SHIM_MARKER);
    const target = basename(link);
    return target === PROXY_STUB_NAME || target === stubNameFor(binName);
  }

  if (!entry.isFile()) return false;

  const head = await readHead(file, 1024);
  if (head === undefined) return false;
  if (head.includes(SHIM_MARKER)) return true;
  return (
    WIN32_WRAPPER_HEADS.some((start) => head.startsWith(start)) &&
    head.includes(stubNameFor(binName))
  );
}
/**
 * One entry `enable` moved out of the way.
 *
 * §15.15 asks for "path, type, and for a symlink its target". A *regular file*
 * needs one thing more to be restorable: its content. Recording a type alone
 * would let `disable` recreate an empty stand-in, which is worse than not
 * restoring at all — so the file itself is parked under `<home>/displaced/` and
 * the record names it. Its mode rides along, or the restored binary would come
 * back non-executable.
 */
export interface DisplacedEntry {
  path: string;
  type: "symlink" | "file";
  /** Symlinks: the link target, verbatim (it may be relative). */
  target?: string;
  /** Regular files: where the content is parked. */
  backup?: string;
  /** Regular files: the permission bits to restore. */
  mode?: number;
}

interface DisplacedRecord {
  version: number;
  displaced: DisplacedEntry[];
}

function displacedRecordPath(): string {
  return join(getHomeFolder(), DISPLACED_RECORD_NAME);
}

/**
 * §15.15 — is this parsed object an entry `disable` may act on?
 *
 * The record is a plain JSON file in `<home>`, and `disable` turns it straight
 * into filesystem operations: `symlink(target, path)`, `rename(backup, path)`,
 * `chmod(path, mode)`. Trusting its shape means an unvalidated `mode` reaching
 * `chmodSync` — `0o4755` on a path of the record's choosing — and a `backup`
 * pointing anywhere on the disk. None of that needs a hostile author: a
 * truncated write or a hand-edit is enough to make `disable` do something the
 * user cannot see coming.
 *
 * So every field is checked against what {@link displace} can actually have
 * written: absolute paths, a `backup` inside `<home>/displaced/`, and a mode
 * that is permission bits and nothing else — setuid, setgid and the sticky bit
 * are never restored, because `displace` never records them.
 */
function isValidDisplacedEntry(value: unknown): value is DisplacedEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;

  if (typeof entry.path !== "string" || !isAbsolute(entry.path)) return false;

  if (entry.type === "symlink") {
    return typeof entry.target === "string" && entry.target !== "";
  }

  if (entry.type !== "file") return false;
  if (typeof entry.backup !== "string" || !isAbsolute(entry.backup)) return false;
  // The only place `displace` parks content. A `backup` outside it was not
  // written by us, and restoring from it would move a file we never saved.
  const parked = join(getHomeFolder(), DISPLACED_BACKUP_DIR);
  if (dirname(resolvePath(entry.backup)) !== resolvePath(parked)) return false;

  return (
    entry.mode === undefined ||
    (typeof entry.mode === "number" &&
      Number.isInteger(entry.mode) &&
      entry.mode === (entry.mode & 0o777))
  );
}

export function readDisplacedRecord(): DisplacedEntry[] {
  let raw: string;
  try {
    raw = readFileSync(displacedRecordPath(), "utf8");
  } catch {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as DisplacedRecord;
    if (!Array.isArray(parsed.displaced)) return [];
    // A single malformed entry is dropped rather than failing the file: the rest
    // of the record is still restorable, and §15.15 asks us to continue.
    return parsed.displaced.filter((entry) => isValidDisplacedEntry(entry));
  } catch {
    // A corrupt record is not a reason to refuse to disable; it only means there
    // is nothing we can put back.
    return [];
  }
}

function writeDisplacedRecord(entries: DisplacedEntry[]): void {
  const file = displacedRecordPath();
  if (entries.length === 0) {
    rmSync(file, { force: true });
    return;
  }
  mkdirSync(dirname(file), { recursive: true });
  const record: DisplacedRecord = { version: 1, displaced: entries };
  writeFileSync(file, `${JSON.stringify(record, undefined, 2)}\n`);
}

/**
 * Append to the record.
 *
 * Deliberately synchronous: `enable` processes every binary name concurrently
 * (§10.5), and a sync read-modify-write cannot be interleaved by another
 * microtask, so no lock is needed for the in-process race that actually exists.
 */
function appendDisplaced(entry: DisplacedEntry): void {
  const entries = readDisplacedRecord().filter((existing) => existing.path !== entry.path);
  entries.push(entry);
  writeDisplacedRecord(entries);
}

let backupCounter = 0;

function backupPathFor(file: string): string {
  const dir = join(getHomeFolder(), DISPLACED_BACKUP_DIR);
  mkdirSync(dir, { recursive: true });
  const suffix = `${Date.now().toString(36)}-${process.pid.toString(36)}-${backupCounter++}`;
  return join(dir, `${basename(file)}-${suffix}`);
}

/**
 * §15.15 — move an entry that is not ours out of the way, recording enough to
 * put it back.
 *
 * Record every displaced foreign entry, including symlinks replaced without
 * `--force`. Returns `true` when the entry has already been removed from `file`.
 */
async function displace(file: string, stats: Stats, installDirectory: string): Promise<boolean> {
  if (stats.isSymbolicLink()) {
    const target = await readlink(file).catch(() => undefined);
    if (target !== undefined) appendDisplaced({ path: file, type: "symlink", target });
    return false;
  }

  if (!stats.isFile()) return false;

  const backup = backupPathFor(file);
  await guardWrites(installDirectory, async () => {
    try {
      await rename(file, backup);
    } catch (error) {
      // A rename across devices cannot work; a copy can.
      if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
      copyFileSync(file, backup);
      await unlink(file);
    }
  });

  appendDisplaced({ path: file, type: "file", backup, mode: stats.mode & 0o777 });
  return true;
}

/**
 * §15.15 — put back whatever `enable` displaced at these paths, then forget it.
 *
 * "If a recorded entry can no longer be restored, say so and continue": every
 * failure warns and the entry is dropped, so a second `disable` does not repeat
 * an unactionable warning.
 */
export function restoreDisplaced(installDirectory: string, files: string[]): number {
  const wanted = new Set(files.map((file) => basename(file)));
  const entries = readDisplacedRecord();

  const kept: DisplacedEntry[] = [];
  let restored = 0;

  for (const entry of entries) {
    if (!wanted.has(basename(entry.path)) || !samePath(dirname(entry.path), installDirectory)) {
      kept.push(entry);
      continue;
    }

    const failure = restoreOne(entry);
    if (failure !== undefined) advisory(restoreFailed(entry.path, failure));
    else restored++;
  }

  if (kept.length !== entries.length) writeDisplacedRecord(kept);
  return restored;
}

function restoreOne(entry: DisplacedEntry): string | undefined {
  if (lstatSync(entry.path, { throwIfNoEntry: false }) !== undefined) {
    return `something else now occupies that path`;
  }

  try {
    if (entry.type === "symlink") {
      if (entry.target === undefined) return `the recorded link target is missing`;
      symlinkSync(entry.target, entry.path);
      return undefined;
    }

    if (entry.backup === undefined || !existsSync(entry.backup)) {
      return `the saved copy is no longer in the store`;
    }
    try {
      renameSync(entry.backup, entry.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
      copyFileSync(entry.backup, entry.path);
      rmSync(entry.backup, { force: true });
    }
    if (entry.mode !== undefined) chmodSync(entry.path, entry.mode);
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
}
/**
 * §10.2 — POSIX shims are relative symlinks, created with `lstat` (not `stat`,
 * so a dangling symlink is seen as a symlink) and **idempotent**: an
 * already-correct link is not rewritten and its mtime is unchanged.
 *
 * §14.16: refuse to replace a regular file that is not one of our own shims
 * unless `--force`. Yarn Switch then falls out of the general rule rather than
 * being a hard-coded exception — both are "this entry is not ours to touch",
 * both warn on stderr, both leave the entry alone, and both exit 0.
 *
 * Returns the installed shim's path, or `undefined` when the name was skipped —
 * §15.29 only verifies the names it actually wrote.
 */
export async function generatePosixLink(
  installDirectory: string,
  distFolder: string,
  binName: string,
  options: ShimOptions = {},
  interpreter?: string,
): Promise<string | undefined> {
  const stub = await ensureStub(distFolder, undefined, interpreter);
  const file = join(installDirectory, binName);
  const target = relative(installDirectory, stub);

  // Use lstat so a dangling symlink is handled as a link rather than an absent
  // path that later fails with EEXIST.
  const existing = await lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });

  if (existing !== undefined) {
    const ours = await isOurEntry(file, binName, existing);

    if (ours) {
      if (existing.isSymbolicLink() && (await readlink(file).catch(() => undefined)) === target) {
        // Already correct: no write, so the mtime does not move (test 122).
        return file;
      }
    } else {
      if (!options.force) {
        if (await isYarnSwitch(binName, file)) {
          // This compatibility message is not suppressed with advisories.
          console.warn(messages.yarnSwitchSkip(binName, file));
          return undefined;
        }
        // Symlinks are ours to manage — §10.2 corrects one that points elsewhere.
        // Anything else without our marker is a real binary and stays put.
        if (!existing.isSymbolicLink()) {
          advisory(messages.shimNotOurs(binName, file));
          return undefined;
        }
      }

      // §15.15 — whatever we are about to overwrite is somebody else's; record
      // it so `disable` can put it back.
      if (await displace(file, existing, installDirectory)) {
        await guardWrites(installDirectory, () => symlink(target, file));
        return file;
      }
    }

    await guardWrites(installDirectory, () => unlink(file));
  }

  await guardWrites(installDirectory, () => symlink(target, file));
  return file;
}

/**
 * §10.6 + §15.15 — POSIX removal: the Yarn Switch guard, then removal of the
 * entry **only if we created it**, then `unlink` with `ENOENT` ignored.
 *
 * `--force` requests unconditional removal.
 */
export async function removePosixLink(
  installDirectory: string,
  binName: string,
  options: ShimOptions = {},
): Promise<void> {
  const file = join(installDirectory, binName);

  const existing = await lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existing === undefined) return;

  if (!options.force) {
    if (await isYarnSwitch(binName, file)) {
      // This compatibility message is not suppressed with advisories.
      console.warn(messages.yarnSwitchSkip(binName, file));
      return;
    }
    // Leave entries not created by this tool alone.
    if (!(await isOurEntry(file, binName, existing))) return;
  }

  await guardWrites(installDirectory, () =>
    unlink(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    }),
  );
}
/**
 * The `.cmd` body of §10.3, byte for byte.
 *
 * The double spaces are real — an empty interpolated argument slot — and the
 * `PATHEXT` line drops `.JS` from the executable-extension list so that `node`
 * resolves to `node.exe` instead of recursing into a `node.js` file.
 *
 * **The fallback branch names the interpreter by absolute path.** `cmd.exe`
 * resolves a bare name from the current directory first, which could execute a
 * repository-controlled `node.bat`, `node.cmd`, or `node.exe`. The baked path
 * also prevents recursion after `enable node` claims `node` on `PATH`.
 *
 * The `%~dp0\\node.exe` branch is kept: it costs nothing, and it is what keeps a
 * shim directory that *is* the Node install directory relocatable.
 */
function win32CmdSource(rel: string, interpreter: string): string {
  const windowsRel = rel.replaceAll("/", "\\");
  return [
    `@SETLOCAL`,
    `@IF EXIST "%~dp0\\node.exe" (`,
    `  "%~dp0\\node.exe"  "%~dp0\\${windowsRel}" %*`,
    `) ELSE (`,
    `  @SET PATHEXT=%PATHEXT:;.JS;=;%`,
    `  "${interpreter}"  "%~dp0\\${windowsRel}" %*`,
    `)`,
    ``,
  ].join("\n");
}

/**
 * The extensionless sh body of §10.3, for Git Bash / MSYS / Cygwin.
 *
 * The fallback is absolute for the same reason the `.cmd`'s is — a bare `node`
 * under Git Bash finds `<shimdir>/node`, this very file, once `enable node` has
 * run — with the separators flipped, which is the spelling those shells accept
 * for a Windows path.
 */
function win32ShSource(rel: string, interpreter: string): string {
  const posixRel = rel.replaceAll("\\", "/");
  const posixInterpreter = interpreter.replaceAll("\\", "/");
  return [
    `#!/bin/sh`,
    `basedir=$(dirname "$(echo "$0" | sed -e 's,\\\\,/,g')")`,
    ``,
    `case \`uname\` in`,
    `    *CYGWIN*) basedir=\`cygpath -w "$basedir"\`;;`,
    `esac`,
    ``,
    `if [ -x "$basedir/node" ]; then`,
    `  exec "$basedir/node"  "$basedir/${posixRel}" "$@"`,
    `else`,
    `  exec "${posixInterpreter}"  "$basedir/${posixRel}" "$@"`,
    `fi`,
    ``,
  ].join("\n");
}

/**
 * The `.ps1` body of §10.3.
 *
 * `$exe` still decides the extension for the `$basedir` branch; the fallback
 * takes the absolute path instead, which already carries its own.
 */
function win32Ps1Source(rel: string, interpreter: string): string {
  const posixRel = rel.replaceAll("\\", "/");
  return [
    `#!/usr/bin/env pwsh`,
    `$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent`,
    ``,
    `$exe=""`,
    `if ($PSVersionTable.PSVersion -lt "6.0" -or $IsWindows) {`,
    `  # Fix case when both the Windows and Linux builds of Node`,
    `  # are installed in the same directory`,
    `  $exe=".exe"`,
    `}`,
    `$ret=0`,
    `if (Test-Path "$basedir/node$exe") {`,
    `  # Support pipeline input`,
    `  if ($MyInvocation.ExpectingInput) {`,
    `    $input | & "$basedir/node$exe"  "$basedir/${posixRel}" $args`,
    `  } else {`,
    `    & "$basedir/node$exe"  "$basedir/${posixRel}" $args`,
    `  }`,
    `  $ret=$LASTEXITCODE`,
    `} else {`,
    `  if ($MyInvocation.ExpectingInput) {`,
    `    $input | & "${interpreter}"  "$basedir/${posixRel}" $args`,
    `  } else {`,
    `    & "${interpreter}"  "$basedir/${posixRel}" $args`,
    `  }`,
    `  $ret=$LASTEXITCODE`,
    `}`,
    `exit $ret`,
    ``,
  ].join("\n");
}

/**
 * §10.3 — three files per binary name, all `0o755`, all written
 * **unconditionally**: there is no idempotency short-circuit on Windows, and no
 * Yarn Switch check either (§10.2 makes that check POSIX-only).
 *
 * §14.16 and §15.15 do still apply here — "unconditionally" in §10.3 is about
 * not short-circuiting on our *own* files, not a licence to delete somebody
 * else's `yarn.cmd`.
 *
 * Platform-independent on purpose, so Windows shims can be produced — and
 * tested — from a POSIX machine.
 */
export async function generateWin32Link(
  installDirectory: string,
  distFolder: string,
  binName: string,
  options: ShimOptions = {},
  interpreter: string = requireInterpreterPath(),
): Promise<string | undefined> {
  // The stub's own shebang is dead weight on Windows — every one of the three
  // wrappers names an interpreter itself — so it is left generic and the
  // wrappers carry the resolved path.
  const stub = await ensureStub(distFolder, binName);
  const file = join(installDirectory, binName);
  const rel = relative(installDirectory, stub);

  const files = [
    [file, win32ShSource(rel, interpreter)],
    [`${file}.cmd`, win32CmdSource(rel, interpreter)],
    [`${file}.ps1`, win32Ps1Source(rel, interpreter)],
  ] as const;

  // §14.16 — decide for the whole binary name before writing any of the three,
  // so a refusal never leaves two of our wrappers beside somebody else's third.
  for (const [path] of files) {
    const existing = await lstat(path).catch(() => undefined);
    if (existing === undefined) continue;
    if (await isOurEntry(path, binName, existing)) continue;
    if (!options.force) {
      advisory(messages.shimNotOurs(binName, path));
      return undefined;
    }
  }

  for (const [path] of files) {
    const existing = await lstat(path).catch(() => undefined);
    if (existing === undefined) continue;
    if (await isOurEntry(path, binName, existing)) continue;
    await displace(path, existing, installDirectory);
  }

  await guardWrites(installDirectory, async () => {
    for (const [path, source] of files) {
      // Remove first rather than writing through a symlink. Otherwise writeFile
      // may modify its target or fail when a stale target is absent.
      await unlink(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      await writeFile(path, source);
      await chmod(path, 0o755);
    }
  });

  return file;
}

/** §10.6 + §15.15 — Windows removal: all three files, ours only, `ENOENT` ignored. */
export async function removeWin32Link(
  installDirectory: string,
  binName: string,
  options: ShimOptions = {},
): Promise<void> {
  await guardWrites(installDirectory, async () => {
    for (const extension of WIN32_EXTENSIONS) {
      const file = join(installDirectory, `${binName}${extension}`);
      const existing = await lstat(file).catch(() => undefined);
      if (existing === undefined) continue;
      // No Yarn Switch check here — §10.2 makes it POSIX-only — but §15.15's
      // "only what we created" holds on every platform.
      if (!options.force && !(await isOurEntry(file, binName, existing))) continue;
      await unlink(file).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  });
}
type Shell = "posix" | "fish" | "csh" | "powershell" | "cmd";

/** Which shell is the user most likely typing into right now? */
export function detectShell(): Shell {
  const shell = process.env[SYSTEM_ENV.SHELL];
  if (shell !== undefined && shell !== "") {
    const name = basename(shell).replace(/\.exe$/i, "");
    if (name === "fish") return "fish";
    if (name === "csh" || name === "tcsh") return "csh";
    if (name === "pwsh" || name === "powershell") return "powershell";
    return "posix";
  }

  if (process.platform === "win32") {
    // PowerShell exports this; `cmd.exe` does not.
    return process.env[SYSTEM_ENV.PSMODULEPATH] !== undefined ? "powershell" : "cmd";
  }

  return "posix";
}

/** §15.13 point 3 — the exact line to add, for the detected shell. */
export function pathExportLine(directory: string, shell: Shell = detectShell()): string {
  switch (shell) {
    case "fish":
      return `fish_add_path ${directory}`;
    case "csh":
      return `setenv PATH "${directory}:$PATH"`;
    case "powershell":
      return `$env:PATH = "${directory};$env:PATH"`;
    case "cmd":
      return `set PATH=${directory};%PATH%`;
    default:
      return `export PATH="${directory}:$PATH"`;
  }
}

/**
 * Is `directory` named by an entry of `PATH`?
 *
 * Only an **absolute** entry counts (§15.13 point 6). An empty entry means the
 * current directory and a relative one means a directory that moves with it;
 * neither puts anything durably on `PATH`, and `samePath` resolves a relative
 * entry against the cwd — so without this a `PATH` of `bin` would report `~/bin`
 * as on `PATH` for any process that happened to be sitting in `$HOME`.
 */
function directoryOnPath(directory: string): boolean {
  for (const entry of (process.env[SYSTEM_ENV.PATH] ?? "").split(delimiter)) {
    if (entry !== "" && isAbsolute(entry) && samePath(entry, directory)) return true;
  }
  return false;
}

/**
 * §15.29 — `enable` verifies its own post-condition.
 *
 * Distinguish an install directory absent from `PATH` from a name shadowed by an
 * earlier entry. The directory-level warning subsumes per-name warnings.
 *
 * Exit code stays 0: these are warnings, not failures.
 */
export function verifyOnPath(installDirectory: string, installed: [string, string][]): void {
  if (!directoryOnPath(installDirectory)) {
    advisory(shimDirectoryNotOnPath(installDirectory));
    return;
  }

  let shadowed = false;
  for (const [binName, shim] of installed) {
    const resolved = whichFile(binName);
    // Nothing on `PATH` at all is not a shadowing report; the directory *is* on
    // `PATH`, so this only happens for an entry we did not install.
    if (resolved === undefined) continue;
    if (samePath(dirname(resolved), installDirectory)) continue;
    advisory(shimShadowed(binName, resolved, shim));
    shadowed = true;
  }

  if (shadowed) advisory(rehashNotice());
}
/**
 * §10.1 — does this install directory put our own shim on the name the shebang
 * would look up?
 *
 * True when the run is claiming it, and true when an earlier run already did:
 * the stub is shared by every name, so a `yarn` shim installed *after*
 * `enable node` would otherwise still go through `env node` and land back on the
 * `node` shim, which then re-enters us with the proxy stub as its argument.
 * A foreign `node` sitting in the directory is not our problem and does not
 * count — treating it as one would rewrite the stub for people who never asked
 * for a `node` shim at all.
 */
async function claimsInterpreter(installDirectory: string, binaries: string[]): Promise<boolean> {
  if (binaries.includes(INTERPRETER_NAME)) return true;
  const file = join(installDirectory, INTERPRETER_NAME);
  const stats = await lstat(file).catch(() => undefined);
  return stats !== undefined && (await isOurEntry(file, INTERPRETER_NAME, stats));
}

/**
 * §10 — install the shims. Idempotent, and exits 0 with empty stdout and stderr
 * on success. A skipped entry — Yarn Switch, or §14.16's foreign binary — warns
 * on stderr and still exits 0: it is a warning, not a failure. So do §15.13's
 * fallback and §15.29's verification.
 *
 * `distFolder` is a seam for the tests; production always uses our own folder.
 */
export async function cmdEnable(
  args: string[],
  distFolder: string = resolveStubFolder(),
): Promise<number> {
  const { options, names, exclude } = parseShimArgs(args);
  // Validate before touching the filesystem, so a bad name reports itself even
  // when the install directory cannot be resolved (§12.9).
  const binaries = targetBinaries(names, exclude);
  // §15.13 — choose, announce, probe, then fall back; nothing is written before
  // the directory is known to be writable.
  const choice = chooseInstallDirectory(options);
  if (choice.preferredOver !== undefined) {
    advisory(shimDirectoryPreferred(choice.preferredOver, choice.directory));
  }
  // Point 2's fallback is where a *bare* `enable` would have gone. When nothing
  // was named that is the directory just chosen, and when something was, the
  // thunk only runs if that directory turned out to be unwritable — so the
  // selection, and the probe inside it, happens exactly once per `enable`.
  //
  // `--system` is point 8's exception and returns *itself*, which
  // `prepareInstallDirectory` turns into a refusal: the user named a scope, not
  // a directory, and quietly delivering the other scope is the failure mode this
  // flag exists to remove. A `RUN jup enable --system` layer that fell back to
  // `~/.local/bin` would exit 0 and ship an image whose shims nothing can find,
  // with the diagnosis deferred to a `pnpm: not found` in some later build.
  const installDirectory = prepareInstallDirectory(choice.directory, () =>
    choice.named === true && options.system !== true
      ? chooseInstallDirectory({}).directory
      : choice.directory,
  );

  const generate = process.platform === "win32" ? generateWin32Link : generatePosixLink;
  // §10.1 — Windows always bakes the path in (the bare `node` its wrappers used
  // to name is resolved from the *current directory* first); POSIX only needs to
  // when this directory claims the interpreter's own name, and paying for it
  // otherwise would rewrite the shipped stub and break §10.7's read-only
  // `distFolder`.
  //
  // §15.43 — `requireInterpreterPath` refuses rather than falling back when the
  // only runtime in sight is one of ours. Nothing is written yet, so the failure
  // leaves both directories exactly as they were; the alternatives would be a
  // shebang that execs itself (§14.26) or one `cache clean` invalidates.
  const claimsName = await claimsInterpreter(installDirectory, binaries);
  const interpreter =
    process.platform === "win32" || claimsName ? requireInterpreterPath() : undefined;

  // §15.46 — the same pin goes into our own CLI entry, but **not** under the
  // wrapper's "always on Windows" condition: under the *stub's*. The recursion
  // §15.46 removes is `#!/usr/bin/env node` finding our own shim, and only a run
  // that claims the interpreter's name can put a shim there. Windows never reads
  // that shebang at all — `jup.cmd` is npm's cmd-shim and invokes the runtime
  // itself — so pinning there buys nothing and costs everything: `enable yarn`
  // against an admin-owned or read-only package directory (Chocolatey, Scoop,
  // `C:\Program Files`, a container image) would fail `cliEntryNotWritable` with
  // no shims written, and that message's remedy — stop claiming the name — is
  // inert when the platform is the trigger.
  //
  // Before any shim is written, so a refusal here leaves the shim directory
  // exactly as it found it — the ordering §15.45 gives the execute-bit check.
  if (claimsName && interpreter !== undefined) await pinCliEntry(distFolder, interpreter);

  // §10.5 — all binaries are processed concurrently.
  const installed = await Promise.all(
    binaries.map(async (binName): Promise<[string, string] | undefined> => {
      const shim = await generate(installDirectory, distFolder, binName, options, interpreter);
      return shim === undefined ? undefined : [binName, shim];
    }),
  );

  verifyOnPath(
    installDirectory,
    installed.filter((entry) => entry !== undefined),
  );

  return 0;
}

/**
 * §10.6 — removes only the names it was asked about, and within those only the
 * entries it created (§15.15); `disable yarn` also removes `yarnpkg`. Anything
 * `enable` displaced is then put back.
 *
 * The §15.46 pin remains because reverting it requires writing to the commonly
 * read-only ${TOOL_NAME} package directory and could leave a partial disable.
 * Re-running `enable` refreshes it.
 */
export async function cmdDisable(args: string[]): Promise<number> {
  const { options, names, exclude } = parseShimArgs(args);
  // `includeOptOut` — removal covers every name the tool can install, including
  // the §15.28 entries a bare `enable` leaves alone. Otherwise `jup disable`
  // would silently decline to undo a `jup enable bun`, which is the one thing a
  // no-argument disable is for.
  const binaries = targetBinaries(names, exclude, { includeOptOut: true });
  // §10.4 — no realpath here: removal needs no relative-path computation.
  const installDirectory = resolveInstallDirectory(options, false);

  await Promise.all(
    binaries.map((binName) =>
      process.platform === "win32"
        ? removeWin32Link(installDirectory, binName, options)
        : removePosixLink(installDirectory, binName, options),
    ),
  );

  // §15.15 — restore *after* removal, so the recorded path is free again. On
  // Windows a name occupies three files, and each was recorded separately.
  const files =
    process.platform === "win32"
      ? binaries.flatMap((binName) =>
          WIN32_EXTENSIONS.map((extension) => join(installDirectory, `${binName}${extension}`)),
        )
      : binaries.map((binName) => join(installDirectory, binName));
  restoreDisplaced(installDirectory, files);

  return 0;
}
