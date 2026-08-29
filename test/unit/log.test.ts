import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

import { HELP_TEXT } from "../../src/commands/usage.ts";
import { err, errColors, out, outColors, warn } from "../../src/utils/log.ts";

const execFileAsync = promisify(execFile);
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const LOG = JSON.stringify(new URL("../../src/utils/log.ts", import.meta.url).href);
const USAGE = JSON.stringify(new URL("../../src/commands/usage.ts", import.meta.url).href);

/**
 * Every SGR sequence the palette can emit.
 *
 * Built rather than written: a literal escape is an unprintable byte in the
 * source, and an editor or a formatter is free to mangle it.
 */
const ESC = String.fromCharCode(0x1b);
const ANSI = new RegExp(`${ESC}\\[\\d+m`, "g");
const YELLOW = `${ESC}[33m`;
const RED = `${ESC}[31m`;
const CYAN = `${ESC}[36m`;
const GREEN = `${ESC}[32m`;
const BOLD = `${ESC}[1m`;
const BOLD_OFF = `${ESC}[22m`;
const RESET = `${ESC}[39m`;

/**
 * Run `source` in a child, with the environment colour actually depends on.
 *
 * A child, because colour is a property of the *stream*: vitest's own stdout is
 * a pipe, so the in-process half below can only ever observe the uncoloured
 * branch. `env` is built from nothing rather than spread over `process.env` —
 * the suite may itself be running under an agent (§11.4), which is one of the
 * things these rows are here to measure.
 */
async function runChild(source: string, env: Record<string, string>): Promise<string> {
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", source], {
    cwd: ROOT,
    env: { PATH: process.env["PATH"] ?? "", ...env },
  });
  return stdout;
}

const printWith = (source: string, env: Record<string, string>): Promise<string> =>
  runChild(`const log = await import(${LOG});\n${source}`, env);

/**
 * §09.11 — the writers, and the one thing colour is not allowed to do.
 *
 * The suite runs with `NO_COLOR=1` (both vitest configs), which is also the
 * state every row in §13 that matches exact output depends on: with colour off
 * these functions must be the plain `write`/`console.warn` they replaced, down
 * to the byte. That is what this half asserts.
 */
describe("the writers with colour off — §09.11", () => {
  let stdout: MockInstance<typeof process.stdout.write>;
  let stderr: MockInstance<typeof process.stderr.write>;
  let warned: MockInstance<typeof console.warn>;

  beforeEach(() => {
    stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    warned = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes stdout verbatim", () => {
    out("Installing yarn@1.22.4\n");

    expect(stdout).toHaveBeenCalledWith("Installing yarn@1.22.4\n");
  });

  it("writes stderr verbatim", () => {
    err("! jup is about to download https://example.test/y.tgz\n");

    expect(stderr).toHaveBeenCalledWith("! jup is about to download https://example.test/y.tgz\n");
  });

  // The download prompt ends in a space and no newline (§12), and the marker
  // rewrite splits on `\n` — so a line without one has to survive it.
  it("preserves a write with no trailing newline", () => {
    err("! Do you want to continue? [Y/n] ");

    expect(stderr).toHaveBeenCalledWith("! Do you want to continue? [Y/n] ");
  });

  it("passes the message to console.warn unchanged", () => {
    warn("! jup validation warning: lockfile ignored");

    expect(warned).toHaveBeenCalledWith("! jup validation warning: lockfile ignored");
  });

  // §03.6's auto-pin is two marked lines in one write.
  it("leaves a multi-line notice byte for byte", () => {
    const notice =
      "! The local project doesn't define a 'packageManager' field.\n! For more details, consult the documentation.\n\n";

    err(notice);

    expect(stderr).toHaveBeenCalledWith(notice);
  });

  it("returns the text unchanged from every palette entry", () => {
    for (const colors of [outColors, errColors]) {
      for (const style of Object.values(colors)) {
        expect(style("Usage Error:")).toBe("Usage Error:");
      }
    }
  });
});

/**
 * The other half: that colour happens at all, and that removing it recovers the
 * exact bytes above.
 */
