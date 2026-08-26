/**
 * The command surface's description of itself — §09, §12.1, §17.4 R8, §17.6 C6.
 *
 * This lives in its own module because both sides of a management-mode error
 * need it and neither should pull in the other: `cli.ts` owns the commands,
 * `main.ts` owns the `Usage Error:` presentation (§08.4) but loads `cli.ts`
 * lazily so the proxy hot path never pays for the command surface.
 *
 * **One table.** §17.4 R8 requires `VERBS` to be "one list, derived from the
 * surface, never written out twice", and before §17 the same words appeared
 * three times: `cli.ts`'s `switch`, this file's usage lines, and this file's
 * help text. {@link COMMANDS} is now the source of all three — the help text is
 * rendered from it, and `cli.ts`'s dispatch table is typed by
 * {@link DispatchedVerb}, so a verb added here and nowhere else is a compile
 * error rather than a word that silently does nothing.
 *
 * Every line here is written **without** the invoked name in front of it, because
 * §17.4 R12 and §17.6 C6 make that name a variable: `$ corepack use <pattern>`
 * under the corepack entry point, `$ jup use <pattern>` unscoped, `$ jup pm use
 * <pattern>` scoped. The prefix arrives from `router.ts`.
 */

/** §09 — one command's description of itself, minus the invoked name. */
export interface CommandSurface {
  /**
   * §12.1's usage line, minus the `$ <invocation> ` prefix — `null` for a verb
   * that has no line of its own and falls back to the generic one.
   */
  usage: string | null;
  /** `--help`'s synopsis lines, minus the `  <invocation> ` prefix. */
  synopsis: string[];
  /** §09 — retained for compatibility only; printed under its own heading. */
  deprecated?: true;
  /**
   * Named by the surface but not dispatched yet, so `--help` does not advertise
   * it and §12.9's `Unknown command` still answers for it.
   */
  pending?: true;
}

/**
 * §09's synopsis, plus §15.30's `info` and §15.34's `project` — §17.4 R8's
 * `VERBS`, in the order `--help` prints them.
 */
export const COMMANDS = {
  cache: {
    usage: "cache clean|clear|list",
    synopsis: ["cache clean [--all]", "cache clear [--all]", "cache list [--json]"],
  },
  disable: {
    usage: "disable [--install-directory <path>] [--exclude <name>] ...",
    synopsis: ["disable [--install-directory <path>] [--exclude <name>] [...name]"],
  },
  enable: {
    usage: "enable [--install-directory <path>] [--exclude <name>] [--force] ...",
    // The second space aligns it under `disable` above.
    synopsis: ["enable  [--install-directory <path>] [--exclude <name>] [--force] [...name]"],
  },
  /**
   * §09 — `help` is both a verb and a flag. It appears in the synopsis as
   * `--help`, with the other top-level flags, so it contributes no line here.
   */
  help: { usage: null, synopsis: [] },
  info: { usage: "info [--json]", synopsis: ["info [--json]"] },
  install: {
    usage: "install [-g,--global] [--cache-only] ...",
    synopsis: ["install", "install -g|--global [--cache-only] [...name[@<version>] | <file>.tgz]"],
  },
  pack: {
    usage: "pack [--json] [-o,--output <path>] ...",
    synopsis: ["pack [--json] [-o|--output <path>] [...name[@<version>]]"],
  },
  /**
   * §15.34's one accepted request — `install --project`, aliased `project
   * install` — which is required and not yet implemented.
   *
   * It is listed anyway because §17.4 R8 derives `VERBS` from this table, and
   * the invariant's whole point is that a word cannot be spent twice: leaving
   * `project` out would let it become a tool name, a binary name, or a scope
   * word between now and the release that implements it, and R7's ordering makes
   * that collision silent rather than an error. `pending` keeps it out of
   * `--help` and out of the dispatch table, so today it reaches §12.9's
   * `Unknown command` exactly as it does now.
   */
  project: { usage: null, synopsis: [], pending: true },
  up: {
    usage: "up [--here] [--pin-style=suffix|sidecar]",
    synopsis: ["up [--here] [--pin-style=suffix|sidecar]"],
  },
  use: {
    usage: "use [--here] [--pin-style=suffix|sidecar] <pattern>",
    synopsis: ["use [--here] [--pin-style=suffix|sidecar] <name[@<version>]>"],
  },
  hydrate: {
    usage: "hydrate [--activate] <file>",
    synopsis: ["hydrate [--activate] <file>"],
    deprecated: true,
  },
  prepare: {
    usage: "prepare [--activate] [--all] [-o,--output <path>] ...",
    synopsis: ["prepare [--activate] [--all] [-o|--output [<path>]] [...spec]"],
    deprecated: true,
  },
} satisfies Record<string, CommandSurface>;

export type Verb = keyof typeof COMMANDS;

/**
 * The verbs `cli.ts` must dispatch: every verb the surface names except the ones
 * marked `pending`. Typing the dispatch table with this is what keeps the switch
 * and the surface from drifting apart without a test to notice.
 */
