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
import {
  getTableSpec,
  isRuntime,
  resolveSpecBin,
  runsAsRuntime,
  SUPPORTED_NAMES,
} from "../config/table.ts";
import { findProjectSpec, reconcile } from "../project/manifest.ts";
import { getFallbackLocator, resolveSpec } from "../version/resolve.ts";
import { readKnownResolution } from "../project/lockfile.ts";
import { isDefaultFresh, isInsideInstallFolder, readInstalledSpec } from "../cache/store.ts";
import { shimDirectoryFor } from "../run/exec.ts";
import { envDisabled } from "../project/env.ts";
import { messages, UsageError } from "../errors-cold.ts";
import { parse } from "../version/semver.ts";
import { out } from "../utils/log.ts";
import { runCwd, runEnv } from "../utils/context.ts";
import { materialise, resolutionDirFor, resolveExactPin } from "../main.ts";
import { firstValue, hasFlag, parseArgs } from "./args.ts";
import type { ProjectSpec } from "../types.ts";

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

/**
 * Resolve each entry that runs files — `node`, and the package managers that
 * also do (bun, deno, nub) — as a run of it from `cwd` would, wherever jup
 * owns the name (§09.18): its shim is enabled, or the project pins it.
 *
 * None of them is shimmed by default (§10.7), so elsewhere the name belongs to
 * the user's own install — nvm's `node`, `~/.bun/bin/bun` — which a global
 * default must not shadow. Where the shim is enabled, the line mirrors it,
 * global default included.
 *
 * `staleDefault` says whether a global default due for its §04.6 re-check may
 * still be accelerated. Only when the shim would answer with it too: offline,
 * it keeps the stale entry; online, it refreshes it, and the line — which never
 * asks the registry — must then leave that answer to the shims.
 */