describe("the writers with colour on — §09.11", () => {
  it("colours the marker and nothing else", async () => {
    const printed = await printWith(`log.out("! jup validation warning: nope\\n");`, {
      FORCE_COLOR: "1",
    });

    expect(printed).toContain(`${YELLOW}!`);
    expect(printed.replaceAll(ANSI, "")).toBe("! jup validation warning: nope\n");
  });

  it("colours each marked line of a notice", async () => {
    const printed = await printWith(`log.out("! one\\n! two\\nunmarked\\n");`, {
      FORCE_COLOR: "1",
    });

    expect(printed.split(YELLOW)).toHaveLength(3);
    expect(printed.replaceAll(ANSI, "")).toBe("! one\n! two\nunmarked\n");
  });

  it("leaves an unmarked line alone", async () => {
    const printed = await printWith(`log.out("Installing yarn@1.22.4\\n");`, {
      FORCE_COLOR: "1",
    });

    expect(printed).toBe("Installing yarn@1.22.4\n");
  });

  it("styles a label without changing what it says", async () => {
    const printed = await printWith(`log.out(log.outColors.red("Usage Error:") + " nope\\n");`, {
      FORCE_COLOR: "1",
    });

    expect(printed).toContain(RED);
    expect(printed.replaceAll(ANSI, "")).toBe("Usage Error: nope\n");
  });

  it("emits nothing under NO_COLOR", async () => {
    const printed = await printWith(`log.out("! marked\\n");`, { NO_COLOR: "1" });

    expect(printed).toBe("! marked\n");
  });
});

/**
 * §11.4 — an AI agent reading the output, which is not a person looking at a
 * terminal even when the stream says it is.
 *
 * The variables are `unjs/std-env`'s agent table; a handful of representative
 * rows stand in for the list, since they all reach the same branch.
 */
describe("agent detection — §11.4", () => {
  const detect = (env: Record<string, string>): Promise<string> =>
    runChild(`const log = await import(${LOG});\nprocess.stdout.write(String(log.isAgent));`, env);

  it("is false in a plain environment", async () => {
    await expect(detect({})).resolves.toBe("false");
  });

  it.for([
    ["AI_AGENT", "1"],
    ["CLAUDECODE", "1"],
    ["CURSOR_AGENT", "1"],
    ["CODEX_THREAD_ID", "abc"],
    ["GEMINI_CLI", "1"],
    ["TERM_PROGRAM", "kiro"],
    ["EDITOR", "/usr/bin/devin"],
  ])("is true for %s", async ([name, value]) => {
    await expect(detect({ [name!]: value! })).resolves.toBe("true");
  });

  it("is true for pi, which announces itself on PATH", async () => {
    await expect(detect({ PATH: "/home/u/.pi/agent/bin:/usr/bin" })).resolves.toBe("true");
  });

  it("strips colour under an agent", async () => {
    const printed = await printWith(`log.out(log.outColors.red("Usage Error:") + "\\n");`, {
      CLAUDECODE: "1",
    });

    expect(printed).toBe("Usage Error:\n");
  });

  // The pair below is the precedence, and the reason the row above cannot carry
  // the weight on its own: the child's stdout is a pipe either way, so only
  // FORCE_COLOR distinguishes "suppressed" from "never offered".
  it("yields to an explicit FORCE_COLOR — the escape hatch out of the heuristic", async () => {
    const printed = await printWith(`log.out(log.outColors.red("Usage Error:") + "\\n");`, {
      CLAUDECODE: "1",
      FORCE_COLOR: "1",
    });

    expect(printed).toContain(RED);
  });

  it("takes FORCE_COLOR=0 as the ask it is", async () => {
    const printed = await printWith(`log.out(log.outColors.red("Usage Error:") + "\\n");`, {
      CLAUDECODE: "1",
      FORCE_COLOR: "0",
    });

    expect(printed).toBe("Usage Error:\n");
  });
});

