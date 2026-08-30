/**
 * The writers — §09.14's stream discipline in one place, plus the colour that
 * rides on top of it.
 *
 * Four rules shape this file:
 *
 * 1. **The text is the contract.** §12 reproduces every user-facing string byte
 *    for byte, so colour may only wrap what a message already says. Nothing here
 *    adds, drops, or reorders a character — §12's `⚠ ` and `│ ` markers are part
 *    of the messages themselves; with colour off, every function is the plain
 *    `write`/`console.warn` it replaced.
 * 2. **The stream is chosen by the caller**, never inferred. Which of the two a
 *    line lands on is asserted by the suite — a proxy-mode `UsageError` on
 *    stderr, its management-mode form on **stdout** — and a helper that guessed
 *    would make that flip silently.
 * 3. **A package manager's own output never comes through here.** §09.14: it is
 *    passthrough, unmodified — `run/exec.ts` inherits stdio, and this module is
 *    not on that path.
 * 4. **Nothing is touched until something is printed** — see {@link streamOf}.
 *
 * Colour comes from `node:util`'s `styleText`, which consults the target
 * stream: not a TTY, `NO_COLOR`, `TERM=dumb`, or a pipe, and it hands the text
 * back untouched. `FORCE_COLOR` is the escape hatch in the other direction. So
 * redirected output, `| head`, and CI logs stay plain without a flag of ours,
 * and §13 pins it with `NO_COLOR` rather than trusting the runner's TTY.
 */

// Free on the warm path: `node:util` is in Node's startup snapshot, so this
// resolves without loading anything. The stream getters below are not, which is
// why they stay behind a function.
const { styleText } = process.getBuiltinModule("node:util");

type Format = Parameters<typeof styleText>[0];

/** Which of the two streams a line is bound for. */
export type Target = "stdout" | "stderr";

/**
 * §16, Build shape — the *first* read of `process.stdout`/`process.stderr`
 * constructs the stream, and that pulls in 20 native modules (`stream`,
 * `string_decoder`, the `internal/streams/*` set). A warm run prints nothing,
 * so nothing here may reach for a stream at module load: every path to one
 * goes through this call, taken only once a caller is already committed to
 * writing.
 */
function streamOf(target: Target): NodeJS.WriteStream {
  return target === "stdout" ? process.stdout : process.stderr;
}

/**
 * The environment variables an AI coding agent announces itself with, taken from
 * `unjs/std-env`'s agent table (`src/agents.ts`): Claude Code, Replit, Gemini
 * CLI, Codex, opencode, Augment, Goose, Junie and Cursor, plus `AI_AGENT` as
 * std-env's explicit opt-in. Presence alone is the signal; the values differ per
 * agent and none of them mean anything to us.
 */
const AGENT_VARIABLES = [
  "AI_AGENT",
  "CLAUDECODE",
  "CLAUDE_CODE",
  "REPL_ID",
  "GEMINI_CLI",
  "CODEX_SANDBOX",
  "CODEX_THREAD_ID",
  "OPENCODE",
  "AUGMENT_AGENT",
  "GOOSE_PROVIDER",
  "JUNIE_DATA",
  "JUNIE_SHIM_PATH",
  "CURSOR_AGENT",
];

/**
 * Whether an AI coding agent, rather than a person, is reading this output.
 *
 * Agents capture our streams through a pty often enough that the TTY test says
 * "terminal" — and then every escape sequence lands verbatim in a transcript
 * that has no use for them. So colour is suppressed here even where the stream
 * would take it, `FORCE_COLOR` excepted (§11.5): an explicit ask on the command
 * line still wins over a heuristic read of the ambient environment.
 *
 * Env only, evaluated once. `std-env` also matches `TERM_PROGRAM=kiro` against a
 * *non*-TTY stdout, and reading `process.stdout` at module load would cost the
 * warm path 20 native modules ({@link streamOf}) — so the TTY half of that row
 * is dropped, and the cost of being wrong is that a person in Kiro's integrated
 * terminal gets plain output until they set `FORCE_COLOR`.
 */
