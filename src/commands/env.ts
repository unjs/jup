/**
 * `jup env` — shell integration for the runtimes, §09.18.
 *
 * The one property this command cannot violate is agreement: the `node` it puts
 * on `PATH` must be the `node` `jup node` would hand over. The resolution
 * therefore reuses the proxy path's own primitives from `main.ts`, in §01.3's
 * order, rather than restating them.
 */

const { basename, delimiter, dirname, isAbsolute, join } = process.getBuiltinModule("node:path");
const { realpathSync } = process.getBuiltinModule("node:fs");
import { ENV, envSpellings, SYSTEM_ENV } from "../config/env-vars.ts";
import { getTableSpec, isRuntime, resolveSpecBin, SUPPORTED_NAMES } from "../config/table.ts";
import { findProjectSpec, reconcile } from "../project/manifest.ts";
import { getFallbackLocator, resolveSpec } from "../version/resolve.ts";
import { readKnownResolution } from "../project/lockfile.ts";
import { isInsideInstallFolder, readInstalledSpec } from "../cache/store.ts";
import { messages, UsageError } from "../errors-cold.ts";
import { parse } from "../version/semver.ts";
import { out } from "../utils/log.ts";
import { runCwd, runEnv } from "../utils/context.ts";
import { materialise, resolutionDirFor, resolveExactPin } from "../main.ts";
import { firstValue, hasFlag, parseArgs } from "./cli.ts";

/**
 * One runtime's answer. `reference: null` is a failed resolution, carried as a
 * value because both views degrade rather than die (§09.18).
 */
export interface RuntimeEnvironment {
  name: string;
  reference: string | null;
  /** The runtime's own executables, or `null` when the version is not installed. */
  binDir: string | null;
  installed: boolean;
  error?: string;
}

