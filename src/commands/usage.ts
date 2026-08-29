/**
 * Usage text is isolated so the hot proxy graph does not parse management-command help.
 */

import type { Palette } from "../utils/log.ts";

/**
 * Keyed by the command word, so `jup use yarn@1` gets `$ jup use
 * <pattern>` rather than the whole synopsis. Anything unrecognised falls back to
 * {@link GENERIC_USAGE_LINE}, which is what an unknown command would print anyway.
 */
export const USAGE_LINES: Record<string, string> = {
  cache: "$ jup cache clean|clear|list",
  disable: "$ jup disable [--install-directory <path>|--system] [--exclude <name>] ...",
  enable: "$ jup enable [--install-directory <path>|--system] [--exclude <name>] [--force] ...",
  info: "$ jup info [--json]",
  install: "$ jup install [-g,--global] [--cache-only] ...",
  pack: "$ jup pack [--json] [-o,--output <path>] ...",
  "self-install": "$ jup self-install [--install-directory <path>|--system] [--force]",
  "self-upgrade": "$ jup self-upgrade [--install-directory <path>|--system] [--force]",
  up: "$ jup up [--here] [--no-integrity] [--no-lockfile]",
  // §09.13's other spelling. Its usage line names the word the user typed, so
  // the two entries differ by exactly that.
  upgrade: "$ jup upgrade [--install-directory <path>|--system] [--force]",
  use: "$ jup use [--here] [--no-integrity] [--no-lockfile] <pattern>",
};

export const GENERIC_USAGE_LINE = "$ jup <command>";

/**
 * §09.14 — {@link HELP_TEXT}, with the structure it already has picked out in
 * colour: the `Usage:` heading, the program name on each synopsis line, the
 * command word after it, and a trailing description.
 *
 * Line-scoped on purpose. The prose paragraphs underneath name commands and
 * flags too ("up updates this project's packageManager field"), and a rule that
 * matched words rather than whole lines would light those up at random. Only a
 * line that *is* a synopsis — two spaces, then `jup` — is treated as one.
 *
 * Every branch reassembles the line from its own captures, so with colour off
 * (`NO_COLOR`, a pipe, an agent) the result is `HELP_TEXT` byte for byte.
 *
 * `text` is a seam for the suite, and production passes nothing. The heading
 * rule below turns on a *shape* the help text is not obliged to keep having —
 * there is no wrapped line ending in a colon in it today — so a row that could
 * only feed it {@link HELP_TEXT} would assert the rule by proxy at best, and
 * silently stop asserting it the next time the prose is rewrapped.
 */
export function formatHelp(colors: Palette, text: string = HELP_TEXT): string {
  const lines = text.split("\n");

  return lines
    .map((line, index) =>
      paintFlags(
        paintEnvNames(paintHelpLine(line, lines[index - 1] ?? "", colors), colors),
        colors,
      ),
    )
    .join("\n");
}

/**
 * The three ways the text spells a variable: `%LOCALAPPDATA%`, `$XDG_BIN_HOME`,
 * and a bare `JUP_SHIM_DIRECTORY` or `PATH`.
 *
 * Applied to every line, prose included — a variable is the one thing here worth
 * picking out of a paragraph, and it is where the eye goes when the paragraph is
 * about where shims land. The bare form needs three characters and no lowercase,
 * which is narrow enough that the whole of §09's help matches six tokens and
 * nothing else.
 */
const ENV_NAME = /%[A-Za-z][A-Za-z\d_]*%|\$?\b[A-Z][A-Z\d_]{2,}\b/g;

/**
 * Runs *after* {@link paintHelpLine}, over a line that may already carry escape
 * sequences. That is safe rather than lucky: an SGR sequence is digits and a
 * lowercase letter, so {@link ENV_NAME} cannot match inside one.
 */
function paintEnvNames(line: string, colors: Palette): string {
  return line.replace(ENV_NAME, (name) => colors.green(name));
}

/**
 * `--install-directory`, `-o`, `--no-integrity`, `--no-lockfile`.
 *
 * The lookbehind is what keeps it off the prose: a hyphen inside a word
 * ("package-manager", "read-only", "self-install") is not the start of a flag,
 * and without it half the paragraphs would light up. §09's help matches sixteen
 * flags this way and nothing else.
 *
 * Runs last, and by the same reasoning as {@link paintEnvNames}: a flag already
 * coloured as a synopsis line's leading token sits directly behind an SGR
 * sequence, whose trailing `m` is a word character — so the lookbehind declines
 * to paint it twice.
 */