export const isAgent: boolean =
  AGENT_VARIABLES.some((name) => process.env[name] !== undefined) ||
  /\.pi[\\/]agent/.test(process.env["PATH"] ?? "") ||
  /devin/.test(process.env["EDITOR"] ?? "") ||
  /kiro/.test(process.env["TERM_PROGRAM"] ?? "");

/** §11.5 — the one way to ask for colour over every heuristic above. */
function forcedOn(): boolean {
  const forced = process.env["FORCE_COLOR"];
  return forced !== undefined && forced !== "0";
}

/** The six styles the messages actually use; add one when a call site needs it. */
export interface Palette {
  bold: (text: string) => string;
  dim: (text: string) => string;
  red: (text: string) => string;
  yellow: (text: string) => string;
  green: (text: string) => string;
  cyan: (text: string) => string;
}

/**
 * A palette bound to one stream.
 *
 * Bound, because support is a property of the destination: stdout can be a pipe
 * while stderr is still a terminal, which is exactly the `jup info | less`
 * shape. `validateStream` performs that check per call — it is reached only
 * when something is being printed, so the check costs a warm run nothing, and
 * {@link isAgent} rides in front of it for the same reason.
 */
function paletteFor(target: Target): Palette {
  const paint =
    (format: Format) =>
    (text: string): string =>
      isAgent && !forcedOn()
        ? text
        : styleText(format, text, { stream: streamOf(target), validateStream: true });

  return {
    bold: paint("bold"),
    dim: paint("dim"),
    red: paint("red"),
    yellow: paint("yellow"),
    green: paint("green"),
    cyan: paint("cyan"),
  };
}

export const outColors: Palette = paletteFor("stdout");
export const errColors: Palette = paletteFor("stderr");

/**
 * §12 — the two markers a line can open with, and what they mean.
 *
 * `⚠ ` opens an advisory, a warning or a notice; `│ ` continues one. They live
 * in the message builders, not here: §12 reproduces every user-facing string
 * byte for byte, so what a reader sees has to be what §12 lists. All this file
 * does is paint them.
 *
 * Both characters are old and narrow — `⚠` is U+26A0, `│` is U+2502, a
 * box-drawing character every terminal font carries — and neither is an emoji,
 * so neither takes the double-width cell that would push a marked line out of
 * alignment with the one above it.
 */
const WARNING_MARKER = "⚠ ";
const CONTINUATION_MARKER = "│ ";

/** Whether any line of a write opens with one of the two markers. */
const MARKED = /^[⚠│] /m;

/**
 * Colour the marker a line opens with, and only that.
 *
 * Line-wise, because a notice can be a paragraph: §03.6's auto-pin prints its
 * sentence and its documentation link as two marked lines in one write, and
 * §10.5's `PATH` advice is four. Only the first of them is the warning — the
 * rest continue it, and their dim gutter is what makes the block read as one
 * advisory rather than as four separate alarms. Split and rejoin on `\n` is
 * byte-exact for everything else, including a write with no trailing newline.
 */
function markers(text: string, colors: Palette): string {
  if (!MARKED.test(text)) return text;

  return text
    .split("\n")
    .map((line) => {
      if (line.startsWith(WARNING_MARKER)) {
        return `${colors.yellow("⚠")} ${line.slice(WARNING_MARKER.length)}`;
      }
      if (line.startsWith(CONTINUATION_MARKER)) {
        return `${colors.dim("│")} ${line.slice(CONTINUATION_MARKER.length)}`;
      }
      return line;
    })
    .join("\n");
}

/** §09.14 — informational output is stdout, unbuffered, unprefixed. */
export function out(text: string): void {
  process.stdout.write(markers(text, outColors));
}

/** The same, on stderr: notices that must not corrupt a piped stdout (§09.14). */
export function err(text: string): void {
  process.stderr.write(markers(text, errColors));
}

/**
 * A warning line on stderr, via `console.warn`.
 *
 * `console.warn` rather than `err()` on purpose: §13 spies on it for the
 * `devEngines` and Yarn Switch text, and the advisory gate's own rows assert the
 * argument it receives — which stays the unmodified message, since the suite
 * runs with colour off.
 */
export function warn(message: string): void {
  console.warn(markers(message, errColors));
}