export type DispatchedVerb = {
  [K in Verb]: (typeof COMMANDS)[K] extends { pending: true } ? never : K;
}[Verb];

/** §17.4 R8's `VERBS`, derived — never written out a second time. */
export const VERBS: readonly string[] = Object.keys(COMMANDS);

/**
 * Is this one of {@link VERBS} the surface names but does not dispatch?
 *
 * Only §15.34's `project` today. R7 step 5 skips these, so they reach step 7's
 * `Unknown command` — the answer they already give.
 */
export function isPendingVerb(verb: string): boolean {
  return Object.hasOwn(COMMANDS, verb) && "pending" in COMMANDS[verb as Verb];
}

/**
 * §12.1 — the usage line appended to a management-mode `Usage Error:`.
 *
 * `prefix` is the invoked name and the scope in effect (`corepack`, `jup`,
 * `jup pm`); anything without a line of its own gets the generic one, which is
 * what an unknown command would print anyway.
 */
export function usageLine(verb: string | undefined, prefix: string): string {
  const surface =
    verb !== undefined && Object.hasOwn(COMMANDS, verb) ? COMMANDS[verb as Verb] : undefined;
  const suffix = surface?.usage;
  return suffix === undefined || suffix === null
    ? `$ ${prefix} <command>`
    : `$ ${prefix} ${suffix}`;
}

/** How `--help` is rendered — §17.6 C6 makes it depend on the scope in effect. */
export interface HelpOptions {
  /** The invoked entry-point name: `jup` or `corepack` (§17.6 C1′). */
  entry: string;
  /** The name plus the scope in effect: `corepack`, `jup`, `jup pm`. */
  prefix: string;
  /**
   * Whether to describe the scopes. §17.6 C6: `jup --help` shows both,
   * `jup pm --help` and `corepack --help` show the package-manager surface.
   */
  scopes: boolean;
}

/**
 * §09 — the complete surface, printed by `--help`. Anything not here is out of
 * scope (§01.7, §17.8).
 *
 * The proxy line keeps the bare entry name even under a scope, and deliberately:
 * §17.4 R7 runs the proxy tests *before* the scope word, so `jup pm yarn` is a
 * usage error and advertising it would be advertising something that does not
 * work.
 */
export function helpText(options: HelpOptions): string {
  const { entry, prefix, scopes } = options;
  const lines: string[] = [];

  lines.push(
    `Usage: ${prefix}${scopes ? " [<scope>]" : ""} <command>`,
    ``,
    `  ${entry} <binary>[@<version>] [...args]     run a package manager`,
    ``,
  );

  for (const surface of Object.values(COMMANDS) as CommandSurface[]) {
    if (surface.deprecated === true || surface.pending === true) continue;
    for (const line of surface.synopsis) lines.push(`  ${prefix} ${line}`);
  }
  lines.push(`  ${prefix} --version`, `  ${prefix} --help`, ``);

  lines.push(`Deprecated, retained for compatibility:`, ``);
  for (const surface of Object.values(COMMANDS) as CommandSurface[]) {
    if (surface.deprecated !== true) continue;
    for (const line of surface.synopsis) lines.push(`  ${prefix} ${line}`);
  }
  lines.push(``);

  if (scopes) {
    lines.push(
      `A scope narrows a command to one kind of tool. Without one the role is`,
      `inferred from the spec, or from what the project pins:`,
      ``,
      `  ${entry} pm <command>          package managers`,
      `  ${entry} runtime <command>     language runtimes`,
      ``,
      `pm and runtime may also be spelled package-manager and rt. A scope word`,
      `takes a command, never a binary: ${entry} yarn --version runs Yarn, and`,
      `${entry} pm yarn --version is an error.`,
      ``,
    );
  }

  lines.push(
    `--here confines a project-mutating command to the manifest in the current`,
    `directory; without it the walk stops at a workspace root (§15.27). Every`,
    `mutating command prints the path it modified.`,
    ``,
    `--pin-style=sidecar writes the digest to devEngines.packageManager.integrity`,
    `and leaves packageManager holding clean semver (§15.12). The default,`,
    `--pin-style=suffix, writes <version>+<algo>.<hex>; both are read back`,
    `identically.`,
    ``,
    `With no names, enable and disable target every supported package manager,`,
    `npm included (§15.16) — pass --exclude npm to leave npm alone. Shims are`,
    `installed to a per-user directory that never needs elevation (§15.13):`,
    // §17.6 C4 — a tier-2 variable is named `JUP_` in this tool's own help text,
    // whatever spelling the reader's CI happens to set (both are read).
    `JUP_SHIM_DIRECTORY, else $XDG_BIN_HOME or ~/.local/bin, else`,
    String.raw`%LOCALAPPDATA%\jup\bin on Windows.`,
    ``,
    `Configuration is by environment variable only; COREPACK_ENABLE_DOWNLOAD_PROMPT`,
    `defaults to 1 when invoked through a package-manager shim and 0 when invoked as`,
    `${entry} itself.`,
    ``,
  );

  return lines.join("\n");
}
