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
 * Keyed by the command word, so `jup use yarn@1` gets `$ jup use
 * <pattern>` rather than the whole synopsis. Anything unrecognised falls back to
 * {@link GENERIC_USAGE_LINE}, which is what an unknown command would print anyway.
 */
export const USAGE_LINES: Record<string, string> = {
  cache: "$ jup cache clean|clear|list",
  disable: "$ jup disable [--install-directory <path>] [--exclude <name>] ...",
  enable: "$ jup enable [--install-directory <path>] [--exclude <name>] [--force] ...",
  hydrate: "$ jup hydrate [--activate] <file>",
  info: "$ jup info [--json]",
  install: "$ jup install [-g,--global] [--cache-only] ...",
  pack: "$ jup pack [--json] [-o,--output <path>] ...",
  prepare: "$ jup prepare [--activate] [--all] [-o,--output <path>] ...",
  up: "$ jup up [--here] [--pin-style=suffix|sidecar]",
  use: "$ jup use [--here] [--pin-style=suffix|sidecar] <pattern>",
};

export const GENERIC_USAGE_LINE = "$ jup <command>";

/** §09 — the complete surface, printed by `--help`. Anything not here is out of scope. */
export const HELP_TEXT = `Usage: jup <command>

  jup <binary>[@<version>] [...args]     run a package manager

  jup cache clean [--all]
  jup cache clear [--all]
  jup cache list [--json]
  jup disable [--install-directory <path>] [--exclude <name>] [...name]
  jup enable  [--install-directory <path>] [--exclude <name>] [--force] [...name]
  jup info [--json]
  jup install
  jup install -g|--global [--cache-only] [...name[@<version>] | <file>.tgz]
  jup pack [--json] [-o|--output <path>] [...name[@<version>]]
  jup up [--here] [--pin-style=suffix|sidecar]
  jup use [--here] [--pin-style=suffix|sidecar] <name[@<version>]>
  jup --version
  jup --help

Deprecated, retained for compatibility:

  jup hydrate [--activate] <file>
  jup prepare [--activate] [--all] [-o|--output [<path>]] [...spec]

--here confines a project-mutating command to the manifest in the current
directory; without it the walk stops at a workspace root (§15.27). Every
mutating command prints the path it modified.

--pin-style=sidecar writes the digest to devEngines.packageManager.integrity
and leaves packageManager holding clean semver (§15.12). The default,
--pin-style=suffix, writes <version>+<algo>.<hex>; both are read back
identically.

With no names, enable and disable target every supported package manager,
npm included (§15.16) — pass --exclude npm to leave npm alone. Shims are
installed to a per-user directory that never needs elevation (§15.13):
JUP_SHIM_DIRECTORY, else $XDG_BIN_HOME or ~/.local/bin, else
%LOCALAPPDATA%\\jup\\bin on Windows.

Configuration is by environment variable only; JUP_ENABLE_DOWNLOAD_PROMPT
defaults to 1 when invoked through a package-manager shim and 0 when invoked as
jup itself.
`;