const FLAG = /(?<![\w-])--?[a-z][a-z\d-]*/g;

function paintFlags(line: string, colors: Palette): string {
  return line.replace(FLAG, (flag) => colors.yellow(flag));
}

/** `  jup <verb> <rest>` — the shape of every line in the command list. */
const SYNOPSIS = /^ {2}jup (\S+)(.*)$/;

/** A trailing description, set off from the synopsis by a run of spaces. */
const DESCRIPTION = /^(.*?)( {3,})(\S.*)$/;

function paintHelpLine(line: string, previous: string, colors: Palette): string {
  if (line.startsWith("Usage:")) return `${colors.bold("Usage:")}${line.slice("Usage:".length)}`;

  const synopsis = SYNOPSIS.exec(line);
  if (synopsis === null) {
    // A heading is a flush-left line ending in a colon that *opens* a block. The
    // blank line in front is what carries it: the prose wraps, and a wrapped
    // line can end in a colon — "… installed to a per-user directory:" — often
    // enough that the colon alone would bold a sentence fragment. No paragraph
    // in the current text wraps that way, which is a fact about this wording
    // rather than a property of it; the suite feeds `formatHelp` a paragraph
    // that does.
    const heading = line.endsWith(":") && !line.startsWith(" ") && previous === "";
    return heading ? colors.bold(line) : line;
  }

  const [, verb = "", rest = ""] = synopsis;
  // `<binary>` is a placeholder, not a command word, so it stays plain — and
  // `jup --version` is a flag in the position a command word usually occupies,
  // so it takes the flag colour rather than the command one.
  const command = verb.startsWith("<")
    ? verb
    : verb.startsWith("-")
      ? colors.yellow(verb)
      : colors.cyan(verb);
  return `  ${colors.bold("jup")} ${command}${paintDescription(rest, colors)}`;
}

function paintDescription(rest: string, colors: Palette): string {
  const described = DESCRIPTION.exec(rest);
  if (described === null) return rest;

  const [, args = "", gap = "", description = ""] = described;
  return `${args}${gap}${colors.dim(description)}`;
}

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
  jup up [--here] [--no-integrity] [--no-lockfile]
  jup use [--here] [--no-integrity] [--no-lockfile] <name[@<version>]>
  jup --version
  jup --help

self-install copies the running jup to <home>/self/<version>, which cache clean
keeps, then links jup and corepack from enable's directory. It uses the current
bytes without resolving or downloading anything. Pass --force to replace names
owned by another tool, including Node's bundled corepack.

self-upgrade downloads and verifies the latest jup, then updates the same links.
Its alias is upgrade. It differs from up: up changes this project's pin;
self-upgrade changes jup.

--here limits project changes to the current directory's manifest. Otherwise,
the search stops at a workspace root. Every mutating command prints each path
it changed.

A pin records the release's digest, in the field the pin itself lands in: an
SRI integrity key beside a clean version in devEngines, or the
<version>+<algo>.<hex> suffix in the top-level packageManager string. Both are
read identically. Pass --no-integrity to pin the version alone and drop any
digest already there.

A range pin also records the release it resolved to, in jup.lock beside the
manifest. Pass --no-lockfile to pin the range alone and drop any entry already
recorded for it. An exact pin never records one.

With no names, enable and disable target every supported package manager,
including npm. Pass --exclude npm to keep npm unchanged. Shims use a per-user
directory: JUP_SHIM_DIRECTORY, then $XDG_BIN_HOME or ~/.local/bin, or
%LOCALAPPDATA%\\jup\\bin on Windows. If that directory is not on PATH, enable
uses ~/bin or $XDG_BIN_HOME when either is on PATH, and reports the choice. It
never chooses a directory merely because it is writable and on PATH. For root,
/usr/local/bin is the last choice, so a bare enable in a container reaches it.
--system explicitly selects /usr/local/bin, or %ProgramData%\\jup\\bin on Windows,
and never falls back elsewhere. Use --system with disable for shims installed
that way.

Configuration uses environment variables only. JUP_ENABLE_DOWNLOAD_PROMPT
defaults to 1 through a package-manager shim and 0 when jup is invoked directly.
`;
