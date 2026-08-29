/**
 * Usage text is isolated so the hot proxy graph does not parse management-command help.
 */

/**
 * Keyed by the command word, so `jup use yarn@1` gets `$ jup use
 * <pattern>` rather than the whole synopsis. Anything unrecognised falls back to
 * {@link GENERIC_USAGE_LINE}, which is what an unknown command would print anyway.
 */
export const USAGE_LINES: Record<string, string> = {
  cache: "$ jup cache clean|clear|list",
  disable: "$ jup disable [--install-directory <path>|--system] [--exclude <name>] ...",
  enable: "$ jup enable [--install-directory <path>|--system] [--exclude <name>] [--force] ...",
  hydrate: "$ jup hydrate [--activate] <file>",
  info: "$ jup info [--json]",
  install: "$ jup install [-g,--global] [--cache-only] ...",
  pack: "$ jup pack [--json] [-o,--output <path>] ...",
  "self-install": "$ jup self-install [--install-directory <path>|--system] [--force]",
  "self-upgrade": "$ jup self-upgrade [--install-directory <path>|--system] [--force]",
  prepare: "$ jup prepare [--activate] [--all] [-o,--output <path>] ...",
  up: "$ jup up [--here] [--pin-style=suffix|sidecar]",
  // §09.13's other spelling. Its usage line names the word the user typed, so
  // the two entries differ by exactly that.
  upgrade: "$ jup upgrade [--install-directory <path>|--system] [--force]",
  use: "$ jup use [--here] [--pin-style=suffix|sidecar] <pattern>",
};

export const GENERIC_USAGE_LINE = "$ jup <command>";

/** §09 — the complete surface, printed by `--help`. Anything not here is out of scope. */
export const HELP_TEXT = `Usage: jup <command>

  jup <binary>[@<version>] [...args]     run a package manager

  jup cache clean [--all]
  jup cache clear [--all]
  jup cache list [--json]
  jup disable [--install-directory <path>|--system] [--exclude <name>] [...name]
  jup enable  [--install-directory <path>|--system] [--exclude <name>] [--force] [...name]
  jup info [--json]
  jup install
  jup install -g|--global [--cache-only] [...name[@<version>] | <file>.tgz]
  jup pack [--json] [-o|--output <path>] [...name[@<version>]]
  jup self-install [--install-directory <path>|--system] [--force]
  jup self-upgrade [--install-directory <path>|--system] [--force]
  jup up [--here] [--pin-style=suffix|sidecar]
  jup use [--here] [--pin-style=suffix|sidecar] <name[@<version>]>
  jup --version
  jup --help

Deprecated, retained for compatibility:

  jup hydrate [--activate] <file>
  jup prepare [--activate] [--all] [-o|--output [<path>]] [...spec]

self-install copies the jup that is running into <home>/self/<version>, which
cache clean does not touch, and links jup and corepack to it from the same
directory enable uses. It resolves nothing and downloads nothing: the bytes it
installs are the ones already executing. Pass --force to take over a name
another tool owns, which is what replacing Node's bundled corepack needs.

self-upgrade fetches the latest published jup, verifies it the way every other
download is verified, and points the same two names at it. It is spelled
upgrade too — which is not up: up updates this project's packageManager field,
self-upgrade updates jup.

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
%LOCALAPPDATA%\\jup\\bin on Windows. When that directory is not on PATH,
enable prefers ~/bin — or $XDG_BIN_HOME — if one of those is, and says so; it
never adopts a directory just for being writable and on PATH (§15.13 point 6).
Running as root adds /usr/local/bin to that list, last, which is what a bare
enable in a container reaches. --system names it outright — %ProgramData%\\jup\\bin
on Windows — and, unlike every other directory, is never quietly fallen back
out of; pass it to disable too when the shims were installed that way
(§15.13 point 8).

Configuration is by environment variable only; JUP_ENABLE_DOWNLOAD_PROMPT
defaults to 1 when invoked through a package-manager shim and 0 when invoked as
jup itself.
`;
