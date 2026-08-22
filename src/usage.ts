/**
 * The command surface's description of itself — §09, §12.1.
 *
 * This lives in its own module because both sides of a management-mode error
 * need it and neither should pull in the other: `cli.ts` owns the commands,
 * `main.ts` owns the `Usage Error:` presentation (§08.4) but loads `cli.ts`
 * lazily so the proxy hot path never pays for the command surface.
 *
 * Keeping one table rather than two also removes a "these MUST stay in step"
 * comment, which is the kind of invariant that drifts the first time a flag
 * changes.
 */

/**
 * Keyed by the command word, so `corepack use yarn@1` gets `$ corepack use
 * <pattern>` rather than the whole synopsis. Anything unrecognised falls back to
 * {@link GENERIC_USAGE_LINE}, which is what an unknown command would print anyway.
 */
export const USAGE_LINES: Record<string, string> = {
  cache: "$ corepack cache clean|clear|list",
  disable: "$ corepack disable [--install-directory <path>] ...",
  enable: "$ corepack enable [--install-directory <path>] ...",
  hydrate: "$ corepack hydrate [--activate] <file>",
  info: "$ corepack info [--json]",
  install: "$ corepack install [-g,--global] [--cache-only] ...",
  pack: "$ corepack pack [--json] [-o,--output <path>] ...",
  prepare: "$ corepack prepare [--activate] [--all] [-o,--output <path>] ...",
  up: "$ corepack up",
  use: "$ corepack use <pattern>",
};

export const GENERIC_USAGE_LINE = "$ corepack <command>";

/** §09 — the complete surface, printed by `--help`. Anything not here is out of scope. */
export const HELP_TEXT = `Usage: corepack <command>

  corepack <binary>[@<version>] [...args]     run a package manager

  corepack cache clean [--all]
  corepack cache clear [--all]
  corepack cache list [--json]
  corepack disable [--install-directory <path>] [...name]
  corepack enable  [--install-directory <path>] [...name]
  corepack info [--json]
  corepack install
  corepack install -g|--global [--cache-only] [...name[@<version>] | <file>.tgz]
  corepack pack [--json] [-o|--output <path>] [...name[@<version>]]
  corepack up
  corepack use <name[@<version>]>
  corepack --version
  corepack --help

Deprecated, retained for compatibility:

  corepack hydrate [--activate] <file>
  corepack prepare [--activate] [--all] [-o|--output [<path>]] [...spec]

Configuration is by environment variable only; COREPACK_ENABLE_DOWNLOAD_PROMPT
defaults to 1 when invoked through a package-manager shim and 0 when invoked as
corepack itself.
`;