/** Resolve every runtime in the table as a run of it from `cwd` would. */
export async function resolveRuntimeEnvironments(cwd: string): Promise<RuntimeEnvironment[]> {
  const resolved: RuntimeEnvironment[] = [];
  for (const name of SUPPORTED_NAMES) {
    if (!isRuntime(name)) continue;
    try {
      resolved.push(await resolveRuntimeEnvironment(cwd, name));
    } catch (error) {
      resolved.push({
        name,
        reference: null,
        binDir: null,
        installed: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return resolved;
}

/**
 * §01.3 steps 3–6 for one runtime, minus auto-pin, the install and the
 * handover. The expired memo is deliberately not used as a stale answer
 * (§09.18): where the store cannot confirm, the shims stay authoritative.
 */
async function resolveRuntimeEnvironment(cwd: string, name: string): Promise<RuntimeEnvironment> {
  const specResult = findProjectSpec(cwd, { projectSpecFlag: true, tool: name });
  const fallback = getFallbackLocator(name, { transparent: false, project: specResult });
  const reconciled = reconcile(specResult, fallback, { requestedName: name, transparent: false });
  const descriptor = await materialise(reconciled);

  const projectDir = resolutionDirFor(specResult, reconciled, descriptor, undefined);
  const known =
    (projectDir === undefined ? null : readKnownResolution(projectDir, descriptor).locator) ??
    resolveExactPin(descriptor);
  const locator = known ?? (await resolveSpec(descriptor, { allowTags: true }));
  if (locator === null) throw new UsageError(messages.failedToResolve(descriptor.range, name));

  // A custom URL pin (§04.1 step 1) has no store marker to probe; the shims own it.
  const installed = parse(locator.reference) === null ? null : readInstalledSpec(locator);

  // §08.1 — the marker's `bin` map, with the table's entry standing in (§07.10).
  const tableSpec = getTableSpec(locator);
  const bin = installed?.bin ?? (tableSpec === undefined ? undefined : resolveSpecBin(tableSpec));
  const entry = bin?.[name];

  return {
    name,
    reference: locator.reference,
    binDir:
      installed !== null && entry !== undefined ? dirname(join(installed.location, entry)) : null,
    installed: installed !== null,
  };
}

/** Single-quote for sh-family shells: no expansion, no splitting. */
function shQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Single-quote for fish, where `\\` and `\'` are the two escapes inside quotes. */
function fishQuote(value: string): string {
  return `'${value.replace(/[\\']/g, "\\$&")}'`;
}

/** Single-quote for PowerShell, which also ends a string on the typographic quotes. */
function psQuote(value: string): string {
  return `'${value.replace(/['‘’‚‛]/g, "$&$&")}'`;
}

/**
 * §09.18 — each dialect's `PATH` line, and its `--use-on-cd` registration given
 * the command that prints that line. The list separator is the host's
 * (`path.delimiter`) in every dialect: PowerShell on POSIX uses `:` too.
 *
 * Each hook calls the base command (no `--use-on-cd`), runs once per directory
 * change, and registers idempotently, so evaluating the block twice hooks once.
 */
interface Dialect {
  quote: (value: string) => string;
  line: (entries: string[]) => string;
  hook: (jup: string) => string;
}

const posixLine = (entries: string[]) => `export PATH=${shQuote(entries.join(delimiter))}`;

const DIALECTS: Record<ShellDialect, Dialect> = {
  zsh: {
    quote: shQuote,
    line: posixLine,
    hook: (jup) => `_jup_env() {
  eval "$(${jup} env --shell zsh 2>/dev/null)"
}
autoload -Uz add-zsh-hook
add-zsh-hook -D chpwd _jup_env
add-zsh-hook chpwd _jup_env
`,
  },
  // `PROMPT_COMMAND` runs before every prompt, so the function gates on the
  // directory having changed. The entry is appended on its own line: a value
  // ending in `;` would otherwise become `;;`, a syntax error on every prompt.
  bash: {
    quote: shQuote,
    line: posixLine,
    hook: (jup) => `_jup_env() {
  [[ $PWD == "\${_JUP_ENV_PWD-}" ]] && return
  _JUP_ENV_PWD=$PWD
  eval "$(${jup} env --shell bash 2>/dev/null)"
}
_JUP_ENV_PWD=$PWD
case \${PROMPT_COMMAND-} in
*_jup_env*) ;;
*) PROMPT_COMMAND="\${PROMPT_COMMAND:+$PROMPT_COMMAND
}_jup_env" ;;
esac
`,
  },
  fish: {
    quote: fishQuote,
    line: (entries) => `set -gx PATH ${entries.map(fishQuote).join(" ")}`,
    hook: (jup) => `function _jup_env --on-variable PWD
  ${jup} env --shell fish 2>/dev/null | source
end
`,
  },
  // No directory-change hook exists, so `prompt` is wrapped, gated on the
  // location having moved; the sentinel keeps a re-evaluation from wrapping
  // the wrapper.
  powershell: {
    quote: psQuote,
    line: (entries) => `$env:PATH = ${psQuote(entries.join(delimiter))}`,
    hook: (jup) => `if ($null -eq $global:__JUP_ORIG_PROMPT) {
  $global:__JUP_ORIG_PROMPT = $function:prompt
}
$global:__JUP_PWD = $PWD.Path
function global:prompt {
  if ($global:__JUP_PWD -ne $PWD.Path) {
    $global:__JUP_PWD = $PWD.Path
    & ${jup} env --shell powershell 2>$null | Out-String | Invoke-Expression
  }
  & $global:__JUP_ORIG_PROMPT
}
`,
  },
};

type ShellDialect = "bash" | "zsh" | "fish" | "powershell";

function isDialect(name: string): name is ShellDialect {
  return Object.hasOwn(DIALECTS, name);
}

/** Shells that run the POSIX `export` spelling, answered as `bash`. */
const POSIX_SHELLS = new Set(["sh", "bash", "dash", "ksh", "mksh", "ash"]);

/**
 * §11.5 — the dialect `SHELL` names when `--shell` is absent, and on Windows
 * PowerShell by `PSModulePath`, as `enable`'s hint detects it. A name outside
 * the four (csh, nu, …) comes back as itself, for the caller to refuse.
 */
function inferShell(): string | undefined {
  const env = runEnv();
  const shell = env[SYSTEM_ENV.SHELL];
  if (shell !== undefined && shell !== "") {
    const name = basename(shell)
      .replace(/^-+/, "")
      .replace(/\.exe$/i, "")
      .toLowerCase();
    if (POSIX_SHELLS.has(name)) return "bash";
    return name === "pwsh" ? "powershell" : name;
  }
  if (process.platform === "win32" && env[SYSTEM_ENV.PSMODULEPATH] !== undefined) {
    return "powershell";
  }
  return undefined;
}

/**
 * Is this `PATH` entry inside the install folder, spelled literally or through
 * a symlinked home? Only absolute entries are candidates: a relative one (`.`,
 * `node_modules/.bin`) means something different in every directory and was
 * never put there by this command.
 */
function isStorePathEntry(entry: string): boolean {
  if (!isAbsolute(entry)) return false;
  if (isInsideInstallFolder(entry)) return true;
  try {
    return isInsideInstallFolder(realpathSync(entry));
  } catch {
    return false;
  }
}

/**
 * The words that run this jup, for the hook body: the §10.2 host runtime and
 * this entry's realpath. A bare `jup` would start under whatever `node` the
 * line just put on `PATH`, which may be too old to run jup at all. Falls back
 * to `jup` when this is not the CLI (an embedder's `runMain`) or no runtime
 * outside the store can be named.
 */
async function selfCommand(handover: boolean): Promise<string[] | undefined> {
  const entry = process.argv[1];
  if (!handover || entry === undefined) return undefined;
  const { interpreterPath } = await import("./shims.ts");
  const runtime = interpreterPath();
  if (runtime === undefined) return undefined;
  try {
    return [runtime, realpathSync(entry)];
  } catch {
    return undefined;
  }
}

/** The `--json` document's shape version, as `info`'s report has one (§09.9). */
const ENV_REPORT_VERSION = 1;

/** §09.18 — print, for `eval`, the one `PATH` assignment for this directory. */
export async function cmdEnv(args: string[], handover = false): Promise<number> {
  const parsed = parseArgs(args, {
    booleans: ["--json", "--use-on-cd"],
    strings: ["--shell"],
  });
  if (parsed.positionals.length > 0) {
    throw new UsageError(`The 'jup env' command takes no arguments`);
  }

  const json = hasFlag(parsed, "--json");
  const useOnCd = hasFlag(parsed, "--use-on-cd");
  const requested = firstValue(parsed, "--shell");
  if (json && requested !== undefined) {
    throw new UsageError(`The 'jup env' command cannot take --json and --shell together`);
  }
  if (json && useOnCd) {
    throw new UsageError(`The 'jup env' command cannot take --json and --use-on-cd together`);
  }

  if (json) {
    const runtimes = await resolveRuntimeEnvironments(runCwd());
    out(`${JSON.stringify({ version: ENV_REPORT_VERSION, runtimes })}\n`);
    return 0;
  }

  // Validated before any resolution work, so a typo fails fast.
  const shell = requested ?? inferShell();
  if (shell === undefined) {
    throw new UsageError(
      `jup env cannot tell which shell to target; pass --shell (bash, zsh, fish or powershell)`,
    );
  }
  if (!isDialect(shell)) {
    throw new UsageError(
      `Unsupported shell "${shell}"; jup env supports bash, zsh, fish and powershell`,
    );
  }
  const dialect = DIALECTS[shell];

  // The line runs from a shell hook on every directory change, so it never
  // waits on the registry: a version only the network could name is not in
  // the store either, and the shims answer it on demand (§09.18).
  //
  // Set in place, never on a spread copy: under the CLI this is `process.env`,
  // whose keys are case-insensitive on Windows, where `PATH` is spelled `Path`
  // and a plain copy would answer `undefined` for it. A scoped run's
  // environment is already its own copy (`run/scoped.ts`). `PATH` is read
  // first, before the env-file merge (§03.2) replaces the object.
  const env = runEnv();
  const path = env[SYSTEM_ENV.PATH];
  for (const spelling of envSpellings(ENV.ENABLE_NETWORK)) env[spelling] = "0";

  // A failed resolution still prints the strip, so whatever a previous
  // directory put on `PATH` comes off and the shims answer instead.
  const runtimes = await resolveRuntimeEnvironments(runCwd());
  const binDirs = runtimes.flatMap((runtime) => (runtime.binDir === null ? [] : [runtime.binDir]));

  const kept = path ? path.split(delimiter).filter((entry) => !isStorePathEntry(entry)) : [];
  const entries = [...binDirs, ...kept];
  // `export PATH=''` would leave the shell with nothing to run, so an empty
  // result prints nothing; the hook is still registered.
  if (entries.length > 0) out(`${dialect.line(entries)}\n`);

  if (useOnCd) {
    const self = await selfCommand(handover);
    out(dialect.hook(self === undefined ? "jup" : self.map(dialect.quote).join(" ")));
  }
  return 0;
}
