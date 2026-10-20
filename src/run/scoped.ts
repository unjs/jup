/**
 * A run without handover — `runMain`'s default, and only ever an embedder's.
 *
 * Cold: every entry point jup ships hands over, so none of this is on the warm
 * path (§16, Build shape). What it builds is the scope `utils/context.ts` reads.
 */

const { resolve } = process.getBuiltinModule("node:path");
import { type RunContext, type Sink, withRunContext } from "../utils/context.ts";
import type { RunOptions, RunResult, StdioMode } from "../types.ts";

const MODES: ReadonlySet<unknown> = new Set(["inherit", "pipe", "ignore"]);

/**
 * Run `dispatch` in a scope of its own, built from `RunOptions`' `cwd`, `env`
 * and `stdio`, and answer with what it collected.
 */
export async function runScoped(
  run: RunOptions | undefined,
  dispatch: () => Promise<number>,
): Promise<RunResult> {
  const context = createRunContext(run);
  const result: RunResult = { code: await withRunContext(context, dispatch) };
  const stdout = collected(context.stdout);
  const stderr = collected(context.stderr);
  if (stdout !== undefined) result.stdout = stdout;
  if (stderr !== undefined) result.stderr = stderr;
  return result;
}

/**
 * The scope for one run. The environment is copied, never adopted: the
 * caller's object is theirs, and the run's merges must reach neither it nor
 * `process.env`.
 */
export function createRunContext(run: RunOptions | undefined): RunContext {
  const cwd = run?.cwd;
  if (cwd !== undefined && typeof cwd !== "string") {
    throw new TypeError("RunOptions.cwd must be a string.");
  }
  const env = run?.env;
  if (env !== undefined && (typeof env !== "object" || env === null)) {
    throw new TypeError("RunOptions.env must be an object.");
  }

  const option: unknown = run?.stdio ?? "inherit";
  const stdio = typeof option === "string" ? [option, option, option] : option;
  if (!Array.isArray(stdio) || stdio.length !== 3 || !stdio.every((mode) => MODES.has(mode))) {
    throw new TypeError(
      'RunOptions.stdio must be "inherit", "pipe" or "ignore", or an array of three of them.',
    );
  }
  const [stdin, stdout, stderr] = stdio as StdioMode[];

  return {
    cwd: cwd === undefined ? process.cwd() : resolve(cwd),
    env: { ...(env ?? process.env) },
    stdio: [stdin!, stdout!, stderr!],
    stdout: sinkFor(stdout!),
    stderr: sinkFor(stderr!),
    npmrc: new Map(),
  };
}

function sinkFor(mode: StdioMode): Sink {
  if (mode === "pipe") return [];
  return mode === "ignore" ? null : undefined;
}

/** The text a `"pipe"` sink collected, or `undefined` for any other mode. */
function collected(sink: Sink): string | undefined {
  if (!Array.isArray(sink)) return undefined;
  return Buffer.concat(
    sink.map((chunk) => (typeof chunk === "string" ? Buffer.from(chunk) : chunk)),
  ).toString("utf8");
}