export async function resolveRuntimeEnvironments(
  cwd: string,
  staleDefault = true,
): Promise<RuntimeEnvironment[]> {
  // bun, deno and nub read the same package-manager fields: one walk serves all three.
  let managerSpec: ProjectSpec | undefined;
  const resolved: RuntimeEnvironment[] = [];
  for (const name of SUPPORTED_NAMES) {
    if (!runsAsRuntime(name)) continue;
    let walked = false;
    try {
      const specResult = isRuntime(name)
        ? findProjectSpec(cwd, { projectSpecFlag: true, tool: name })
        : (managerSpec ??= findProjectSpec(cwd, { projectSpecFlag: true, tool: name }));
      walked = true;
      if (pinnedName(specResult) !== name && shimDirectoryFor(name) === undefined) continue;
      resolved.push(await resolveRuntimeEnvironment(name, specResult, staleDefault));
    } catch (error) {
      // A walk that failed — a malformed `package.json` — cannot say whether the
      // project pins the name: `node` reports it, the others only where their
      // own shim would meet the same failure.
      if (!walked && !isRuntime(name) && shimDirectoryFor(name) === undefined) continue;
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
async function resolveRuntimeEnvironment(
  name: string,
  specResult: ProjectSpec,
  staleDefault: boolean,
): Promise<RuntimeEnvironment> {
  const fallback = getFallbackLocator(name, { transparent: false, project: specResult });
  const reconciled = reconcile(specResult, fallback, { requestedName: name, transparent: false });
  const descriptor = await materialise(reconciled);
  const shimsOwnDefault =
    !staleDefault &&
    !("range" in reconciled) &&
    !envDisabled(ENV.DEFAULT_TO_LATEST) &&
    !isDefaultFresh(name);

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
      installed !== null && entry !== undefined && !shimsOwnDefault
        ? dirname(join(installed.location, entry))
        : null,
    installed: installed !== null,
  };
}

/**
 * The entry the project pins, if any: `devEngines.runtime` or `.nvmrc` for
 * `node`, the package-manager fields for the rest. A pin that cannot be read is
 * not this command's to report: its own shim will say so when it runs.
 */
function pinnedName(specResult: ProjectSpec): string | undefined {
  if (specResult.type !== "Found" || envDisabled(ENV.ENABLE_PROJECT_SPEC)) return undefined;
  try {
    return specResult.getSpec({ requireVersion: false }).name;
  } catch {
    return undefined;
  }
}

/** Single-quote for sh-family shells: no expansion, no splitting. */
function shQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Single-quote for fish, where `\\` and `\'` are the two escapes inside quotes. */
function fishQuote(value: string): string {
  return `'${value.replace(/[\\']/g, "\\$&")}'`;
}

/**
 * Quote for PowerShell. Its hook reads a native command's output through
 * `[Console]::OutputEncoding` — the OEM code page on Windows, not UTF-8 — so
 * anything outside printable ASCII would come back mangled, and be written
 * into `PATH` on every `cd`. Such a value travels as base64 of its UTF-8 bytes,
 * which every code page reads alike; the typographic quotes PowerShell also
 * ends a string on are among them.
 */
function psQuote(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return `'${value.replaceAll("'", "''")}'`;
  const base64 = Buffer.from(value, "utf8").toString("base64");
  return `([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${base64}')))`;
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
  // the wrapper. `$?` and `$LASTEXITCODE` are restored for the original
  // prompt, and a jup that cannot start (or prints nothing) is skipped
  // silently rather than erroring on every `cd`.
  powershell: {
    quote: psQuote,
    line: (entries) => `$env:PATH = ${psQuote(entries.join(delimiter))}`,
    hook: (jup) => `if ($null -eq $global:__JUP_ORIG_PROMPT) {
  $global:__JUP_ORIG_PROMPT = $function:prompt
}
$global:__JUP_PWD = $PWD.Path
function global:prompt {
  $ok = $?
  $code = $global:LASTEXITCODE
  if ($global:__JUP_PWD -ne $PWD.Path) {
    $global:__JUP_PWD = $PWD.Path
    try { $line = & ${jup} env --shell powershell 2>$null | Out-String } catch { $line = $null }
    if ($line) { Invoke-Expression $line }
    $global:LASTEXITCODE = $code
  }
  if (-not $ok) { Write-Error '' -ErrorAction Ignore }
  & $global:__JUP_ORIG_PROMPT
}
`,
  },
};

type ShellDialect = "bash" | "zsh" | "fish" | "powershell";

function isDialect(name: string): name is ShellDialect {
  return Object.hasOwn(DIALECTS, name);
}

/**
 * Shells that run the POSIX `export` spelling, answered as `bash`. Only bash
 * itself runs the `--use-on-cd` block, which needs `[[` and `PROMPT_COMMAND`.
 */
const POSIX_SHELLS = new Set(["sh", "bash", "dash", "ksh", "mksh", "ash"]);

/**
 * §11.5 — the shell `SHELL` names when `--shell` is absent, and on Windows
 * PowerShell by `PSModulePath`, as `enable`'s hint detects it. The name comes
 * back as itself, for the caller to map or refuse.
 */
function inferShell(): string | undefined {
  const env = runEnv();
  const shell = env[SYSTEM_ENV.SHELL];
  if (shell !== undefined && shell !== "") {
    const name = basename(shell)
      .replace(/^-+/, "")
      .replace(/\.exe$/i, "")
      .toLowerCase();
    return name === "pwsh" ? "powershell" : name;
  }
  if (process.platform === "win32" && env[SYSTEM_ENV.PSMODULEPATH] !== undefined) {
    return "powershell";
  }
  return undefined;
}

/**
 * The inherited `PATH`. A scoped run's environment (`run/scoped.ts`) is a plain
 * copy, whose keys are case-sensitive even on Windows, where the variable is
 * spelled `Path`: reading `PATH` from it would find nothing and the line would
 * replace the whole value.
 */
function inheritedPath(env: Record<string, string | undefined>): string | undefined {
  if (process.platform !== "win32") return env[SYSTEM_ENV.PATH];
  const key = Object.keys(env).find((name) => name.toUpperCase() === SYSTEM_ENV.PATH);
  return key === undefined ? undefined : env[key];
}

/**
 * Is this `PATH` entry inside the install folder, spelled literally or through
 * a symlink? Only absolute entries are candidates: a relative one (`.`,
 * `node_modules/.bin`) means something different in every directory and was
 * never put there by this command.
 *
 * An entry that no longer exists — a version since removed — cannot be
 * resolved whole, so its deepest existing ancestor is, and the rest appended:
 * spelled through a link to the home, it would otherwise outlive the directory
 * it named. Every entry that exists resolves on the first try.
 */
function isStorePathEntry(entry: string): boolean {
  if (!isAbsolute(entry)) return false;
  if (isInsideInstallFolder(entry)) return true;
  let head = entry;
  let tail = "";
  for (;;) {
    try {
      return isInsideInstallFolder(join(realpathSync(head), tail));
    } catch {
      const parent = dirname(head);
      if (parent === head) return false;
      tail = join(basename(head), tail);
      head = parent;
    }
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
  const inferred = requested === undefined ? inferShell() : undefined;
  if (useOnCd && inferred !== undefined && inferred !== "bash" && POSIX_SHELLS.has(inferred)) {
    throw new UsageError(
      `jup env --use-on-cd cannot hook ${inferred}; pass --shell (bash, zsh, fish or powershell)`,
    );
  }
  const shell =
    inferred !== undefined && POSIX_SHELLS.has(inferred) ? "bash" : (requested ?? inferred);
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
  // MSYS and Cygwin shells set `SHELL` on Windows, but split `PATH` on `:` and
  // spell drives `/c/`; the host's `;`-joined `C:\` value would leave them
  // with nothing to run. PowerShell is the one dialect the host value fits.
  if (process.platform === "win32" && shell !== "powershell") {
    throw new UsageError(
      `Unsupported shell "${shell}" on Windows; jup env supports powershell there`,
    );
  }
  const dialect = DIALECTS[shell];

  // The line runs from a shell hook on every directory change, so it never
  // waits on the registry: a version only the network could name is not in
  // the store either, and the shims answer it on demand (§09.18).
  //
  // Set in place, never on a spread copy: under the CLI this is `process.env`,
  // whose keys are case-insensitive on Windows. A scoped run's environment is
  // already its own copy (`run/scoped.ts`). `PATH` is read first, before the
  // env-file merge (§03.2) replaces the object.
  const env = runEnv();
  const path = inheritedPath(env);
  const offline = envDisabled(ENV.ENABLE_NETWORK);
  for (const spelling of envSpellings(ENV.ENABLE_NETWORK)) env[spelling] = "0";

  // A failed resolution still prints the strip, so whatever a previous
  // directory put on `PATH` comes off and the shims answer instead.
  const runtimes = await resolveRuntimeEnvironments(runCwd(), offline);
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