/** §09.11 — `--help`, which is colour applied to a fixed block of text. */
describe("the help text — §09.11", () => {
  const helpWithColour = (): Promise<string> =>
    runChild(
      [
        `const log = await import(${LOG});`,
        `const usage = await import(${USAGE});`,
        `log.out(usage.formatHelp(log.outColors));`,
      ].join("\n"),
      { FORCE_COLOR: "1" },
    );

  /** {@link helpWithColour}, over text of the row's own rather than `HELP_TEXT`. */
  const paintedWithColour = (text: string): Promise<string> =>
    runChild(
      [
        `const log = await import(${LOG});`,
        `const usage = await import(${USAGE});`,
        `log.out(usage.formatHelp(log.outColors, ${JSON.stringify(text)}));`,
      ].join("\n"),
      { FORCE_COLOR: "1" },
    );

  it("is HELP_TEXT byte for byte with colour off", async () => {
    const { formatHelp } = await import("../../src/commands/usage.ts");

    expect(formatHelp(outColors)).toBe(HELP_TEXT);
  });

  it("recovers HELP_TEXT exactly once the escapes are stripped", async () => {
    const printed = await helpWithColour();

    expect(printed).not.toBe(HELP_TEXT);
    expect(printed.replaceAll(ANSI, "")).toBe(HELP_TEXT);
  });

  it("highlights an environment variable wherever it is spelled", async () => {
    const printed = await helpWithColour();

    // The three spellings §09's text uses, and `PATH` twice in one paragraph.
    expect(printed).toContain(`${GREEN}JUP_SHIM_DIRECTORY`);
    expect(printed).toContain(`${GREEN}$XDG_BIN_HOME`);
    expect(printed).toContain(`${GREEN}%LOCALAPPDATA%`);
    expect(printed).toContain(`${GREEN}%ProgramData%`);
    expect(printed).toContain(`${GREEN}PATH`);
    expect(printed).toContain(`${GREEN}JUP_ENABLE_DOWNLOAD_PROMPT`);
  });

  it("highlights a flag in the list and in the prose", async () => {
    const printed = await helpWithColour();

    expect(printed).toContain(`${YELLOW}--install-directory`);
    expect(printed).toContain(`${YELLOW}-o`);
    expect(printed).toContain(`${YELLOW}-g`);
    // The name is the flag; the value after `=` is not.
    expect(printed).toContain(`${YELLOW}--pin-style${RESET}=suffix`);
  });

  it("takes a flag in the command word's position as a flag", async () => {
    const printed = await helpWithColour();

    expect(printed).toContain(`${BOLD}jup${BOLD_OFF} ${YELLOW}--version`);
    expect(printed).not.toContain(`${CYAN}--version`);
  });

  it("leaves a hyphen inside a word alone", async () => {
    const printed = await helpWithColour();

    // The words, not the phrases they sit in: what is under test is the
    // lookbehind in `FLAG`, and an assertion spanning two words also asserts
    // where the paragraph happens to wrap.
    expect(printed).toContain("package-manager");
    expect(printed).toContain("per-user");
    expect(printed).not.toContain(`${YELLOW}-manager`);
    expect(printed).not.toContain(`${YELLOW}-user`);
  });

  it("bolds a heading in the help text", async () => {
    const printed = await helpWithColour();

    expect(printed).toContain(`${BOLD}Deprecated, retained for compatibility:`);
  });

  /**
   * The other half of the heading rule, and the reason it is not asserted
   * against `HELP_TEXT`: a heading is a flush-left line ending in a colon *with
   * a blank line in front*, and it is the blank line that does the work. No
   * paragraph in the current wording wraps onto a colon, so the real text cannot
   * tell a correct implementation from one that dropped the `previous === ""`
   * condition — it would have to be rewrapped back into the shape the rule
   * exists for. Feeding `formatHelp` that shape directly is what keeps the
   * condition under test through the next rewrite.
   */
  it("does not bold a wrapped line that ends in a colon", async () => {
    const wrapped = [
      "Shims go where enable puts them, which is a per-user",
      "directory that never needs elevation:",
      "",
      "A heading:",
    ].join("\n");

    const painted = await paintedWithColour(wrapped);

    expect(painted).toContain(`${BOLD}A heading:`);
    expect(painted).toContain("directory that never needs elevation:");
    expect(painted).not.toContain(`${BOLD}directory that never needs elevation:`);
    // §09.11 rule 1 — colour may only wrap what the text already says.
    expect(painted.replaceAll(ANSI, "")).toBe(wrapped);
  });

  it("colours the command word and leaves the prose alone", async () => {
    const printed = await helpWithColour();

    expect(printed).toContain(`${CYAN}cache`);
    // The paragraphs below the list name commands too; they must stay plain.
    expect(printed).toContain("self-upgrade changes jup.");
  });
});
