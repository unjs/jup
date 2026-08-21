/**
 * §13.1's `run()` — spawn the real entry point and assert on
 * `(exitCode, stdout, stderr)`.
 *
 * The environment is scrubbed of every `COREPACK_*`, `DEBUG` and `FORCE_COLOR`
 * variable, `COREPACK_HOME` is always a fresh directory the caller owns, and
 * `COREPACK_DEFAULT_TO_LATEST` is `0` unless the test is about default-version
 * lookup and says otherwise.
 */

import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { MockRegistry } from "./registry.ts";

export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const BIN = join(REPO_ROOT, "src", "bin.ts");

const INTERCEPT = fileURLToPath(new URL("./intercept.ts", import.meta.url));

export interface RunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd: string;
  /** §13.1 — a fresh `COREPACK_HOME` per test. */
  home: string;
  /** Overrides applied last; an explicit `undefined` removes the variable. */
  env?: Record<string, string | undefined>;
  /** Route the embedded table's hardcoded hosts at this mock. */
  registry?: MockRegistry | string;
  /** Written to the child's stdin, which is then closed. */
  input?: string;
  /** Run a *copy* of the tool (see `copyTool`) rather than `src/bin.ts`. */
  bin?: string;
  /** Inherit the parent's stdio instead of piping it (row 140's TTY case). */
  inheritStdio?: boolean;
  timeout?: number;
}

/**
 * A clean environment: everything the tool reads is either absent or set
 * deliberately by the test.
 */
export function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key.startsWith("COREPACK_") || key === "DEBUG" || key === "FORCE_COLOR") continue;
    // `CI` gates the interactive half of the download prompt (§05.5), and
    // `NODE_OPTIONS` could smuggle a loader into the child.
    if (key === "CI" || key === "NODE_OPTIONS" || key === "PIPACK_MOCK_ORIGIN") continue;
    env[key] = value;
  }
  return env;
}

export function run(args: string[], options: RunOptions): Promise<RunResult> {
  const env = cleanEnv();
  env.COREPACK_HOME = options.home;
  env.COREPACK_DEFAULT_TO_LATEST = "0";

  const nodeArgs: string[] = [];
  if (options.registry !== undefined) {
    env.PIPACK_MOCK_ORIGIN =
      typeof options.registry === "string" ? options.registry : options.registry.origin;
    nodeArgs.push("--import", INTERCEPT);
  }

  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }

  const child = spawn(process.execPath, [...nodeArgs, options.bin ?? BIN, ...args], {
    cwd: options.cwd,
    env,
    stdio: options.inheritStdio ? ["pipe", "inherit", "inherit"] : "pipe",
    timeout: options.timeout ?? 30_000,
  });

  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));

  if (options.input !== undefined) child.stdin?.end(options.input);
  else child.stdin?.end();

  return new Promise<RunResult>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (exitCode, signal) => {
      resolve({ exitCode, signal, stdout, stderr });
    });
  });
}
